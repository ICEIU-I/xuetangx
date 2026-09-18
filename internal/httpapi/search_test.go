package httpapi

import (
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
)

func TestSearchQueryLimitAndWhitespace(t *testing.T) {
	for _, tc := range []struct {
		q, want string
		fail    bool
	}{{"  物理  ", "物理", false}, {strings.Repeat("中", 200), strings.Repeat("中", 200), false}, {strings.Repeat("中", 201), "", true}, {"%_", "%_", false}} {
		got, err := searchQuery(httptest.NewRequest("GET", "/?q="+url.QueryEscape(tc.q), nil))
		if (err != nil) != tc.fail || got != tc.want {
			t.Fatalf("got %q err %v", got, err)
		}
	}
}
