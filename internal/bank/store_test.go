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

func TestObserveBatchUsesOneAtomicPreparation(t *testing.T) {
	db := testkit.Database(t)
	ctx := context.Background()
	a, c := testkit.Seed(t, db)
	b := &bank.Service{DB: db}
	ex := domain.Exercise{LeafID: 34, ExerciseID: 56}
	valid := func(id int64, key string) domain.Problem {
		return domain.Problem{ID: id, Content: json.RawMessage(`{"Type":"SingleChoice","Body":"Q","Options":[{"key":"A"},{"key":"B"}]}`), User: json.RawMessage(`{"my_count":1,"is_right":true,"answer":["` + key + `"]}`)}
	}
	ex.Problems = []domain.Problem{valid(78, "A"), valid(79, "B")}
	if err := b.ObserveBatch(ctx, a, c, []domain.Exercise{ex}); err != nil {
		t.Fatal(err)
	}
	var questions, states int
	if err := db.Pool.QueryRow(ctx, "SELECT count(*) FROM question_versions").Scan(&questions); err != nil {
		t.Fatal(err)
	}
	if err := db.Pool.QueryRow(ctx, "SELECT count(*) FROM account_question_states").Scan(&states); err != nil {
		t.Fatal(err)
	}
	if questions != 2 || states != 2 {
		t.Fatalf("batch did not persist all observations: questions=%d states=%d", questions, states)
	}

	// A malformed later question rolls back the whole batch, so preparation cannot
	// leave a half-written local inventory behind.
	ex.Problems = []domain.Problem{valid(80, "A"), {ID: 81, Content: json.RawMessage(`{"Type":"SingleChoice","Body":"bad","Options":[{"key":""}]}`)}}
	if err := b.ObserveBatch(ctx, a, c, []domain.Exercise{ex}); err == nil {
		t.Fatal("malformed batch unexpectedly committed")
	}
	if err := db.Pool.QueryRow(ctx, "SELECT count(*) FROM question_versions WHERE problem_id IN (80,81)").Scan(&questions); err != nil {
		t.Fatal(err)
	}
	if questions != 0 {
		t.Fatalf("atomic batch left partial rows: %d", questions)
	}
}
