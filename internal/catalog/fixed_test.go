package catalog_test

import (
	"testing"
	"xuetangx/internal/catalog"
)

func TestFixedCourseMatchesAnswerBankCourse(t *testing.T) {
	c := catalog.FixedCourse()
	if c.Title != "大学物理2" || c.ClassroomID != 31384299 || c.Sign != "ncepu0702bt1359" || c.CourseSign != c.Sign {
		t.Fatalf("unexpected fixed course: %+v", c)
	}
	if !catalog.IsFixedCourse(c) {
		t.Fatal("fixed course was not recognized")
	}
}
