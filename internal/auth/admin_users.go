package auth

import (
	"context"
	"github.com/jackc/pgx/v5"
	"xuetangx/internal/fault"
	"xuetangx/internal/secure"
)

func (s *Service) UpdateUser(ctx context.Context, actor, target string, email, password *string) error {
	var hash string
	if email != nil {
		v, e := Email(*email)
		if e != nil {
			return e
		}
		email = &v
	}
	if password != nil {
		v, e := secure.Password(*password)
		if e != nil {
			return fault.New("INVALID_INPUT", e.Error())
		}
		hash = v
	}
	return s.DB.Tx(ctx, func(tx pgx.Tx) error {
		var allowed bool
		if e := tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM users WHERE id=$1 AND admin AND NOT disabled)`, actor).Scan(&allowed); e != nil {
			return e
		}
		if !allowed {
			return fault.New("FORBIDDEN", "需要管理员权限")
		}
		var isAdmin bool
		e := tx.QueryRow(ctx, `SELECT admin FROM users WHERE id=$1 FOR UPDATE`, target).Scan(&isAdmin)
		if e == pgx.ErrNoRows {
			return fault.New("NOT_FOUND", "用户不存在")
		}
		if e != nil {
			return e
		}
		if isAdmin {
			return fault.New("INVALID_INPUT", "请在账号设置中修改管理员个人信息")
		}
		if email != nil {
			var exists bool
			if e = tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM users WHERE lower(email)=lower($1) AND id<>$2)`, *email, target).Scan(&exists); e != nil {
				return e
			}
			if exists {
				return fault.New("INVALID_INPUT", "该邮箱已被使用")
			}
			if _, e = tx.Exec(ctx, `UPDATE users SET email=$2 WHERE id=$1`, target, *email); e != nil {
				return e
			}
		}
		if password != nil {
			if _, e = tx.Exec(ctx, `UPDATE users SET password_hash=$2 WHERE id=$1`, target, hash); e != nil {
				return e
			}
		}
		if _, e = tx.Exec(ctx, `DELETE FROM sessions WHERE user_id=$1`, target); e != nil {
			return e
		}
		_, e = tx.Exec(ctx, `UPDATE auth_tokens SET used_at=now() WHERE user_id=$1 AND used_at IS NULL`, target)
		return e
	})
}
