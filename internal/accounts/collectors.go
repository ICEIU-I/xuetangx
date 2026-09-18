package accounts

import (
	"context"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"strings"
	"time"
	"xuetangx/internal/domain"
	"xuetangx/internal/fault"
	"xuetangx/internal/secure"
)

type Collector struct {
	ID        string     `json:"id"`
	UserID    int64      `json:"userId"`
	Name      string     `json:"name"`
	Label     string     `json:"label"`
	Enabled   bool       `json:"enabled"`
	Valid     bool       `json:"valid"`
	UpdatedAt *time.Time `json:"updatedAt"`
}

func (s *Service) collectorAdmin(ctx context.Context, actor string) error {
	var allowed bool
	if e := s.DB.Pool.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM users WHERE id=$1 AND admin AND verified AND NOT disabled)`, actor).Scan(&allowed); e != nil {
		return e
	}
	if !allowed {
		return fault.New("FORBIDDEN", "需要管理员权限")
	}
	return nil
}
func (s *Service) ListCollectors(ctx context.Context, actor string) ([]Collector, error) {
	if e := s.collectorAdmin(ctx, actor); e != nil {
		return nil, e
	}
	rows, e := s.DB.Pool.Query(ctx, `SELECT id,platform_user_id,display_name,label,enabled,valid,connected_at FROM platform_accounts WHERE shared_collector ORDER BY connected_at DESC NULLS LAST,id`)
	if e != nil {
		return nil, e
	}
	defer rows.Close()
	out := []Collector{}
	for rows.Next() {
		var a Collector
		if e = rows.Scan(&a.ID, &a.UserID, &a.Name, &a.Label, &a.Enabled, &a.Valid, &a.UpdatedAt); e != nil {
			return nil, e
		}
		out = append(out, a)
	}
	return out, rows.Err()
}

// SaveCollector verifies identity before encrypting and does not reassign a private account.
func (s *Service) SaveCollector(ctx context.Context, actor, id, label, cookie string) error {
	if e := s.collectorAdmin(ctx, actor); e != nil {
		return e
	}
	cookie = strings.TrimSpace(cookie)
	label = strings.TrimSpace(label)
	if len(label) > 100 || len(cookie) > 65536 || strings.ContainsAny(cookie, "\r\n") || !strings.Contains(cookie, "csrftoken=") {
		return fault.New("INVALID_INPUT", "请填写有效 Cookie，备注不超过 100 字节")
	}
	uid, name, e := s.Authenticate(ctx, cookie)
	if e != nil {
		return fault.New("ACCOUNT_REQUIRED", "Cookie 校验失败，请检查有效期或稍后重试")
	}
	if uid <= 0 {
		return fault.New("ACCOUNT_REQUIRED", "无法确认平台账号")
	}
	s.mu.Lock()
	var accountID string
	e = s.DB.Tx(ctx, func(tx pgx.Tx) error {
		if e := lockPlatformIdentity(ctx, tx, uid); e != nil {
			return e
		}
		owner := actor
		var private bool
		if e := tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM platform_accounts WHERE platform_user_id=$1 AND NOT shared_collector)`, uid).Scan(&private); e != nil {
			return e
		}
		if private {
			return fault.New("ACCOUNT_BOUND", "该账号已绑定个人学习账号，请使用独立的答案采集账号")
		}
		err := tx.QueryRow(ctx, `SELECT id,owner_id FROM platform_accounts WHERE platform_user_id=$1 AND shared_collector FOR UPDATE`, uid).Scan(&accountID, &owner)
		if err != nil && err != pgx.ErrNoRows {
			return err
		}
		if id != "" && accountID != id {
			return fault.New("INVALID_INPUT", "新 Cookie 与原采集账号不一致，请作为新账号添加")
		}
		if accountID == "" {
			accountID = uuid.NewString()
		}
		_, err = tx.Exec(ctx, `INSERT INTO platform_accounts(id,owner_id,platform_user_id,display_name,shared_collector,label,valid,enabled,connected_at) VALUES($1,$2,$3,$4,true,$5,true,true,now()) ON CONFLICT(id) DO UPDATE SET display_name=excluded.display_name,label=excluded.label,valid=true,revision=platform_accounts.revision+1,connected_at=now()`, accountID, owner, uid, name, label)
		if err != nil {
			return err
		}
		sealed, err := s.Keys.Seal(owner+":"+accountID, cookie)
		if err != nil {
			return err
		}
		_, err = tx.Exec(ctx, `INSERT INTO platform_credentials(account_id,key_id,nonce,ciphertext) VALUES($1,$2,$3,$4) ON CONFLICT(account_id) DO UPDATE SET key_id=excluded.key_id,nonce=excluded.nonce,ciphertext=excluded.ciphertext,updated_at=now()`, accountID, sealed.KeyID, sealed.Nonce, sealed.Ciphertext)
		return err
	})
	delete(s.validated, accountID)
	s.mu.Unlock()
	if e == nil && s.OnChange != nil {
		s.OnChange(actor, "shared")
	}
	return e
}
func (s *Service) EnableCollector(ctx context.Context, actor, id string, enabled bool) error {
	if e := s.collectorAdmin(ctx, actor); e != nil {
		return e
	}
	tag, e := s.DB.Pool.Exec(ctx, `UPDATE platform_accounts SET enabled=$2,revision=revision+1 WHERE id=$1 AND shared_collector`, id, enabled)
	if e != nil {
		return e
	}
	if tag.RowsAffected() != 1 {
		return fault.New("NOT_FOUND", "采集账号不存在")
	}
	if s.OnChange != nil {
		s.OnChange(actor, "shared")
	}
	return nil
}
func (s *Service) CheckCollector(ctx context.Context, actor, id string) error {
	if e := s.collectorAdmin(ctx, actor); e != nil {
		return e
	}
	var owner, label string
	var sealed secure.Sealed
	e := s.DB.Pool.QueryRow(ctx, `SELECT a.owner_id,a.label,c.key_id,c.nonce,c.ciphertext FROM platform_accounts a JOIN platform_credentials c ON c.account_id=a.id WHERE a.id=$1 AND a.shared_collector`, id).Scan(&owner, &label, &sealed.KeyID, &sealed.Nonce, &sealed.Ciphertext)
	if e == pgx.ErrNoRows {
		return fault.New("NOT_FOUND", "采集账号不存在")
	}
	if e != nil {
		return e
	}
	cookie, e := s.Keys.Open(owner+":"+id, sealed)
	if e != nil {
		return e
	}
	return s.SaveCollector(ctx, actor, id, label, cookie)
}

// SharedCollectors is used by the parent scheduler, never returned to ordinary clients.
func (s *Service) SharedCollectors(ctx context.Context, exclude int64) ([]domain.Account, error) {
	rows, e := s.DB.Pool.Query(ctx, `SELECT a.id,a.owner_id,a.platform_user_id,a.display_name,a.revision FROM platform_accounts a JOIN users u ON u.id=a.owner_id WHERE a.shared_collector AND a.enabled AND a.valid AND u.admin AND u.verified AND NOT u.disabled AND a.platform_user_id<>$1 ORDER BY a.connected_at DESC,a.id`, exclude)
	if e != nil {
		return nil, e
	}
	defer rows.Close()
	out := []domain.Account{}
	for rows.Next() {
		a := domain.Account{Role: "test", Shared: true, Connected: true}
		if e = rows.Scan(&a.ID, &a.Owner, &a.UserID, &a.Name, &a.Revision); e != nil {
			return nil, e
		}
		out = append(out, a)
	}
	return out, rows.Err()
}
