package bank

import (
	"context"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"xuetangx/internal/domain"
	"xuetangx/internal/platform/wire"
	"xuetangx/internal/questions"
	"xuetangx/internal/secure"
)

// ObserveBatch records all already-fetched questions in one database transaction.
// This avoids opening two transactions per question during workflow preparation.
func (s *Service) ObserveBatch(ctx context.Context, a domain.Account, c domain.Course, exercises []domain.Exercise) error {
	return s.DB.Tx(ctx, func(tx pgx.Tx) error {
		for _, ex := range exercises {
			for _, p := range ex.Problems {
				source, _ := wire.Decode(p.User)
				answer, valid := questions.Extract(p, source)
				id, err := s.ensure(ctx, tx, c, ex, p)
				if err != nil {
					return err
				}
				if !valid {
					if questions.Kind(p) == "reference" && source["is_show_answer"] == true {
						v := source["answer"]
						if v == nil {
							v = source["answers"]
						}
						if v != nil {
							if _, err = tx.Exec(ctx, "UPDATE standard_answers SET status='reference',reference_text=$2 WHERE question_id=$1 AND status='missing'", id, string(wire.JSON(v))); err != nil {
								return err
							}
						}
					}
				} else if err = persistBatchAnswer(ctx, tx, id, answer, a, c, ex, p); err != nil {
					return err
				}
				count, err := questions.Count(p)
				if err != nil {
					continue
				}
				var right any
				if b, ok := source["is_right"].(bool); ok {
					right = b
				}
				if _, err = tx.Exec(ctx, `INSERT INTO account_question_states(account_id,question_id,my_count,is_right) VALUES($1,$2,$3,$4) ON CONFLICT(account_id,question_id) DO UPDATE SET my_count=excluded.my_count,is_right=excluded.is_right,checked_at=now()`, a.ID, id, count, right); err != nil {
					return err
				}
			}
		}
		return nil
	})
}

func persistBatchAnswer(ctx context.Context, tx pgx.Tx, id string, answer domain.Answer, a domain.Account, c domain.Course, ex domain.Exercise, p domain.Problem) error {
	var status string
	if err := tx.QueryRow(ctx, "SELECT status FROM standard_answers WHERE question_id=$1 FOR UPDATE", id).Scan(&status); err != nil {
		return err
	}
	newDigest := secure.Hash(string(wire.JSON(answer)))
	if status == "captured" {
		old, err := readAnswer(ctx, tx, id, answer.Type)
		if err != nil {
			return err
		}
		if secure.Hash(string(wire.JSON(old))) != newDigest {
			status = "conflict"
		}
	} else if status != "conflict" {
		status = "captured"
	}
	if _, err := tx.Exec(ctx, `INSERT INTO answer_sources(id,question_id,owner_id,account_id,source,answer_digest,evidence) VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(question_id,answer_digest,source) DO NOTHING`, uuid.NewString(), id, nullable(a.Owner), nullable(a.ID), "exercise_list", newDigest, wire.JSON(answer)); err != nil {
		return err
	}
	if _, err := tx.Exec(ctx, "UPDATE standard_answers SET status=$2,updated_at=now() WHERE question_id=$1", id, status); err != nil {
		return err
	}
	if status == "conflict" {
		return nil
	}
	if _, err := tx.Exec(ctx, "DELETE FROM answer_items WHERE question_id=$1", id); err != nil {
		return err
	}
	if err := writeAnswer(ctx, tx, id, answer); err != nil {
		return err
	}
	_, err := tx.Exec(ctx, `INSERT INTO event_outbox(topic,payload) VALUES('answer-ready',$1)`, wire.JSON(map[string]any{"classroomId": c.ClassroomID, "leafId": ex.LeafID, "problemId": p.ID, "fingerprint": questions.Fingerprint(p)}))
	return err
}
