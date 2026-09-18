package catalog

import (
	"context"
	"net/url"
	"strconv"
	"xuetangx/internal/domain"
	"xuetangx/internal/platform/wire"
)

// CourseScore contains only the platform's account-specific course grade.
// Missing grades remain unavailable; a legitimate zero is still a grade.
type CourseScore struct {
	Course    domain.Course
	Value     float64
	Available bool
}

func (s *Service) Score(ctx context.Context, a domain.Account, target domain.Course) (CourseScore, error) {
	course, err := s.Authorize(ctx, a, target)
	if err != nil {
		return CourseScore{}, err
	}
	q := url.Values{"cid": {strconv.FormatInt(course.ClassroomID, 10)}, "sign": {course.Sign}, "is_refresh": {"true"}}
	d, err := s.Data(ctx, a, "GET", "/api/v1/lms/learn/course/user-score?"+q.Encode(), nil)
	if err != nil {
		return CourseScore{}, err
	}
	// The official course page reads data.user_score on a 100-point scale.
	value, ok := wire.Number(d["user_score"])
	return CourseScore{Course: course, Value: value, Available: ok && value >= 0 && value <= 100}, nil
}
