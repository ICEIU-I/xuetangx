package jobs_test

import (
	"context"
	"github.com/google/uuid"
	"testing"
	"xuetangx/internal/jobs"
	"xuetangx/internal/testkit"
)

func TestJobSearchPaginationAndOwnerIsolation(t *testing.T) {
	db := testkit.Database(t)
	ctx := context.Background()
	a, c := testkit.Seed(t, db)
	r := &jobs.Repository{DB: db}
	for i := 0; i < 3; i++ {
		if _, err := db.Pool.Exec(ctx, `INSERT INTO jobs(id,owner_id,account_id,course_id,status,concurrency) VALUES($1,$2,$3,$4,'done',1)`, uuid.NewString(), a.Owner, a.ID, c.ID); err != nil {
			t.Fatal(err)
		}
	}
	for _, tc := range []struct {
		q                    string
		offset, total, count int
	}{{"course", 0, 3, 1}, {"course", 2, 3, 1}, {"101", 0, 3, 1}, {"%", 0, 0, 0}, {"missing", 0, 0, 0}} {
		list, total, err := r.List(ctx, a.Owner, 1, tc.offset, tc.q)
		if err != nil || total != tc.total || len(list) != tc.count {
			t.Fatalf("%q: total=%d count=%d err=%v", tc.q, total, len(list), err)
		}
	}
	list, total, err := r.List(ctx, uuid.NewString(), 20, 0, "course")
	if err != nil || total != 0 || len(list) != 0 {
		t.Fatal("search leaked jobs", err)
	}
}
