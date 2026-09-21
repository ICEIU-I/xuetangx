package catalog

import "xuetangx/internal/domain"

// CourseChoice keeps the fixed entry visible without treating it as enrollment.
type CourseChoice struct {
	domain.Course
	Fixed    bool `json:"fixed"`
	Enrolled bool `json:"enrolled"`
}

func Choices(fixed domain.Course, enrolled []domain.Course) []CourseChoice {
	out := []CourseChoice{{Course: fixed, Fixed: true}}
	seen := map[int64]bool{fixed.ClassroomID: true}
	for _, c := range enrolled {
		if IsFixedCourse(c) {
			out[0] = CourseChoice{Course: c, Fixed: true, Enrolled: true}
			continue
		}
		if seen[c.ClassroomID] {
			continue
		}
		seen[c.ClassroomID] = true
		out = append(out, CourseChoice{Course: c, Enrolled: true})
	}
	return out
}
