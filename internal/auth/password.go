package auth

import (
	"context"
	"github.com/jackc/pgx/v5"
	"xuetangx/internal/fault"
	"xuetangx/internal/secure"
)

// ChangePassword requires the current password and revokes all sessions and CLI tokens.
func (s *Service) ChangePassword(ctx context.Context, owner, current, replacement string) error {
	var old string
	if e := s.DB.Pool.QueryRow(ctx, "SELECT password_hash FROM users WHERE id=$1 AND NOT disabled", owner).Scan(&old); e != nil {
		return fault.New("AUTH_REQUIRED", "请重新登录")
	}
	if !secure.CheckPassword(current, old) {
		return fault.New("INVALID_INPUT", "当前密码不正确")
	}
	hash, e := secure.Password(replacement)
	if e != nil {
		return fault.New("INVALID_INPUT", e.Error())
	}
	return s.DB.Tx(ctx, func(tx pgx.Tx) error {
		tag, e := tx.Exec(ctx, "UPDATE users SET password_hash=$2 WHERE id=$1 AND password_hash=$3 AND NOT disabled", owner, hash, old)
		if e != nil {
			return e
		}
		if tag.RowsAffected() != 1 {
			return fault.New("AUTH_REQUIRED", "账号状态已变化，请重新登录")
		}
		if _, e = tx.Exec(ctx, "DELETE FROM sessions WHERE user_id=$1", owner); e != nil {
			return e
		}
		_, e = tx.Exec(ctx, "UPDATE auth_tokens SET used_at=now() WHERE user_id=$1 AND used_at IS NULL", owner)
		return e
	})
}
