package auth

import (
	"context"
	"crypto/rand"
	"fmt"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"math/big"
	"net/mail"
	"strings"
	"time"
	"xuetangx/internal/domain"
	"xuetangx/internal/fault"
	mailer "xuetangx/internal/mail"
	"xuetangx/internal/secure"
	"xuetangx/internal/store"
	"xuetangx/internal/store/dbgen"
)

type Service struct {
	DB                       *store.Store
	Mail                     *mailer.Queue
	BaseURL                  string
	OnDisabled               func(string)
	RequireEmailVerification bool
	dummy                    string
}
type Login struct {
	User  domain.User `json:"user"`
	Token string      `json:"-"`
	CSRF  string      `json:"csrf"`
}
type Principal struct {
	User                domain.User
	TokenHash, CSRFHash string
	Bearer              bool
}

func New(db *store.Store, m *mailer.Queue, base string) *Service {
	dummy, _ := secure.Password(secure.Token())
	return &Service{DB: db, Mail: m, BaseURL: base, dummy: dummy, RequireEmailVerification: true}
}
func Email(v string) (string, error) {
	v = strings.ToLower(strings.TrimSpace(v))
	p, e := mail.ParseAddress(v)
	if e != nil || p.Address != v || len(v) > 254 {
		return "", fault.New("INVALID_INPUT", "邮箱格式无效")
	}
	return v, nil
}
func (s *Service) Register(ctx context.Context, email, password string) error {
	email, e := Email(email)
	if e != nil {
		return e
	}
	hash, e := secure.Password(password)
	if e != nil {
		return fault.New("INVALID_INPUT", e.Error())
	}
	return s.DB.Tx(ctx, func(tx pgx.Tx) error {
		id := uuid.NewString()
		tag, e := tx.Exec(ctx, "INSERT INTO users(id,email,password_hash,verified) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING", id, email, hash, !s.RequireEmailVerification)
		if e != nil {
			return e
		}
		if tag.RowsAffected() == 0 {
			if !s.RequireEmailVerification {
				return fault.New("EMAIL_REGISTERED", "该邮箱已注册，请登录")
			}
			return nil
		}
		if !s.RequireEmailVerification {
			return nil
		}
		return s.issue(ctx, tx, id, email, "verify")
	})
}
func (s *Service) issue(ctx context.Context, tx pgx.Tx, id, email, kind string) error {
	token := secure.Token()
	_, e := tx.Exec(ctx, "UPDATE auth_tokens SET used_at=now() WHERE user_id=$1 AND kind=$2 AND used_at IS NULL", id, kind)
	if e != nil {
		return e
	}
	_, e = tx.Exec(ctx, "INSERT INTO auth_tokens(token_hash,user_id,kind,expires_at) VALUES($1,$2,$3,$4)", secure.Hash(token), id, kind, time.Now().Add(30*time.Minute))
	if e != nil {
		return e
	}
	title := "Verify your email"
	if kind == "reset" {
		title = "Reset your password"
	}
	return s.Mail.Enqueue(ctx, tx, email, title, s.BaseURL+"/#"+kind+"="+token+"\nThis single-use link expires in 30 minutes.")
}
func (s *Service) RequestEmail(ctx context.Context, email, kind string) error {
	if kind != "verify" && kind != "reset" {
		return fault.New("INVALID_INPUT", "操作无效")
	}
	email, e := Email(email)
	if e != nil {
		return e
	}
	return s.DB.Tx(ctx, func(tx pgx.Tx) error {
		var id string
		var verified, disabled bool
		e := tx.QueryRow(ctx, "SELECT id,verified,disabled FROM users WHERE lower(email)=$1 FOR UPDATE", email).Scan(&id, &verified, &disabled)
		if e == pgx.ErrNoRows {
			return nil
		}
		if e != nil {
			return e
		}
		if disabled || (kind == "verify" && verified) {
			return nil
		}
		return s.issue(ctx, tx, id, email, kind)
	})
}

// RequestResetCode issues a short-lived, single-use numeric password-reset
// code. The plaintext code is only placed in the encrypted mail outbox and is
// never returned to the caller or written to logs.
func (s *Service) RequestResetCode(ctx context.Context, email string) error {
	email, e := Email(email)
	if e != nil {
		return e
	}
	codeNumber, e := rand.Int(rand.Reader, big.NewInt(1000000))
	if e != nil {
		return e
	}
	code := fmt.Sprintf("%06d", codeNumber.Int64())
	return s.DB.Tx(ctx, func(tx pgx.Tx) error {
		var id string
		var disabled bool
		e := tx.QueryRow(ctx, "SELECT id,disabled FROM users WHERE lower(email)=$1 FOR UPDATE", email).Scan(&id, &disabled)
		if e == pgx.ErrNoRows {
			return nil
		}
		if e != nil {
			return e
		}
		if disabled {
			return nil
		}
		if _, e = tx.Exec(ctx, "UPDATE auth_challenges SET used_at=now() WHERE user_id=$1 AND kind='reset' AND used_at IS NULL", id); e != nil {
			return e
		}
		challengeID := uuid.NewString()
		if _, e = tx.Exec(ctx, "INSERT INTO auth_challenges(id,user_id,kind,code_hash,expires_at) VALUES($1,$2,'reset',$3,$4)", challengeID, id, secure.Hash(code), time.Now().Add(10*time.Minute)); e != nil {
			return e
		}
		subject, plain, html, e := mailer.ResetCode(code)
		if e != nil {
			return e
		}
		return s.Mail.EnqueueHTML(ctx, tx, email, subject, plain, html)
	})
}

// ConsumeResetCode verifies and consumes a reset code, then changes the
// password in the same transaction. Five incorrect attempts permanently
// invalidate the challenge.
func (s *Service) ConsumeResetCode(ctx context.Context, email, code, password string) error {
	email, e := Email(email)
	if e != nil || len(code) != 6 {
		return fault.New("TOKEN_INVALID", "验证码无效或已过期")
	}
	for _, r := range code {
		if r < '0' || r > '9' {
			return fault.New("TOKEN_INVALID", "验证码无效或已过期")
		}
	}
	hash, e := secure.Password(password)
	if e != nil {
		return fault.New("INVALID_INPUT", e.Error())
	}
	var rejected error
	err := s.DB.Tx(ctx, func(tx pgx.Tx) error {
		var challengeID, userID, expected string
		var attempts int
		e := tx.QueryRow(ctx, `SELECT c.id,c.user_id,c.code_hash,c.attempts FROM auth_challenges c JOIN users u ON u.id=c.user_id WHERE lower(u.email)=$1 AND c.kind='reset' AND c.used_at IS NULL AND c.expires_at>now() AND NOT u.disabled ORDER BY c.created_at DESC LIMIT 1 FOR UPDATE`, email).Scan(&challengeID, &userID, &expected, &attempts)
		if e == pgx.ErrNoRows {
			return fault.New("TOKEN_INVALID", "验证码无效或已过期")
		}
		if e != nil {
			return e
		}
		if expected != secure.Hash(code) {
			attempts++
			_, e = tx.Exec(ctx, "UPDATE auth_challenges SET attempts=$2,used_at=CASE WHEN $2>=5 THEN now() ELSE used_at END WHERE id=$1", challengeID, attempts)
			if e != nil {
				return e
			}
			// Returning the rejection from the callback would roll back the
			// attempt counter, allowing unlimited guesses. Commit it first.
			rejected = fault.New("TOKEN_INVALID", "验证码无效或已过期")
			return nil
		}
		if _, e = tx.Exec(ctx, "UPDATE auth_challenges SET used_at=now() WHERE id=$1", challengeID); e != nil {
			return e
		}
		if _, e = tx.Exec(ctx, "UPDATE users SET password_hash=$2 WHERE id=$1 AND NOT disabled", userID, hash); e != nil {
			return e
		}
		if _, e = tx.Exec(ctx, "DELETE FROM sessions WHERE user_id=$1", userID); e != nil {
			return e
		}
		_, e = tx.Exec(ctx, "UPDATE auth_tokens SET used_at=now() WHERE user_id=$1 AND used_at IS NULL", userID)
		return e
	})
	if err != nil {
		return err
	}
	return rejected
}
func (s *Service) Consume(ctx context.Context, token, kind, password string) error {
	if kind != "verify" && kind != "reset" {
		return fault.New("INVALID_INPUT", "操作无效")
	}
	var hash string
	var e error
	if kind == "reset" {
		hash, e = secure.Password(password)
		if e != nil {
			return fault.New("INVALID_INPUT", e.Error())
		}
	}
	return s.DB.Tx(ctx, func(tx pgx.Tx) error {
		var id string
		e := tx.QueryRow(ctx, `UPDATE auth_tokens SET used_at=now() WHERE token_hash=$1 AND kind=$2 AND used_at IS NULL AND expires_at>now() RETURNING user_id`, secure.Hash(token), kind).Scan(&id)
		if e == pgx.ErrNoRows {
			return fault.New("TOKEN_INVALID", "链接无效或已过期")
		}
		if e != nil {
			return e
		}
		if kind == "verify" {
			_, e = tx.Exec(ctx, "UPDATE users SET verified=true WHERE id=$1 AND NOT disabled", id)
			return e
		}
		if _, e = tx.Exec(ctx, "UPDATE users SET password_hash=$2 WHERE id=$1 AND NOT disabled", id, hash); e != nil {
			return e
		}
		if _, e = tx.Exec(ctx, "DELETE FROM sessions WHERE user_id=$1", id); e != nil {
			return e
		}
		_, e = tx.Exec(ctx, "UPDATE auth_tokens SET used_at=now() WHERE user_id=$1 AND used_at IS NULL", id)
		return e
	})
}
func (s *Service) Login(ctx context.Context, email, password string) (Login, error) {
	email = strings.ToLower(strings.TrimSpace(email))
	row, e := dbgen.New(s.DB.Pool).FindUser(ctx, email)
	hash := row.PasswordHash
	if e == pgx.ErrNoRows {
		hash = s.dummy
	} else if e != nil {
		return Login{}, e
	}
	valid := secure.CheckPassword(password, hash)
	if !valid || row.Disabled || e == pgx.ErrNoRows {
		return Login{}, fault.New("LOGIN_FAILED", "邮箱或密码错误")
	}
	if !row.Verified {
		return Login{}, fault.New("EMAIL_UNVERIFIED", "请先验证邮箱")
	}
	user := domain.User{ID: uuid.UUID(row.ID.Bytes).String(), Email: row.Email, Verified: row.Verified, Admin: row.Admin}
	token, csrf := secure.Token(), secure.Token()
	tag, e := s.DB.Pool.Exec(ctx, `INSERT INTO sessions(token_hash,user_id,csrf_hash,expires_at) SELECT $1,id,$3,$4 FROM users WHERE id=$2 AND verified AND NOT disabled AND password_hash=$5`, secure.Hash(token), user.ID, secure.Hash(csrf), time.Now().Add(7*24*time.Hour), hash)
	if e != nil {
		return Login{}, e
	}
	if tag.RowsAffected() != 1 {
		return Login{}, fault.New("LOGIN_FAILED", "账号状态已变化，请重新登录")
	}
	return Login{user, token, csrf}, nil
}
func (s *Service) Authenticate(ctx context.Context, token string, bearer bool) (Principal, error) {
	p := Principal{TokenHash: secure.Hash(token), Bearer: bearer}
	var e error
	if bearer {
		e = s.DB.Pool.QueryRow(ctx, `SELECT u.id,u.email,u.verified,u.disabled,u.admin FROM auth_tokens t JOIN users u ON u.id=t.user_id WHERE t.token_hash=$1 AND t.kind='api' AND t.used_at IS NULL AND t.expires_at>now() AND NOT u.disabled AND u.verified`, p.TokenHash).Scan(&p.User.ID, &p.User.Email, &p.User.Verified, &p.User.Disabled, &p.User.Admin)
	} else {
		e = s.DB.Pool.QueryRow(ctx, `SELECT u.id,u.email,u.verified,u.disabled,u.admin,s.csrf_hash FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token_hash=$1 AND s.expires_at>now() AND NOT u.disabled AND u.verified`, p.TokenHash).Scan(&p.User.ID, &p.User.Email, &p.User.Verified, &p.User.Disabled, &p.User.Admin, &p.CSRFHash)
	}
	if e == pgx.ErrNoRows {
		return p, fault.New("AUTH_REQUIRED", "请登录控制台")
	}
	return p, e
}
func (s *Service) Logout(ctx context.Context, p Principal) error {
	_, e := s.DB.Pool.Exec(ctx, "DELETE FROM sessions WHERE token_hash=$1 AND user_id=$2", p.TokenHash, p.User.ID)
	return e
}
