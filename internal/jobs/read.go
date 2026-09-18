package jobs

import (
	"context"
	"encoding/json"
	"github.com/jackc/pgx/v5"
	"time"
	"xuetangx/internal/domain"
	"xuetangx/internal/fault"
)

func (r *Repository) Get(ctx context.Context, owner, id string) (domain.Job, error) {
	j := domain.Job{Owner: owner, Modules: map[string]*domain.Module{}, Logs: []domain.Log{}, Requested: []string{}}
	var targets []byte
	var unit *int64
	var created, updated time.Time
	e := r.DB.Pool.QueryRow(ctx, `SELECT j.id,j.account_id,a.platform_user_id,j.status,j.concurrency,j.submit_unanswered,j.targets,j.unit_id,j.revision,j.created_at,j.updated_at,c.id,c.classroom_id,c.sign,c.course_sign,c.title,c.url FROM jobs j JOIN courses c ON c.id=j.course_id JOIN platform_accounts a ON a.id=j.account_id WHERE j.id=$1 AND j.owner_id=$2`, id, owner).Scan(&j.ID, &j.AccountID, &j.PrimaryID, &j.Status, &j.Concurrency, &j.SubmitUnanswered, &targets, &unit, &j.Revision, &created, &updated, &j.Course.ID, &j.Course.ClassroomID, &j.Course.Sign, &j.Course.CourseSign, &j.Course.Title, &j.Course.URL)
	if e == pgx.ErrNoRows {
		return j, fault.New("NOT_FOUND", "任务不存在")
	}
	if e != nil {
		return j, e
	}
	_ = json.Unmarshal(targets, &j.Targets)
	if unit != nil {
		j.UnitID = *unit
	}
	j.CreatedAt = created.UnixMilli()
	j.UpdatedAt = updated.UnixMilli()
	rows, e := r.DB.Pool.Query(ctx, "SELECT kind,status,generation,restarts,total,message FROM job_modules WHERE job_id=$1 ORDER BY kind", id)
	if e != nil {
		return j, e
	}
	for rows.Next() {
		var kind string
		m := &domain.Module{Results: []domain.Item{}}
		if e = rows.Scan(&kind, &m.Status, &m.Generation, &m.Restarts, &m.Total, &m.Message); e != nil {
			rows.Close()
			return j, e
		}
		m.Role = "primary"
		if kind == "collector" && j.SubmitUnanswered {
			m.Role = "test"
		}
		j.Modules[kind] = m
		j.Requested = append(j.Requested, kind)
	}
	e = rows.Err()
	rows.Close()
	if e != nil {
		return j, e
	}
	rows, e = r.DB.Pool.Query(ctx, "SELECT kind,leaf_id,problem_id,title,status,error FROM job_items WHERE job_id=$1 ORDER BY leaf_id,problem_id", id)
	if e != nil {
		return j, e
	}
	for rows.Next() {
		var kind string
		var item domain.Item
		if e = rows.Scan(&kind, &item.UnitID, &item.ProblemID, &item.Title, &item.Status, &item.Error); e != nil {
			rows.Close()
			return j, e
		}
		m := j.Modules[kind]
		if m == nil {
			continue
		}
		m.Results = append(m.Results, item)
		m.Processed++
		switch item.Status {
		case "completed":
			m.Completed++
		case "captured":
			m.Captured++
			m.Completed++
		case "skipped":
			m.Skipped++
		case "retrying":
			m.Processed--
		case "wrong_existing":
			m.Skipped++
			m.WrongExisting++
		default:
			m.Failed++
		}
	}
	e = rows.Err()
	rows.Close()
	if e != nil {
		return j, e
	}
	rows, e = r.DB.Pool.Query(ctx, "SELECT payload FROM job_events WHERE job_id=$1 AND owner_id=$2 AND event_type='log' ORDER BY id DESC LIMIT 200", id, owner)
	if e != nil {
		return j, e
	}
	for rows.Next() {
		var b []byte
		var l domain.Log
		if e = rows.Scan(&b); e != nil {
			rows.Close()
			return j, e
		}
		if e = json.Unmarshal(b, &l); e != nil {
			rows.Close()
			return j, e
		}
		j.Logs = append(j.Logs, l)
	}
	e = rows.Err()
	rows.Close()
	if e != nil {
		return j, e
	}
	for left, right := 0, len(j.Logs)-1; left < right; left, right = left+1, right-1 {
		j.Logs[left], j.Logs[right] = j.Logs[right], j.Logs[left]
	}
	var raw []byte
	e = r.DB.Pool.QueryRow(ctx, "SELECT payload FROM job_events WHERE job_id=$1 AND owner_id=$2 AND event_type='coverage' ORDER BY id DESC LIMIT 1", id, owner).Scan(&raw)
	if e == nil {
		e = json.Unmarshal(raw, &j.Coverage)
	}
	if e == pgx.ErrNoRows {
		e = nil
	}
	return j, e
}
func (r *Repository) List(ctx context.Context, owner string, limit, offset int, queries ...string) ([]domain.Job, int, error) {
	limit = max(1, min(limit, 100))
	offset = max(0, offset)
	query := ""
	if len(queries) > 0 {
		query = queries[0]
	}
	from := ` FROM jobs j JOIN courses c ON c.id=j.course_id JOIN platform_accounts a ON a.id=j.account_id WHERE j.owner_id=$1 AND (strpos(lower(c.title),lower($2))>0 OR strpos(j.id::text,$2)>0 OR strpos(a.platform_user_id::text,$2)>0)`
	var total int
	if e := r.DB.Pool.QueryRow(ctx, "SELECT count(*)"+from, owner, query).Scan(&total); e != nil {
		return nil, 0, e
	}
	rows, e := r.DB.Pool.Query(ctx, "SELECT j.id"+from+" ORDER BY j.created_at DESC,j.id LIMIT $3 OFFSET $4", owner, query, limit, offset)
	if e != nil {
		return nil, 0, e
	}
	ids := []string{}
	for rows.Next() {
		var id string
		if e = rows.Scan(&id); e != nil {
			rows.Close()
			return nil, 0, e
		}
		ids = append(ids, id)
	}
	e = rows.Err()
	rows.Close()
	if e != nil {
		return nil, 0, e
	}
	out := []domain.Job{}
	for _, id := range ids {
		j, e := r.Get(ctx, owner, id)
		if e != nil {
			return nil, 0, e
		}
		out = append(out, j)
	}
	return out, total, nil
}
