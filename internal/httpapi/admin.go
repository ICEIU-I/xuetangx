package httpapi

import (
	"net/http"
	"xuetangx/internal/fault"
)

func (s *Server) admin(fn http.HandlerFunc) http.Handler {
	return s.require(func(w http.ResponseWriter, r *http.Request) {
		if !principal(r).User.Admin {
			writeError(w, fault.New("FORBIDDEN", "需要管理员权限"))
			return
		}
		fn(w, r)
	})
}
func (s *Server) adminRoutes(m *http.ServeMux) {
	m.Handle("GET /api/admin/jobs", s.admin(s.adminJobs))
	s.adminUserRoutes(m)
	s.adminCollectorRoutes(m)
	m.Handle("GET /api/admin/users", s.admin(s.adminUsers))
	m.Handle("POST /api/admin/users/{id}/disable", s.admin(func(w http.ResponseWriter, r *http.Request) {
		var v struct{ Disabled bool }
		if e := body(w, r, &v); e != nil {
			writeError(w, e)
			return
		}
		if !validUUID(r.PathValue("id")) {
			writeError(w, fault.New("NOT_FOUND", "用户不存在"))
			return
		}
		if e := s.Auth.Disable(r.Context(), principal(r).User.ID, r.PathValue("id"), v.Disabled); e != nil {
			writeError(w, e)
			return
		}
		writeJSON(w, 200, map[string]bool{"ok": true})
	}))
	m.Handle("POST /api/admin/jobs/{id}/stop", s.admin(func(w http.ResponseWriter, r *http.Request) {
		if !validUUID(r.PathValue("id")) {
			writeError(w, fault.New("NOT_FOUND", "任务不存在"))
			return
		}
		var owner string
		if e := s.Auth.DB.Pool.QueryRow(r.Context(), "SELECT owner_id FROM jobs WHERE id=$1", r.PathValue("id")).Scan(&owner); e != nil {
			writeError(w, fault.New("NOT_FOUND", "任务不存在"))
			return
		}
		j, e := s.Engine.Control(r.Context(), owner, r.PathValue("id"), "stop", "")
		if e != nil {
			writeError(w, e)
			return
		}
		writeJSON(w, 200, map[string]any{"job": j})
	}))
	m.Handle("GET /api/admin/metrics", s.admin(s.metrics))
	m.Handle("GET /api/admin/conflicts", s.admin(s.conflicts))
}
func (s *Server) metrics(w http.ResponseWriter, r *http.Request) {
	out := map[string]any{"ready": s.Engine.Ready()}
	for key, query := range map[string]string{"users": "SELECT count(*) FROM users", "activeUsers": "SELECT count(*) FROM users WHERE NOT disabled", "collectors": "SELECT count(*) FROM platform_accounts WHERE shared_collector", "availableCollectors": "SELECT count(*) FROM platform_accounts WHERE shared_collector AND enabled AND valid", "capturedAnswers": "SELECT count(*) FROM standard_answers WHERE status='captured'", "queuedJobs": "SELECT count(*) FROM jobs WHERE status='queued'", "runningJobs": "SELECT count(*) FROM jobs WHERE status='running'", "pendingOperations": "SELECT count(*) FROM operations WHERE state IN ('pending','unknown')", "failedMail": "SELECT count(*) FROM mail_outbox WHERE sent_at IS NULL AND attempts>0", "workerRestarts": "SELECT coalesce(sum(restarts),0) FROM job_modules"} {
		var n int64
		if e := s.Auth.DB.Pool.QueryRow(r.Context(), query).Scan(&n); e != nil {
			writeError(w, e)
			return
		}
		out[key] = n
	}
	performance, err := readAdminPerformance(r.Context(), s.Auth.DB)
	if err != nil {
		writeError(w, err)
		return
	}
	out["performance"] = performance
	writeJSON(w, 200, out)
}
