package catalog

import (
	"context"
	"net/url"
	"strconv"
	"xuetangx/internal/domain"
	"xuetangx/internal/platform/wire"
)

// ScorePart contains only grade contributions, not individual learning records.
type ScorePart struct {
	Name    string   `json:"name"`
	Value   *float64 `json:"score"`
	Maximum *float64 `json:"maximum"`
	Weight  *float64 `json:"weight"`
}
type CourseScore struct {
	Course    domain.Course
	Value     float64
	Available bool
	Breakdown []ScorePart
}

func gradeNumber(v any) *float64 {
	n, ok := wire.Number(v)
	if !ok || n < 0 || n > 100 {
		return nil
	}
	return &n
}

func (s *Service) Score(ctx context.Context, a domain.Account, course domain.Course) (CourseScore, error) {
	// The official progress page authorizes this read against the requesting
	// account. Do not gate it on user-courses?status=1: that filtered list can be
	// empty even when the account can still view its course and grade.
	q := url.Values{"cid": {strconv.FormatInt(course.ClassroomID, 10)}, "sign": {course.Sign}}
	d, err := s.Data(ctx, a, "GET", "/api/v1/lms/learn/get_evaluation_detail/?"+q.Encode(), nil)
	if err != nil {
		return CourseScore{}, err
	}
	score := CourseScore{Course: course, Breakdown: []ScorePart{}}
	if value := gradeNumber(wire.Obj(d["total_score_and_schedule"])["user_score"]); value != nil {
		score.Value, score.Available = *value, true
	}
	list, _ := d["score_detail"].([]any)
	for _, raw := range list {
		item := wire.Obj(raw)
		name := wire.String(item["evaluation_name"])
		if name == "" {
			continue
		}
		score.Breakdown = append(score.Breakdown, ScorePart{
			Name: name, Value: gradeNumber(item["use_evaluation_score"]),
			Maximum: gradeNumber(item["evaluation_score"]), Weight: gradeNumber(item["proportion"]),
		})
	}
	return score, nil
}
