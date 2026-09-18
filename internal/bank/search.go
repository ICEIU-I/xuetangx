package bank

import (
	"context"
	"encoding/json"
	"strconv"

	"xuetangx/internal/domain"
	"xuetangx/internal/platform/wire"
)

// SearchQuestions pages through stored questions without changing full JSON exports.
func (s *Service) SearchQuestions(ctx context.Context, c domain.Course, limit, offset int, query string) (map[string]any, error) {
	limit = max(1, min(100, limit))
	offset = max(0, offset)
	from := ` FROM question_versions q JOIN exercises e ON e.id=q.exercise_id
 JOIN course_units u ON u.id=e.unit_id JOIN standard_answers a ON a.question_id=q.id
 WHERE u.course_id=$1 AND (strpos(lower(q.body_html),lower($2))>0 OR strpos(lower(u.title),lower($2))>0 OR strpos(q.problem_id::text,$2)>0)`
	var total int
	if err := s.DB.Pool.QueryRow(ctx, "SELECT count(*)"+from, c.ID, query).Scan(&total); err != nil {
		return nil, err
	}
	rows, err := s.DB.Pool.Query(ctx, `SELECT q.id,u.leaf_id,u.title,e.platform_exercise_id,q.problem_id,q.question_type,q.body_html,q.position,a.status,a.reference_text,
 coalesce((SELECT jsonb_agg(o.extra ORDER BY o.position) FROM question_options o WHERE o.question_id=q.id),'[]'::jsonb)`+from+` ORDER BY u.leaf_id,q.problem_id,q.created_at DESC,q.id LIMIT $3 OFFSET $4`, c.ID, query, limit, offset)
	if err != nil {
		return nil, err
	}
	type record struct {
		id, title, kind, body, status, reference string
		leaf, exercise, problem                  int64
		position                                 int
		options                                  json.RawMessage
	}
	records := []record{}
	for rows.Next() {
		var v record
		if err = rows.Scan(&v.id, &v.leaf, &v.title, &v.exercise, &v.problem, &v.kind, &v.body, &v.position, &v.status, &v.reference, &v.options); err != nil {
			rows.Close()
			return nil, err
		}
		records = append(records, v)
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		return nil, err
	}
	exercises := map[string]any{}
	for _, v := range records {
		answer, err := readAnswer(ctx, s.DB.Pool, v.id, v.kind)
		if err != nil {
			return nil, err
		}
		q := wire.ObjFromJSON(answer)
		q["problem_id"] = v.problem
		q["index"] = v.position
		q["body_html"] = v.body
		q["answer_status"] = v.status
		q["reference_answer"] = v.reference
		q["options"] = v.options
		if v.status != "captured" && v.status != "reference" {
			q["error"] = "答案缺失、待验证或存在冲突"
		}
		key := strconv.FormatInt(v.leaf, 10)
		ex, ok := exercises[key].(map[string]any)
		if !ok {
			ex = map[string]any{"leaf_id": v.leaf, "exercise_id": v.exercise, "section": v.title, "questions": []any{}}
			exercises[key] = ex
		}
		ex["questions"] = append(ex["questions"].([]any), q)
	}
	return map[string]any{"database": map[string]any{"course": c, "exercises": exercises}, "pagination": map[string]int{"total": total, "limit": limit, "offset": offset}}, nil
}
