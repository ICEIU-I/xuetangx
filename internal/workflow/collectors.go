package workflow

import (
	"context"
	"strings"
	"time"
	"xuetangx/internal/domain"
	"xuetangx/internal/fault"
	"xuetangx/internal/learning"
	"xuetangx/internal/platform"
)

func (e *Engine) prepareCollector(ctx context.Context, job domain.Job, primary domain.Account, inv domain.Inventory, missing bool) {
	defer func() {
		e.mu.Lock()
		delete(e.preparingCollectors, job.ID)
		e.mu.Unlock()
	}()
	candidates, err := e.Accounts.SharedCollectors(ctx, primary.UserID)
	if err != nil {
		e.collectorError(ctx, job, err)
		return
	}
	// Preserve private collectors for existing CLI clients, with shared accounts preferred.
	own, err := e.Accounts.Get(ctx, job.Owner, "test")
	if err != nil {
		e.collectorError(ctx, job, err)
		return
	}
	if own.Connected && own.UserID != primary.UserID {
		candidates = append(candidates, own)
	}
	if len(candidates) == 0 {
		e.collectorError(ctx, job, fault.New("ACCOUNT_REQUIRED", "暂无可用的答案采集账号，请联系管理员添加"))
		return
	}
	var last error
	for _, a := range candidates {
		if ctx.Err() != nil {
			return
		}
		e.mu.Lock()
		e.preparingCollectors[job.ID] = a
		e.mu.Unlock()
		target, err := e.Catalog.Discover(ctx, a, job.Course.URL)
		if fault.Code(err) == "ENROLLMENT_REQUIRED" && a.Shared && missing {
			_ = e.Jobs.Module(ctx, job.Owner, job.ID, "collector", "queued", "正在检查课程的免费加入选项")
			err = e.Ops.EnrollFree(ctx, a, inv.Course)
			if err == nil {
				target, err = e.Catalog.Discover(ctx, a, job.Course.URL)
			}
		}
		if err == nil {
			err = e.Catalog.Exercises(ctx, a, &target)
		}
		if err != nil {
			last = err
			continue
		}
		selected := []domain.Exercise{}
		for _, ex := range target.Exercises {
			for _, original := range inv.Exercises {
				if ex.LeafID == original.LeafID {
					if ex.ExerciseID != original.ExerciseID {
						ex.Error = "两账号题集标识不匹配"
					}
					selected = append(selected, ex)
					break
				}
			}
		}
		if ctx.Err() != nil {
			return
		}
		e.launch(job, a, learning.Input{Kind: "collector", Course: inv.Course, Exercises: selected, Concurrency: job.Concurrency, UserID: a.UserID, Role: a.Role, SubmitUnanswered: true}, inv)
		return
	}
	e.collectorError(ctx, job, last)
}

// CollectorLimit exposes only the cooldown of this owner's active job, without shared identity.
func (e *Engine) CollectorLimit(owner, id string) *platform.CooldownState {
	e.mu.Lock()
	if e.owners[id] != owner {
		e.mu.Unlock()
		return nil
	}
	a, ok := e.preparingCollectors[id]
	if actor := e.actors[id+":collector"]; actor != nil {
		a, ok = actor.account, true
	}
	e.mu.Unlock()
	if !ok {
		return nil
	}
	state := e.Broker.State(a.UserID).CooldownState
	return &state
}
func (e *Engine) collectorError(ctx context.Context, j domain.Job, err error) {
	if ctx.Err() != nil {
		return
	}
	status := "blocked"
	switch fault.Code(err) {
	case "ACCOUNT_REQUIRED", "ACCOUNT_CHANGED":
		status = "waiting_account"
	case "ENROLLMENT_REQUIRED", "NO_FREE_ENROLLMENT":
		status = "waiting_enrollment"
	}
	_ = e.Jobs.Module(ctx, j.Owner, j.ID, "collector", status, fault.Public(err))
}
func (e *Engine) collectorsChanged() {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	// Cancel only workers whose shared credential revision changed. Unrelated modules continue.
	e.mu.Lock()
	changed := []string{}
	for key, a := range e.actors {
		if !a.account.Shared {
			continue
		}
		var valid bool
		err := e.DB.Pool.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM platform_accounts WHERE id=$1 AND revision=$2 AND enabled AND valid)`, a.account.ID, a.account.Revision).Scan(&valid)
		if err != nil || !valid {
			a.cancel()
			changed = append(changed, strings.TrimSuffix(key, ":collector"))
		}
	}
	e.mu.Unlock()
	_, _ = e.DB.Pool.Exec(ctx, `UPDATE job_modules m SET status='queued',generation=generation+1,message='采集账号已更新，等待回查' FROM jobs j WHERE j.id=m.job_id AND j.status IN ('running','queued','waiting_input') AND j.submit_unanswered AND m.kind='collector' AND (m.status IN ('waiting_account','waiting_enrollment') OR (j.id=ANY($1::uuid[]) AND m.status='running'))`, changed)
	_, _ = e.DB.Pool.Exec(ctx, `UPDATE job_modules m SET status='queued' FROM jobs j WHERE j.id=m.job_id AND j.status='waiting_input' AND m.kind='homework' AND m.status='waiting_answers' AND EXISTS(SELECT 1 FROM job_modules c WHERE c.job_id=j.id AND c.kind='collector' AND c.status='queued')`)
	_, _ = e.DB.Pool.Exec(ctx, `UPDATE jobs j SET status='queued',revision=revision+1 WHERE status='waiting_input' AND EXISTS(SELECT 1 FROM job_modules m WHERE m.job_id=j.id AND m.status='queued')`)
}
