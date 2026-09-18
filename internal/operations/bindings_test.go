package operations_test

import (
	"context"
	"testing"

	"github.com/google/uuid"
	"xuetangx/internal/domain"
	"xuetangx/internal/fault"
	"xuetangx/internal/operations"
	"xuetangx/internal/platform"
	"xuetangx/internal/platform/wire"
	"xuetangx/internal/store"
	"xuetangx/internal/testkit"
)

func anotherBinding(t *testing.T, db *store.Store, first domain.Account) domain.Account {
	t.Helper()
	a := first
	a.ID, a.Owner = uuid.NewString(), uuid.NewString()
	ctx := context.Background()
	if _, e := db.Pool.Exec(ctx, "INSERT INTO users(id,email,password_hash,verified) VALUES($1,$2,'hash',true)", a.Owner, a.Owner+"@example.test"); e != nil {
		t.Fatal(e)
	}
	if _, e := db.Pool.Exec(ctx, "INSERT INTO platform_accounts(id,owner_id,platform_user_id,role,valid) VALUES($1,$2,$3,'primary',true)", a.ID, a.Owner, a.UserID); e != nil {
		t.Fatal(e)
	}
	return a
}

func TestBindingsShareRetryJournalWithoutReassigningOwnership(t *testing.T) {
	db := testkit.Database(t)
	a, c := testkit.Seed(t, db)
	b := anotherBinding(t, db, a)
	ctx := context.Background()
	j := &operations.Journal{DB: db}
	key := operations.Key("question", a, c, 34, 78, "v1")
	r, err := j.Load(ctx, key, "question", a, c, 34, 78, "v1")
	if err != nil {
		t.Fatal(err)
	}
	if err = j.Save(ctx, &r, "pending", 2, true, nil); err != nil {
		t.Fatal(err)
	}
	if err = j.Save(ctx, &r, "unknown", 2, true, nil); err != nil {
		t.Fatal(err)
	}
	restarted := &operations.Journal{DB: db}
	shared, err := restarted.Load(ctx, key, "question", b, c, 34, 78, "v1")
	if err != nil || shared.ID != r.ID || shared.Retries != 2 || shared.Attempt != 1 || shared.State != "unknown" {
		t.Fatal("retry journal reset across bindings", shared, err)
	}
	if err = restarted.Save(ctx, &shared, "confirmed", 2, false, wire.Object{"is_correct": true}); err != nil {
		t.Fatal(err)
	}
	if err = j.Save(ctx, &r, "pending", 2, true, nil); fault.Code(err) != "OPERATION_CONFLICT" {
		t.Fatal("stale binding overwrote confirmed operation", err)
	}
	var owner, account string
	if err = db.Pool.QueryRow(ctx, "SELECT owner_id,account_id FROM operations WHERE id=$1", r.ID).Scan(&owner, &account); err != nil || owner != a.Owner || account != a.ID {
		t.Fatal("audit ownership was changed", err)
	}
	for _, invalid := range []domain.Account{{ID: b.ID, Owner: a.Owner, UserID: a.UserID}, {ID: b.ID, Owner: b.Owner, UserID: 999}} {
		if _, err = j.Load(ctx, key, "question", invalid, c, 34, 78, "v1"); fault.Code(err) != "ACCOUNT_REQUIRED" {
			t.Fatal("forged identity accepted", err)
		}
	}
	current, err := j.Load(ctx, operations.Key("question", b, c, 34, 78, "v2"), "question", b, c, 34, 78, "v2")
	if err != nil {
		t.Fatal(err)
	}
	if err = j.PreserveLegacy(ctx, &current, b, c, 34, 78, []string{"v1"}); err != nil || current.State != "confirmed" || current.Retries != 2 {
		t.Fatal("legacy journal lost across bindings", current, err)
	}
}

func TestEffectIsNotRepeatedByAnotherBinding(t *testing.T) {
	db := testkit.Database(t)
	a, c := testkit.Seed(t, db)
	b := anotherBinding(t, db, a)
	writes := 0
	call := func(context.Context, domain.Account, string, string, any) (platform.Response, error) {
		writes++
		return platform.Response{Status: 200, JSON: wire.Object{"success": true, "data": wire.Object{"id": 123}}}, nil
	}
	for _, account := range []domain.Account{a, b} {
		op := operations.New(&operations.Journal{DB: db}, nil, nil, call)
		if _, err := op.Effect(context.Background(), account, c, 34, "discussion", "", "POST", "/mock", nil); err != nil {
			t.Fatal(err)
		}
	}
	if writes != 1 {
		t.Fatal("repeated platform write", writes)
	}
}
