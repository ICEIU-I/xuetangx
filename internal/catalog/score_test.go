package catalog

import (
	"context"
	"testing"
	"xuetangx/internal/domain"
	"xuetangx/internal/platform"
	"xuetangx/internal/platform/wire"
)

func TestScoreReadsEvaluationDetailWithoutCourseList(t *testing.T) {
	var got string
	svc := &Service{Request: func(_ context.Context, _ domain.Account, method, path string, _ any) (platform.Response, error) {
		got = method + " " + path
		return platform.Response{Status: 200, JSON: wire.Object{"success": true, "data": wire.Object{
			"total_score_and_schedule": wire.Object{"user_score": 70.0},
			"score_detail":             []any{wire.Object{"evaluation_name": "Exam", "evaluation_score": 30, "proportion": 30, "use_evaluation_score": "0.0"}},
		}}}, nil
	}}
	score, err := svc.Score(context.Background(), domain.Account{UserID: 101}, FixedCourse())
	if err != nil {
		t.Fatal(err)
	}
	if got != "GET /api/v1/lms/learn/get_evaluation_detail/?cid=31384299&sign=ncepu0702bt1359" {
		t.Fatalf("request %q", got)
	}
	if !score.Available || score.Value != 70 || len(score.Breakdown) != 1 || score.Breakdown[0].Value == nil || *score.Breakdown[0].Value != 0 {
		t.Fatalf("unexpected score %#v", score)
	}
}

func TestScoreKeepsLegitimateZero(t *testing.T) {
	svc := &Service{Request: func(context.Context, domain.Account, string, string, any) (platform.Response, error) {
		return platform.Response{Status: 200, JSON: wire.Object{"success": true, "data": wire.Object{"total_score_and_schedule": wire.Object{"user_score": 0}}}}, nil
	}}
	score, err := svc.Score(context.Background(), domain.Account{}, FixedCourse())
	if err != nil || !score.Available || score.Value != 0 {
		t.Fatalf("zero score lost: %#v %v", score, err)
	}
}
