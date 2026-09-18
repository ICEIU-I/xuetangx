package httpapi

import (
	"context"
	"net/http"
	"strings"
	"time"
	"xuetangx/internal/catalog"
	"xuetangx/internal/fault"
)

func (s *Server) workflowCourseRoutes(m *http.ServeMux) {
	m.Handle("GET /api/workflow/courses", s.require(func(w http.ResponseWriter, r *http.Request) {
		// Show the exact answer-bank classroom even before enrollment. Prefer the
		// canonical title last read from the platform, without blocking on it.
		course := catalog.FixedCourse()
		fromPlatform := false
		if account, err := s.Accounts.Get(r.Context(), principal(r).User.ID, "primary"); err == nil && account.Connected {
			ctx, cancel := context.WithTimeout(r.Context(), 12*time.Second)
			defer cancel()
			if courses, err := s.Catalog.Courses(ctx, account); err == nil {
				for _, current := range courses {
					if current.ClassroomID == course.ClassroomID && current.Sign == course.Sign && current.CourseSign == course.CourseSign {
						course = current
						fromPlatform = true
						break
					}
				}
			}
		}
		var title string
		err := s.Catalog.DB.Pool.QueryRow(r.Context(), "SELECT title FROM courses WHERE classroom_id=$1 AND sign=$2 AND course_sign=$3", course.ClassroomID, course.Sign, course.CourseSign).Scan(&title)
		if !fromPlatform && err == nil && strings.TrimSpace(title) != "" {
			course.Title = title
		}
		writeJSON(w, http.StatusOK, map[string]any{"ok": true, "courses": []any{course}})
	}))
	m.Handle("GET /api/workflow/course-score", s.require(s.courseScore))
}

func (s *Server) courseScore(w http.ResponseWriter, r *http.Request) {
	// Display reads must not wait forever in the task broker's retry loop.
	ctx, cancel := context.WithTimeout(r.Context(), 12*time.Second)
	defer cancel()
	owner := principal(r).User.ID
	account, err := s.Accounts.Require(ctx, owner, "primary")
	if err != nil {
		writeError(w, err)
		return
	}
	score, err := s.Catalog.Score(ctx, account, catalog.FixedCourse())
	if err != nil {
		switch fault.Code(err) {
		case "ENROLLMENT_REQUIRED":
			writeJSON(w, http.StatusOK, map[string]any{"ok": true, "primaryId": account.UserID, "available": false, "message": "加入课程后可查看成绩"})
		case "ACCOUNT_REQUIRED", "ACCOUNT_CHANGED":
			writeError(w, err)
		default:
			writeError(w, fault.New("UNAVAILABLE", "成绩暂不可用，请稍后刷新"))
		}
		return
	}
	current, err := s.Accounts.Require(ctx, owner, "primary")
	if err != nil {
		writeError(w, err)
		return
	}
	if current.ID != account.ID || current.Revision != account.Revision {
		writeError(w, fault.New("ACCOUNT_CHANGED", "平台账号已切换"))
		return
	}
	out := map[string]any{"ok": true, "primaryId": account.UserID, "course": score.Course, "available": score.Available}
	if score.Available {
		out["score"] = score.Value
	} else {
		out["message"] = "平台暂无成绩"
	}
	writeJSON(w, http.StatusOK, out)
}
