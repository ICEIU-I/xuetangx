package workflow_test

import (
	"context"
	"encoding/base64"
	"os"
	"strings"
	"sync/atomic"
	"testing"
	"time"
	"xuetangx/internal/accounts"
	"xuetangx/internal/bank"
	"xuetangx/internal/catalog"
	"xuetangx/internal/domain"
	"xuetangx/internal/operations"
	"xuetangx/internal/platform"
	"xuetangx/internal/platform/wire"
	"xuetangx/internal/process"
	"xuetangx/internal/secure"
	"xuetangx/internal/testkit"
	"xuetangx/internal/workflow"
)

type progressTransport struct {
	inner  platform.Transport
	mode   string
	writes atomic.Int32
}

func (p *progressTransport) Do(ctx context.Context, m, path string, body any, cookie string) (platform.Response, error) {
	if path != "/video-log/heartbeat/" {
		return p.inner.Do(ctx, m, path, body, cookie)
	}
	n := p.writes.Add(1)
	if n == 1 {
		if p.mode == "timeout" {
			return platform.Response{}, &platform.TransportError{Connected: true, Transient: true}
		}
		if p.mode == "acknowledged" || p.mode == "pause" {
			return platform.Response{Status: 200, JSON: wire.Object{"success": true, "data": wire.Object{}}}, nil
		}
	}
	return p.inner.Do(ctx, m, path, body, cookie)
}

func TestVideoIncompleteResponseRetriesAndLegacyJobRecovers(t *testing.T) {
	for _, mode := range []string{"timeout", "acknowledged", "legacy", "pause"} {
		t.Run(mode, func(t *testing.T) {
			db := testkit.Database(t)
			seed, _ := testkit.Seed(t, db)
			mock := testkit.MockPlatform(t)
			keys := &secure.Keys{Active: "k", Values: map[string]string{"k": base64.StdEncoding.EncodeToString([]byte(strings.Repeat("k", 32)))}}
			a := accounts.New(db, keys, mock.Client.Authenticate)
			b := &bank.Service{DB: db}
			transport := &progressTransport{inner: mock.Client, mode: mode}
			makeEngine := func() *workflow.Engine {
				broker := platform.NewBroker(a, transport)
				cat := &catalog.Service{DB: db, Request: broker.Call}
				ops := operations.New(&operations.Journal{DB: db}, b, cat, broker.Call)
				ops.Wait = func(ctx context.Context, _ time.Duration) error { return ctx.Err() }
				e, err := workflow.New(context.Background(), db, a, b, cat, broker, ops, 10, 2)
				if err != nil {
					t.Fatal(err)
				}
				e.Host = process.Host{Executable: os.Args[0], Args: []string{"-test.run=^TestWorkerEntrypoint$", "--", "worker"}}
				return e
			}
			engine := makeEngine()
			defer func() {
				if engine != nil {
					engine.Close()
				}
			}()
			ctx := context.Background()
			if _, err := a.Connect(ctx, seed.Owner, "primary", "csrftoken=csrf; sessionid=101"); err != nil {
				t.Fatal(err)
			}
			job, err := engine.Start(ctx, seed.Owner, domain.Start{CourseURL: "https://www.xuetangx.com/learn/space/s/c/12", Modules: []string{"video"}})
			if err != nil {
				t.Fatal(err)
			}
			wait := func(check func(domain.Job) bool) domain.Job {
				t.Helper()
				deadline := time.Now().Add(15 * time.Second)
				for time.Now().Before(deadline) {
					j, err := engine.Jobs.Get(ctx, seed.Owner, job.ID)
					if err != nil {
						t.Fatal(err)
					}
					if check(j) {
						return j
					}
					if j.Status == "partial" {
						t.Fatalf("incomplete video stopped: %+v", j.Modules["video"])
					}
					time.Sleep(20 * time.Millisecond)
				}
				j, _ := engine.Jobs.Get(ctx, seed.Owner, job.ID)
				t.Fatalf("timeout: %+v", j.Modules["video"])
				return j
			}
			if mode == "pause" {
				j := wait(func(j domain.Job) bool {
					return len(j.Modules["video"].Results) > 0 && strings.Contains(j.Modules["video"].Message, "退避")
				})
				if j.Modules["video"].Completed != 0 || j.Modules["video"].Failed != 0 || j.Modules["video"].Processed != 0 {
					t.Fatal("retry counted as complete or failed", j.Modules["video"])
				}
				if _, err = engine.Control(ctx, seed.Owner, job.ID, "pause", ""); err != nil {
					t.Fatal(err)
				}
				time.Sleep(1200 * time.Millisecond)
				if transport.writes.Load() != 1 {
					t.Fatal("paused video retried")
				}
				if _, err = engine.Control(ctx, seed.Owner, job.ID, "resume", ""); err != nil {
					t.Fatal(err)
				}
			}
			wait(func(j domain.Job) bool { return j.Status == "done" })
			if mode == "legacy" {
				// Reproduce the persisted screenshot error and an unknown heartbeat record.
				engine.Close()
				engine = nil
				clearMock := testkit.MockPlatform(t)
				transport.inner = clearMock.Client
				if _, err = db.Pool.Exec(ctx, "UPDATE operations SET state='unknown' WHERE kind='video'"); err != nil {
					t.Fatal(err)
				}
				if _, err = db.Pool.Exec(ctx, "UPDATE job_items SET status='failed',error='上次操作结果不确定，未重复发送' WHERE job_id=$1", job.ID); err != nil {
					t.Fatal(err)
				}
				if _, err = db.Pool.Exec(ctx, "UPDATE job_modules SET status='partial' WHERE job_id=$1", job.ID); err != nil {
					t.Fatal(err)
				}
				if _, err = db.Pool.Exec(ctx, "UPDATE jobs SET status='partial' WHERE id=$1", job.ID); err != nil {
					t.Fatal(err)
				}
				engine = makeEngine()
				wait(func(j domain.Job) bool { return j.Status == "done" })
			}
			j, err := engine.Jobs.Get(ctx, seed.Owner, job.ID)
			if err != nil {
				t.Fatal(err)
			}
			if j.Modules["video"].Completed+j.Modules["video"].Skipped != 1 || j.Modules["video"].Failed != 0 {
				t.Fatal("incorrect completion counts", j.Modules["video"])
			}
			if transport.writes.Load() != 2 {
				t.Fatal("unexpected write count", transport.writes.Load())
			}
		})
	}
}
