package jobs_test

import (
	"context"
	"testing"
	"xuetangx/internal/domain"
	"xuetangx/internal/jobs"
	"xuetangx/internal/testkit"
)

func TestRecoverRespectsUserControlAndRepairsLegacyProgress(t *testing.T) {
	for _, mode := range []string{"active", "paused", "stopped", "legacy_shutdown", "legacy_partial", "legacy_403", "legacy_403_limit", "older_partial", "unknown_discussion"} {
		t.Run(mode, func(t *testing.T) {
			db := testkit.Database(t)
			a, c := testkit.Seed(t, db)
			ctx := context.Background()
			repo := &jobs.Repository{DB: db}
			id, err := repo.Create(ctx, a, c, domain.Start{Modules: []string{"video", "article"}})
			if err != nil {
				t.Fatal(err)
			}
			status, module, msg, kind := "running", "running", "执行中", "video"
			switch mode {
			case "paused":
				status, module, msg = "paused", "paused", "任务已暂停"
			case "stopped":
				status, module, msg = "stopped", "stopped", "任务已停止"
			case "legacy_shutdown":
				status, module, msg = "paused", "paused", "服务已重启，点击继续后回查恢复"
			case "legacy_partial", "legacy_403", "legacy_403_limit", "older_partial", "unknown_discussion":
				status, module, msg = "partial", "partial", "课程单元处理结束"
			}
			if _, err = db.Pool.Exec(ctx, "UPDATE jobs SET status=$2,created_at=now()-interval '1 minute' WHERE id=$1", id, status); err != nil {
				t.Fatal(err)
			}
			if _, err = db.Pool.Exec(ctx, "UPDATE job_modules SET status=$2,message=$3 WHERE job_id=$1 AND kind='video'", id, module, msg); err != nil {
				t.Fatal(err)
			}
			if _, err = db.Pool.Exec(ctx, "UPDATE job_modules SET status='done' WHERE job_id=$1 AND kind='article'", id); err != nil {
				t.Fatal(err)
			}
			if mode == "unknown_discussion" {
				kind = "discussion"
				if _, err = db.Pool.Exec(ctx, "UPDATE job_modules SET kind='discussion' WHERE job_id=$1 AND kind='video'", id); err != nil {
					t.Fatal(err)
				}
			}
			if module == "partial" {
				if _, err = db.Pool.Exec(ctx, "INSERT INTO job_items(job_id,kind,leaf_id,status,error) VALUES($1,$2,11,'failed','上次操作结果不确定，未重复发送')", id, kind); err != nil {
					t.Fatal(err)
				}
			}
			if mode == "older_partial" {
				if _, err = repo.Create(ctx, a, c, domain.Start{Modules: []string{"video"}}); err != nil {
					t.Fatal(err)
				}
			}
			if err = repo.Recover(ctx); err != nil {
				t.Fatal(err)
			}
			// Idempotent across shutdown and subsequent startup.
			if err = repo.Recover(ctx); err != nil {
				t.Fatal(err)
			}
			j, err := repo.Get(ctx, a.Owner, id)
			if err != nil {
				t.Fatal(err)
			}
			want := status
			if mode == "active" || mode == "legacy_shutdown" || mode == "legacy_partial" || mode == "legacy_403" || mode == "legacy_403_limit" {
				want = "queued"
			}
			if j.Status != want || j.Modules["article"].Status != "done" {
				t.Fatalf("mode=%s job=%+v", mode, j)
			}
			if want == "queued" && j.Modules[kind].Status != "queued" {
				t.Fatal("module not queued", j.Modules[kind])
			}
		})
	}
}
