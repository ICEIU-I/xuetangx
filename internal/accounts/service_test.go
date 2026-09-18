package accounts_test

import (
	"context"
	"encoding/base64"
	"github.com/google/uuid"
	"strings"
	"testing"
	"xuetangx/internal/accounts"
	"xuetangx/internal/fault"
	"xuetangx/internal/secure"
	"xuetangx/internal/testkit"
)

func TestAccountOwnershipEncryptionAndRoles(t *testing.T) {
	s := testkit.Database(t)
	ctx := context.Background()
	one, two := uuid.NewString(), uuid.NewString()
	for i, id := range []string{one, two} {
		_, e := s.Pool.Exec(ctx, "INSERT INTO users(id,email,password_hash,verified) VALUES($1,$2,'hash',true)", id, []string{"one@example.test", "two@example.test"}[i])
		if e != nil {
			t.Fatal(e)
		}
	}
	keys := &secure.Keys{Active: "k", Values: map[string]string{"k": base64.StdEncoding.EncodeToString([]byte(strings.Repeat("b", 32)))}}
	a := accounts.New(s, keys, func(context.Context, string) (int64, string, error) { return 123, "Student", nil })
	first, e := a.Connect(ctx, one, "primary", "csrftoken=secret; sessionid=private")
	if e != nil {
		t.Fatal(e)
	}
	second, e := a.Connect(ctx, two, "primary", "csrftoken=second")
	if e != nil || second.ID == first.ID || second.UserID != first.UserID {
		t.Fatal("independent binding failed", second, e)
	}
	firstAgain, e := a.Connect(ctx, one, "primary", "csrftoken=updated")
	if e != nil || firstAgain.ID != first.ID || firstAgain.Revision <= first.Revision {
		t.Fatal("reconnect did not reuse own binding", firstAgain, e)
	}
	for _, binding := range []struct{ owner, id, cookie string }{{one, first.ID, "csrftoken=updated"}, {two, second.ID, "csrftoken=second"}} {
		if _, cookie, err := a.Credential(ctx, binding.owner, binding.id, 0); err != nil || cookie != binding.cookie {
			t.Fatal("credentials were overwritten", err)
		}
	}
	if _, e = a.Connect(ctx, one, "test", "csrftoken=secret"); fault.Code(e) != "INVALID_INPUT" {
		t.Fatal(e)
	}
	if _, _, e = a.Credential(ctx, two, first.ID, 0); fault.Code(e) != "ACCOUNT_REQUIRED" {
		t.Fatal(e)
	}
	var cipher []byte
	if e = s.Pool.QueryRow(ctx, "SELECT ciphertext FROM platform_credentials WHERE account_id=$1", second.ID).Scan(&cipher); e != nil {
		t.Fatal(e)
	}
	if strings.Contains(string(cipher), "csrftoken") || strings.Contains(string(cipher), "second") {
		t.Fatal("plaintext stored")
	}
	if e = a.Disconnect(ctx, one, "primary"); e != nil {
		t.Fatal(e)
	}
	if _, _, e = a.Credential(ctx, one, first.ID, 0); fault.Code(e) != "ACCOUNT_REQUIRED" {
		t.Fatal("disconnect kept credentials", e)
	}
	if _, cookie, err := a.Credential(ctx, two, second.ID, second.Revision); err != nil || cookie != "csrftoken=second" {
		t.Fatal("disconnect affected another user", err)
	}
	if _, e = s.Pool.Exec(ctx, "INSERT INTO platform_accounts(id,owner_id,platform_user_id) VALUES($1,$2,123)", uuid.NewString(), two); e == nil {
		t.Fatal("duplicate binding within one user accepted")
	}
}

func TestConcurrentIdentityBindings(t *testing.T) {
	for _, shared := range []bool{false, true} {
		t.Run(map[bool]string{false: "two_private_users", true: "private_and_collector"}[shared], func(t *testing.T) {
			db := testkit.Database(t)
			ctx := context.Background()
			one, two := uuid.NewString(), uuid.NewString()
			for _, id := range []string{one, two} {
				if _, err := db.Pool.Exec(ctx, "INSERT INTO users(id,email,password_hash,verified,admin) VALUES($1,$2,'hash',true,true)", id, id+"@example.test"); err != nil {
					t.Fatal(err)
				}
			}
			keys := &secure.Keys{Active: "k", Values: map[string]string{"k": base64.StdEncoding.EncodeToString([]byte(strings.Repeat("b", 32)))}}
			ready, start := make(chan struct{}, 2), make(chan struct{})
			authenticate := func(context.Context, string) (int64, string, error) {
				ready <- struct{}{}
				<-start
				return 123, "Student", nil
			}
			first, second := accounts.New(db, keys, authenticate), accounts.New(db, keys, authenticate)
			results := make(chan error, 2)
			go func() { _, err := first.Connect(ctx, one, "primary", "csrftoken=one"); results <- err }()
			go func() {
				if shared {
					results <- second.SaveCollector(ctx, two, "", "", "csrftoken=two")
				} else {
					_, err := second.Connect(ctx, two, "primary", "csrftoken=two")
					results <- err
				}
			}()
			<-ready
			<-ready
			close(start)
			successes := 0
			for i := 0; i < 2; i++ {
				if err := <-results; err == nil {
					successes++
				} else if !shared || fault.Code(err) != "ACCOUNT_BOUND" {
					t.Fatal(err)
				}
			}
			want := 2
			if shared {
				want = 1
			}
			var count int
			if err := db.Pool.QueryRow(ctx, "SELECT count(*) FROM platform_accounts WHERE platform_user_id=123").Scan(&count); err != nil || successes != want || count != want {
				t.Fatal("concurrent identity policy failed", count, successes, err)
			}
		})
	}
}
