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

func TestQuestionSearchBeforePagination(t *testing.T) {
	db := testkit.Database(t)
	ctx := context.Background()
	_, c := testkit.Seed(t, db)
	b := &bank.Service{DB: db}
	for i := int64(1); i <= 3; i++ {
		body := "Other"
		if i == 3 {
			body = "Target Physics"
		}
		p := domain.Problem{ID: i, Content: json.RawMessage(`{"Type":"SingleChoice","Body":"` + body + `","Options":[{"key":"A","content":"one"}]}`)}
		if err := b.Save(ctx, domain.Account{}, c, domain.Exercise{LeafID: 34, ExerciseID: 56}, p, wire.Object{"is_show_answer": true, "answer": []any{"A"}}, "exercise_list"); err != nil {
			t.Fatal(err)
		}
	}
	for _, tc := range []struct {
		q                    string
		offset, total, count int
	}{{"", 0, 3, 1}, {"physics", 0, 1, 1}, {"physics", 1, 1, 0}, {"%", 0, 0, 0}, {"3", 0, 1, 1}, {"does-not-exist", 0, 0, 0}} {
		out, err := b.SearchQuestions(ctx, c, 1, tc.offset, tc.q)
		if err != nil {
			t.Fatal(err)
		}
		var decoded struct {
			Pagination struct{ Total int }
			Database   struct {
				Exercises map[string]struct {
					Questions []struct {
						Answer  string
						Options []any
					}
				}
			}
		}
		raw, _ := json.Marshal(out)
		if err = json.Unmarshal(raw, &decoded); err != nil {
			t.Fatal(err)
		}
		count := 0
		for _, ex := range decoded.Database.Exercises {
			for _, q := range ex.Questions {
				count++
				if q.Answer != "A" || len(q.Options) != 1 {
					t.Fatalf("answer/options lost: %s", raw)
				}
			}
		}
		if decoded.Pagination.Total != tc.total || count != tc.count {
			t.Fatalf("query=%q total=%d count=%d", tc.q, decoded.Pagination.Total, count)
		}
	}
	c.ID = uuid.NewString()
	out, err := b.SearchQuestions(ctx, c, 20, 0, "")
	if err != nil || out["pagination"].(map[string]int)["total"] != 0 {
		t.Fatal("course isolation failed", err)
	}
}
