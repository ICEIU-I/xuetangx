package accounts_test

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"github.com/google/uuid"
	"strings"
	"testing"
	"xuetangx/internal/accounts"
	"xuetangx/internal/fault"
	"xuetangx/internal/secure"
	"xuetangx/internal/testkit"
)

func TestSharedCollectorIsolationAndRevocation(t *testing.T) {
	db := testkit.Database(t)
	ctx := context.Background()
	admin, learner := uuid.NewString(), uuid.NewString()
	for i, id := range []string{admin, learner} {
		if _, err := db.Pool.Exec(ctx, `INSERT INTO users(id,email,password_hash,verified,admin) VALUES($1,$2,'hash',true,$3)`, id, id+"@example.test", i == 0); err != nil {
			t.Fatal(err)
		}
	}
	keys := &secure.Keys{Active: "k", Values: map[string]string{"k": base64.StdEncoding.EncodeToString([]byte(strings.Repeat("b", 32)))}}
	a := accounts.New(db, keys, func(context.Context, string) (int64, string, error) { return 202, "Collector", nil })
	secret := "csrftoken=secret; sessionid=private-value"
	if err := a.SaveCollector(ctx, learner, "", "", secret); fault.Code(err) != "FORBIDDEN" {
		t.Fatal(err)
	}
	if err := a.SaveCollector(ctx, admin, "", "Shared", secret); err != nil {
		t.Fatal(err)
	}
	all, err := a.ListCollectors(ctx, admin)
	if err != nil || len(all) != 1 {
		t.Fatal(all, err)
	}
	raw, _ := json.Marshal(all)
	if strings.Contains(string(raw), "secret") || strings.Contains(string(raw), "private-value") {
		t.Fatal("credential leaked")
	}
	if _, err = a.ListCollectors(ctx, learner); fault.Code(err) != "FORBIDDEN" {
		t.Fatal(err)
	}
	list, err := a.SharedCollectors(ctx, 101)
	if err != nil || len(list) != 1 {
		t.Fatal(list, err)
	}
	x := list[0]
	if !x.Shared || x.Owner != admin || x.Role != "test" {
		t.Fatal(x)
	}
	if _, _, err = a.Credential(ctx, learner, x.ID, x.Revision); fault.Code(err) != "ACCOUNT_REQUIRED" {
		t.Fatal("cross-owner secret", err)
	}
	if _, _, err = a.Credential(ctx, admin, x.ID, x.Revision); err != nil {
		t.Fatal(err)
	}
	if _, err = a.Connect(ctx, learner, "primary", secret); fault.Code(err) != "ACCOUNT_BOUND" {
		t.Fatal(err)
	}
	if err = a.EnableCollector(ctx, admin, x.ID, false); err != nil {
		t.Fatal(err)
	}
	if _, _, err = a.Credential(ctx, admin, x.ID, x.Revision); fault.Code(err) != "ACCOUNT_REQUIRED" {
		t.Fatal(err)
	}
	list, err = a.SharedCollectors(ctx, 0)
	if err != nil || len(list) != 0 {
		t.Fatal(list, err)
	}
	var cipher []byte
	if err = db.Pool.QueryRow(ctx, "SELECT ciphertext FROM platform_credentials WHERE account_id=$1", x.ID).Scan(&cipher); err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(cipher), "private-value") {
		t.Fatal("plaintext persisted")
	}
}
