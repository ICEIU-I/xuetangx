package httpapi

import "net/http"

func (s *Server) adminJobs(w http.ResponseWriter, r *http.Request) {
	limit, offset := page(r)
	rows, e := s.Auth.DB.Pool.Query(r.Context(), `SELECT j.id,j.status,j.created_at,u.email,c.title FROM jobs j JOIN users u ON u.id=j.owner_id JOIN courses c ON c.id=j.course_id ORDER BY j.created_at DESC LIMIT $1 OFFSET $2`, limit, offset)
	if e != nil {
		writeError(w, e)
		return
	}
	defer rows.Close()
	items := []map[string]any{}
	for rows.Next() {
		var id, status, email, title string
		var created any
		if e = rows.Scan(&id, &status, &created, &email, &title); e != nil {
			writeError(w, e)
			return
		}
		items = append(items, map[string]any{"id": id, "status": status, "email": email, "title": title, "createdAt": created})
	}
	if e = rows.Err(); e != nil {
		writeError(w, e)
		return
	}
	writeJSON(w, 200, map[string]any{"jobs": items})
}
