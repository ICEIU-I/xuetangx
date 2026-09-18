package bank

import (
	"context"
	"strings"
	"time"

	"xuetangx/internal/domain"
)

// CourseBank describes stored answers, independently of any platform login.
type CourseBank struct {
	Course          domain.Course `json:"course"`
	TotalExercises  int           `json:"totalExercises"`
	TotalQuestions  int           `json:"totalQuestions"`
	CapturedAnswers int           `json:"capturedAnswers"`
	MissingAnswers  int           `json:"missingAnswers"`
	UpdatedAt       time.Time     `json:"updatedAt"`
}

func (s *Service) Courses(ctx context.Context, limit, offset int, queries ...string) ([]CourseBank, int, error) {
	limit = max(1, min(limit, 100))
	offset = max(0, offset)
	query := ""
	if len(queries) > 0 {
		query = strings.TrimSpace(queries[0])
	}
	var total int
	if err := s.DB.Pool.QueryRow(ctx, `SELECT count(DISTINCT u.course_id)
		FROM courses c JOIN course_units u ON u.course_id=c.id JOIN exercises e ON e.unit_id=u.id
		JOIN question_versions q ON q.exercise_id=e.id JOIN standard_answers a ON a.question_id=q.id WHERE strpos(lower(c.title),lower($1))>0 OR strpos(c.classroom_id::text,$1)>0`, query).Scan(&total); err != nil {
		return nil, 0, err
	}
	// Match Export's stored question/answer records, including missing answers.
	rows, err := s.DB.Pool.Query(ctx, `SELECT c.id,c.classroom_id,c.sign,c.course_sign,c.title,c.url,
		count(DISTINCT e.id),count(*),count(*) FILTER (WHERE a.status='captured'),max(a.updated_at)
		FROM courses c JOIN course_units u ON u.course_id=c.id
		JOIN exercises e ON e.unit_id=u.id JOIN question_versions q ON q.exercise_id=e.id
		JOIN standard_answers a ON a.question_id=q.id
		WHERE strpos(lower(c.title),lower($3))>0 OR strpos(c.classroom_id::text,$3)>0
 GROUP BY c.id ORDER BY max(a.updated_at) DESC,c.classroom_id LIMIT $1 OFFSET $2`, limit, offset, query)
	if err != nil {
		return nil, 0, err
	}
	defer rows.Close()
	list := []CourseBank{}
	for rows.Next() {
		var item CourseBank
		c := &item.Course
		if err = rows.Scan(&c.ID, &c.ClassroomID, &c.Sign, &c.CourseSign, &c.Title, &c.URL,
			&item.TotalExercises, &item.TotalQuestions, &item.CapturedAnswers, &item.UpdatedAt); err != nil {
			return nil, 0, err
		}
		item.MissingAnswers = item.TotalQuestions - item.CapturedAnswers
		list = append(list, item)
	}
	return list, total, rows.Err()
}
