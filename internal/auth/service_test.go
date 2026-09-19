package auth_test

import (
	"context"
	"encoding/base64"
	"regexp"
	"strings"
	"testing"
	"xuetangx/internal/auth"
	"xuetangx/internal/fault"
	"xuetangx/internal/mail"
	"xuetangx/internal/secure"
	"xuetangx/internal/testkit"
)

func resetCode(body string) string {
	return regexp.MustCompile(`Your code: ([0-9]{6})`).FindStringSubmatch(body)[1]
}

type inbox struct {
	body string
	fail bool
}

func (i *inbox) Send(_ context.Context, _, _, body string) error {
	i.body = body
	if i.fail {
		return fault.New("SMTP", "unavailable")
	}
	return nil
}
func TestVerifiedRegistrationResetAndRevocation(t *testing.T) {
	s := testkit.Database(t)
	keys := &secure.Keys{Active: "k", Values: map[string]string{"k": base64.StdEncoding.EncodeToString([]byte(strings.Repeat("a", 32)))}}
	box := &inbox{}
	q := &mail.Queue{DB: s, Keys: keys, Sender: box}
	a := auth.New(s, q, "https://example.test")
	ctx := context.Background()
	if e := a.Register(ctx, "User@Example.com", "correct-password-123"); e != nil {
		t.Fatal(e)
	}
	if _, e := a.Login(ctx, "user@example.com", "correct-password-123"); fault.Code(e) != "EMAIL_UNVERIFIED" {
		t.Fatal(e)
	}
	if e := q.Tick(ctx); e != nil {
		t.Fatal(e)
	}
	token := strings.Split(strings.Split(box.body, "#verify=")[1], "\n")[0]
	if e := a.Consume(ctx, token, "verify", ""); e != nil {
		t.Fatal(e)
	}
	if e := a.Consume(ctx, token, "verify", ""); fault.Code(e) != "TOKEN_INVALID" {
		t.Fatal("reused token", e)
	}
	login, e := a.Login(ctx, "user@example.com", "correct-password-123")
	if e != nil {
		t.Fatal(e)
	}
	api, e := a.CreateToken(ctx, login.User.ID, "cli")
	if e != nil {
		t.Fatal(e)
	}
	if _, e = a.Authenticate(ctx, api, true); e != nil {
		t.Fatal(e)
	}
	if e = a.RequestEmail(ctx, "user@example.com", "reset"); e != nil {
		t.Fatal(e)
	}
	if e = q.Tick(ctx); e != nil {
		t.Fatal(e)
	}
	token = strings.Split(strings.Split(box.body, "#reset=")[1], "\n")[0]
	if e = a.Consume(ctx, token, "reset", "replacement-password-123"); e != nil {
		t.Fatal(e)
	}
	for _, b := range []bool{false, true} {
		v := login.Token
		if b {
			v = api
		}
		if _, e = a.Authenticate(ctx, v, b); fault.Code(e) != "AUTH_REQUIRED" {
			t.Fatal("token not revoked", e)
		}
	}
}

func TestPasswordResetCodeSingleUseAndResend(t *testing.T) {
	s := testkit.Database(t)
	keys := &secure.Keys{Active: "k", Values: map[string]string{"k": base64.StdEncoding.EncodeToString([]byte(strings.Repeat("a", 32)))}}
	box := &inbox{}
	q := &mail.Queue{DB: s, Keys: keys, Sender: box}
	a := auth.New(s, q, "https://example.test")
	a.RequireEmailVerification = false
	ctx := context.Background()
	if e := a.Register(ctx, "code@example.test", "old-password"); e != nil {
		t.Fatal(e)
	}
	if e := a.RequestResetCode(ctx, "code@example.test"); e != nil {
		t.Fatal(e)
	}
	if e := q.Tick(ctx); e != nil {
		t.Fatal(e)
	}
	first := resetCode(box.body)
	if e := a.ConsumeResetCode(ctx, "code@example.test", first, "new-password"); e != nil {
		t.Fatal(e)
	}
	if e := a.ConsumeResetCode(ctx, "code@example.test", first, "other-password"); fault.Code(e) != "TOKEN_INVALID" {
		t.Fatal(e)
	}
	if _, e := a.Login(ctx, "code@example.test", "new-password"); e != nil {
		t.Fatal(e)
	}
	if e := a.RequestResetCode(ctx, "code@example.test"); e != nil {
		t.Fatal(e)
	}
	if e := q.Tick(ctx); e != nil {
		t.Fatal(e)
	}
	second := resetCode(box.body)
	if first == second {
		t.Fatal("reset code repeated")
	}
	if e := a.ConsumeResetCode(ctx, "code@example.test", first, "bad-password"); fault.Code(e) != "TOKEN_INVALID" {
		t.Fatal(e)
	}
	for i := 0; i < 4; i++ {
		if e := a.ConsumeResetCode(ctx, "code@example.test", "000000", "bad-password"); fault.Code(e) != "TOKEN_INVALID" {
			t.Fatal(e)
		}
	}
	if e := a.ConsumeResetCode(ctx, "code@example.test", second, "bad-password"); fault.Code(e) != "TOKEN_INVALID" {
		t.Fatal(e)
	}
}
