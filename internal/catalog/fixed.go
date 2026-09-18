package catalog

import "xuetangx/internal/domain"

// FixedCourse is the course shown by the unified workflow for every user.
// The classroom is the 2026 autumn offering already present in this project's
// answer bank.
const (
	FixedCourseTitle       = "大学物理（2）(2026秋)"
	FixedCourseSign        = "ncepu0702bt1359"
	FixedCourseClassroomID = int64(31384299)
)

func FixedCourse() domain.Course {
	return domain.Course{
		ClassroomID: FixedCourseClassroomID,
		Sign:        FixedCourseSign,
		CourseSign:  FixedCourseSign,
		Title:       FixedCourseTitle,
		URL:         "https://www.xuetangx.com/learn/space/ncepu0702bt1359/ncepu0702bt1359/31384299",
	}
}

func IsFixedCourse(c domain.Course) bool {
	return c.ClassroomID == FixedCourseClassroomID && c.Sign == FixedCourseSign && c.CourseSign == FixedCourseSign
}
