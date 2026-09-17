package httpapi

import (
	"net/http"
	"strings"
	"xuetangx/internal/admin"
	"xuetangx/internal/fault"
)

func (s *Server) adminUsers(w http.ResponseWriter, r *http.Request) {
	limit, offset := page(r)
	search := strings.TrimSpace(r.URL.Query().Get("q"))
	if len(search) > 200 {
		writeError(w, fault.New("INVALID_INPUT", "搜索内容过长"))
		return
	}
	list, total, e := (admin.Service{DB: s.Auth.DB}).Users(r.Context(), search, limit, offset)
	if e != nil {
		writeError(w, e)
		return
	}
	writeJSON(w, 200, map[string]any{"users": list, "total": total})
}
func (s *Server) adminUserRoutes(m *http.ServeMux) {
	m.Handle("GET /api/admin/users/{id}", s.admin(func(w http.ResponseWriter, r *http.Request) {
		if !validUUID(r.PathValue("id")) {
			http.NotFound(w, r)
			return
		}
		detail, e := (admin.Service{DB: s.Auth.DB}).Detail(r.Context(), r.PathValue("id"))
		if e != nil {
			writeError(w, e)
			return
		}
		writeJSON(w, 200, detail)
	}))
	m.Handle("PATCH /api/admin/users/{id}", s.admin(func(w http.ResponseWriter, r *http.Request) {
		if !validUUID(r.PathValue("id")) {
			http.NotFound(w, r)
			return
		}
		var v struct{ Email, Password *string }
		if e := body(w, r, &v); e != nil {
			writeError(w, e)
			return
		}
		release, e := s.hashSlot(r.Context())
		if e != nil {
			return
		}
		defer release()
		if e = s.Auth.UpdateUser(r.Context(), principal(r).User.ID, r.PathValue("id"), v.Email, v.Password); e != nil {
			writeError(w, e)
			return
		}
		writeJSON(w, 200, map[string]bool{"ok": true})
	}))
}
