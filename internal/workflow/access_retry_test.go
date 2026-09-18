package workflow_test

import (
	"context"
	"encoding/base64"
	"encoding/json"
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

type denyingCollector struct {
	transport platform.Transport
	path      string
	deny      atomic.Bool
	calls     atomic.Int32
	limit     int32
}

func (d *denyingCollector) Do(ctx context.Context, method, path string, body any, cookie string) (platform.Response, error) {
	if strings.Contains(cookie, "sessionid=202") && strings.HasPrefix(path, d.path) && d.deny.Load() {
		if d.calls.Add(1) <= d.limit {
			return platform.Response{Status: 403, RetryAfter: "0.15", JSON: wire.Object{"success": false, "msg": "请求过于频繁"}}, nil
		}
	}
	return d.transport.Do(ctx, method, path, body, cookie)
}

func TestSharedCollectorAccessRecovery(t *testing.T) {
	for _, mode := range []string{"scan", "submit", "exhausted", "pause"} {
		t.Run(mode, func(t *testing.T) {
			db := testkit.Database(t)
			seed, _ := testkit.Seed(t, db)
			mock := testkit.MockPlatform(t)
			transport := &denyingCollector{transport: mock.Client, path: platform.SubmitPath, limit: 2}
			transport.deny.Store(true)
			if mode == "scan" {
				transport.path = "/api/v1/lms/exercise/get_exercise_list/"
			}
			if mode == "exhausted" || mode == "pause" {
				transport.limit = 100
			}
			keys := &secure.Keys{Active: "k", Values: map[string]string{"k": base64.StdEncoding.EncodeToString([]byte(strings.Repeat("k", 32)))}}
			a := accounts.New(db, keys, mock.Client.Authenticate)
			b := &bank.Service{DB: db}
			broker := platform.NewBroker(a, transport)
			c := &catalog.Service{DB: db, Request: broker.Call}
			engine, err := workflow.New(context.Background(), db, a, b, c, broker, operations.New(&operations.Journal{DB: db}, b, c, broker.Call), 10, 2)
			if err != nil {
				t.Fatal(err)
			}
			engine.Host = process.Host{Executable: os.Args[0], Args: []string{"-test.run=^TestWorkerEntrypoint$", "--", "worker"}}
			defer engine.Close()
			ctx := context.Background()
			if _, err = db.Pool.Exec(ctx, "UPDATE users SET admin=true WHERE id=$1", seed.Owner); err != nil {
				t.Fatal(err)
			}
			if _, err = a.Connect(ctx, seed.Owner, "primary", "csrftoken=csrf; sessionid=101"); err != nil {
				t.Fatal(err)
			}
			if err = a.SaveCollector(ctx, seed.Owner, "", "Shared", "csrftoken=csrf; sessionid=202"); err != nil {
				t.Fatal(err)
			}
			job, err := engine.Start(ctx, seed.Owner, domain.Start{CourseURL: "https://www.xuetangx.com/learn/space/s/c/12", Concurrency: 1})
			if err != nil {
				t.Fatal(err)
			}
			wait := func(check func(domain.Job) bool) domain.Job {
				t.Helper()
				deadline := time.Now().Add(15 * time.Second)
				for time.Now().Before(deadline) {
					j, e := engine.Jobs.Get(ctx, seed.Owner, job.ID)
					if e != nil {
						t.Fatal(e)
					}
					if check(j) {
						return j
					}
					time.Sleep(10 * time.Millisecond)
				}
				j, _ := engine.Jobs.Get(ctx, seed.Owner, job.ID)
				t.Fatalf("timeout: %+v", j)
				return j
			}
			wait(func(domain.Job) bool {
				s := engine.CollectorLimit(seed.Owner, job.ID)
				return s != nil && s.Blocked
			})
			s := engine.CollectorLimit(seed.Owner, job.ID)
			raw, _ := json.Marshal(s)
			if s == nil || s.Reason != "access_denied" || strings.Contains(string(raw), "userId") || strings.Contains(string(raw), "202") || engine.CollectorLimit("other", job.ID) != nil {
				t.Fatalf("collector state or privacy failed: %s", raw)
			}
			if broker.State(101).Blocked {
				t.Fatal("collector cooldown blocked primary account")
			}
			if mode == "exhausted" {
				j := wait(func(j domain.Job) bool { return j.Status == "partial" })
				if transport.calls.Load() != 6 || j.Modules["collector"].Status != "blocked" || !strings.Contains(j.Modules["collector"].Message, "已冷却重试 5 次") {
					t.Fatalf("unbounded retries: calls=%d collector=%+v", transport.calls.Load(), j.Modules["collector"])
				}
				var state string
				if err := db.Pool.QueryRow(ctx, "SELECT state FROM operations WHERE kind='question'").Scan(&state); err != nil || state != "rejected" {
					t.Fatal("explicit rejection journal", state, err)
				}
				transport.deny.Store(false)
				if _, err = engine.Control(ctx, seed.Owner, job.ID, "resume", ""); err != nil {
					t.Fatal(err)
				}
			}
			if mode == "pause" {
				if _, err = engine.Control(ctx, seed.Owner, job.ID, "pause", ""); err != nil {
					t.Fatal(err)
				}
				before := transport.calls.Load()
				time.Sleep(350 * time.Millisecond)
				if transport.calls.Load() != before {
					t.Fatal("retry continued after pause")
				}
				if n, _ := mock.Counts(202); n != 0 {
					t.Fatal("collector posted while paused")
				}
				transport.deny.Store(false)
				if _, err = engine.Control(ctx, seed.Owner, job.ID, "resume", ""); err != nil {
					t.Fatal(err)
				}
			}
			j := wait(func(j domain.Job) bool { return j.Status == "done" })
			if j.Modules["collector"].Captured != 1 || j.Modules["homework"].Completed != 1 {
				t.Fatalf("pipeline did not recover: %+v", j)
			}
			for _, id := range []int64{101, 202} {
				if n, _ := mock.Counts(id); n != 1 {
					t.Fatal("duplicate or missing answer", id, n)
				}
			}
		})
	}
}
