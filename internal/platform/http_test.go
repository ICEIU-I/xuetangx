package platform

import "testing"

func TestCourseScoreEndpointIsReadOnly(t *testing.T) {
	if !ReadOnly("GET", "/api/v1/lms/learn/get_evaluation_detail/?cid=31384299&sign=ncepu0702bt1359") {
		t.Fatal("evaluation detail must use the read-only transport")
	}
	if !ReadOnly("GET", "/api/v1/lms/learn/course/user-score?cid=31384299&sign=ncepu0702bt1359&is_refresh=true") {
		t.Fatal("course score must use the read-only transport")
	}
	if ReadOnly("POST", "/api/v1/lms/learn/course/user-score") {
		t.Fatal("course score POST must not be allowed")
	}
}
