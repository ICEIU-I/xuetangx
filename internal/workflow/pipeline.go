package workflow

import (
	"context"
	"xuetangx/internal/domain"
	"xuetangx/internal/fault"
	"xuetangx/internal/learning"
)

func (e *Engine) prepare(ctx context.Context, owner, id string) {
	job, err := e.Jobs.Get(ctx, owner, id)
	if err != nil {
		return
	}
	a, err := e.Accounts.Require(ctx, owner, "primary")
	if err == nil && a.ID != job.AccountID {
		err = fault.New("ACCOUNT_REQUIRED", "请连接此任务原有正式账号")
	}
	if err != nil {
		e.blockQueued(ctx, job, err)
		return
	}
	inv, err := e.Catalog.Discover(ctx, a, job.Course.URL)
	if err != nil {
		e.blockQueued(ctx, job, err)
		return
	}
	for _, kind := range []string{"video", "article", "discussion"} {
		if m := job.Modules[kind]; m != nil && m.Status == "queued" {
			units := []domain.Unit{}
			for _, u := range inv.Units {
				if u.Kind == kind && (job.UnitID == 0 || job.UnitID == u.ID) {
					units = append(units, u)
				}
			}
			if job.UnitID != 0 && len(units) != 1 {
				_ = e.Jobs.Module(ctx, owner, id, kind, "blocked", "视频不属于所选课程")
				continue
			}
			e.launch(job, a, learning.Input{Kind: kind, Course: inv.Course, Units: units, Concurrency: job.Concurrency, UserID: a.UserID, Role: a.Role}, inv)
		}
	}
	homework, collector := job.Modules["homework"], job.Modules["collector"]
	if (homework == nil || homework.Status != "queued") && (collector == nil || collector.Status != "queued") {
		return
	}
	if err = e.Catalog.Exercises(ctx, a, &inv); err != nil {
		e.blockQueued(ctx, job, err)
		return
	}
	if len(job.Targets) > 0 {
		selected := []domain.Exercise{}
		for _, ex := range inv.Exercises {
			for _, name := range job.Targets {
				if ex.Title == name {
					selected = append(selected, ex)
					break
				}
			}
		}
		inv.Exercises = selected
		if len(selected) == 0 {
			e.blockQueued(ctx, job, fault.New("INVALID_INPUT", "没有匹配的作业"))
			return
		}
	}
	if err = e.Bank.ObserveBatch(ctx, a, inv.Course, inv.Exercises); err != nil {
		e.blockQueued(ctx, job, err)
		return
	}
	coverage, err := e.Bank.Coverage(ctx, inv)
	if err != nil {
		e.blockQueued(ctx, job, err)
		return
	}
	_ = e.Jobs.SetCoverage(ctx, owner, id, coverage)
	if collector != nil && collector.Status == "queued" && !job.SubmitUnanswered {
		e.launch(job, a, learning.Input{Kind: "collector", Course: inv.Course, Exercises: inv.Exercises, Concurrency: job.Concurrency, UserID: a.UserID, Role: a.Role}, inv)
	} else if (collector != nil && collector.Status == "queued") || (homework != nil && homework.Status == "queued" && coverage.Missing > 0) {
		if collector == nil {
			_ = e.Jobs.Module(ctx, owner, id, "collector", "queued", "准备补齐题库")
		}
		e.prepareCollector(ctx, job, a, inv, coverage.Missing > 0)
	}
	if homework != nil && homework.Status == "queued" {
		e.launch(job, a, learning.Input{Kind: "homework", Course: inv.Course, Exercises: inv.Exercises, Concurrency: job.Concurrency, UserID: a.UserID, Role: a.Role}, inv)
	}
}
func (e *Engine) blockQueued(ctx context.Context, j domain.Job, err error) {
	if ctx.Err() != nil {
		return
	}
	status := "blocked"
	if fault.Code(err) == "ACCOUNT_REQUIRED" || fault.Code(err) == "ACCOUNT_CHANGED" {
		status = "waiting_account"
	}
	for k, m := range j.Modules {
		if m.Status == "queued" {
			_ = e.Jobs.Module(ctx, j.Owner, j.ID, k, status, fault.Public(err))
		}
	}
}
