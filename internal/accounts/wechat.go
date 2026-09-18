package accounts

import (
	"context"
	"sync"
	"time"

	"github.com/google/uuid"
	"xuetangx/internal/domain"
	"xuetangx/internal/fault"
)

// WeChatRunner is the platform QR protocol. The callback is invoked as soon
// as the short-lived QR URL is ready; the returned string is never exposed to
// callers and is passed straight to Connect for encrypted persistence.
type WeChatRunner interface {
	Login(context.Context, func(string, time.Time)) (string, error)
}

type WeChatLogin struct {
	connector Connector
	runner    WeChatRunner

	mu       sync.Mutex
	sessions map[string]*wechatSession
}

type Connector interface {
	Connect(context.Context, string, string, string) (domain.Account, error)
}

type wechatSession struct {
	id        string
	owner     string
	role      string
	status    string
	qrURL     string
	expiresAt time.Time
	account   domain.Account
	message   string
	cancel    context.CancelFunc
	createdAt time.Time
}

type WeChatSession struct {
	ID        string         `json:"id"`
	Role      string         `json:"role"`
	Status    string         `json:"status"`
	QRURL     string         `json:"qrUrl,omitempty"`
	ExpiresAt time.Time      `json:"expiresAt,omitempty"`
	Account   domain.Account `json:"account,omitempty"`
	Message   string         `json:"message,omitempty"`
}

func NewWeChatLogin(connector Connector, runner WeChatRunner) *WeChatLogin {
	return &WeChatLogin{connector: connector, runner: runner, sessions: map[string]*wechatSession{}}
}

func (s *WeChatLogin) Start(ctx context.Context, owner, role string) (WeChatSession, error) {
	if owner == "" || !roleValid(role) {
		return WeChatSession{}, fault.New("INVALID_INPUT", "平台账号角色无效")
	}
	if s == nil || s.connector == nil || s.runner == nil {
		return WeChatSession{}, fault.New("PLATFORM_LOGIN_UNAVAILABLE", "微信登录服务未配置")
	}
	now := time.Now()
	id := uuid.NewString()
	runCtx, cancel := context.WithTimeout(context.Background(), 90*time.Second)
	session := &wechatSession{id: id, owner: owner, role: role, status: "starting", cancel: cancel, createdAt: now}
	s.mu.Lock()
	s.expireLocked(now)
	for _, old := range s.sessions {
		if old.owner == owner && old.role == role && isActive(old.status) {
			old.status = "cancelled"
			old.message = "新的扫码请求已替代本次请求"
			old.cancel()
		}
	}
	s.sessions[id] = session
	s.mu.Unlock()

	ready := make(chan struct{})
	var readyOnce sync.Once
	go func() {
		cookie, err := s.runner.Login(runCtx, func(qr string, expires time.Time) {
			s.mu.Lock()
			if current := s.sessions[id]; current != nil && isActive(current.status) {
				current.status = "waiting_scan"
				current.qrURL = qr
				current.expiresAt = expires
			}
			s.mu.Unlock()
			readyOnce.Do(func() { close(ready) })
		})
		if err != nil {
			s.finish(id, "expired", publicLoginError(err))
			readyOnce.Do(func() { close(ready) })
			return
		}
		account, connectErr := s.connector.Connect(context.Background(), owner, role, cookie)
		if connectErr != nil {
			s.finish(id, "error", connectErr.Error())
			return
		}
		s.mu.Lock()
		if current := s.sessions[id]; current != nil && isActive(current.status) {
			current.status = "connected"
			current.account = account
			current.qrURL = ""
			current.message = "学堂在线账号已连接"
		}
		s.mu.Unlock()
	}()

	timer := time.NewTimer(3 * time.Second)
	defer timer.Stop()
	select {
	case <-ready:
	case <-timer.C:
	case <-ctx.Done():
		cancel()
		return WeChatSession{}, ctx.Err()
	}
	view, ok := s.view(owner, id)
	if !ok {
		return WeChatSession{}, fault.New("NOT_FOUND", "微信登录请求不存在")
	}
	return view, nil
}

func (s *WeChatLogin) Status(owner, id string) (WeChatSession, error) {
	view, ok := s.view(owner, id)
	if !ok {
		return WeChatSession{}, fault.New("NOT_FOUND", "微信登录请求不存在")
	}
	return view, nil
}

func (s *WeChatLogin) Cancel(owner, id string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	current := s.sessions[id]
	if current == nil || current.owner != owner {
		return fault.New("NOT_FOUND", "微信登录请求不存在")
	}
	if isActive(current.status) {
		current.status = "cancelled"
		current.message = "已取消微信扫码登录"
		current.cancel()
	}
	return nil
}

func (s *WeChatLogin) Close() {
	s.mu.Lock()
	defer s.mu.Unlock()
	for _, session := range s.sessions {
		if isActive(session.status) {
			session.cancel()
			session.status = "cancelled"
			session.message = "服务正在关闭"
		}
	}
}

func (s *WeChatLogin) view(owner, id string) (WeChatSession, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.expireLocked(time.Now())
	current := s.sessions[id]
	if current == nil || current.owner != owner {
		return WeChatSession{}, false
	}
	return WeChatSession{ID: current.id, Role: current.role, Status: current.status, QRURL: current.qrURL, ExpiresAt: current.expiresAt, Account: current.account, Message: current.message}, true
}

func (s *WeChatLogin) finish(id, status, message string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if current := s.sessions[id]; current != nil && isActive(current.status) {
		current.status = status
		current.message = message
		current.qrURL = ""
	}
}

func (s *WeChatLogin) expireLocked(now time.Time) {
	for _, session := range s.sessions {
		if isActive(session.status) && !session.expiresAt.IsZero() && now.After(session.expiresAt.Add(5*time.Second)) {
			session.status = "expired"
			session.message = "二维码已过期，请重新获取"
			session.cancel()
		}
		if !isActive(session.status) && now.Sub(session.createdAt) > 10*time.Minute {
			delete(s.sessions, session.id)
		}
	}
}

func isActive(status string) bool { return status == "starting" || status == "waiting_scan" }

func publicLoginError(err error) string {
	if fault.Code(err) == "PLATFORM_LOGIN_FAILED" || fault.Code(err) == "PLATFORM_LOGIN_UNAVAILABLE" {
		return fault.Public(err)
	}
	if err == context.Canceled || err == context.DeadlineExceeded {
		return "二维码已过期，请重新获取"
	}
	return "微信扫码登录失败，请重新获取二维码"
}
