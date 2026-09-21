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

func TestWholeCourseAfterHomeworkDoesNotResubmitAnswers(t *testing.T) {
	db := testkit.Database(t)
	seed, _ := testkit.Seed(t, db)
	mock := testkit.MockPlatform(t)
	keys := &secure.Keys{Active: "k", Values: map[string]string{"k": base64.StdEncoding.EncodeToString([]byte(strings.Repeat("k", 32)))}}
	ac := accounts.New(db, keys, mock.Client.Authenticate)
	b := &bank.Service{DB: db}
	broker := platform.NewBroker(ac, mock.Client)
	c := &catalog.Service{DB: db, Request: broker.Call}
	ops := operations.New(&operations.Journal{DB: db}, b, c, broker.Call)
	engine, err := workflow.New(context.Background(), db, ac, b, c, broker, ops, 10, 2)
	if err != nil {
		t.Fatal(err)
	}
	defer engine.Close()
	engine.Host = process.Host{Executable: os.Args[0], Args: []string{"-test.run=^TestWorkerEntrypoint$", "--", "worker"}}
	ctx := context.Background()
	for role, id := range map[string]string{"primary": "101", "test": "202"} {
		if _, err = ac.Connect(ctx, seed.Owner, role, "csrftoken=csrf; sessionid="+id); err != nil {
			t.Fatal(err)
		}
	}
	wait := func(id string) domain.Job {
		t.Helper()
		deadline := time.Now().Add(20 * time.Second)
		for time.Now().Before(deadline) {
			j, e := engine.Jobs.Get(ctx, seed.Owner, id)
			if e != nil {
				t.Fatal(e)
			}
			if j.Status == "done" {
				return j
			}
			if j.Status == "partial" || j.Status == "stopped" {
				t.Fatalf("unexpected task state %s", j.Status)
			}
			time.Sleep(30 * time.Millisecond)
		}
		t.Fatal("task did not complete")
		return domain.Job{}
	}
	old, err := engine.Start(ctx, seed.Owner, domain.Start{CourseURL: "https://www.xuetangx.com/learn/space/s/c/12", Modules: []string{"homework"}})
	if err != nil {
		t.Fatal(err)
	}
	done := wait(old.ID)
	if len(done.Modules) != 2 || done.Modules["homework"].Completed != 1 || done.Modules["video"] != nil {
		t.Fatal("fixture was not a completed homework-only task")
	}
	answers, posts := mock.Counts(101)
	if answers != 1 || posts != 0 {
		t.Fatal("homework-only run touched other modules")
	}
	whole, err := engine.Start(ctx, seed.Owner, domain.Start{CourseURL: old.Course.URL})
	if err != nil {
		t.Fatal(err)
	}
	if whole.ID == old.ID {
		t.Fatal("completed tool record overwritten")
	}
	finished := wait(whole.ID)
	for _, kind := range []string{"video", "article", "discussion", "homework"} {
		if finished.Modules[kind] == nil || finished.Modules[kind].Status != "done" {
			t.Fatal("missing completed module", kind)
		}
	}
	if finished.Modules["homework"].Skipped != 1 || finished.Modules["homework"].Completed != 0 {
		t.Fatal("completed answer was not skipped")
	}
	if finished.Modules["video"].Completed != 1 {
		t.Fatal("remaining video was not executed")
	}
	answers, posts = mock.Counts(101)
	if answers != 1 || posts != 1 {
		t.Fatal("answer resubmitted or discussion duplicated")
	}
	original, err := engine.Jobs.Get(ctx, seed.Owner, old.ID)
	if err != nil || original.Status != "done" || original.Modules["homework"].Completed != 1 || original.Modules["video"] != nil {
		t.Fatal("old task history changed")
	}
}
