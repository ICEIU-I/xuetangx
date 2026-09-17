package operations

import (
	"context"
	"encoding/json"
	"fmt"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"xuetangx/internal/domain"
	"xuetangx/internal/fault"
	"xuetangx/internal/platform/wire"
	"xuetangx/internal/store"
)

type Journal struct{ DB *store.Store }
type Record struct {
	ID, Key, State   string
	Retries, Attempt int
	Retryable        bool
	Result           wire.Object
}

func (j *Journal) Load(ctx context.Context, key, kind string, a domain.Account, c domain.Course, leaf, problem int64, fingerprint string) (Record, error) {
	r := Record{Key: key}
	var raw []byte
	e := j.DB.Tx(ctx, func(tx pgx.Tx) error {
		var blocked bool
		if e := tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM migration_blocks WHERE classroom_id=$1 AND (owner_id=$2 OR owner_id IS NULL) AND resolved_at IS NULL)`, c.ClassroomID, a.Owner).Scan(&blocked); e != nil {
			return e
		}
		if blocked {
			return fault.New("REVIEW_REQUIRED", "该课程存在尚未处理的旧数据迁移记录")
		}
		if _, e := tx.Exec(ctx, `INSERT INTO operations(id,op_key,owner_id,account_id,classroom_id,leaf_id,problem_id,kind,fingerprint,state) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,'new') ON CONFLICT(op_key) DO NOTHING`, uuid.NewString(), key, a.Owner, a.ID, c.ClassroomID, leaf, problem, kind, fingerprint); e != nil {
			return e
		}
		return tx.QueryRow(ctx, `SELECT id,state,network_retries,attempt,retryable,result FROM operations WHERE op_key=$1 AND owner_id=$2 AND account_id=$3`, key, a.Owner, a.ID).Scan(&r.ID, &r.State, &r.Retries, &r.Attempt, &r.Retryable, &raw)
	})
	if e == nil {
		r.Result, _ = wire.Decode(raw)
	}
	return r, e
}
func (j *Journal) Save(ctx context.Context, r *Record, state string, retries int, retryable bool, result wire.Object) error {
	next := r.Attempt
	if state == "pending" {
		next++
	}
	if result == nil {
		result = r.Result
	}
	if result == nil {
		result = wire.Object{}
	}
	e := j.DB.Tx(ctx, func(tx pgx.Tx) error {
		tag, e := tx.Exec(ctx, `UPDATE operations SET state=$2,network_retries=$3,attempt=$4,retryable=$5,result=$6,updated_at=now() WHERE id=$1 AND state=$7 AND attempt=$8 AND network_retries=$9`, r.ID, state, retries, next, retryable, wire.JSON(result), r.State, r.Attempt, r.Retries)
		if e != nil {
			return e
		}
		if tag.RowsAffected() != 1 {
			return fault.New("OPERATION_CONFLICT", "操作状态已变化，请重新核对")
		}
		if next > 0 {
			_, e = tx.Exec(ctx, `INSERT INTO operation_attempts(id,operation_id,sequence,state) VALUES($1,$2,$3,$4) ON CONFLICT(operation_id,sequence) DO UPDATE SET state=excluded.state`, uuid.NewString(), r.ID, next, state)
		}
		return e
	})
	if e == nil {
		r.State = state
		r.Retries = retries
		r.Attempt = next
		r.Retryable = retryable
		r.Result = result
	}
	return e
}
func (j *Journal) PreserveLegacy(ctx context.Context, r *Record, a domain.Account, c domain.Course, leaf, problem int64, hashes []string) error {
	rows, e := j.DB.Pool.Query(ctx, `SELECT state,network_retries,retryable,result FROM operations WHERE account_id=$1 AND classroom_id=$2 AND leaf_id=$3 AND problem_id=$4 AND kind='question' AND id<>$5 AND (fingerprint=ANY($6) OR fingerprint='')`, a.ID, c.ClassroomID, leaf, problem, r.ID, hashes)
	if e != nil {
		return e
	}
	type old struct {
		state     string
		retries   int
		retryable bool
		raw       []byte
	}
	var values []old
	for rows.Next() {
		var v old
		if e = rows.Scan(&v.state, &v.retries, &v.retryable, &v.raw); e != nil {
			rows.Close()
			return e
		}
		values = append(values, v)
	}
	e = rows.Err()
	rows.Close()
	if e != nil {
		return e
	}
	if r.State != "new" || len(values) == 0 {
		return nil
	}
	state := "unknown"
	retries := 0
	retryable := true
	result := wire.Object{}
	for _, v := range values {
		retries = max(retries, v.retries)
		retryable = retryable && v.retryable
		if v.state == "confirmed" || v.state == "posted" {
			state = v.state
			_ = json.Unmarshal(v.raw, &result)
		}
	}
	return j.Save(ctx, r, state, min(retries, 2), retryable, result)
}
func Key(kind string, a domain.Account, c domain.Course, leaf, problem int64, suffix string) string {
	return fmt.Sprintf("%s:%d:%d:%d:%d:%s", kind, a.UserID, c.ClassroomID, leaf, problem, suffix)
}
