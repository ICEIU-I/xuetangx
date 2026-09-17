package httpapi

import "net/http"

func (s *Server) adminCollectorRoutes(m *http.ServeMux) {
	m.Handle("GET /api/admin/collectors", s.admin(func(w http.ResponseWriter, r *http.Request) {
		list, e := s.Accounts.ListCollectors(r.Context(), principal(r).User.ID)
		if e != nil {
			writeError(w, e)
			return
		}
		writeJSON(w, 200, map[string]any{"accounts": list})
	}))
	save := func(w http.ResponseWriter, r *http.Request) {
		var v struct{ Cookie, Label string }
		if e := body(w, r, &v); e != nil {
			writeError(w, e)
			return
		}
		id := r.PathValue("id")
		if id != "" && !validUUID(id) {
			http.NotFound(w, r)
			return
		}
		if e := s.Accounts.SaveCollector(r.Context(), principal(r).User.ID, id, v.Label, v.Cookie); e != nil {
			writeError(w, e)
			return
		}
		writeJSON(w, 200, map[string]bool{"ok": true})
	}
	m.Handle("POST /api/admin/collectors", s.admin(save))
	m.Handle("PUT /api/admin/collectors/{id}", s.admin(save))
	m.Handle("POST /api/admin/collectors/{id}/enabled", s.admin(func(w http.ResponseWriter, r *http.Request) {
		if !validUUID(r.PathValue("id")) {
			http.NotFound(w, r)
			return
		}
		var v struct{ Enabled bool }
		if e := body(w, r, &v); e != nil {
			writeError(w, e)
			return
		}
		if e := s.Accounts.EnableCollector(r.Context(), principal(r).User.ID, r.PathValue("id"), v.Enabled); e != nil {
			writeError(w, e)
			return
		}
		writeJSON(w, 200, map[string]bool{"ok": true})
	}))
	m.Handle("POST /api/admin/collectors/{id}/check", s.admin(func(w http.ResponseWriter, r *http.Request) {
		if !validUUID(r.PathValue("id")) {
			http.NotFound(w, r)
			return
		}
		if e := s.Accounts.CheckCollector(r.Context(), principal(r).User.ID, r.PathValue("id")); e != nil {
			writeError(w, e)
			return
		}
		writeJSON(w, 200, map[string]bool{"ok": true})
	}))
}
