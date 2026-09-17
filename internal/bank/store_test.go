package bank_test

import (
	"context"
	"encoding/json"
	"github.com/google/uuid"
	"testing"
	"xuetangx/internal/bank"
	"xuetangx/internal/domain"
	"xuetangx/internal/platform/wire"
	"xuetangx/internal/testkit"
)

func TestSharedAnswersConflictAndAtomicNotification(t *testing.T) {
	s := testkit.Database(t)
	ctx := context.Background()
	c := domain.Course{ID: uuid.NewString(), ClassroomID: 12}
	unit := uuid.NewString()
	if _, e := s.Pool.Exec(ctx, "INSERT INTO courses(id,classroom_id,sign,course_sign,url) VALUES($1,12,'s','s','url')", c.ID); e != nil {
		t.Fatal(e)
	}
	if _, e := s.Pool.Exec(ctx, "INSERT INTO course_units(id,course_id,leaf_id,kind,leaf_type) VALUES($1,$2,34,'homework',5)", unit, c.ID); e != nil {
		t.Fatal(e)
	}
	b := &bank.Service{DB: s}
	ex := domain.Exercise{LeafID: 34, ExerciseID: 56}
	p := domain.Problem{ID: 78, Content: json.RawMessage(`{"Type":"SingleChoice","Body":"<p>Q</p>","Options":[{"key":"A"},{"key":"B"}]}`)}
	source := wire.Object{"is_show_answer": true, "answer": []any{"A"}}
	if e := b.Save(ctx, domain.Account{}, c, ex, p, source, "exercise_list"); e != nil {
		t.Fatal(e)
	}
	a, ok, e := b.Lookup(ctx, c, ex, p)
	if e != nil || !ok || a.Answer != "A" {
		t.Fatal(a, ok, e)
	}
	var count int
	s.Pool.QueryRow(ctx, "SELECT count(*) FROM event_outbox").Scan(&count)
	if count != 1 {
		t.Fatal("notification missing")
	}
	source["answer"] = []any{"B"}
	if e = b.Save(ctx, domain.Account{}, c, ex, p, source, "submission_response"); e != nil {
		t.Fatal(e)
	}
	if _, ok, e = b.Lookup(ctx, c, ex, p); e != nil || ok {
		t.Fatal("conflict remained usable", e)
	}
	var n int
	s.Pool.QueryRow(ctx, "SELECT count(*) FROM answer_sources").Scan(&n)
	if n != 2 {
		t.Fatal("sources lost")
	}
}
