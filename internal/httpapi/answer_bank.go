package httpapi

import (
	"fmt"
	"net/http"
	"strconv"

	"github.com/jackc/pgx/v5"
	"xuetangx/internal/domain"
	"xuetangx/internal/fault"
)

func (s *Server) answerBankRoutes(m *http.ServeMux) {
	m.Handle("GET /api/answer-bank", s.admin(s.answerBankCourses))
	m.Handle("GET /api/answer-bank/{classroomId}", s.admin(s.answerBank))
}

func (s *Server) answerBankCourses(w http.ResponseWriter, r *http.Request) {
	q, err := searchQuery(r)
	if err != nil {
		writeError(w, err)
		return
	}
	limit, offset := page(r)
	courses, total, err := s.Engine.Bank.Courses(r.Context(), limit, offset, q)
	if err != nil {
		writeError(w, err)
		return
	}
	writeJSON(w, 200, map[string]any{"courses": courses, "total": total})
}

func (s *Server) answerBank(w http.ResponseWriter, r *http.Request) {
	id, e := strconv.ParseInt(r.PathValue("classroomId"), 10, 64)
	if e != nil || id <= 0 {
		writeError(w, fault.New("INVALID_INPUT", "课程标识无效"))
		return
	}
	var c domain.Course
	e = s.Auth.DB.Pool.QueryRow(r.Context(), `SELECT id,classroom_id,sign,course_sign,title,url FROM courses WHERE classroom_id=$1 ORDER BY updated_at DESC LIMIT 1`, id).Scan(&c.ID, &c.ClassroomID, &c.Sign, &c.CourseSign, &c.Title, &c.URL)
	if e == pgx.ErrNoRows {
		writeError(w, fault.New("NOT_FOUND", "题库课程不存在"))
		return
	}
	if e != nil {
		writeError(w, e)
		return
	}
	limit, offset := page(r)
	if r.URL.Query().Get("download") == "1" {
		limit = 10000
		offset = 0
	}
	q, e := searchQuery(r)
	if e != nil {
		writeError(w, e)
		return
	}
	var out map[string]any
	if r.URL.Query().Get("download") == "1" {
		out, e = s.Engine.Bank.Export(r.Context(), c, limit, offset)
	} else {
		out, e = s.Engine.Bank.SearchQuestions(r.Context(), c, limit, offset, q)
	}
	if e != nil {
		writeError(w, e)
		return
	}
	if r.URL.Query().Get("download") == "1" {
		w.Header().Set("Content-Disposition", fmt.Sprintf("attachment; filename=answers-%d.json", id))
		writeJSON(w, 200, out["database"])
		return
	}
	writeJSON(w, 200, out)
}
