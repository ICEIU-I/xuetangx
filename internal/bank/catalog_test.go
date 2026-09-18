package bank_test

import (
	"context"
	"testing"

	"github.com/google/uuid"

	"xuetangx/internal/bank"
	"xuetangx/internal/testkit"
)

func TestCourseBankOverviewAndPagination(t *testing.T) {
	db := testkit.Database(t)
	ctx := context.Background()
	b := &bank.Service{DB: db}
	list, total, err := b.Courses(ctx, 20, 0)
	if err != nil || list == nil || len(list) != 0 || total != 0 {
		t.Fatalf("empty bank: %v %d %v", list, total, err)
	}
	_, c := testkit.Seed(t, db)
	if _, err = db.Pool.Exec(ctx, `INSERT INTO courses(id,classroom_id,sign,course_sign,title,url) VALUES($1,99,'s','s','No questions','url')`, uuid.NewString()); err != nil {
		t.Fatal(err)
	}
	exercise := uuid.NewString()
	if _, err = db.Pool.Exec(ctx, `INSERT INTO exercises(id,unit_id,platform_exercise_id) SELECT $1,id,56 FROM course_units WHERE course_id=$2`, exercise, c.ID); err != nil {
		t.Fatal(err)
	}
	for i, status := range []string{"captured", "missing", "conflict"} {
		id := uuid.NewString()
		if _, err = db.Pool.Exec(ctx, `INSERT INTO question_versions(id,exercise_id,problem_id,fingerprint,question_type,platform_type) VALUES($1,$2,$3,'v','single','SingleChoice')`, id, exercise, i+1); err != nil {
			t.Fatal(err)
		}
		if _, err = db.Pool.Exec(ctx, `INSERT INTO standard_answers(question_id,status) VALUES($1,$2)`, id, status); err != nil {
			t.Fatal(err)
		}
	}
	list, total, err = b.Courses(ctx, 1, 0)
	if err != nil || total != 1 || len(list) != 1 {
		t.Fatalf("course list: %v %d %v", list, total, err)
	}
	item := list[0]
	if item.Course.ClassroomID != 12 || item.Course.Title != "Course" || item.TotalExercises != 1 || item.TotalQuestions != 3 || item.CapturedAnswers != 1 || item.MissingAnswers != 2 || item.UpdatedAt.IsZero() {
		t.Fatalf("wrong overview: %+v", item)
	}
	list, total, err = b.Courses(ctx, 1, 1)
	if err != nil || total != 1 || len(list) != 0 {
		t.Fatalf("pagination: %v %d %v", list, total, err)
	}
}
