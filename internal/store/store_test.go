package store_test

import (
	"context"
	"errors"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"testing"
	"xuetangx/internal/testkit"
)

func TestTransactionsAndIdentityConstraints(t *testing.T) {
	s := testkit.Database(t)
	ctx := context.Background()
	id := uuid.NewString()
	e := s.Tx(ctx, func(tx pgx.Tx) error {
		_, e := tx.Exec(ctx, "INSERT INTO users(id,email,password_hash) VALUES($1,'test@example.com','hash')", id)
		if e != nil {
			return e
		}
		return errors.New("rollback")
	})
	if e == nil {
		t.Fatal("expected rollback")
	}
	var n int
	s.Pool.QueryRow(ctx, "SELECT count(*) FROM users").Scan(&n)
	if n != 0 {
		t.Fatal("transaction leaked")
	}
	_, e = s.Pool.Exec(ctx, "INSERT INTO users(id,email,password_hash) VALUES($1,'test@example.com','hash')", id)
	if e != nil {
		t.Fatal(e)
	}
	_, e = s.Pool.Exec(ctx, "INSERT INTO users(id,email,password_hash) VALUES($1,'TEST@example.com','hash')", uuid.NewString())
	if e == nil {
		t.Fatal("case insensitive email collision accepted")
	}
}
