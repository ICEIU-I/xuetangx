package testkit

import (
	"context"
	"github.com/google/uuid"
	"testing"
	"xuetangx/internal/domain"
	"xuetangx/internal/store"
)

func Seed(t testing.TB, s *store.Store) (domain.Account, domain.Course) {
	t.Helper()
	ctx := context.Background()
	a := domain.Account{ID: uuid.NewString(), Owner: uuid.NewString(), UserID: 101, Role: "primary", Connected: true, Revision: 1}
	c := domain.Course{ID: uuid.NewString(), ClassroomID: 12, Sign: "s", CourseSign: "c", URL: "https://www.xuetangx.com/learn/space/s/c/12"}
	for _, q := range []struct {
		sql  string
		args []any
	}{{"INSERT INTO users(id,email,password_hash,verified) VALUES($1,$2,'hash',true)", []any{a.Owner, a.Owner + "@example.test"}}, {"INSERT INTO platform_accounts(id,owner_id,platform_user_id,role,valid) VALUES($1,$2,$3,$4,true)", []any{a.ID, a.Owner, a.UserID, a.Role}}, {"INSERT INTO courses(id,classroom_id,sign,course_sign,title,url) VALUES($1,$2,$3,$4,'Course',$5)", []any{c.ID, c.ClassroomID, c.Sign, c.CourseSign, c.URL}}, {"INSERT INTO course_units(id,course_id,leaf_id,kind,leaf_type) VALUES($1,$2,34,'homework',5)", []any{uuid.NewString(), c.ID}}} {
		if _, e := s.Pool.Exec(ctx, q.sql, q.args...); e != nil {
			t.Fatal(e)
		}
	}
	return a, c
}
