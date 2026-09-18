package jobs

import (
	"context"
	"encoding/json"
	"fmt"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"time"
	"xuetangx/internal/domain"
	"xuetangx/internal/fault"
	"xuetangx/internal/learning"
	"xuetangx/internal/platform/wire"
	"xuetangx/internal/store"
)

type Repository struct{ DB *store.Store }

var Kinds = map[string]bool{"video": true, "article": true, "discussion": true, "homework": true, "collector": true}

func (r *Repository) Create(ctx context.Context, a domain.Account, c domain.Course, input domain.Start) (string, error) {
	id := uuid.NewString()
	if input.Concurrency == 0 {
		input.Concurrency = 3
	}
	if input.Concurrency < 1 || input.Concurrency > 3 {
		return "", fault.New("INVALID_INPUT", "并发数须为 1–3")
	}
	if len(input.Modules) == 0 {
		input.Modules = []string{"video", "article", "discussion", "homework"}
	}
	for _, kind := range input.Modules {
		if !Kinds[kind] {
			return "", fault.New("INVALID_INPUT", "任务类型无效")
		}
	}
	if input.UnitID != 0 && (input.UnitID < 0 || len(input.Modules) != 1 || input.Modules[0] != "video") {
		return "", fault.New("INVALID_INPUT", "单视频参数无效")
	}
	if input.Targets == nil {
		input.Targets = []string{}
	}
	submit := true
	if input.SubmitUnanswered != nil {
		submit = *input.SubmitUnanswered
	}
	e := r.DB.Tx(ctx, func(tx pgx.Tx) error {
		if _, e := tx.Exec(ctx, "SELECT pg_advisory_xact_lock(hashtextextended($1,1))", a.ID+":"+c.ID); e != nil {
			return e
		}
		var previousTargets []byte
		var previousUnit *int64
		e := tx.QueryRow(ctx, `SELECT id,targets,unit_id FROM jobs WHERE account_id=$1 AND course_id=$2 AND status IN ('queued','running','waiting_input') FOR UPDATE`, a.ID, c.ID).Scan(&id, &previousTargets, &previousUnit)
		if e != nil && e != pgx.ErrNoRows {
			return e
		}
		if e == nil {
			var prior []string
			_ = json.Unmarshal(previousTargets, &prior)
			unit := int64(0)
			if previousUnit != nil {
				unit = *previousUnit
			}
			if string(wire.JSON(prior)) != string(wire.JSON(input.Targets)) || unit != input.UnitID {
				return fault.New("JOB_CONFLICT", "该课程已有不同范围的任务，请先停止或等待完成")
			}
		} else {
			var unit any
			if input.UnitID != 0 {
				unit = input.UnitID
			}
			_, e = tx.Exec(ctx, `INSERT INTO jobs(id,owner_id,account_id,course_id,concurrency,submit_unanswered,targets,unit_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8)`, id, a.Owner, a.ID, c.ID, input.Concurrency, submit, wire.JSON(input.Targets), unit)
			if e != nil {
				return e
			}
		}
		for _, kind := range input.Modules {
			if _, e = tx.Exec(ctx, "INSERT INTO job_modules(job_id,kind) VALUES($1,$2) ON CONFLICT DO NOTHING", id, kind); e != nil {
				return e
			}
		}
		return touch(ctx, tx, a.Owner, id)
	})
	return id, e
}
func touch(ctx context.Context, tx pgx.Tx, owner, id string) error {
	var rev int64
	if e := tx.QueryRow(ctx, "UPDATE jobs SET revision=revision+1,updated_at=now() WHERE id=$1 AND owner_id=$2 RETURNING revision", id, owner).Scan(&rev); e != nil {
		return e
	}
	_, e := tx.Exec(ctx, `INSERT INTO job_events(owner_id,job_id,event_type,payload) VALUES($1,$2,'workflow',$3)`, owner, id, wire.JSON(map[string]any{"jobId": id, "revision": rev}))
	return e
}
func (r *Repository) Module(ctx context.Context, owner, id, kind, status, message string) error {
	return r.DB.Tx(ctx, func(tx pgx.Tx) error {
		_, e := tx.Exec(ctx, `INSERT INTO job_modules(job_id,kind,status,message) SELECT id,$3,$4,$5 FROM jobs WHERE id=$1 AND owner_id=$2 AND status='running' ON CONFLICT(job_id,kind) DO UPDATE SET status=excluded.status,message=excluded.message WHERE job_modules.status NOT IN ('done','paused','stopped')`, id, owner, kind, status, message)
		if e != nil {
			return e
		}
		return touch(ctx, tx, owner, id)
	})
}
func (r *Repository) BeginModule(ctx context.Context, owner, id, kind string) (int64, error) {
	var generation int64
	e := r.DB.Tx(ctx, func(tx pgx.Tx) error {
		e := tx.QueryRow(ctx, `UPDATE job_modules m SET generation=generation+1,status='running',message='执行中' FROM jobs j WHERE j.id=m.job_id AND j.id=$1 AND j.owner_id=$2 AND m.kind=$3 AND j.status='running' AND m.status='queued' RETURNING generation`, id, owner, kind).Scan(&generation)
		if e != nil {
			return e
		}
		return touch(ctx, tx, owner, id)
	})
	return generation, e
}
func (r *Repository) Progress(ctx context.Context, owner, id, kind string, generation int64, p learning.Progress) error {
	return r.DB.Tx(ctx, func(tx pgx.Tx) error {
		tag, e := tx.Exec(ctx, `UPDATE job_modules m SET total=greatest(total,$5),message=$6 FROM jobs j WHERE m.job_id=j.id AND j.id=$1 AND j.owner_id=$2 AND m.kind=$3 AND m.generation=$4 AND m.status='running' AND j.status='running'`, id, owner, kind, generation, p.Total, p.Message)
		if e != nil {
			return e
		}
		if tag.RowsAffected() == 0 {
			return context.Canceled
		}
		if p.Item != nil {
			v := p.Item
			_, e = tx.Exec(ctx, `INSERT INTO job_items(job_id,kind,leaf_id,problem_id,title,status,error) VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(job_id,kind,leaf_id,problem_id) DO UPDATE SET title=excluded.title,status=excluded.status,error=excluded.error,updated_at=now()`, id, kind, v.UnitID, v.ProblemID, v.Title, v.Status, v.Error)
			if e != nil {
				return e
			}
		}
		if p.Message != "" {
			if _, e = tx.Exec(ctx, `INSERT INTO job_events(owner_id,job_id,event_type,payload) VALUES($1,$2,'log',$3)`, owner, id, wire.JSON(domain.Log{TS: time.Now().UnixMilli(), Kind: kind, Message: p.Message})); e != nil {
				return e
			}
		}
		return touch(ctx, tx, owner, id)
	})
}
func (r *Repository) FinishModule(ctx context.Context, owner, id, kind string, generation int64, result learning.Result) error {
	return r.DB.Tx(ctx, func(tx pgx.Tx) error {
		tag, e := tx.Exec(ctx, `UPDATE job_modules m SET status=$5,message=$6,total=greatest(total,$7) FROM jobs j WHERE m.job_id=j.id AND j.id=$1 AND j.owner_id=$2 AND m.kind=$3 AND m.generation=$4 AND m.status='running' AND j.status='running'`, id, owner, kind, generation, result.Status, result.Message, result.Total)
		if e != nil {
			return e
		}
		if tag.RowsAffected() == 0 {
			return nil
		}
		return touch(ctx, tx, owner, id)
	})
}
func (r *Repository) Control(ctx context.Context, owner, id, action, kind string) error {
	if kind != "" && !Kinds[kind] {
		return fault.New("INVALID_INPUT", "模块类型无效")
	}
	status := ""
	switch action {
	case "pause":
		status = "paused"
	case "stop":
		status = "stopped"
	case "resume", "retry":
		status = "queued"
	default:
		return fault.New("INVALID_INPUT", "任务操作无效")
	}
	return r.DB.Tx(ctx, func(tx pgx.Tx) error {
		var found string
		if e := tx.QueryRow(ctx, "SELECT id FROM jobs WHERE id=$1 AND owner_id=$2 FOR UPDATE", id, owner).Scan(&found); e != nil {
			if e == pgx.ErrNoRows {
				return fault.New("NOT_FOUND", "任务不存在")
			}
			return e
		}
		if _, e := tx.Exec(ctx, `UPDATE job_modules SET status=$3,generation=generation+1,message=$4 WHERE job_id=$1 AND ($2='' OR kind=$2) AND (status<>'done' OR $3<>'queued')`, id, kind, status, map[string]string{"paused": "任务已暂停", "stopped": "任务已停止", "queued": "等待回查并继续"}[status]); e != nil {
			return e
		}
		if kind == "" || status == "queued" {
			if _, e := tx.Exec(ctx, "UPDATE jobs SET status=$2 WHERE id=$1", id, status); e != nil {
				return e
			}
		}
		return touch(ctx, tx, owner, id)
	})
}
func (r *Repository) Aggregate(ctx context.Context, owner, id string) error {
	return r.DB.Tx(ctx, func(tx pgx.Tx) error {
		_, e := tx.Exec(ctx, `UPDATE jobs SET status=CASE WHEN EXISTS(SELECT 1 FROM job_modules WHERE job_id=$1 AND status IN ('queued','running','waiting_rate_limit')) THEN 'queued' WHEN EXISTS(SELECT 1 FROM job_modules WHERE job_id=$1 AND status IN ('waiting_answers','waiting_account','waiting_enrollment')) THEN 'waiting_input' WHEN EXISTS(SELECT 1 FROM job_modules WHERE job_id=$1 AND status IN ('partial','blocked','error','stopped','paused')) THEN 'partial' ELSE 'done' END WHERE id=$1 AND owner_id=$2 AND status NOT IN ('paused','stopped','done')`, id, owner)
		if e != nil {
			return e
		}
		return touch(ctx, tx, owner, id)
	})
}
func (r *Repository) SetCoverage(ctx context.Context, owner, id string, c domain.Coverage) error {
	_, e := r.DB.Pool.Exec(ctx, `INSERT INTO job_events(owner_id,job_id,event_type,payload) SELECT owner_id,id,'coverage',$3 FROM jobs WHERE id=$1 AND owner_id=$2`, id, owner, wire.JSON(c))
	return e
}
func (r *Repository) Producer(ctx context.Context, owner, id string) (string, error) {
	var status string
	e := r.DB.Pool.QueryRow(ctx, `SELECT m.status FROM job_modules m JOIN jobs j ON j.id=m.job_id WHERE j.id=$1 AND j.owner_id=$2 AND m.kind='collector'`, id, owner).Scan(&status)
	if e == pgx.ErrNoRows {
		return "done", nil
	}
	return status, e
}

var _ = fmt.Sprint
