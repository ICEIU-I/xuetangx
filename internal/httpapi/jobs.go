package httpapi

import (
	"context"
	"net/http"
	"xuetangx/internal/domain"
	"xuetangx/internal/fault"
)

func (s *Server) jobRoutes(m *http.ServeMux) {
	m.Handle("GET /api/workflow/state", s.require(func(w http.ResponseWriter, r *http.Request) {
		limit, offset := page(r)
		state, e := s.snapshot(r.Context(), principal(r).User.ID, limit, offset)
		if e != nil {
			writeError(w, e)
			return
		}
		writeJSON(w, 200, state)
	}))
	m.Handle("POST /api/workflow/start", s.require(func(w http.ResponseWriter, r *http.Request) {
		var v domain.Start
		if e := body(w, r, &v); e != nil {
			writeError(w, e)
			return
		}
		j, e := s.Engine.Start(r.Context(), principal(r).User.ID, v)
		if e != nil {
			writeError(w, e)
			return
		}
		writeJSON(w, 202, map[string]any{"ok": true, "job": j})
	}))
	m.Handle("GET /api/workflow/{id}", s.require(func(w http.ResponseWriter, r *http.Request) {
		if !validUUID(r.PathValue("id")) {
			writeError(w, fault.New("NOT_FOUND", "任务不存在"))
			return
		}
		j, e := s.Jobs.Get(r.Context(), principal(r).User.ID, r.PathValue("id"))
		if e != nil {
			writeError(w, e)
			return
		}
		writeJSON(w, 200, map[string]any{"job": j})
	}))
	m.Handle("POST /api/workflow/{id}/{action}", s.require(func(w http.ResponseWriter, r *http.Request) {
		if !validUUID(r.PathValue("id")) {
			writeError(w, fault.New("NOT_FOUND", "任务不存在"))
			return
		}
		var v struct{ Module string }
		if e := body(w, r, &v); e != nil {
			writeError(w, e)
			return
		}
		j, e := s.Engine.Control(r.Context(), principal(r).User.ID, r.PathValue("id"), r.PathValue("action"), v.Module)
		if e != nil {
			writeError(w, e)
			return
		}
		writeJSON(w, 200, map[string]any{"ok": true, "job": j})
	}))
}
func (s *Server) snapshot(ctx context.Context, owner string, limit, offset int) (map[string]any, error) {
	accounts := map[string]any{}
	limits := map[string]any{}
	for _, role := range []string{"primary", "test"} {
		a, e := s.Accounts.Get(ctx, owner, role)
		if e != nil {
			return nil, e
		}
		accounts[role] = accountView(a)
		limits[role] = nil
		if a.Connected {
			limits[role] = s.Engine.Broker.State(a.UserID)
		}
	}
	list, total, e := s.Jobs.List(ctx, owner, limit, offset)
	if e != nil {
		return nil, e
	}
	collectorLimits := map[string]any{}
	for _, j := range list {
		if state := s.Engine.CollectorLimit(owner, j.ID); state != nil {
			collectorLimits[j.ID] = state
		}
	}
	shared, e := s.Accounts.SharedCollectors(ctx, 0)
	if e != nil {
		return nil, e
	}
	return map[string]any{"collectorLimits": collectorLimits, "sharedCollectors": len(shared), "accounts": accounts, "rateLimits": limits, "jobs": list, "pagination": map[string]int{"total": total, "limit": limit, "offset": offset}}, nil
}
