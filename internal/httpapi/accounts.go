package httpapi

import (
	"net/http"
	"xuetangx/internal/domain"
)

func accountView(a domain.Account) map[string]any {
	var user any
	if a.ID != "" {
		user = map[string]any{"user_id": a.UserID, "id": a.UserID, "name": a.Name, "username": a.Name}
	}
	return map[string]any{"connected": a.Connected, "role": a.Role, "userId": a.UserID, "user": user, "connectedAt": a.ConnectedAt}
}
func (s *Server) accountRoutes(m *http.ServeMux) {
	m.Handle("GET /api/session", s.require(func(w http.ResponseWriter, r *http.Request) {
		a, e := s.Accounts.Get(r.Context(), principal(r).User.ID, "primary")
		if e != nil {
			writeError(w, e)
			return
		}
		writeJSON(w, 200, accountView(a))
	}))
	for _, role := range []string{"primary", "test"} {
		connect, disconnect := "/api/cookie", "/api/disconnect"
		if role == "test" {
			connect, disconnect = "/api/test-cookie", "/api/test-disconnect"
		}
		m.Handle("POST "+connect, s.require(func(w http.ResponseWriter, r *http.Request) {
			var v struct{ Cookie string }
			if e := body(w, r, &v); e != nil {
				writeError(w, e)
				return
			}
			a, e := s.Accounts.Connect(r.Context(), principal(r).User.ID, role, v.Cookie)
			if e != nil {
				writeError(w, e)
				return
			}
			out := accountView(a)
			out["ok"] = true
			writeJSON(w, 200, out)
		}))
		m.Handle("POST "+disconnect, s.require(func(w http.ResponseWriter, r *http.Request) {
			if e := s.Accounts.Disconnect(r.Context(), principal(r).User.ID, role); e != nil {
				writeError(w, e)
				return
			}
			writeJSON(w, 200, map[string]bool{"ok": true})
		}))
	}
}
