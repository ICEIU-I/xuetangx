package mail

import (
	"context"
	"encoding/base64"
	"strings"
	"testing"

	"github.com/jackc/pgx/v5"
	"xuetangx/internal/secure"
	"xuetangx/internal/testkit"
)

type plainInbox struct{ plain string }

func (i *plainInbox) Send(_ context.Context, _, _, body string) error { i.plain = body; return nil }

type richInbox struct {
	plainInbox
	html string
}

func (i *richInbox) SendRich(_ context.Context, _, _, plain, html string) error {
	i.plain = plain
	i.html = html
	return nil
}

func TestQueueRichAndLegacyBodies(t *testing.T) {
	db := testkit.Database(t)
	keys := &secure.Keys{Active: "test", Values: map[string]string{"test": base64.StdEncoding.EncodeToString([]byte(strings.Repeat("a", 32)))}}
	ctx := context.Background()
	plain, rich := &plainInbox{}, &richInbox{}
	for _, sender := range []Sender{plain, rich} {
		q := &Queue{DB: db, Keys: keys, Sender: sender}
		subject, text, html, err := ResetCode("123456")
		if err != nil {
			t.Fatal(err)
		}
		err = db.Tx(ctx, func(tx pgx.Tx) error { return q.EnqueueHTML(ctx, tx, "user@example.test", subject, text, html) })
		if err != nil {
			t.Fatal(err)
		}
		var encrypted []byte
		if err = db.Pool.QueryRow(ctx, "SELECT encrypted_body FROM mail_outbox WHERE sent_at IS NULL").Scan(&encrypted); err != nil {
			t.Fatal(err)
		}
		if strings.Contains(string(encrypted), "123456") {
			t.Fatal("outbox leaked code")
		}
		if err = q.Tick(ctx); err != nil {
			t.Fatal(err)
		}
		if sender == plain && plain.plain != text {
			t.Fatal("fallback missing")
		}
		if sender == rich && (rich.plain != text || rich.html != html) {
			t.Fatal("HTML not sent")
		}
		var pending, retained int
		if err = db.Pool.QueryRow(ctx, "SELECT count(*) FILTER (WHERE sent_at IS NULL),count(*) FILTER (WHERE length(encrypted_body)>0) FROM mail_outbox").Scan(&pending, &retained); err != nil || pending != 0 || retained != 0 {
			t.Fatal("outbox not cleared")
		}
		err = db.Tx(ctx, func(tx pgx.Tx) error { return q.Enqueue(ctx, tx, "user@example.test", "Legacy", "original plaintext") })
		if err != nil {
			t.Fatal(err)
		}
		if err = q.Tick(ctx); err != nil {
			t.Fatal(err)
		}
		if sender == plain && plain.plain != "original plaintext" {
			t.Fatal("legacy plaintext changed")
		}
		if sender == rich && rich.plain != "original plaintext" {
			t.Fatal("legacy plaintext changed")
		}
	}
}
