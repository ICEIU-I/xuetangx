package httpapi

import (
	"context"
	"encoding/json"
	"math"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/google/uuid"
	"xuetangx/internal/auth"
	"xuetangx/internal/domain"
	"xuetangx/internal/store"
	"xuetangx/internal/testkit"
	"xuetangx/internal/workflow"
)

type performanceFixture struct {
	t     *testing.T
	db    *store.Store
	a     domain.Account
	c     domain.Course
	start time.Time
}

func newPerformanceFixture(t *testing.T) *performanceFixture {
	db := testkit.Database(t)
	a, c := testkit.Seed(t, db)
	return &performanceFixture{t, db, a, c, time.Date(2026, 9, 1, 0, 0, 0, 0, time.UTC)}
}

func (f *performanceFixture) exec(query string, args ...any) {
	f.t.Helper()
	if _, err := f.db.Pool.Exec(context.Background(), query, args...); err != nil {
		f.t.Fatal(err)
	}
}

func (f *performanceFixture) read() AdminPerformance {
	f.t.Helper()
	out, err := readAdminPerformance(context.Background(), f.db)
	if err != nil {
		f.t.Fatal(err)
	}
	return out
}

func (f *performanceFixture) job(status string) string {
	id := uuid.NewString()
	f.exec(`INSERT INTO jobs(id,owner_id,account_id,course_id,status,concurrency,created_at,updated_at) VALUES($1,$2,$3,$4,$5,1,$6,$7)`, id, f.a.Owner, f.a.ID, f.c.ID, status, f.start, f.start.Add(24*time.Hour))
	return id
}

func (f *performanceFixture) module(job, kind, status string, total int) {
	f.exec(`INSERT INTO job_modules(job_id,kind,status,total) VALUES($1,$2,$3,$4)`, job, kind, status, total)
}

func (f *performanceFixture) item(job, kind, status string, problem int64, seconds int) {
	f.exec(`INSERT INTO job_items(job_id,kind,leaf_id,problem_id,status,updated_at) VALUES($1,$2,34,$3,$4,$5)`, job, kind, problem, status, f.start.Add(time.Duration(seconds)*time.Second))
}

func TestAdminPerformanceEmptySamplesAreNull(t *testing.T) {
	f := newPerformanceFixture(t)
	out := f.read()
	if out.GradedAnswers != 0 || out.AnswerAccuracyPercent != nil || out.CompletedCourseJobs != 0 || out.AverageCourseDurationSeconds != nil {
		t.Fatalf("empty samples: %+v", out)
	}
	s := &Server{Auth: &auth.Service{DB: f.db}, Engine: &workflow.Engine{}}
	w := httptest.NewRecorder()
	s.metrics(w, httptest.NewRequest("GET", "/api/admin/metrics", nil))
	var body struct {
		Performance map[string]any `json:"performance"`
	}
	if w.Code != 200 || json.Unmarshal(w.Body.Bytes(), &body) != nil || len(body.Performance) != 4 || body.Performance["answerAccuracyPercent"] != nil || body.Performance["averageCourseDurationSeconds"] != nil {
		t.Fatalf("metrics JSON: %d %s", w.Code, w.Body.String())
	}
}

func TestAdminPerformanceAnswersUseAttributableGradedSubmissions(t *testing.T) {
	f := newPerformanceFixture(t)
	job := f.job("partial")
	f.module(job, "homework", "partial", 20)
	type sample struct {
		problem             int64
		result, state, item string
		attempt             int
		stamp               int
		recorded            bool
	}
	cases := []sample{
		{1, `{"is_correct":true}`, "posted", "completed", 1, 10, true},
		{2, `{"is_right":false}`, "confirmed", "failed", 3, 10, true},
		// A later retry sees our own completed submission as skipped: keep it.
		{3, `{"is_right":true}`, "confirmed", "skipped", 2, 10, true},
		{4, `{"is_correct":"true"}`, "posted", "failed", 1, 10, true},
		{5, `{"is_correct":true,"is_right":false}`, "confirmed", "failed", 1, 10, true},
		{6, `{"is_correct":true}`, "unknown", "failed", 1, 10, true},
		{7, `{"is_correct":true}`, "pending", "failed", 1, 10, true},
		// Pre-existing/imported answer, no local send attempt.
		{8, `{"is_right":true}`, "confirmed", "skipped", 0, 10, false},
		{9, `{"is_right":true}`, "confirmed", "skipped", 1, 10, false},
		// Earlier test-account probe before the formal task was created.
		{10, `{"is_right":false}`, "confirmed", "wrong_existing", 1, -10, true},
		// Collector-only submission: no matching formal homework item.
		{11, `{"is_correct":false}`, "posted", "", 1, 10, true},
		{12, `{}`, "posted", "failed", 1, 10, true},
	}
	var first string
	for _, v := range cases {
		id := uuid.NewString()
		f.exec(`INSERT INTO operations(id,op_key,owner_id,account_id,classroom_id,leaf_id,problem_id,kind,fingerprint,state,attempt,result,updated_at) VALUES($1::uuid,$1::text,$2,$3,12,34,$4,'question','version',$5,$6,$7,$8)`, id, f.a.Owner, f.a.ID, v.problem, v.state, v.attempt, v.result, f.start.Add(30*time.Second))
		if v.recorded {
			for n := 1; n <= v.attempt; n++ {
				state := "rejected"
				if n == v.attempt {
					state = v.state
				}
				f.exec(`INSERT INTO operation_attempts(id,operation_id,sequence,state,created_at) VALUES($1,$2,$3,$4,$5)`, uuid.NewString(), id, n, state, f.start.Add(time.Duration(v.stamp)*time.Second))
			}
		}
		if v.item != "" {
			f.item(job, "homework", v.item, v.problem, 60)
		}
		if v.problem == 1 {
			first = id
		}
	}
	// A duplicate legacy journal must not double-count one platform question.
	duplicate := uuid.NewString()
	f.exec(`INSERT INTO operations(id,op_key,owner_id,account_id,classroom_id,leaf_id,problem_id,kind,fingerprint,state,attempt,result,updated_at) SELECT $1::uuid,$1::text,owner_id,account_id,classroom_id,leaf_id,problem_id,kind,fingerprint,state,attempt,result,updated_at FROM operations WHERE id=$2`, duplicate, first)
	f.exec(`INSERT INTO operation_attempts(id,operation_id,sequence,state,created_at) VALUES($1,$2,1,'posted',$3)`, uuid.NewString(), duplicate, f.start.Add(10*time.Second))
	// Account switching clears role, but must not erase attributable history.
	f.exec(`UPDATE platform_accounts SET role=NULL,valid=false WHERE id=$1`, f.a.ID)
	out := f.read()
	if out.GradedAnswers != 3 || out.AnswerAccuracyPercent == nil || math.Abs(*out.AnswerAccuracyPercent-200.0/3) > 0.000001 {
		t.Fatalf("graded submission metrics: %+v", out)
	}
	// Journal keys follow the real platform identity. A later private binding can
	// perform an accepted retry in the original journal, with its own task item.
	otherOwner, otherAccount := uuid.NewString(), uuid.NewString()
	f.exec(`INSERT INTO users(id,email,password_hash,verified) VALUES($1,$2,'hash',true)`, otherOwner, otherOwner+"@example.test")
	f.exec(`INSERT INTO platform_accounts(id,owner_id,platform_user_id,role) VALUES($1,$2,$3,'primary')`, otherAccount, otherOwner, f.a.UserID)
	f.exec(`UPDATE jobs SET owner_id=$2,account_id=$3 WHERE id=$1`, job, otherOwner, otherAccount)
	out = f.read()
	if out.GradedAnswers != 3 || out.AnswerAccuracyPercent == nil || math.Abs(*out.AnswerAccuracyPercent-200.0/3) > 0.000001 {
		t.Fatalf("cross-binding accepted journal attempts disappeared: %+v", out)
	}
	// A private test binding for that same platform user must not be attributed
	// to another owner's overlapping homework task.
	f.exec(`UPDATE platform_accounts SET role='test' WHERE id=$1`, f.a.ID)
	if out = f.read(); out.GradedAnswers != 0 || out.AnswerAccuracyPercent != nil {
		t.Fatalf("private test submission included: %+v", out)
	}
	// Role is cleared on account switch. Collector items still identify ambiguous
	// submission history; exclude even when the formal task also observed it.
	f.exec(`UPDATE platform_accounts SET role=NULL WHERE id=$1`, f.a.ID)
	collector := f.job("done")
	f.module(collector, "collector", "done", 3)
	for _, problem := range []int64{1, 2, 3} {
		f.item(collector, "collector", "completed", problem, 50)
	}
	if out = f.read(); out.GradedAnswers != 0 || out.AnswerAccuracyPercent != nil {
		t.Fatalf("ambiguous collector overlap included after role cleared: %+v", out)
	}
	// Non-overlapping read-only collection does not erase formal submissions.
	f.exec(`UPDATE jobs SET created_at=$2 WHERE id=$1`, collector, f.start.Add(20*time.Second))
	if out = f.read(); out.GradedAnswers != 3 {
		t.Fatalf("later collection erased formal submissions: %+v", out)
	}
	// Shared collection identities are never included, even with malformed legacy jobs.
	f.exec(`UPDATE platform_accounts SET shared_collector=true WHERE id=$1`, f.a.ID)
	if out = f.read(); out.GradedAnswers != 0 || out.AnswerAccuracyPercent != nil {
		t.Fatalf("collector included: %+v", out)
	}
}

func TestAdminPerformanceDurationRequiresCompleteWholeCourse(t *testing.T) {
	f := newPerformanceFixture(t)
	full := func(seconds int, itemStatus string) string {
		job := f.job("done")
		for _, kind := range []string{"video", "article", "discussion", "homework"} {
			f.module(job, kind, "done", 1)
			f.item(job, kind, itemStatus, 1, seconds)
		}
		return job
	}
	one := full(60, "completed")
	full(180, "completed")
	full(3, "skipped")
	for _, status := range []string{"paused", "partial", "stopped", "running"} {
		job := full(10000, "completed")
		f.exec(`UPDATE jobs SET status=$2 WHERE id=$1`, job, status)
	}
	for _, status := range []string{"failed", "wrong_existing", "retrying"} {
		full(10000, status)
	}
	missing := full(10000, "completed")
	f.exec(`DELETE FROM job_items WHERE job_id=$1 AND kind='video'`, missing)
	f.exec(`DELETE FROM job_modules WHERE job_id=$1 AND kind='video'`, missing)
	incomplete := full(10000, "completed")
	f.exec(`UPDATE job_modules SET total=2 WHERE job_id=$1 AND kind='video'`, incomplete)
	partial := full(10000, "completed")
	f.exec(`UPDATE job_modules SET status='partial' WHERE job_id=$1 AND kind='homework'`, partial)
	scoped := full(10000, "completed")
	f.exec(`UPDATE jobs SET targets='["some exercise"]' WHERE id=$1`, scoped)
	single := full(10000, "completed")
	f.exec(`UPDATE jobs SET unit_id=34 WHERE id=$1`, single)
	empty := f.job("done")
	for _, kind := range []string{"video", "article", "discussion", "homework"} {
		f.module(empty, kind, "done", 0)
	}
	full(-1, "completed")
	// Jobs are touched on repeated aggregate calls; that cannot inflate elapsed time.
	f.exec(`UPDATE jobs SET updated_at=$2 WHERE id=$1`, one, f.start.Add(365*24*time.Hour))
	f.exec(`UPDATE platform_accounts SET role=NULL WHERE id=$1`, f.a.ID)
	out := f.read()
	if out.CompletedCourseJobs != 3 || out.AverageCourseDurationSeconds == nil || *out.AverageCourseDurationSeconds != 81 {
		t.Fatalf("whole-course metrics: %+v", out)
	}
}
