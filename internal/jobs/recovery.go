package jobs

import (
	"context"
	"github.com/jackc/pgx/v5"
)

// Recover resumes work that was active when the service exited. Explicitly
// paused/stopped jobs and modules remain under the user's control.
func (r *Repository) Recover(ctx context.Context) error {
	return r.DB.Tx(ctx, func(tx pgx.Tx) error {
		// Older releases paused active jobs on shutdown. Their exact recovery
		// message distinguishes them from an explicit user pause.
		if _, err := tx.Exec(ctx, `UPDATE jobs j SET status='queued' WHERE status='paused'
			AND EXISTS(SELECT 1 FROM job_modules m WHERE m.job_id=j.id AND m.status='paused' AND m.message='服务已重启，点击继续后回查恢复')
			AND NOT EXISTS(SELECT 1 FROM jobs newer WHERE newer.account_id=j.account_id AND newer.course_id=j.course_id AND (newer.created_at,newer.id)>(j.created_at,j.id))
			AND NOT EXISTS(SELECT 1 FROM jobs active WHERE active.account_id=j.account_id AND active.course_id=j.course_id AND active.status IN ('running','queued','waiting_input'))`); err != nil {
			return err
		}
		if _, err := tx.Exec(ctx, `UPDATE job_modules m SET status='queued',generation=generation+1,message='服务已恢复，自动回查未完成项'
			FROM jobs j WHERE m.job_id=j.id AND j.status='queued' AND m.status='paused' AND m.message='服务已重启，点击继续后回查恢复'`); err != nil {
			return err
		}
		if _, err := tx.Exec(ctx, `UPDATE job_modules m SET status='queued',generation=generation+1,message='服务已恢复，自动回查未完成项'
			FROM jobs j WHERE m.job_id=j.id AND j.status IN ('running','queued','waiting_input')
			AND m.status IN ('running','queued','waiting_answers','waiting_rate_limit')`); err != nil {
			return err
		}
		if _, err := tx.Exec(ctx, `UPDATE jobs j SET status='queued',revision=revision+1 WHERE status IN ('running','queued','waiting_input')
			AND EXISTS(SELECT 1 FROM job_modules m WHERE m.job_id=j.id AND m.status='queued')`); err != nil {
			return err
		}

		// Repair the latest legacy job only, for the exact automatic-stop bugs.
		// The journal is retained and the new runner checks upstream progress.
		rows, err := tx.Query(ctx, `SELECT j.id,j.owner_id FROM jobs j
			WHERE j.status='partial' AND NOT EXISTS(SELECT 1 FROM jobs newer WHERE newer.account_id=j.account_id AND newer.course_id=j.course_id AND (newer.created_at,newer.id)>(j.created_at,j.id))
			AND NOT EXISTS(SELECT 1 FROM jobs active WHERE active.account_id=j.account_id AND active.course_id=j.course_id AND active.status IN ('running','queued','waiting_input'))
			AND EXISTS(SELECT 1 FROM job_modules m WHERE m.job_id=j.id AND m.status IN ('partial','blocked') AND
			((m.message LIKE '%已冷却重试 5 次%' OR m.message='平台拒绝访问（HTTP 403）') OR (m.kind IN ('video','article') AND EXISTS(SELECT 1 FROM job_items i WHERE i.job_id=j.id AND i.kind=m.kind AND i.error='上次操作结果不确定，未重复发送')))) FOR UPDATE OF j`)
		if err != nil {
			return err
		}
		type candidate struct{ id, owner string }
		var all []candidate
		for rows.Next() {
			var c candidate
			if err = rows.Scan(&c.id, &c.owner); err != nil {
				rows.Close()
				return err
			}
			all = append(all, c)
		}
		err = rows.Err()
		rows.Close()
		if err != nil {
			return err
		}
		for _, c := range all {
			if _, err = tx.Exec(ctx, `UPDATE job_modules m SET status='queued',generation=generation+1,message='已修复自动重试，正在回查未完成项'
				WHERE job_id=$1 AND status IN ('partial','blocked') AND (message LIKE '%已冷却重试 5 次%' OR message='平台拒绝访问（HTTP 403）'
				OR (kind IN ('video','article') AND EXISTS(SELECT 1 FROM job_items i WHERE i.job_id=m.job_id AND i.kind=m.kind AND i.error='上次操作结果不确定，未重复发送')))`, c.id); err != nil {
				return err
			}
			if _, err = tx.Exec(ctx, "UPDATE jobs SET status='queued' WHERE id=$1", c.id); err != nil {
				return err
			}
			if err = touch(ctx, tx, c.owner, c.id); err != nil {
				return err
			}
		}
		return nil
	})
}
