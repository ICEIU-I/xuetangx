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
	if _, e = a.Connect(ctx, two, "primary", "csrftoken=secret"); fault.Code(e) != "ACCOUNT_BOUND" {
		t.Fatal(e)
	}
	if _, e = a.Connect(ctx, one, "test", "csrftoken=secret"); fault.Code(e) != "INVALID_INPUT" {
		t.Fatal(e)
	}
	if _, _, e = a.Credential(ctx, two, first.ID, 0); fault.Code(e) != "ACCOUNT_REQUIRED" {
		t.Fatal(e)
	}
	var cipher []byte
	s.Pool.QueryRow(ctx, "SELECT ciphertext FROM platform_credentials").Scan(&cipher)
	if strings.Contains(string(cipher), "private") {
		t.Fatal("plaintext stored")
	}
	if e = a.Disconnect(ctx, one, "primary"); e != nil {
		t.Fatal(e)
	}
	if _, _, e = a.Credential(ctx, one, first.ID, 0); fault.Code(e) != "ACCOUNT_REQUIRED" {
		t.Fatal("disconnect kept credentials", e)
	}
}
