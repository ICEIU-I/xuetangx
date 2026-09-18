package operations_test

import (
	"context"
	"encoding/json"
	"errors"
	"testing"
	"time"
	"xuetangx/internal/bank"
	"xuetangx/internal/catalog"
	"xuetangx/internal/domain"
	"xuetangx/internal/fault"
	"xuetangx/internal/operations"
	"xuetangx/internal/platform"
	"xuetangx/internal/platform/wire"
	"xuetangx/internal/testkit"
)

func TestDurableRetryAndAcceptedTimeout(t *testing.T) {
	for _, accepted := range []bool{false, true} {
		t.Run(map[bool]string{false: "unanswered_retries", true: "accepted_never_replays"}[accepted], func(t *testing.T) {
			s := testkit.Database(t)
			a, c := testkit.Seed(t, s)
			ctx := context.Background()
			ex := domain.Exercise{LeafID: 34, ExerciseID: 56, SKUID: 9}
			p := domain.Problem{ID: 78, Content: json.RawMessage(`{"Type":"SingleChoice","Options":[{"key":"A"}]}`), User: json.RawMessage(`{"my_count":0}`)}
			b := &bank.Service{DB: s}
			if e := b.Save(ctx, a, c, ex, p, wire.Object{"is_show_answer": true, "answer": []any{"A"}}, "exercise_list"); e != nil {
				t.Fatal(e)
			}
			posts, reads := 0, 0
			done := false
			call := func(_ context.Context, _ domain.Account, method, path string, _ any) (platform.Response, error) {
				if method == "POST" {
					posts++
					if posts == 1 {
						done = accepted
						return platform.Response{}, &platform.TransportError{Connected: true, Transient: true, Cause: errors.New("timeout")}
					}
					done = true
					return platform.Response{Status: 200, JSON: wire.Object{"success": true, "data": wire.Object{"is_correct": true}}}, nil
				}
				reads++
				fresh := p
				if done {
					fresh.User = json.RawMessage(`{"my_count":1,"is_right":true}`)
				}
				return platform.Response{Status: 200, JSON: wire.Object{"success": true, "data": wire.Object{"problems": []any{wire.ObjFromJSON(fresh)}}}}, nil
			}
			cat := &catalog.Service{DB: s, Request: call}
			op := operations.New(&operations.Journal{DB: s}, b, cat, call)
			op.Wait = func(context.Context, time.Duration) error { return nil }
			op.Delays = []time.Duration{0, 0, 0}
			if _, e := op.Submit(ctx, a, c, ex, p, false); e != nil {
				t.Fatal(e)
			}
			want := 2
			if accepted {
				want = 1
			}
			if posts != want {
				t.Fatal("posts", posts)
			}
			if !accepted && reads != 3 {
				t.Fatal("reconciliation reads", reads)
			}
			restarted := operations.New(&operations.Journal{DB: s}, b, cat, call)
			restarted.Wait = op.Wait
			restarted.Delays = op.Delays
			if _, e := restarted.Submit(ctx, anotherBinding(t, s, a), c, ex, p, false); e != nil {
				t.Fatal(e)
			}
			if posts != want {
				t.Fatal("restart replayed accepted write")
			}
		})
	}
}
func TestMissingCountNeverRetriesAndBudgetSurvives(t *testing.T) {
	s := testkit.Database(t)
	a, c := testkit.Seed(t, s)
	ctx := context.Background()
	ex := domain.Exercise{LeafID: 34, ExerciseID: 56, SKUID: 9}
	p := domain.Problem{ID: 78, Content: json.RawMessage(`{"Type":"Judgement"}`), User: json.RawMessage(`{}`)}
	b := &bank.Service{DB: s}
	b.Save(ctx, a, c, ex, p, wire.Object{"is_show_answer": true, "answer": []any{true}}, "exercise_list")
	posts := 0
	call := func(_ context.Context, _ domain.Account, m, _ string, _ any) (platform.Response, error) {
		if m == "POST" {
			posts++
			return platform.Response{}, &platform.TransportError{Connected: true, Transient: true}
		}
		return platform.Response{Status: 200, JSON: wire.Object{"success": true, "data": wire.Object{"problems": []any{wire.ObjFromJSON(p)}}}}, nil
	}
	op := operations.New(&operations.Journal{DB: s}, b, &catalog.Service{DB: s, Request: call}, call)
	op.Wait = func(context.Context, time.Duration) error { return nil }
	op.Delays = []time.Duration{0, 0, 0}
	if _, e := op.Submit(ctx, a, c, ex, p, false); fault.Code(e) != "REVIEW_REQUIRED" {
		t.Fatal(e)
	}
	if posts != 1 {
		t.Fatal(posts)
	}
	p.User = json.RawMessage(`{"my_count":0}`)
	a = anotherBinding(t, s, a)
	for i := 0; i < 2; i++ {
		if _, e := op.Submit(ctx, a, c, ex, p, false); fault.Code(e) != "SUBMISSION_RETRY_EXHAUSTED" {
			t.Fatal(e)
		}
	}
	if posts != 3 {
		t.Fatal("retry budget reset", posts)
	}
}
