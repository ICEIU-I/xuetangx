package httpapi

import (
	"net/http"
	"xuetangx/internal/catalog"
)

func (s *Server) workflowCourseRoutes(m *http.ServeMux) {
	m.Handle("GET /api/workflow/courses", s.require(func(w http.ResponseWriter, r *http.Request) {
		// The unified workflow intentionally exposes one fixed course even before
		// the platform account has joined it. Engine.Start performs the join when
		// the user selects it.
		writeJSON(w, http.StatusOK, map[string]any{"ok": true, "courses": []any{catalog.FixedCourse()}})
	}))
}
