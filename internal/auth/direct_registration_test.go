package auth_test

import (
	"context"
	"testing"
	"xuetangx/internal/auth"
	"xuetangx/internal/fault"
	"xuetangx/internal/testkit"
)

func TestDirectRegistrationAndPasswordChange(t *testing.T) {
	db := testkit.Database(t)
	a := auth.New(db, nil, "https://example.test")
	if _, err := db.Pool.Exec(context.Background(), "UPDATE registration_settings SET email_verification_required=false"); err != nil {
		t.Fatal(err)
	}
	ctx := context.Background()
	if e := a.Register(ctx, "direct@example.test", "1", ""); e != nil {
		t.Fatal(e)
	}
	var mailCount int
	if e := db.Pool.QueryRow(ctx, "SELECT count(*) FROM mail_outbox").Scan(&mailCount); e != nil || mailCount != 0 {
		t.Fatal(e, mailCount)
	}
	l, e := a.Login(ctx, "direct@example.test", "1")
	if e != nil {
		t.Fatal(e)
	}
	if l.User.Admin {
		t.Fatal("registration granted admin")
	}
	if e = a.Register(ctx, "direct@example.test", "2", ""); fault.Code(e) != "EMAIL_REGISTERED" {
		t.Fatal(e)
	}
	if e = a.ChangePassword(ctx, l.User.ID, "wrong-password", "2"); e == nil {
		t.Fatal("wrong password accepted")
	}
	token, e := a.CreateToken(ctx, l.User.ID, "cli")
	if e != nil {
		t.Fatal(e)
	}
	if e = a.ChangePassword(ctx, l.User.ID, "1", "2"); e != nil {
		t.Fatal(e)
	}
	if _, e = a.Authenticate(ctx, l.Token, false); e == nil {
		t.Fatal("session not revoked")
	}
	if _, e = a.Authenticate(ctx, token, true); e == nil {
		t.Fatal("CLI token not revoked")
	}
	if _, e = a.Login(ctx, "direct@example.test", "2"); e != nil {
		t.Fatal(e)
	}
}
