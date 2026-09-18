package httpapi

import (
	"net/http"
	"strings"
	"xuetangx/internal/catalog"
)

func (s *Server) workflowCourseRoutes(m *http.ServeMux) {
	m.Handle("GET /api/workflow/courses", s.require(func(w http.ResponseWriter, r *http.Request) {
		// Show the exact answer-bank classroom even before enrollment. Prefer the
		// canonical title last read from the platform, without blocking on it.
		course := catalog.FixedCourse()
		var title string
		err := s.Catalog.DB.Pool.QueryRow(r.Context(), "SELECT title FROM courses WHERE classroom_id=$1 AND sign=$2 AND course_sign=$3", course.ClassroomID, course.Sign, course.CourseSign).Scan(&title)
		if err == nil && strings.TrimSpace(title) != "" {
			course.Title = title
		}
		writeJSON(w, http.StatusOK, map[string]any{"ok": true, "courses": []any{course}})
	}))
	m.Handle("GET /api/workflow/course-score", s.require(s.courseScore))
}
