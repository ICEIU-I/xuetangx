package httpapi

import (
	"net/http"
	"xuetangx/internal/admin"
)

func (s *Server) adminUsers(w http.ResponseWriter, r *http.Request) {
	limit, offset := page(r)
	search, err := searchQuery(r)
	if err != nil {
		writeError(w, err)
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
	m.Handle("GET /api/admin/users/{id}/jobs", s.admin(func(w http.ResponseWriter, r *http.Request) {
		if !validUUID(r.PathValue("id")) {
			http.NotFound(w, r)
			return
		}
		q, err := searchQuery(r)
		if err != nil {
			writeError(w, err)
			return
		}
		limit, offset := page(r)
		jobs, total, e := s.Jobs.List(r.Context(), r.PathValue("id"), limit, offset, q)
		if e != nil {
			writeError(w, e)
			return
		}
		var email string
		if e = s.Auth.DB.Pool.QueryRow(r.Context(), "SELECT email FROM users WHERE id=$1", r.PathValue("id")).Scan(&email); e != nil {
			writeError(w, e)
			return
		}
		writeJSON(w, 200, map[string]any{"email": email, "jobs": jobs, "total": total})
	}))
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
