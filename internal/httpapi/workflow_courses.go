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
	m.Handle("GET /api/workflow/courses", s.require(s.workflowCourses))
	m.Handle("GET /api/workflow/course-score", s.require(s.courseScore))
}

func (s *Server) workflowCourses(w http.ResponseWriter, r *http.Request) {
	ctx, cancel := context.WithTimeout(r.Context(), 12*time.Second)
	defer cancel()
	fixed := catalog.FixedCourse()
	var title string
	if err := s.Catalog.DB.Pool.QueryRow(ctx, "SELECT title FROM courses WHERE classroom_id=$1 AND sign=$2 AND course_sign=$3", fixed.ClassroomID, fixed.Sign, fixed.CourseSign).Scan(&title); err == nil && strings.TrimSpace(title) != "" {
		fixed.Title = title
	}
	account, err := s.Accounts.Get(ctx, principal(r).User.ID, "primary")
	if err != nil {
		writeError(w, err)
		return
	}
	result := map[string]any{"ok": true, "primaryId": account.UserID, "connectedAt": account.ConnectedAt, "courses": catalog.Choices(fixed, nil)}
	if !account.Connected {
		writeJSON(w, 200, result)
		return
	}
	// Display reads must not enter the background task's indefinite retry loop.
	reader := &catalog.Service{DB: s.Catalog.DB, Request: s.Engine.Broker.Request}
	enrolled, readErr := reader.Courses(ctx, account)
	current, err := s.Accounts.Get(r.Context(), principal(r).User.ID, "primary")
	if err != nil {
		writeError(w, err)
		return
	}
	if current.ID != account.ID || current.Revision != account.Revision || !current.Connected {
		writeError(w, fault.New("ACCOUNT_CHANGED", "平台账号已切换或断开，请刷新课程列表"))
		return
	}
	if readErr != nil {
		// Do not silently present a failed list query as "only the fixed course".
		result["warning"] = "已选课程暂时读取失败，请刷新重试。固定课程仅为可选项，不会自动开始。"
		result["code"] = fault.Code(readErr)
	} else {
		result["courses"] = catalog.Choices(fixed, enrolled)
	}
	writeJSON(w, 200, result)
}
