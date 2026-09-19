package auth

import (
	"context"
	"crypto/rand"
	"crypto/subtle"
	"fmt"
	"math/big"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"xuetangx/internal/fault"
	mailer "xuetangx/internal/mail"
	"xuetangx/internal/secure"
)

// RequestRegistrationCode never creates a user or reserves their password.
func (s *Service) RequestRegistrationCode(ctx context.Context, email string) error {
	email, err := Email(email)
	if err != nil {
		return err
	}
	if s.Mail == nil || s.Mail.Keys == nil || s.Mail.Sender == nil {
		return fault.New("MAIL_UNAVAILABLE", "邮箱服务暂不可用")
	}
	number, err := rand.Int(rand.Reader, big.NewInt(1000000))
	if err != nil {
		return err
	}
	code := fmt.Sprintf("%06d", number.Int64())
	id := uuid.NewString()
	keyID := s.Mail.Keys.Active
	digest, err := s.Mail.Keys.MAC(keyID, "register:"+id+":"+email, code)
	if err != nil {
		return err
	}
	return s.DB.Tx(ctx, func(tx pgx.Tx) error {
		required, err := registrationPolicy(ctx, tx)
		if err != nil {
			return err
		}
		if !required {
			return fault.New("REGISTRATION_VERIFICATION_DISABLED", "注册邮箱验证已关闭，可直接注册")
		}
		var exists bool
		if err = tx.QueryRow(ctx, "SELECT EXISTS(SELECT 1 FROM users WHERE lower(email)=$1)", email).Scan(&exists); err != nil {
			return err
		}
		if exists {
			return nil
		}
		// Unique email + conditional upsert serializes concurrent sends, including
		// after process restarts. Resending replaces the old code, not the user.
		tag, err := tx.Exec(ctx, `INSERT INTO registration_challenges(email,id,code_hash,key_id,expires_at) VALUES($1,$2,$3,$4,$5)
   ON CONFLICT(email) DO UPDATE SET id=excluded.id,code_hash=excluded.code_hash,key_id=excluded.key_id,expires_at=excluded.expires_at,
    attempts=0,used_at=NULL,sent_at=now(),
    send_count=CASE WHEN registration_challenges.window_started_at<=now()-interval '1 hour' THEN 1 ELSE registration_challenges.send_count+1 END,
    window_started_at=CASE WHEN registration_challenges.window_started_at<=now()-interval '1 hour' THEN now() ELSE registration_challenges.window_started_at END
   WHERE registration_challenges.sent_at<=now()-interval '60 seconds'
    AND (registration_challenges.window_started_at<=now()-interval '1 hour' OR registration_challenges.send_count<5)`, email, id, digest, keyID, time.Now().Add(10*time.Minute))
		if err != nil {
			return err
		}
		if tag.RowsAffected() != 1 {
			return fault.New("RATE_LIMITED", "验证码发送过于频繁，请稍后再试")
		}
		subject, plain, html, err := mailer.RegistrationCode(code)
		if err != nil {
			return err
		}
		return s.Mail.EnqueueHTML(ctx, tx, email, subject, plain, html)
	})
}

// Register enforces the persisted policy, regardless of stale browser state.
// Only after proving mailbox ownership do we create the account/password.
func (s *Service) Register(ctx context.Context, email, password, code string) error {
	email, err := Email(email)
	if err != nil {
		return err
	}
	hash, err := secure.Password(password)
	if err != nil {
		return fault.New("INVALID_INPUT", err.Error())
	}
	var rejected error
	err = s.DB.Tx(ctx, func(tx pgx.Tx) error {
		required, err := registrationPolicy(ctx, tx)
		if err != nil {
			return err
		}
		if required {
			if code == "" {
				return fault.New("EMAIL_CODE_REQUIRED", "请输入注册邮箱验证码")
			}
			if len(code) != 6 {
				return invalidRegistrationCode()
			}
			for _, r := range code {
				if r < '0' || r > '9' {
					return invalidRegistrationCode()
				}
			}
			var id, expected, keyID string
			var attempts int
			err = tx.QueryRow(ctx, `SELECT id,code_hash,key_id,attempts FROM registration_challenges
    WHERE email=$1 AND used_at IS NULL AND expires_at>now() AND attempts<5 FOR UPDATE`, email).Scan(&id, &expected, &keyID, &attempts)
			if err == pgx.ErrNoRows {
				return invalidRegistrationCode()
			}
			if err != nil {
				return err
			}
			if s.Mail == nil || s.Mail.Keys == nil {
				return fault.New("MAIL_UNAVAILABLE", "邮箱服务暂不可用")
			}
			actual, err := s.Mail.Keys.MAC(keyID, "register:"+id+":"+email, code)
			if err != nil {
				return err
			}
			if subtle.ConstantTimeCompare([]byte(actual), []byte(expected)) != 1 {
				_, err = tx.Exec(ctx, "UPDATE registration_challenges SET attempts=attempts+1,used_at=CASE WHEN attempts+1>=5 THEN now() ELSE used_at END WHERE email=$1", email)
				if err != nil {
					return err
				}
				rejected = invalidRegistrationCode()
				return nil
			}
			if _, err = tx.Exec(ctx, "UPDATE registration_challenges SET used_at=now() WHERE email=$1", email); err != nil {
				return err
			}
		}
		tag, err := tx.Exec(ctx, "INSERT INTO users(id,email,password_hash,verified) VALUES($1,$2,$3,true) ON CONFLICT DO NOTHING", uuid.NewString(), email, hash)
		if err != nil {
			return err
		}
		if tag.RowsAffected() != 1 {
			return fault.New("EMAIL_REGISTERED", "该邮箱已注册，请登录")
		}
		// A direct registration also invalidates any code sent before the switch changed.
		_, err = tx.Exec(ctx, "UPDATE registration_challenges SET used_at=now() WHERE email=$1 AND used_at IS NULL", email)
		return err
	})
	if err != nil {
		return err
	}
	return rejected
}
func invalidRegistrationCode() error {
	return fault.New("CODE_INVALID", "验证码无效、已过期或尝试次数过多")
}
