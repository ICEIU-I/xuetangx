package workflow

import (
	"context"
	"encoding/json"
	"time"
	"xuetangx/internal/domain"
	"xuetangx/internal/fault"
	"xuetangx/internal/learning"
)

func (e *Engine) launch(job domain.Job, account domain.Account, input learning.Input, primary domain.Inventory) {
	key := job.ID + ":" + input.Kind
	e.mu.Lock()
	if e.actors[key] != nil {
		e.mu.Unlock()
		return
	}
	ctx, cancel := context.WithCancel(e.ctx)
	a := &actor{cancel: cancel, wake: make(chan string, 8), account: account}
	e.actors[key] = a
	e.wg.Add(1)
	e.mu.Unlock()
	go func() {
		defer e.wg.Done()
		defer cancel()
		defer func() {
			e.mu.Lock()
			delete(e.actors, key)
			e.mu.Unlock()
			if input.Kind == "collector" {
				e.wake(job.ID, "answers-complete")
			}
			e.settle(job.Owner, job.ID)
		}()
		for attempt := 0; attempt < 2; attempt++ {
			generation, err := e.Jobs.BeginModule(ctx, job.Owner, job.ID, input.Kind)
			if err != nil {
				return
			}
			e.mu.Lock()
			a.generation = generation
			e.mu.Unlock()
			result, err := e.Host.Run(ctx, generation, input, func(ctx context.Context, method string, args json.RawMessage) (any, error) {
				return e.rpc(ctx, job, account, input, primary, method, args)
			}, func(p learning.Progress) error {
				return e.Jobs.Progress(ctx, job.Owner, job.ID, input.Kind, generation, p)
			}, a.wake)
			if ctx.Err() != nil {
				return
			}
			if err != nil && fault.Code(err) == "WORKER_CRASH" && attempt == 0 {
				var restarts int
				if err = e.DB.Pool.QueryRow(ctx, "UPDATE job_modules SET restarts=restarts+1,status='queued',message='子进程退出，重新回查后恢复' WHERE job_id=$1 AND kind=$2 AND generation=$3 AND restarts<1 RETURNING restarts", job.ID, input.Kind, generation).Scan(&restarts); err != nil {
					return
				}
				fresh, err := e.Catalog.Discover(ctx, account, input.Course.URL)
				if err == nil && (input.Kind == "homework" || input.Kind == "collector") {
					err = e.Catalog.Exercises(ctx, account, &fresh)
				}
				if err != nil {
					_ = e.Jobs.Module(ctx, job.Owner, job.ID, input.Kind, "blocked", fault.Public(err))
					return
				}
				if input.Kind == "homework" || input.Kind == "collector" {
					allowed := map[int64]bool{}
					for _, ex := range input.Exercises {
						allowed[ex.LeafID] = true
					}
					input.Exercises = nil
					for _, ex := range fresh.Exercises {
						if allowed[ex.LeafID] {
							input.Exercises = append(input.Exercises, ex)
						}
					}
				} else {
					allowed := map[int64]bool{}
					for _, u := range input.Units {
						allowed[u.ID] = true
					}
					input.Units = nil
					for _, u := range fresh.Units {
						if allowed[u.ID] {
							input.Units = append(input.Units, u)
						}
					}
				}
				continue
			}
			if err != nil {
				result.Status = "blocked"
				result.Message = fault.Public(err)
				if fault.Code(err) == "ACCOUNT_REQUIRED" || fault.Code(err) == "ACCOUNT_CHANGED" {
					result.Status = "waiting_account"
				}
			}
			_ = e.Jobs.FinishModule(ctx, job.Owner, job.ID, input.Kind, generation, result)
			if input.Kind == "collector" {
				if coverage, err := e.Bank.Coverage(ctx, primary); err == nil {
					_ = e.Jobs.SetCoverage(ctx, job.Owner, job.ID, coverage)
				}
			}
			return
		}
	}()
}
func (e *Engine) wake(id, kind string) {
	e.mu.Lock()
	defer e.mu.Unlock()
	if a := e.actors[id+":homework"]; a != nil {
		select {
		case a.wake <- kind:
		default:
		}
	}
}
func (e *Engine) AccountChanged(owner, role string) {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	a, err := e.Accounts.Get(ctx, owner, role)
	if err != nil {
		return
	}
	e.mu.Lock()
	for _, actor := range e.actors {
		if actor.account.Owner == owner && actor.account.Role == role {
			actor.cancel()
		}
	}
	if role == "primary" {
		for id, cancel := range e.preparing {
			if e.owners[id] == owner {
				cancel()
			}
		}
	}
	e.mu.Unlock()
	if role == "primary" {
		_, _ = e.DB.Pool.Exec(ctx, `UPDATE job_modules m SET status='waiting_account',generation=generation+1,message='平台账号已变化，请确认后继续' FROM jobs j WHERE j.id=m.job_id AND j.owner_id=$1 AND j.status IN ('running','queued','waiting_input') AND (m.kind<>'collector' OR NOT j.submit_unanswered) AND m.status IN ('running','queued','waiting_answers','waiting_account')`, owner)
	} else {
		status := "waiting_account"
		if a.Connected {
			status = "queued"
		}
		_, _ = e.DB.Pool.Exec(ctx, `UPDATE job_modules m SET status=$2,generation=generation+1,message='测试账号状态已变化' FROM jobs j WHERE j.id=m.job_id AND j.owner_id=$1 AND j.submit_unanswered AND j.status IN ('running','queued','waiting_input') AND m.kind='collector' AND m.status NOT IN ('done','stopped','paused')`, owner, status)
		if a.Connected {
			_, _ = e.DB.Pool.Exec(ctx, `UPDATE job_modules m SET status='queued' FROM jobs j WHERE j.id=m.job_id AND j.owner_id=$1 AND j.status='waiting_input' AND m.kind='homework' AND m.status='waiting_answers'`, owner)
			_, _ = e.DB.Pool.Exec(ctx, "UPDATE jobs SET status='queued' WHERE owner_id=$1 AND status='waiting_input'", owner)
		}
	}
}
func (e *Engine) deliverAnswers() error {
	rows, err := e.DB.Pool.Query(e.ctx, "SELECT id,payload FROM event_outbox WHERE delivered_at IS NULL ORDER BY id LIMIT 100")
	if err != nil {
		return err
	}
	type event struct {
		id        int64
		classroom int64
	}
	all := []event{}
	for rows.Next() {
		var id int64
		var raw []byte
		if err = rows.Scan(&id, &raw); err != nil {
			rows.Close()
			return err
		}
		var v struct {
			Classroom int64 `json:"classroomId"`
		}
		if err = json.Unmarshal(raw, &v); err != nil {
			rows.Close()
			return err
		}
		all = append(all, event{id, v.Classroom})
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		return err
	}
	for _, ev := range all {
		jobs, err := e.DB.Pool.Query(e.ctx, "SELECT j.id FROM jobs j JOIN courses c ON c.id=j.course_id WHERE c.classroom_id=$1 AND j.status IN ('running','waiting_input')", ev.classroom)
		if err != nil {
			return err
		}
		ids := []string{}
		for jobs.Next() {
			var id string
			if err = jobs.Scan(&id); err != nil {
				jobs.Close()
				return err
			}
			ids = append(ids, id)
		}
		jobs.Close()
		for _, id := range ids {
			e.wake(id, "answer-ready")
		}
		if _, err = e.DB.Pool.Exec(e.ctx, "UPDATE event_outbox SET delivered_at=now() WHERE id=$1", ev.id); err != nil {
			return err
		}
	}
	return nil
}
