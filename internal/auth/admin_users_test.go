package auth_test

import (
	"context"
	"github.com/google/uuid"
	"testing"
	"xuetangx/internal/admin"
	"xuetangx/internal/auth"
	"xuetangx/internal/fault"
	"xuetangx/internal/testkit"
)

func TestAdminUserEditsAndSessionRevocation(t *testing.T) {
	db := testkit.Database(t)
	ctx := context.Background()
	actor := uuid.NewString()
	_, err := db.Pool.Exec(ctx, `INSERT INTO users(id,email,password_hash,admin,verified) VALUES($1,'admin@example.test','hash',true,true)`, actor)
	if err != nil {
		t.Fatal(err)
	}
	a := auth.New(db, nil, "https://example.test")
	a.RequireEmailVerification = false
	if err = a.Register(ctx, "learner@example.test", "x"); err != nil {
		t.Fatal(err)
	}
	login, err := a.Login(ctx, "learner@example.test", "x")
	if err != nil {
		t.Fatal(err)
	}
	token, err := a.CreateToken(ctx, login.User.ID, "cli")
	if err != nil {
		t.Fatal(err)
	}
	email, password := "updated@example.test", "y"
	if err = a.UpdateUser(ctx, login.User.ID, login.User.ID, &email, &password); fault.Code(err) != "FORBIDDEN" {
		t.Fatal(err)
	}
	if err = a.UpdateUser(ctx, actor, login.User.ID, &email, &password); err != nil {
		t.Fatal(err)
	}
	for _, v := range []struct {
		token string
		api   bool
	}{{login.Token, false}, {token, true}} {
		if _, err = a.Authenticate(ctx, v.token, v.api); fault.Code(err) != "AUTH_REQUIRED" {
			t.Fatal("session survived", err)
		}
	}
	if _, err = a.Login(ctx, email, password); err != nil {
		t.Fatal(err)
	}
	if err = a.UpdateUser(ctx, actor, actor, &email, nil); fault.Code(err) != "INVALID_INPUT" {
		t.Fatal(err)
	}
	list, total, err := (admin.Service{DB: db}).Users(ctx, "updated", 20, 0)
	if err != nil || total != 1 || len(list) != 1 {
		t.Fatal(list, total, err)
	}
	if _, err = (admin.Service{DB: db}).Detail(ctx, login.User.ID); err != nil {
		t.Fatal(err)
	}
}
