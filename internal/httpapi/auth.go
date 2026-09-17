package httpapi

import (
	"net/http"
	"strings"
	"time"
	"xuetangx/internal/fault"
)

func (s *Server) authRoutes(m *http.ServeMux) {
	m.HandleFunc("GET /api/auth/config", func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, 200, map[string]bool{"emailEnabled": !s.EmailDisabled, "emailVerificationRequired": s.Auth.RequireEmailVerification})
	})
	m.HandleFunc("POST /api/auth/register", s.register)
	m.HandleFunc("POST /api/auth/login", s.login)
	m.HandleFunc("POST /api/auth/verify", s.verify)
	m.HandleFunc("POST /api/auth/resend", s.resend)
	m.HandleFunc("POST /api/auth/forgot-password", s.forgot)
	m.HandleFunc("POST /api/auth/reset-password", s.reset)
	m.Handle("POST /api/auth/logout", s.require(s.logout))
	m.Handle("POST /api/auth/change-password", s.require(s.changePassword))
	m.Handle("GET /api/auth/me", s.require(func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, 200, map[string]any{"user": principal(r).User})
	}))
	m.Handle("GET /api/tokens", s.require(s.listTokens))
	m.Handle("POST /api/tokens", s.require(s.createToken))
	m.Handle("DELETE /api/tokens/{id}", s.require(s.revokeToken))
}
func (s *Server) changePassword(w http.ResponseWriter, r *http.Request) {
	var v struct{ CurrentPassword, Password string }
	if e := body(w, r, &v); e != nil {
		writeError(w, e)
		return
	}
	if !s.authLimit(w, r, "change-password", principal(r).User.Email) {
		return
	}
	release, e := s.hashSlot(r.Context())
	if e != nil {
		return
	}
	defer release()
	if e = s.Auth.ChangePassword(r.Context(), principal(r).User.ID, v.CurrentPassword, v.Password); e != nil {
		writeError(w, e)
		return
	}
	writeJSON(w, 200, map[string]bool{"ok": true})
}
func (s *Server) register(w http.ResponseWriter, r *http.Request) {
	if s.Auth.RequireEmailVerification && s.emailUnavailable(w) {
		return
	}
	var v struct{ Email, Password string }
	if e := body(w, r, &v); e != nil {
		writeError(w, e)
		return
	}
	if !s.authLimit(w, r, "register", v.Email) {
		return
	}
	release, e := s.hashSlot(r.Context())
	if e != nil {
		return
	}
	defer release()
	if e = s.Auth.Register(r.Context(), v.Email, v.Password); e != nil {
		writeError(w, e)
		return
	}
	message := "注册成功，请登录"
	if s.Auth.RequireEmailVerification {
		message = "如邮箱可以注册，验证邮件将发送至该邮箱"
	}
	writeJSON(w, 202, map[string]any{"ok": true, "message": message})
}
func (s *Server) login(w http.ResponseWriter, r *http.Request) {
	var v struct{ Email, Password string }
	if e := body(w, r, &v); e != nil {
		writeError(w, e)
		return
	}
	if !s.authLimit(w, r, "login", v.Email) {
		return
	}
	release, e := s.hashSlot(r.Context())
	if e != nil {
		return
	}
	defer release()
	login, e := s.Auth.Login(r.Context(), v.Email, v.Password)
	if e != nil {
		writeError(w, e)
		return
	}
	for name, value := range map[string]string{"xuetangx_session": login.Token, "xuetangx_csrf": login.CSRF} {
		http.SetCookie(w, &http.Cookie{Name: name, Value: value, Path: "/", HttpOnly: name == "xuetangx_session", Secure: strings.HasPrefix(s.Auth.BaseURL, "https://"), SameSite: http.SameSiteLaxMode, MaxAge: 7 * 24 * 3600})
	}
	writeJSON(w, 200, map[string]any{"ok": true, "user": login.User, "csrf": login.CSRF})
}
func (s *Server) verify(w http.ResponseWriter, r *http.Request) {
	var v struct{ Token string }
	if e := body(w, r, &v); e != nil {
		writeError(w, e)
		return
	}
	if !s.authLimit(w, r, "verify", "") {
		return
	}
	if e := s.Auth.Consume(r.Context(), v.Token, "verify", ""); e != nil {
		writeError(w, e)
		return
	}
	writeJSON(w, 200, map[string]bool{"ok": true})
}
func (s *Server) resend(w http.ResponseWriter, r *http.Request) { s.sendEmail(w, r, "verify") }
func (s *Server) forgot(w http.ResponseWriter, r *http.Request) { s.sendEmail(w, r, "reset") }
func (s *Server) sendEmail(w http.ResponseWriter, r *http.Request, kind string) {
	if s.emailUnavailable(w) {
		return
	}
	var v struct{ Email string }
	if e := body(w, r, &v); e != nil {
		writeError(w, e)
		return
	}
	if !s.authLimit(w, r, kind+"-mail", v.Email) {
		return
	}
	if e := s.Auth.RequestEmail(r.Context(), v.Email, kind); e != nil {
		writeError(w, e)
		return
	}
	writeJSON(w, 202, map[string]bool{"ok": true})
}
func (s *Server) emailUnavailable(w http.ResponseWriter) bool {
	if !s.EmailDisabled {
		return false
	}
	writeJSON(w, http.StatusServiceUnavailable, map[string]any{"ok": false, "code": "MAIL_UNAVAILABLE", "error": "邮箱服务尚未配置，暂不支持注册和找回密码"})
	return true
}
func (s *Server) reset(w http.ResponseWriter, r *http.Request) {
	var v struct{ Token, Password string }
	if e := body(w, r, &v); e != nil {
		writeError(w, e)
		return
	}
	if !s.authLimit(w, r, "reset", "") {
		return
	}
	release, e := s.hashSlot(r.Context())
	if e != nil {
		return
	}
	defer release()
	if e = s.Auth.Consume(r.Context(), v.Token, "reset", v.Password); e != nil {
		writeError(w, e)
		return
	}
	writeJSON(w, 200, map[string]bool{"ok": true})
}
func (s *Server) logout(w http.ResponseWriter, r *http.Request) {
	p := principal(r)
	var e error
	if p.Bearer {
		e = s.Auth.RevokeToken(r.Context(), p.User.ID, p.TokenHash)
	} else {
		e = s.Auth.Logout(r.Context(), p)
	}
	if e != nil {
		writeError(w, e)
		return
	}
	for _, name := range []string{"xuetangx_session", "xuetangx_csrf"} {
		http.SetCookie(w, &http.Cookie{Name: name, Path: "/", MaxAge: -1, Secure: strings.HasPrefix(s.Auth.BaseURL, "https://"), HttpOnly: name == "xuetangx_session", SameSite: http.SameSiteLaxMode})
	}
	writeJSON(w, 200, map[string]bool{"ok": true})
}
func (s *Server) listTokens(w http.ResponseWriter, r *http.Request) {
	rows, e := s.Auth.DB.Pool.Query(r.Context(), "SELECT token_hash,name,expires_at,created_at FROM auth_tokens WHERE user_id=$1 AND kind='api' AND used_at IS NULL AND expires_at>now() ORDER BY created_at DESC", principal(r).User.ID)
	if e != nil {
		writeError(w, e)
		return
	}
	defer rows.Close()
	items := []any{}
	for rows.Next() {
		var id, name string
		var expires, created time.Time
		if e = rows.Scan(&id, &name, &expires, &created); e != nil {
			writeError(w, e)
			return
		}
		items = append(items, map[string]any{"id": id, "name": name, "expiresAt": expires, "createdAt": created})
	}
	if e = rows.Err(); e != nil {
		writeError(w, e)
		return
	}
	writeJSON(w, 200, map[string]any{"tokens": items})
}
func (s *Server) createToken(w http.ResponseWriter, r *http.Request) {
	var v struct{ Name string }
	if e := body(w, r, &v); e != nil {
		writeError(w, e)
		return
	}
	token, e := s.Auth.CreateToken(r.Context(), principal(r).User.ID, v.Name)
	if e != nil {
		writeError(w, e)
		return
	}
	writeJSON(w, 201, map[string]any{"token": token})
}
func (s *Server) revokeToken(w http.ResponseWriter, r *http.Request) {
	if len(r.PathValue("id")) != 64 {
		writeError(w, fault.New("INVALID_INPUT", "令牌标识无效"))
		return
	}
	if e := s.Auth.RevokeToken(r.Context(), principal(r).User.ID, r.PathValue("id")); e != nil {
		writeError(w, e)
		return
	}
	writeJSON(w, 200, map[string]bool{"ok": true})
}
