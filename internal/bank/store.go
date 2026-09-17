package bank

import (
	"context"
	"encoding/json"
	"fmt"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"strconv"
	"xuetangx/internal/domain"
	"xuetangx/internal/platform/wire"
	"xuetangx/internal/questions"
	"xuetangx/internal/secure"
	"xuetangx/internal/store"
)

type Service struct{ DB *store.Store }

func (s *Service) ensure(ctx context.Context, tx pgx.Tx, c domain.Course, ex domain.Exercise, p domain.Problem) (string, error) {
	var exerciseID string
	e := tx.QueryRow(ctx, `INSERT INTO exercises(id,unit_id,platform_exercise_id) SELECT $1,u.id,$3 FROM course_units u JOIN courses c ON c.id=u.course_id WHERE c.classroom_id=$2 AND u.leaf_id=$4 ON CONFLICT(unit_id,platform_exercise_id) DO UPDATE SET platform_exercise_id=excluded.platform_exercise_id RETURNING id`, uuid.NewString(), c.ClassroomID, ex.ExerciseID, ex.LeafID).Scan(&exerciseID)
	if e != nil {
		return "", e
	}
	content := questions.Content(p)
	fingerprint := questions.Fingerprint(p)
	if fingerprint == "" {
		return "", fmt.Errorf("invalid question fingerprint")
	}
	var id string
	e = tx.QueryRow(ctx, `INSERT INTO question_versions(id,exercise_id,problem_id,fingerprint,question_type,platform_type,body_html,position,blank_count,metadata) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT(exercise_id,problem_id,algorithm,fingerprint) DO UPDATE SET verified=true RETURNING id`, uuid.NewString(), exerciseID, p.ID, fingerprint, questions.Kind(p), wire.String(content["Type"]), wire.String(content["Body"]), p.Index, questions.BlankCount(p), p.Content).Scan(&id)
	if e != nil {
		return "", e
	}
	for index, o := range questions.Options(p) {
		key := wire.String(o["key"])
		if key == "" {
			return "", fmt.Errorf("invalid option key")
		}
		label := wire.String(o["content"])
		if label == "" {
			label = wire.String(o["value"])
		}
		if _, e = tx.Exec(ctx, `INSERT INTO question_options(question_id,key,position,content,extra) VALUES($1,$2,$3,$4,$5) ON CONFLICT(question_id,key) DO NOTHING`, id, key, index, label, wire.JSON(o)); e != nil {
			return "", e
		}
	}
	_, e = tx.Exec(ctx, `INSERT INTO standard_answers(question_id,status) VALUES($1,'missing') ON CONFLICT DO NOTHING`, id)
	return id, e
}
func (s *Service) Observe(ctx context.Context, a domain.Account, c domain.Course, ex domain.Exercise, p domain.Problem) error {
	source, _ := wire.Decode(p.User)
	if err := s.Save(ctx, a, c, ex, p, source, "exercise_list"); err != nil {
		return err
	}
	count, e := questions.Count(p)
	if e != nil {
		return nil
	}
	return s.DB.Tx(ctx, func(tx pgx.Tx) error {
		id, e := s.ensure(ctx, tx, c, ex, p)
		if e != nil {
			return e
		}
		var right any
		if b, ok := source["is_right"].(bool); ok {
			right = b
		}
		_, e = tx.Exec(ctx, `INSERT INTO account_question_states(account_id,question_id,my_count,is_right) VALUES($1,$2,$3,$4) ON CONFLICT(account_id,question_id) DO UPDATE SET my_count=excluded.my_count,is_right=excluded.is_right,checked_at=now()`, a.ID, id, count, right)
		return e
	})
}
func (s *Service) Save(ctx context.Context, a domain.Account, c domain.Course, ex domain.Exercise, p domain.Problem, source wire.Object, sourceName string) error {
	answer, valid := questions.Extract(p, source)
	return s.DB.Tx(ctx, func(tx pgx.Tx) error {
		id, e := s.ensure(ctx, tx, c, ex, p)
		if e != nil {
			return e
		}
		if !valid {
			if questions.Kind(p) == "reference" && source["is_show_answer"] == true {
				v := source["answer"]
				if v == nil {
					v = source["answers"]
				}
				if v != nil {
					_, e = tx.Exec(ctx, "UPDATE standard_answers SET status='reference',reference_text=$2 WHERE question_id=$1 AND status='missing'", id, string(wire.JSON(v)))
				}
			}
			return e
		}
		var status string
		if e = tx.QueryRow(ctx, "SELECT status FROM standard_answers WHERE question_id=$1 FOR UPDATE", id).Scan(&status); e != nil {
			return e
		}
		newDigest := secure.Hash(string(wire.JSON(answer)))
		if status == "captured" {
			old, e := readAnswer(ctx, tx, id, answer.Type)
			if e != nil {
				return e
			}
			if secure.Hash(string(wire.JSON(old))) != newDigest {
				status = "conflict"
			}
		} else if status != "conflict" {
			status = "captured"
		}
		if _, e = tx.Exec(ctx, `INSERT INTO answer_sources(id,question_id,owner_id,account_id,source,answer_digest,evidence) VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(question_id,answer_digest,source) DO NOTHING`, uuid.NewString(), id, nullable(a.Owner), nullable(a.ID), sourceName, newDigest, wire.JSON(answer)); e != nil {
			return e
		}
		if _, e = tx.Exec(ctx, "UPDATE standard_answers SET status=$2,updated_at=now() WHERE question_id=$1", id, status); e != nil {
			return e
		}
		if status == "conflict" {
			return nil
		}
		if _, e = tx.Exec(ctx, "DELETE FROM answer_items WHERE question_id=$1", id); e != nil {
			return e
		}
		if e = writeAnswer(ctx, tx, id, answer); e != nil {
			return e
		}
		_, e = tx.Exec(ctx, `INSERT INTO event_outbox(topic,payload) VALUES('answer-ready',$1)`, wire.JSON(map[string]any{"classroomId": c.ClassroomID, "leafId": ex.LeafID, "problemId": p.ID, "fingerprint": questions.Fingerprint(p)}))
		return e
	})
}

type querier interface {
	Query(context.Context, string, ...any) (pgx.Rows, error)
}

func readAnswer(ctx context.Context, q querier, id, kind string) (domain.Answer, error) {
	a := domain.Answer{Type: kind}
	rows, e := q.Query(ctx, "SELECT slot,variant,value FROM answer_items WHERE question_id=$1 ORDER BY slot,variant", id)
	if e != nil {
		return a, e
	}
	defer rows.Close()
	if kind == "fill" {
		a.Accepted = map[string][]string{}
	}
	for rows.Next() {
		var slot, variant int
		var v string
		if e = rows.Scan(&slot, &variant, &v); e != nil {
			return a, e
		}
		switch kind {
		case "choice", "judge":
			a.Answer = v
		case "multi":
			a.Answers = append(a.Answers, v)
		case "fill":
			a.Accepted[strconv.Itoa(slot)] = append(a.Accepted[strconv.Itoa(slot)], v)
			if variant == 0 {
				a.Answers = append(a.Answers, v)
			}
		}
	}
	return a, rows.Err()
}
func writeAnswer(ctx context.Context, tx pgx.Tx, id string, a domain.Answer) error {
	values := a.Answers
	if a.Type == "choice" || a.Type == "judge" {
		values = []string{a.Answer}
	}
	for i, v := range values {
		variants := []string{v}
		if a.Type == "fill" && len(a.Accepted[strconv.Itoa(i+1)]) > 0 {
			variants = a.Accepted[strconv.Itoa(i+1)]
		}
		for j, value := range variants {
			if _, e := tx.Exec(ctx, "INSERT INTO answer_items(question_id,slot,variant,value) VALUES($1,$2,$3,$4)", id, i+1, j, value); e != nil {
				return e
			}
		}
	}
	return nil
}
func nullable(v string) any {
	if v == "" {
		return nil
	}
	return v
}
func (s *Service) Lookup(ctx context.Context, c domain.Course, ex domain.Exercise, p domain.Problem) (domain.Answer, bool, error) {
	var id, status, kind string
	e := s.DB.Pool.QueryRow(ctx, `SELECT q.id,a.status,q.question_type FROM question_versions q JOIN exercises e ON e.id=q.exercise_id JOIN course_units u ON u.id=e.unit_id JOIN courses c ON c.id=u.course_id JOIN standard_answers a ON a.question_id=q.id WHERE c.classroom_id=$1 AND u.leaf_id=$2 AND e.platform_exercise_id=$3 AND q.problem_id=$4 AND q.fingerprint=$5 AND q.algorithm='canonical-v3' AND q.verified`, c.ClassroomID, ex.LeafID, ex.ExerciseID, p.ID, questions.Fingerprint(p)).Scan(&id, &status, &kind)
	if e != nil && e != pgx.ErrNoRows {
		return domain.Answer{}, false, e
	}
	if e == nil && status == "conflict" {
		return domain.Answer{}, false, nil
	}
	if e == nil && status == "captured" {
		a, e := readAnswer(ctx, s.DB.Pool, id, kind)
		if e != nil {
			return a, false, e
		}
		a, ok := questions.Extract(p, questions.AnswerSource(a))
		return a, ok, nil
	}
	rows, e := s.DB.Pool.Query(ctx, `SELECT q.id,q.fingerprint,q.question_type FROM question_versions q JOIN exercises e ON e.id=q.exercise_id JOIN course_units u ON u.id=e.unit_id JOIN courses c ON c.id=u.course_id JOIN standard_answers a ON a.question_id=q.id WHERE c.classroom_id=$1 AND u.leaf_id=$2 AND e.platform_exercise_id=$3 AND q.problem_id=$4 AND q.algorithm<>'canonical-v3' AND a.status IN ('captured','unverified')`, c.ClassroomID, ex.LeafID, ex.ExerciseID, p.ID)
	if e != nil {
		return domain.Answer{}, false, e
	}
	type candidate struct{ id, hash, kind string }
	var matches []candidate
	for rows.Next() {
		var v candidate
		if e = rows.Scan(&v.id, &v.hash, &v.kind); e != nil {
			rows.Close()
			return domain.Answer{}, false, e
		}
		if questions.Matches(p, v.hash, "legacy") {
			matches = append(matches, v)
		}
	}
	e = rows.Err()
	rows.Close()
	if e != nil {
		return domain.Answer{}, false, e
	}
	for _, v := range matches {
		a, e := readAnswer(ctx, s.DB.Pool, v.id, v.kind)
		if e != nil {
			return a, false, e
		}
		if verified, ok := questions.Extract(p, questions.AnswerSource(a)); ok {
			if e = s.Save(ctx, domain.Account{}, c, ex, p, questions.AnswerSource(verified), "legacy_verified"); e != nil {
				return a, false, e
			}
			return s.Lookup(ctx, c, ex, p)
		}
	}
	return domain.Answer{}, false, nil
}
func (s *Service) Coverage(ctx context.Context, inv domain.Inventory) (domain.Coverage, error) {
	out := domain.Coverage{}
	for _, ex := range inv.Exercises {
		for _, p := range ex.Problems {
			out.Total++
			_, ok, e := s.Lookup(ctx, inv.Course, ex, p)
			if e != nil {
				return out, e
			}
			if ok {
				out.Captured++
			} else {
				out.Missing++
			}
		}
	}
	return out, nil
}
func Equal(a, b domain.Answer) bool {
	left, _ := json.Marshal(a)
	right, _ := json.Marshal(b)
	return string(left) == string(right)
}
