package httpapi

import (
	"context"

	"xuetangx/internal/store"
)

// AdminPerformance uses only persisted, attributable results. Missing samples
// are null, not a fabricated zero or 100 percent success rate.
type AdminPerformance struct {
	AnswerAccuracyPercent        *float64 `json:"answerAccuracyPercent"`
	GradedAnswers                int64    `json:"gradedAnswers"`
	CompletedCourseJobs          int64    `json:"completedCourseJobs"`
	AverageCourseDurationSeconds *float64 `json:"averageCourseDurationSeconds"`
}

func readAdminPerformance(ctx context.Context, db *store.Store) (AdminPerformance, error) {
	var out AdminPerformance
	// A question observed before this service submitted it has no journal attempt.
	// Collectors also have attempts, so require a homework item for the same real
	// platform identity and an accepted attempt within that task's lifetime. This
	// preserves history after an account is disconnected/rebound (role can be null)
	// and after a retry rewrites a submitted item as skipped. A later homework task
	// cannot claim an earlier collection probe as its own submission.
	// Legacy journals do not record the sending role: exclude current private test
	// bindings and any accepted attempt overlapping a collector item for the same
	// identity/question. Ambiguous history is omitted rather than called accuracy.
	const answers = `WITH attributed AS (
		SELECT a.platform_user_id,o.classroom_id,o.leaf_id,o.problem_id,o.fingerprint,o.updated_at,o.id,
			CASE
				WHEN jsonb_typeof(o.result->'is_correct')='boolean'
				 AND jsonb_typeof(o.result->'is_right')='boolean'
				 AND o.result->'is_correct'<>o.result->'is_right' THEN NULL
				WHEN jsonb_typeof(o.result->'is_correct')='boolean' THEN (o.result->>'is_correct')::boolean
				WHEN jsonb_typeof(o.result->'is_right')='boolean' THEN (o.result->>'is_right')::boolean
			END AS correct
		FROM operations o JOIN platform_accounts a ON a.id=o.account_id
		WHERE o.kind='question' AND o.state IN ('posted','confirmed') AND o.attempt>0
			AND o.fingerprint<>'' AND NOT a.shared_collector AND a.role IS DISTINCT FROM 'test'
			AND EXISTS (
				SELECT 1 FROM operation_attempts t
				JOIN jobs j ON j.created_at<=t.created_at
				JOIN platform_accounts ja ON ja.id=j.account_id
				JOIN courses c ON c.id=j.course_id
				JOIN job_items i ON i.job_id=j.id AND i.kind='homework'
				WHERE t.operation_id=o.id AND t.state IN ('posted','confirmed')
					AND ja.platform_user_id=a.platform_user_id AND NOT ja.shared_collector
					AND c.classroom_id=o.classroom_id AND i.leaf_id=o.leaf_id AND i.problem_id=o.problem_id
					AND i.updated_at>=t.created_at
			)
			AND NOT EXISTS (
				SELECT 1 FROM operation_attempts t
				JOIN jobs j ON j.created_at<=t.created_at
				JOIN platform_accounts ja ON ja.id=j.account_id
				JOIN courses c ON c.id=j.course_id
				JOIN job_items i ON i.job_id=j.id AND i.kind='collector'
				WHERE t.operation_id=o.id AND t.state IN ('posted','confirmed')
					AND ja.platform_user_id=a.platform_user_id
					AND c.classroom_id=o.classroom_id AND i.leaf_id=o.leaf_id AND i.problem_id=o.problem_id
					AND i.updated_at>=t.created_at
			)
	), unique_results AS (
		SELECT DISTINCT ON (platform_user_id,classroom_id,leaf_id,problem_id,fingerprint) correct
		FROM attributed
		ORDER BY platform_user_id,classroom_id,leaf_id,problem_id,fingerprint,updated_at DESC,id
	)
	SELECT count(correct),100.0*count(*) FILTER (WHERE correct)/NULLIF(count(correct),0)
	FROM unique_results`
	if err := db.Pool.QueryRow(ctx, answers).Scan(&out.GradedAnswers, &out.AnswerAccuracyPercent); err != nil {
		return out, err
	}
	// jobs.updated_at also changes on harmless re-aggregation. Item timestamps
	// instead identify the last confirmed result, including final rechecks. This is
	// elapsed time from creation, including queue/platform waits and any pauses,
	// not active worker time. Already-complete/skipped items remain valid samples.
	const durations = `WITH module_results AS (
		SELECT j.id,j.created_at,m.kind,m.total,m.status,
			count(i.job_id) AS item_count,
			count(i.job_id) FILTER (WHERE i.status IN ('completed','skipped')) AS completed_count,
			max(i.updated_at) AS finished_at
		FROM jobs j JOIN platform_accounts a ON a.id=j.account_id
		JOIN job_modules m ON m.job_id=j.id AND m.kind IN ('video','article','discussion','homework')
		LEFT JOIN job_items i ON i.job_id=m.job_id AND i.kind=m.kind
		WHERE j.status='done' AND NOT a.shared_collector
			AND j.unit_id IS NULL AND j.targets='[]'::jsonb
		GROUP BY j.id,j.created_at,m.kind,m.total,m.status
	), completed_courses AS (
		SELECT id,extract(epoch FROM max(finished_at)-created_at) AS duration
		FROM module_results
		GROUP BY id,created_at
		HAVING count(*)=4 AND bool_and(status='done' AND total=item_count AND item_count=completed_count)
			AND sum(item_count)>0 AND max(finished_at)>=created_at
	)
	SELECT count(*),avg(duration) FROM completed_courses`
	err := db.Pool.QueryRow(ctx, durations).Scan(&out.CompletedCourseJobs, &out.AverageCourseDurationSeconds)
	return out, err
}
