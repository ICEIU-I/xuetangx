package auth

import (
	"context"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"time"
	"xuetangx/internal/fault"
	"xuetangx/internal/secure"
)

func (s *Service) Bootstrap(ctx context.Context, email, password string) error {
	email, e := Email(email)
	if e != nil {
		return e
	}
	hash, e := secure.Password(password)
	if e != nil {
		return e
	}
	_, e = s.DB.Pool.Exec(ctx, "INSERT INTO users(id,email,password_hash,verified,admin) VALUES($1,$2,$3,true,true)", uuid.NewString(), email, hash)
	return e
}
func (s *Service) Disable(ctx context.Context, admin, target string, disabled bool) error {
	if admin == target {
		return fault.New("INVALID_INPUT", "不能禁用当前管理员")
	}
	e := s.DB.Tx(ctx, func(tx pgx.Tx) error {
		tag, e := tx.Exec(ctx, "UPDATE users SET disabled=$2 WHERE id=$1", target, disabled)
		if e != nil {
			return e
		}
		if tag.RowsAffected() == 0 {
			return fault.New("NOT_FOUND", "用户不存在")
		}
		if disabled {
			if _, e = tx.Exec(ctx, "DELETE FROM sessions WHERE user_id=$1", target); e != nil {
				return e
			}
			_, e = tx.Exec(ctx, "UPDATE auth_tokens SET used_at=now() WHERE user_id=$1 AND used_at IS NULL", target)
		}
		return e
	})
	if e == nil && disabled && s.OnDisabled != nil {
		s.OnDisabled(target)
	}
	return e
}
func (s *Service) CreateToken(ctx context.Context, owner, name string) (string, error) {
	if len(name) > 100 {
		return "", fault.New("INVALID_INPUT", "令牌名称过长")
	}
	token := secure.Token()
	_, e := s.DB.Pool.Exec(ctx, `INSERT INTO auth_tokens(token_hash,user_id,kind,name,expires_at) SELECT $1,id,'api',$3,$4 FROM users WHERE id=$2 AND verified AND NOT disabled`, secure.Hash(token), owner, name, time.Now().Add(90*24*time.Hour))
	return token, e
}
func (s *Service) RevokeToken(ctx context.Context, owner, hash string) error {
	_, e := s.DB.Pool.Exec(ctx, "UPDATE auth_tokens SET used_at=now() WHERE token_hash=$1 AND user_id=$2 AND kind='api'", hash, owner)
	return e
}
