package httpapi

import (
	"net/http"
	"xuetangx/internal/accounts"
	"xuetangx/internal/fault"
)

func (s *Server) wechatRoutes(m *http.ServeMux) {
	m.Handle("POST /api/wechat/start", s.require(func(w http.ResponseWriter, r *http.Request) {
		if s.WeChat == nil {
			writeError(w, fault.New("PLATFORM_LOGIN_UNAVAILABLE", "微信登录服务未配置"))
			return
		}
		var v struct{ Role string }
		if e := body(w, r, &v); e != nil {
			writeError(w, e)
			return
		}
		if v.Role == "" {
			v.Role = "primary"
		}
		view, e := s.WeChat.Start(r.Context(), principal(r).User.ID, v.Role)
		if e != nil {
			writeError(w, e)
			return
		}
		writeJSON(w, http.StatusOK, wechatView(view))
	}))
	m.Handle("GET /api/wechat/{id}", s.require(func(w http.ResponseWriter, r *http.Request) {
		if s.WeChat == nil {
			writeError(w, fault.New("PLATFORM_LOGIN_UNAVAILABLE", "微信登录服务未配置"))
			return
		}
		view, e := s.WeChat.Status(principal(r).User.ID, r.PathValue("id"))
		if e != nil {
			writeError(w, e)
			return
		}
		writeJSON(w, http.StatusOK, wechatView(view))
	}))
	m.Handle("POST /api/wechat/{id}/cancel", s.require(func(w http.ResponseWriter, r *http.Request) {
		if s.WeChat == nil {
			writeError(w, fault.New("PLATFORM_LOGIN_UNAVAILABLE", "微信登录服务未配置"))
			return
		}
		if e := s.WeChat.Cancel(principal(r).User.ID, r.PathValue("id")); e != nil {
			writeError(w, e)
			return
		}
		writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
	}))
}

func wechatView(view accounts.WeChatSession) map[string]any {
	out := map[string]any{
		"id":        view.ID,
		"role":      view.Role,
		"status":    view.Status,
		"qrUrl":     view.QRURL,
		"expiresAt": view.ExpiresAt,
		"message":   view.Message,
	}
	if view.Status == "connected" {
		out["account"] = accountView(view.Account)
	}
	return out
}
