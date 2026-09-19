package auth_test

import (
	"context"
	"encoding/base64"
	"strings"
	"sync"
	"testing"

	"github.com/google/uuid"
	"xuetangx/internal/auth"
	"xuetangx/internal/fault"
	"xuetangx/internal/mail"
	"xuetangx/internal/secure"
	"xuetangx/internal/testkit"
)

func TestRegistrationCodePolicyAndLifecycle(t *testing.T) {
	db := testkit.Database(t)
	ctx := context.Background()
	keys := &secure.Keys{Active: "k", Values: map[string]string{"k": base64.StdEncoding.EncodeToString([]byte(strings.Repeat("a", 32)))}}
	box := &inbox{}
	q := &mail.Queue{DB: db, Keys: keys, Sender: box}
	a := auth.New(db, q, "https://example.test")
	check := func(err error) {
		t.Helper()
		if err != nil {
			t.Fatal(err)
		}
	}
	send := func(email string) string {
		t.Helper()
		check(a.RequestRegistrationCode(ctx, email))
		check(q.Tick(ctx))
		return resetCode(box.body)
	}
	age := func(email string) {
		t.Helper()
		_, err := db.Pool.Exec(ctx, "UPDATE registration_challenges SET sent_at=now()-interval '61 seconds' WHERE email=$1", email)
		check(err)
	}
	countUsers := func(email string) int {
		t.Helper()
		var count int
		check(db.Pool.QueryRow(ctx, "SELECT count(*) FROM users WHERE email=$1", email).Scan(&count))
		return count
	}
	required, err := a.RegistrationVerificationRequired(ctx)
	check(err)
	if !required {
		t.Fatal("verification not default-on")
	}
	if fault.Code(a.Register(ctx, "new@example.test", "x", "")) != "EMAIL_CODE_REQUIRED" {
		t.Fatal("code bypass accepted")
	}
	code := send(" New@Example.test ")
	if countUsers("new@example.test") != 0 {
		t.Fatal("code issuance created an account before verification")
	}
	if fault.Code(a.RequestRegistrationCode(ctx, "NEW@example.test")) != "RATE_LIMITED" {
		t.Fatal("resend cooldown ignored")
	}
	a = auth.New(db, q, "https://example.test")
	if fault.Code(a.RequestRegistrationCode(ctx, "new@example.test")) != "RATE_LIMITED" {
		t.Fatal("cooldown lost on restart")
	}
	if a.Register(ctx, "other@example.test", "x", code) == nil {
		t.Fatal("code worked for another mailbox")
	}
	check(a.Register(ctx, "NEW@example.test", "new-password", code))
	login, err := a.Login(ctx, "new@example.test", "new-password")
	check(err)
	if login.User.Admin || !login.User.Verified {
		t.Fatal("wrong registration privileges")
	}
	if a.Register(ctx, "new@example.test", "attacker-password", code) == nil {
		t.Fatal("code replay accepted")
	}
	check(a.RequestRegistrationCode(ctx, "new@example.test"))
	check(q.Tick(ctx))
	_, err = a.Login(ctx, "new@example.test", "new-password")
	check(err)
	if _, err = a.Login(ctx, "new@example.test", "attacker-password"); err == nil {
		t.Fatal("existing password overwritten")
	}

	locked := send("locked@example.test")
	wrong := "000000"
	if wrong == locked {
		wrong = "000001"
	}
	for i := 0; i < 5; i++ {
		if fault.Code(a.Register(ctx, "locked@example.test", "x", wrong)) != "CODE_INVALID" {
			t.Fatal("wrong code accepted")
		}
	}
	var attempts int
	var used bool
	check(db.Pool.QueryRow(ctx, "SELECT attempts,used_at IS NOT NULL FROM registration_challenges WHERE email='locked@example.test'").Scan(&attempts, &used))
	if attempts != 5 || !used || a.Register(ctx, "locked@example.test", "x", locked) == nil {
		t.Fatal("attempt lockout not durable")
	}
	if countUsers("locked@example.test") != 0 {
		t.Fatal("failed attempt created account")
	}

	old := send("resend@example.test")
	age("resend@example.test")
	fresh := send("resend@example.test")
	if old != fresh && a.Register(ctx, "resend@example.test", "x", old) == nil {
		t.Fatal("old code remained valid")
	}
	_, err = db.Pool.Exec(ctx, "UPDATE registration_challenges SET expires_at=now()-interval '1 second' WHERE email='resend@example.test'")
	check(err)
	if a.Register(ctx, "resend@example.test", "x", fresh) == nil {
		t.Fatal("expired code accepted")
	}

	_ = send("limited@example.test")
	for i := 0; i < 4; i++ {
		age("limited@example.test")
		_ = send("limited@example.test")
	}
	age("limited@example.test")
	if fault.Code(a.RequestRegistrationCode(ctx, "limited@example.test")) != "RATE_LIMITED" {
		t.Fatal("per-mailbox hourly limit ignored")
	}

	rotated := send("rotate@example.test")
	keys.Values["next"] = base64.StdEncoding.EncodeToString([]byte(strings.Repeat("b", 32)))
	keys.Active = "next"
	check(a.Register(ctx, "rotate@example.test", "x", rotated))

	adminID := uuid.NewString()
	_, err = db.Pool.Exec(ctx, "INSERT INTO users(id,email,password_hash,admin,verified) VALUES($1,'admin@example.test','unused',true,true)", adminID)
	check(err)
	if fault.Code(a.SetRegistrationVerification(ctx, login.User.ID, false)) != "FORBIDDEN" {
		t.Fatal("ordinary user changed policy")
	}
	check(a.SetRegistrationVerification(ctx, adminID, false))
	check(a.Register(ctx, "direct@example.test", "x", ""))
	if fault.Code(a.RequestRegistrationCode(ctx, "disabled@example.test")) != "REGISTRATION_VERIFICATION_DISABLED" {
		t.Fatal("sending while disabled")
	}
	a = auth.New(db, q, "https://example.test")
	required, err = a.RegistrationVerificationRequired(ctx)
	check(err)
	if required {
		t.Fatal("disabled setting lost on restart")
	}
	check(a.SetRegistrationVerification(ctx, adminID, true))
	if fault.Code(a.Register(ctx, "bypass@example.test", "x", "")) != "EMAIL_CODE_REQUIRED" {
		t.Fatal("stale client bypassed enabled policy")
	}
	if _, err = a.Login(ctx, "direct@example.test", "x"); err != nil {
		t.Fatal("existing user affected by policy change")
	}
}

func TestRegistrationConcurrentCodeConsumption(t *testing.T) {
	db := testkit.Database(t)
	ctx := context.Background()
	keys := &secure.Keys{Active: "k", Values: map[string]string{"k": base64.StdEncoding.EncodeToString([]byte(strings.Repeat("a", 32)))}}
	box := &inbox{}
	q := &mail.Queue{DB: db, Keys: keys, Sender: box}
	a := auth.New(db, q, "https://example.test")
	if err := a.RequestRegistrationCode(ctx, "race@example.test"); err != nil {
		t.Fatal(err)
	}
	if err := q.Tick(ctx); err != nil {
		t.Fatal(err)
	}
	code := resetCode(box.body)
	results := make(chan error, 2)
	var wg sync.WaitGroup
	for i := 0; i < 2; i++ {
		wg.Add(1)
		go func() { defer wg.Done(); results <- a.Register(ctx, "race@example.test", "x", code) }()
	}
	wg.Wait()
	close(results)
	successes := 0
	for err := range results {
		if err == nil {
			successes++
		}
	}
	if successes != 1 {
		t.Fatal("code consumption was not single-use", successes)
	}
}
