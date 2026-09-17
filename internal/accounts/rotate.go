package accounts

import (
	"context"
	"github.com/jackc/pgx/v5"
	"xuetangx/internal/secure"
)

func (s *Service) Rotate(ctx context.Context) error {
	return s.DB.Tx(ctx, func(tx pgx.Tx) error {
		rows, e := tx.Query(ctx, `SELECT c.account_id,a.owner_id,c.key_id,c.nonce,c.ciphertext FROM platform_credentials c JOIN platform_accounts a ON a.id=c.account_id FOR UPDATE OF c`)
		if e != nil {
			return e
		}
		type row struct {
			id, owner string
			sealed    secure.Sealed
		}
		var all []row
		for rows.Next() {
			var r row
			if e = rows.Scan(&r.id, &r.owner, &r.sealed.KeyID, &r.sealed.Nonce, &r.sealed.Ciphertext); e != nil {
				rows.Close()
				return e
			}
			all = append(all, r)
		}
		e = rows.Err()
		rows.Close()
		if e != nil {
			return e
		}
		for _, r := range all {
			p, e := s.Keys.Open(r.owner+":"+r.id, r.sealed)
			if e != nil {
				return e
			}
			v, e := s.Keys.Seal(r.owner+":"+r.id, p)
			if e != nil {
				return e
			}
			if _, e = tx.Exec(ctx, "UPDATE platform_credentials SET key_id=$2,nonce=$3,ciphertext=$4,updated_at=now() WHERE account_id=$1", r.id, v.KeyID, v.Nonce, v.Ciphertext); e != nil {
				return e
			}
		}
		return nil
	})
}
