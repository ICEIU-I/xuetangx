package catalog_test

import (
	"testing"
	"xuetangx/internal/catalog"
	"xuetangx/internal/domain"
)

func TestChoicesKeepOptionalFixedAndDeduplicateEnrolled(t *testing.T) {
	fixed := catalog.FixedCourse()
	other := domain.Course{ClassroomID: 42, Title: "Math", URL: "https://www.xuetangx.com/learn/space/math/math/42"}
	got := catalog.Choices(fixed, []domain.Course{other, other, fixed})
	if len(got) != 2 || !got[0].Fixed || !got[0].Enrolled || !got[1].Enrolled || got[1].Fixed {
		t.Fatal(got)
	}
	empty := catalog.Choices(fixed, nil)
	if len(empty) != 1 || !empty[0].Fixed || empty[0].Enrolled {
		t.Fatal(empty)
	}
}
