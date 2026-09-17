package accounts

import (
	"context"
	"fmt"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"strings"
	"sync"
	"time"
	"xuetangx/internal/domain"
	"xuetangx/internal/fault"
	"xuetangx/internal/secure"
	"xuetangx/internal/store"
)

type Authenticate func(context.Context, string) (int64, string, error)
type Service struct {
	DB           *store.Store
	Keys         *secure.Keys
	Authenticate Authenticate
	OnChange     func(string, string)
	mu           sync.Mutex
	revisions    map[string]int64
	validated    map[string]int64
}

func New(db *store.Store, keys *secure.Keys, authenticate Authenticate) *Service {
	return &Service{DB: db, Keys: keys, Authenticate: authenticate, revisions: map[string]int64{}, validated: map[string]int64{}}
}
func roleValid(role string) bool { return role == "primary" || role == "test" }
func (s *Service) Connect(ctx context.Context, owner, role, cookie string) (domain.Account, error) {
	if !roleValid(role) || len(cookie) > 65536 || strings.ContainsAny(cookie, "\r\n") || !strings.Contains(cookie, "csrftoken=") {
		return domain.Account{}, fault.New("INVALID_INPUT", "角色或 Cookie 格式无效")
	}
	key := owner + ":" + role
	s.mu.Lock()
	s.revisions[key]++
	rev := s.revisions[key]
	s.mu.Unlock()
	platformID, name, e := s.Authenticate(ctx, strings.TrimSpace(cookie))
	if e != nil {
		return domain.Account{}, e
	}
	if platformID <= 0 {
		return domain.Account{}, fault.New("ACCOUNT_REQUIRED", "无法确认平台身份")
	}
	s.mu.Lock()
	if s.revisions[key] != rev {
		s.mu.Unlock()
		return domain.Account{}, fault.New("ACCOUNT_CHANGED", "连接请求已被替代")
	}
	var accountID string
	e = s.DB.Tx(ctx, func(tx pgx.Tx) error {
		if _, e := tx.Exec(ctx, "SELECT pg_advisory_xact_lock(hashtextextended($1,0))", owner); e != nil {
			return e
		}
		var existingOwner, existingRole string
		var shared bool
		e := tx.QueryRow(ctx, "SELECT id,owner_id,coalesce(role,''),shared_collector FROM platform_accounts WHERE platform_user_id=$1 FOR UPDATE", platformID).Scan(&accountID, &existingOwner, &existingRole, &shared)
		if e != nil && e != pgx.ErrNoRows {
			return e
		}
		if e == nil && shared {
			return fault.New("ACCOUNT_BOUND", "此账号已作为全站答案采集账号")
		}
		if e == nil && existingOwner != owner {
			return fault.New("ACCOUNT_BOUND", "该平台账号已绑定其他系统用户")
		}
		if e == nil && existingRole != "" && existingRole != role {
			return fault.New("INVALID_INPUT", "正式与测试账号必须不同")
		}
		if e == pgx.ErrNoRows {
			accountID = uuid.NewString()
		}
		if _, e = tx.Exec(ctx, "DELETE FROM platform_credentials WHERE account_id IN (SELECT id FROM platform_accounts WHERE owner_id=$1 AND role=$2 AND id<>$3)", owner, role, accountID); e != nil {
			return e
		}
		if _, e = tx.Exec(ctx, "UPDATE platform_accounts SET role=NULL,valid=false,revision=revision+1 WHERE owner_id=$1 AND role=$2 AND id<>$3", owner, role, accountID); e != nil {
			return e
		}
		if _, e = tx.Exec(ctx, `INSERT INTO platform_accounts(id,owner_id,platform_user_id,display_name,role,valid,connected_at) VALUES($1,$2,$3,$4,$5,true,now()) ON CONFLICT(id) DO UPDATE SET display_name=excluded.display_name,role=excluded.role,valid=true,revision=platform_accounts.revision+1,connected_at=now()`, accountID, owner, platformID, name, role); e != nil {
			return e
		}
		sealed, e := s.Keys.Seal(owner+":"+accountID, cookie)
		if e != nil {
			return e
		}
		_, e = tx.Exec(ctx, `INSERT INTO platform_credentials(account_id,key_id,nonce,ciphertext) VALUES($1,$2,$3,$4) ON CONFLICT(account_id) DO UPDATE SET key_id=excluded.key_id,nonce=excluded.nonce,ciphertext=excluded.ciphertext,updated_at=now()`, accountID, sealed.KeyID, sealed.Nonce, sealed.Ciphertext)
		return e
	})
	delete(s.validated, accountID)
	s.mu.Unlock()
	if e != nil {
		return domain.Account{}, e
	}
	if s.OnChange != nil {
		s.OnChange(owner, role)
	}
	return s.Get(ctx, owner, role)
}
func (s *Service) Get(ctx context.Context, owner, role string) (domain.Account, error) {
	a := domain.Account{Owner: owner, Role: role}
	if !roleValid(role) {
		return a, fault.New("INVALID_INPUT", "角色无效")
	}
	var connected *time.Time
	e := s.DB.Pool.QueryRow(ctx, "SELECT id,platform_user_id,display_name,valid,revision,connected_at FROM platform_accounts WHERE owner_id=$1 AND role=$2", owner, role).Scan(&a.ID, &a.UserID, &a.Name, &a.Connected, &a.Revision, &connected)
	if e == pgx.ErrNoRows {
		return a, nil
	}
	if connected != nil {
		a.ConnectedAt = connected.UnixMilli()
	}
	return a, e
}
func (s *Service) Credential(ctx context.Context, owner, id string, revision int64) (domain.Account, string, error) {
	var a domain.Account
	var sealed secure.Sealed
	a.Owner = owner
	e := s.DB.Pool.QueryRow(ctx, `SELECT a.id,a.platform_user_id,coalesce(a.role,'test'),a.revision,c.key_id,c.nonce,c.ciphertext,a.shared_collector FROM platform_accounts a JOIN platform_credentials c ON c.account_id=a.id JOIN users u ON u.id=a.owner_id WHERE a.id=$1 AND a.owner_id=$2 AND (a.role IS NOT NULL OR (a.shared_collector AND u.admin)) AND a.enabled AND a.valid AND u.verified AND NOT u.disabled`, id, owner).Scan(&a.ID, &a.UserID, &a.Role, &a.Revision, &sealed.KeyID, &sealed.Nonce, &sealed.Ciphertext, &a.Shared)
	if e == pgx.ErrNoRows {
		return a, "", fault.New("ACCOUNT_REQUIRED", "请重新连接平台账号")
	}
	if e != nil {
		return a, "", e
	}
	if revision != 0 && a.Revision != revision {
		return a, "", fault.New("ACCOUNT_CHANGED", "平台账号已切换")
	}
	cookie, e := s.Keys.Open(owner+":"+id, sealed)
	if e != nil {
		return a, "", e
	}
	s.mu.Lock()
	valid := s.validated[id] == a.Revision
	s.mu.Unlock()
	if !valid {
		uid, _, e := s.Authenticate(ctx, cookie)
		if e != nil || uid != a.UserID {
			_ = s.Invalidate(ctx, owner, id, a.Revision)
			return a, "", fault.New("ACCOUNT_REQUIRED", "保存的 Cookie 已失效，请重新连接")
		}
		s.mu.Lock()
		s.validated[id] = a.Revision
		s.mu.Unlock()
	}
	return a, cookie, nil
}
func (s *Service) Disconnect(ctx context.Context, owner, role string) error {
	if !roleValid(role) {
		return fault.New("INVALID_INPUT", "角色无效")
	}
	s.mu.Lock()
	s.revisions[owner+":"+role]++
	s.mu.Unlock()
	e := s.DB.Tx(ctx, func(tx pgx.Tx) error {
		if _, e := tx.Exec(ctx, "DELETE FROM platform_credentials WHERE account_id IN (SELECT id FROM platform_accounts WHERE owner_id=$1 AND role=$2)", owner, role); e != nil {
			return e
		}
		_, e := tx.Exec(ctx, "UPDATE platform_accounts SET valid=false,revision=revision+1 WHERE owner_id=$1 AND role=$2", owner, role)
		return e
	})
	if e == nil && s.OnChange != nil {
		s.OnChange(owner, role)
	}
	return e
}
func (s *Service) Invalidate(ctx context.Context, owner, id string, revision int64) error {
	tag, e := s.DB.Pool.Exec(ctx, "UPDATE platform_accounts SET valid=false WHERE id=$1 AND owner_id=$2 AND revision=$3", id, owner, revision)
	if e == nil && tag.RowsAffected() > 0 && s.OnChange != nil {
		var role string
		if e = s.DB.Pool.QueryRow(ctx, "SELECT CASE WHEN shared_collector THEN 'shared' ELSE role END FROM platform_accounts WHERE id=$1", id).Scan(&role); e == nil {
			s.OnChange(owner, role)
		}
	}
	return e
}
func (s *Service) Require(ctx context.Context, owner, role string) (domain.Account, error) {
	a, e := s.Get(ctx, owner, role)
	if e == nil && !a.Connected {
		e = fault.New("ACCOUNT_REQUIRED", fmt.Sprintf("请连接 %s 平台账号", role))
	}
	return a, e
}
