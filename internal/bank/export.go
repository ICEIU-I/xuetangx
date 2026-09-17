package bank

import (
	"context"
	"strconv"
	"xuetangx/internal/domain"
	"xuetangx/internal/platform/wire"
)

func (s *Service) Export(ctx context.Context, c domain.Course, limit, offset int) (map[string]any, error) {
	if limit < 1 {
		limit = 100
	}
	if limit > 10000 {
		limit = 10000
	}
	if offset < 0 {
		offset = 0
	}
	rows, e := s.DB.Pool.Query(ctx, `SELECT q.id,u.leaf_id,u.title,e.platform_exercise_id,q.problem_id,q.question_type,q.platform_type,q.body_html,q.position,q.fingerprint,q.algorithm,a.status,a.reference_text FROM question_versions q JOIN exercises e ON e.id=q.exercise_id JOIN course_units u ON u.id=e.unit_id JOIN standard_answers a ON a.question_id=q.id WHERE u.course_id=$1 ORDER BY u.leaf_id,q.problem_id,q.created_at DESC LIMIT $2 OFFSET $3`, c.ID, limit, offset)
	if e != nil {
		return nil, e
	}
	type record struct {
		id                                        string
		leaf, exercise, problem                   int64
		title, kind, platform, body               string
		position                                  int
		fingerprint, algorithm, status, reference string
	}
	records := []record{}
	for rows.Next() {
		var r record
		if e = rows.Scan(&r.id, &r.leaf, &r.title, &r.exercise, &r.problem, &r.kind, &r.platform, &r.body, &r.position, &r.fingerprint, &r.algorithm, &r.status, &r.reference); e != nil {
			rows.Close()
			return nil, e
		}
		records = append(records, r)
	}
	e = rows.Err()
	rows.Close()
	if e != nil {
		return nil, e
	}
	exercises := map[string]any{}
	captured := 0
	for _, r := range records {
		a, e := readAnswer(ctx, s.DB.Pool, r.id, r.kind)
		if e != nil {
			return nil, e
		}
		q := wire.ObjFromJSON(a)
		q["problem_id"] = r.problem
		q["index"] = r.position
		q["platform_type"] = r.platform
		q["body_html"] = r.body
		q["fingerprint"] = r.fingerprint
		q["fingerprint_algorithm"] = r.algorithm
		q["answer_status"] = r.status
		q["reference_answer"] = r.reference
		if r.status == "captured" {
			captured++
		} else {
			q["error"] = "答案缺失、待验证或存在冲突"
		}
		opts, e := s.DB.Pool.Query(ctx, "SELECT extra FROM question_options WHERE question_id=$1 ORDER BY position", r.id)
		if e != nil {
			return nil, e
		}
		options := []any{}
		for opts.Next() {
			var b []byte
			if e = opts.Scan(&b); e != nil {
				opts.Close()
				return nil, e
			}
			o, e := wire.Decode(b)
			if e != nil {
				opts.Close()
				return nil, e
			}
			options = append(options, o)
		}
		e = opts.Err()
		opts.Close()
		if e != nil {
			return nil, e
		}
		q["options"] = options
		key := strconv.FormatInt(r.leaf, 10)
		ex, ok := exercises[key].(map[string]any)
		if !ok {
			ex = map[string]any{"leaf_id": r.leaf, "exercise_id": r.exercise, "section": r.title, "active": true, "questions": []any{}}
			exercises[key] = ex
		}
		ex["questions"] = append(ex["questions"].([]any), q)
	}
	var total int
	if e = s.DB.Pool.QueryRow(ctx, `SELECT count(*) FROM question_versions q JOIN exercises e ON e.id=q.exercise_id JOIN course_units u ON u.id=e.unit_id WHERE u.course_id=$1`, c.ID).Scan(&total); e != nil {
		return nil, e
	}
	database := map[string]any{"version": 3, "course": c, "exercises": exercises}
	summary := map[string]any{"course": c, "totalExercises": len(exercises), "processedExercises": len(exercises), "totalQuestions": len(records), "capturedAnswers": captured, "missingAnswers": len(records) - captured}
	return map[string]any{"database": database, "summary": summary, "pagination": map[string]any{"limit": limit, "offset": offset, "total": total}}, nil
}
