package httpapi

import (
	"github.com/google/uuid"
	"net/http"
	"xuetangx/internal/fault"
	"xuetangx/internal/store/dbgen"
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
	m.Handle("GET /api/admin/users", s.admin(func(w http.ResponseWriter, r *http.Request) {
		limit, offset := page(r)
		users, e := dbgen.New(s.Auth.DB.Pool).ListUsers(r.Context(), dbgen.ListUsersParams{Limit: int32(limit), Offset: int32(offset)})
		if e != nil {
			writeError(w, e)
			return
		}
		out := []any{}
		for _, u := range users {
			out = append(out, map[string]any{"id": uuid.UUID(u.ID.Bytes).String(), "email": u.Email, "verified": u.Verified, "disabled": u.Disabled, "admin": u.Admin, "createdAt": u.CreatedAt.Time})
		}
		writeJSON(w, 200, map[string]any{"users": out})
	}))
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
	for key, query := range map[string]string{"queuedJobs": "SELECT count(*) FROM jobs WHERE status='queued'", "runningJobs": "SELECT count(*) FROM jobs WHERE status='running'", "pendingOperations": "SELECT count(*) FROM operations WHERE state IN ('pending','unknown')", "failedMail": "SELECT count(*) FROM mail_outbox WHERE sent_at IS NULL AND attempts>0", "workerRestarts": "SELECT coalesce(sum(restarts),0) FROM job_modules"} {
		var n int64
		if e := s.Auth.DB.Pool.QueryRow(r.Context(), query).Scan(&n); e != nil {
			writeError(w, e)
			return
		}
		out[key] = n
	}
	writeJSON(w, 200, out)
}
func (s *Server) conflicts(w http.ResponseWriter, r *http.Request) {
	limit, offset := page(r)
	rows, e := s.Auth.DB.Pool.Query(r.Context(), `SELECT q.id,c.classroom_id,q.problem_id,q.body_html FROM standard_answers a JOIN question_versions q ON q.id=a.question_id JOIN exercises x ON x.id=q.exercise_id JOIN course_units u ON u.id=x.unit_id JOIN courses c ON c.id=u.course_id WHERE a.status='conflict' ORDER BY a.updated_at DESC LIMIT $1 OFFSET $2`, limit, offset)
	if e != nil {
		writeError(w, e)
		return
	}
	defer rows.Close()
	out := []any{}
	for rows.Next() {
		var id, body string
		var class, problem int64
		if e = rows.Scan(&id, &class, &problem, &body); e != nil {
			writeError(w, e)
			return
		}
		out = append(out, map[string]any{"id": id, "classroomId": class, "problemId": problem, "body": body})
	}
	if e = rows.Err(); e != nil {
		writeError(w, e)
		return
	}
	writeJSON(w, 200, map[string]any{"conflicts": out})
}
