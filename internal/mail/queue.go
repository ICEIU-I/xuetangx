package mail

import (
	"context"
	"fmt"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"time"
	"xuetangx/internal/secure"
	"xuetangx/internal/store"
)

type Sender interface {
	Send(context.Context, string, string, string) error
}
type Queue struct {
	DB     *store.Store
	Keys   *secure.Keys
	Sender Sender
}

func (q *Queue) Enqueue(ctx context.Context, tx pgx.Tx, to, subject, body string) error {
	id := uuid.NewString()
	sealed, e := q.Keys.Seal("mail:"+id, body)
	if e != nil {
		return e
	}
	_, e = tx.Exec(ctx, "INSERT INTO mail_outbox(id,recipient,subject,encrypted_body,nonce,key_id) VALUES($1,$2,$3,$4,$5,$6)", id, to, subject, sealed.Ciphertext, sealed.Nonce, sealed.KeyID)
	return e
}
func (q *Queue) Tick(ctx context.Context) error {
	var id, to, subject, key string
	var body, nonce []byte
	var attempts int
	e := q.DB.Pool.QueryRow(ctx, `WITH next AS (SELECT id FROM mail_outbox WHERE sent_at IS NULL AND available_at<=now() AND (lease_until IS NULL OR lease_until<now()) AND attempts<10 ORDER BY available_at FOR UPDATE SKIP LOCKED LIMIT 1) UPDATE mail_outbox m SET lease_until=now()+interval '1 minute',attempts=attempts+1 FROM next WHERE m.id=next.id RETURNING m.id,m.recipient,m.subject,m.encrypted_body,m.nonce,m.key_id,m.attempts`).Scan(&id, &to, &subject, &body, &nonce, &key, &attempts)
	if e == pgx.ErrNoRows {
		return nil
	}
	if e != nil {
		return e
	}
	plain, e := q.Keys.Open("mail:"+id, secure.Sealed{KeyID: key, Nonce: nonce, Ciphertext: body})
	if e == nil {
		if q.Sender == nil {
			e = fmt.Errorf("SMTP unavailable")
		} else {
			e = q.Sender.Send(ctx, to, subject, plain)
		}
	}
	if e != nil {
		delay := time.Minute * time.Duration(1<<min(attempts, 6))
		_, saveErr := q.DB.Pool.Exec(ctx, "UPDATE mail_outbox SET lease_until=NULL,available_at=$2,last_error='SMTP delivery failed' WHERE id=$1", id, time.Now().Add(delay))
		return saveErr
	}
	_, e = q.DB.Pool.Exec(ctx, "UPDATE mail_outbox SET sent_at=now(),lease_until=NULL,encrypted_body=''::bytea,nonce=''::bytea WHERE id=$1", id)
	return e
}
func (q *Queue) Run(ctx context.Context) {
	ticker := time.NewTicker(time.Second)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			_ = q.Tick(ctx)
		}
	}
}
