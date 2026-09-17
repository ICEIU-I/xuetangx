package workflow_test

import (
	"context"
	"encoding/base64"
	"os"
	"strings"
	"testing"
	"time"
	"xuetangx/internal/accounts"
	"xuetangx/internal/bank"
	"xuetangx/internal/catalog"
	"xuetangx/internal/domain"
	"xuetangx/internal/operations"
	"xuetangx/internal/platform"
	"xuetangx/internal/process"
	"xuetangx/internal/secure"
	"xuetangx/internal/testkit"
	"xuetangx/internal/workflow"
)

func TestWorkerEntrypoint(t *testing.T) {
	if os.Args[len(os.Args)-1] != "worker" {
		return
	}
	if process.Worker(os.Stdin, os.Stdout) != nil {
		os.Exit(2)
	}
	os.Exit(0)
}
func TestCompleteCourseAndLateTestAccount(t *testing.T) {
	for _, late := range []bool{false, true} {
		t.Run(map[bool]string{false: "complete", true: "late_account"}[late], func(t *testing.T) {
			db := testkit.Database(t)
			seed, _ := testkit.Seed(t, db)
			mock := testkit.MockPlatform(t)
			keys := &secure.Keys{Active: "k", Values: map[string]string{"k": base64.StdEncoding.EncodeToString([]byte(strings.Repeat("k", 32)))}}
			a := accounts.New(db, keys, mock.Client.Authenticate)
			b := &bank.Service{DB: db}
			broker := platform.NewBroker(a, mock.Client)
			c := &catalog.Service{DB: db, Request: broker.Call}
			ops := operations.New(&operations.Journal{DB: db}, b, c, broker.Call)
			engine, err := workflow.New(context.Background(), db, a, b, c, broker, ops, 10, 2)
			if err != nil {
				t.Fatal(err)
			}
			engine.Host = process.Host{Executable: os.Args[0], Args: []string{"-test.run=^TestWorkerEntrypoint$", "--", "worker"}}
			defer engine.Close()
			ctx := context.Background()
			if _, err = a.Connect(ctx, seed.Owner, "primary", "csrftoken=csrf; sessionid=101"); err != nil {
				t.Fatal(err)
			}
			if !late {
				if _, err = a.Connect(ctx, seed.Owner, "test", "csrftoken=csrf; sessionid=202"); err != nil {
					t.Fatal(err)
				}
			}
			job, err := engine.Start(ctx, seed.Owner, domain.Start{CourseURL: "https://www.xuetangx.com/learn/space/s/c/12"})
			if err != nil {
				t.Fatal(err)
			}
			wait := func(wanted string) domain.Job {
				t.Helper()
				deadline := time.Now().Add(15 * time.Second)
				for time.Now().Before(deadline) {
					j, e := engine.Jobs.Get(ctx, seed.Owner, job.ID)
					if e != nil {
						t.Fatal(e)
					}
					if j.Status == wanted {
						return j
					}
					if j.Status == "partial" || j.Status == "stopped" {
						t.Fatalf("unexpected job %+v modules=%+v", j, j.Modules)
					}
					time.Sleep(30 * time.Millisecond)
				}
				j, _ := engine.Jobs.Get(ctx, seed.Owner, job.ID)
				for k, m := range j.Modules {
					t.Logf("%s %+v", k, m)
				}
				t.Fatalf("timeout: %s expected %s", j.Status, wanted)
				return j
			}
			if late {
				j := wait("waiting_input")
				if j.Modules["video"].Status != "done" || j.Modules["article"].Status != "done" {
					t.Fatal("missing test blocked media")
				}
				if _, err = a.Connect(ctx, seed.Owner, "test", "csrftoken=csrf; sessionid=202"); err != nil {
					t.Fatal(err)
				}
			}
			j := wait("done")
			if j.Modules["homework"].Completed != 1 || j.Modules["collector"].Captured != 1 {
				t.Fatalf("unexpected counts %+v %+v", j.Modules["homework"], j.Modules["collector"])
			}
			answers, posts := mock.Counts(101)
			if answers != 1 || posts != 1 {
				t.Fatalf("duplicate writes: %d %d", answers, posts)
			}
			if _, err = engine.Jobs.Get(ctx, "00000000-0000-0000-0000-000000000001", job.ID); err == nil {
				t.Fatal("cross-owner task exposed")
			}
		})
	}
}
