package admin

import (
	"context"
	"github.com/jackc/pgx/v5"
	"time"
	"xuetangx/internal/fault"
	"xuetangx/internal/store"
)

type Service struct{ DB *store.Store }
type User struct {
	ID        string    `json:"id"`
	Email     string    `json:"email"`
	Admin     bool      `json:"admin"`
	Disabled  bool      `json:"disabled"`
	Verified  bool      `json:"verified"`
	CreatedAt time.Time `json:"createdAt"`
	Accounts  int64     `json:"accounts"`
	Records   int64     `json:"records"`
}

func (s Service) Users(ctx context.Context, search string, limit, offset int) ([]User, int, error) {
	var total int
	if e := s.DB.Pool.QueryRow(ctx, `SELECT count(*) FROM users WHERE strpos(lower(email),lower($1))>0`, search).Scan(&total); e != nil {
		return nil, 0, e
	}
	rows, e := s.DB.Pool.Query(ctx, `SELECT u.id,u.email,u.admin,u.disabled,u.verified,u.created_at,(SELECT count(*) FROM platform_accounts a WHERE a.owner_id=u.id AND NOT a.shared_collector),(SELECT count(*) FROM jobs j WHERE j.owner_id=u.id) FROM users u WHERE strpos(lower(u.email),lower($1))>0 ORDER BY u.created_at DESC,u.id LIMIT $2 OFFSET $3`, search, limit, offset)
	if e != nil {
		return nil, 0, e
	}
	defer rows.Close()
	users := []User{}
	for rows.Next() {
		var u User
		if e = rows.Scan(&u.ID, &u.Email, &u.Admin, &u.Disabled, &u.Verified, &u.CreatedAt, &u.Accounts, &u.Records); e != nil {
			return nil, 0, e
		}
		users = append(users, u)
	}
	return users, total, rows.Err()
}
func (s Service) Detail(ctx context.Context, id string) (map[string]any, error) {
	var email string
	if e := s.DB.Pool.QueryRow(ctx, `SELECT email FROM users WHERE id=$1`, id).Scan(&email); e == pgx.ErrNoRows {
		return nil, fault.New("NOT_FOUND", "用户不存在")
	} else if e != nil {
		return nil, e
	}
	out := map[string]any{"email": email}
	for k, q := range map[string]string{"activeSessions": `SELECT count(*) FROM sessions WHERE user_id=$1 AND expires_at>now()`, "apiTokens": `SELECT count(*) FROM auth_tokens WHERE user_id=$1 AND kind='api' AND used_at IS NULL AND expires_at>now()`, "answeredQuestions": `SELECT count(*) FROM account_question_states q JOIN platform_accounts a ON a.id=q.account_id WHERE a.owner_id=$1 AND NOT a.shared_collector AND q.my_count>0`} {
		var n int
		if e := s.DB.Pool.QueryRow(ctx, q, id).Scan(&n); e != nil {
			return nil, e
		}
		out[k] = n
	}
	rows, e := s.DB.Pool.Query(ctx, `SELECT platform_user_id,display_name,coalesce(role,''),valid FROM platform_accounts WHERE owner_id=$1 AND NOT shared_collector ORDER BY connected_at DESC NULLS LAST LIMIT 100`, id)
	if e != nil {
		return nil, e
	}
	defer rows.Close()
	accounts := []any{}
	for rows.Next() {
		var uid int64
		var name, role string
		var valid bool
		if e = rows.Scan(&uid, &name, &role, &valid); e != nil {
			return nil, e
		}
		accounts = append(accounts, map[string]any{"userId": uid, "name": name, "role": role, "valid": valid})
	}
	if e = rows.Err(); e != nil {
		return nil, e
	}
	out["accounts"] = accounts
	return out, nil
}
