package httpapi

import (
	"context"
	"encoding/json"
	"github.com/google/uuid"
	"io"
	"log/slog"
	"net"
	"net/http"
	"strconv"
	"strings"
	"time"
	"xuetangx/internal/auth"
	"xuetangx/internal/fault"
	"xuetangx/internal/secure"
)

type contextKey struct{}

func principal(r *http.Request) auth.Principal {
	p, _ := r.Context().Value(contextKey{}).(auth.Principal)
	return p
}
func unavailable() error { return fault.New("UNAVAILABLE", "服务暂不可用，请稍后重试") }
func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}
func writeError(w http.ResponseWriter, e error) {
	status := 400
	switch fault.Code(e) {
	case "AUTH_REQUIRED", "LOGIN_FAILED":
		status = 401
	case "FORBIDDEN", "CSRF", "EMAIL_UNVERIFIED":
		status = 403
	case "ACCOUNT_BOUND", "JOB_CONFLICT", "OPERATION_CONFLICT":
		status = 409
	case "NOT_FOUND":
		status = 404
	case "RATE_LIMITED":
		status = 429
	case "INTERNAL_ERROR", "UNAVAILABLE", "LEADER_UNAVAILABLE", "MAIL_UNAVAILABLE":
		status = 503
	}
	writeJSON(w, status, map[string]any{"ok": false, "error": fault.Public(e), "code": fault.Code(e)})
}
func body(w http.ResponseWriter, r *http.Request, v any) error {
	if !strings.HasPrefix(r.Header.Get("Content-Type"), "application/json") {
		return fault.New("INVALID_INPUT", "请求需要 application/json")
	}
	r.Body = http.MaxBytesReader(w, r.Body, 1<<20)
	d := json.NewDecoder(r.Body)
	if e := d.Decode(v); e != nil {
		return fault.New("INVALID_INPUT", "请求格式无效或过大")
	}
	if d.Decode(new(any)) != io.EOF {
		return fault.New("INVALID_INPUT", "请求包含多余内容")
	}
	return nil
}
func page(r *http.Request) (int, int) {
	limit, _ := strconv.Atoi(r.URL.Query().Get("limit"))
	offset, _ := strconv.Atoi(r.URL.Query().Get("offset"))
	if limit == 0 {
		limit = 25
	}
	return max(1, min(100, limit)), max(0, offset)
}
func validUUID(v string) bool { _, e := uuid.Parse(v); return e == nil }
func (s *Server) middleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		id := uuid.NewString()
		w.Header().Set("X-Request-ID", id)
		w.Header().Set("X-Content-Type-Options", "nosniff")
		w.Header().Set("Referrer-Policy", "same-origin")
		w.Header().Set("Content-Security-Policy", "default-src 'self'; connect-src 'self'; img-src 'self' data: https://mp.weixin.qq.com; style-src 'self' 'unsafe-inline'; script-src 'self'; frame-ancestors 'none'")
		defer func() {
			if recover() != nil {
				slog.Error("request panic", "requestId", id)
				writeError(w, unavailable())
			}
		}()
		if r.Method != "GET" && r.Method != "HEAD" && r.Method != "OPTIONS" {
			if origin := r.Header.Get("Origin"); origin != "" && origin != s.Auth.BaseURL {
				writeError(w, fault.New("CSRF", "请求来源不匹配"))
				return
			}
		}
		next.ServeHTTP(w, r)
	})
}
func (s *Server) authenticate(r *http.Request) (auth.Principal, error) {
	if h := r.Header.Get("Authorization"); h != "" {
		if !strings.HasPrefix(h, "Bearer ") {
			return auth.Principal{}, fault.New("AUTH_REQUIRED", "令牌格式无效")
		}
		return s.Auth.Authenticate(r.Context(), strings.TrimPrefix(h, "Bearer "), true)
	}
	c, e := r.Cookie("xuetangx_session")
	if e != nil {
		return auth.Principal{}, fault.New("AUTH_REQUIRED", "请登录控制台")
	}
	return s.Auth.Authenticate(r.Context(), c.Value, false)
}
func (s *Server) require(next http.HandlerFunc) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		p, e := s.authenticate(r)
		if e != nil {
			writeError(w, e)
			return
		}
		if !p.Bearer && r.Method != "GET" && r.Method != "HEAD" {
			token := r.Header.Get("X-CSRF-Token")
			if token == "" || secure.Hash(token) != p.CSRFHash || r.Header.Get("Origin") != s.Auth.BaseURL {
				writeError(w, fault.New("CSRF", "请求校验失败，请刷新页面"))
				return
			}
		}
		next(w, r.WithContext(context.WithValue(r.Context(), contextKey{}, p)))
	})
}
func (s *Server) clientIP(r *http.Request) string {
	host, _, _ := net.SplitHostPort(r.RemoteAddr)
	peer := net.ParseIP(host)
	trusted := false
	for _, network := range s.TrustedProxies {
		if network.Contains(peer) {
			trusted = true
		}
	}
	if trusted {
		chain := strings.Split(r.Header.Get("X-Forwarded-For"), ",")
		for i := len(chain) - 1; i >= 0; i-- {
			raw := chain[i]
			ip := net.ParseIP(strings.TrimSpace(raw))
			if ip != nil {
				isProxy := false
				for _, network := range s.TrustedProxies {
					if network.Contains(ip) {
						isProxy = true
						break
					}
				}
				if isProxy {
					continue
				}
				return ip.String()
			}
		}
	}
	return host
}
func (s *Server) authLimit(w http.ResponseWriter, r *http.Request, kind, email string) bool {
	count, window := 10, time.Minute
	if kind != "login" {
		count, window = 5, time.Hour
	}
	if !s.limiter.Allow(kind+":ip:"+s.clientIP(r), count, window) || (email != "" && !s.limiter.Allow(kind+":email:"+strings.ToLower(strings.TrimSpace(email)), count, window)) {
		writeError(w, fault.New("RATE_LIMITED", "请求过于频繁，请稍后重试"))
		return false
	}
	return true
}
func (s *Server) hashSlot(ctx context.Context) (func(), error) {
	select {
	case s.hashSlots <- struct{}{}:
		return func() { <-s.hashSlots }, nil
	case <-ctx.Done():
		return nil, ctx.Err()
	}
}
