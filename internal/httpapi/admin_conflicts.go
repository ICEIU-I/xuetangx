package httpapi

import "net/http"

func (s *Server) conflicts(w http.ResponseWriter, r *http.Request) {
	q, err := searchQuery(r)
	if err != nil {
		writeError(w, err)
		return
	}
	limit, offset := page(r)
	from := ` FROM standard_answers a JOIN question_versions q ON q.id=a.question_id JOIN exercises x ON x.id=q.exercise_id JOIN course_units u ON u.id=x.unit_id JOIN courses c ON c.id=u.course_id WHERE a.status='conflict' AND (strpos(lower(c.title),lower($1))>0 OR strpos(lower(q.body_html),lower($1))>0 OR strpos(c.classroom_id::text,$1)>0 OR strpos(q.problem_id::text,$1)>0)`
	var total int
	if err = s.Auth.DB.Pool.QueryRow(r.Context(), "SELECT count(*)"+from, q).Scan(&total); err != nil {
		writeError(w, err)
		return
	}
	rows, e := s.Auth.DB.Pool.Query(r.Context(), "SELECT q.id,c.classroom_id,q.problem_id,q.body_html,c.title"+from+" ORDER BY a.updated_at DESC,q.id LIMIT $2 OFFSET $3", q, limit, offset)
	if e != nil {
		writeError(w, e)
		return
	}
	defer rows.Close()
	out := []any{}
	for rows.Next() {
		var id, body, title string
		var class, problem int64
		if e = rows.Scan(&id, &class, &problem, &body, &title); e != nil {
			writeError(w, e)
			return
		}
		out = append(out, map[string]any{"id": id, "classroomId": class, "problemId": problem, "body": body, "title": title})
	}
	if e = rows.Err(); e != nil {
		writeError(w, e)
		return
	}
	writeJSON(w, 200, map[string]any{"conflicts": out, "total": total})
}
