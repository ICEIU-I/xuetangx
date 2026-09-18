package httpapi

import (
	"net/http"
	"net/http/httptest"
	"testing"
	"xuetangx/internal/auth"
)

func TestAllowedOriginsAreExactAndOptIn(t *testing.T) {
	s := &Server{Auth: &auth.Service{BaseURL: "https://primary.test"}}
	if s.allowsOrigin("https://legacy.test") {
		t.Fatal("alternate must be opt in")
	}
	s.AllowedOrigins = []string{"https://legacy.test"}
	for _, origin := range []string{"https://primary.test", "https://legacy.test"} {
		if !s.allowsOrigin(origin) {
			t.Errorf("rejected %s", origin)
		}
	}
	for _, origin := range []string{"", "null", "https://evil.test", "http://legacy.test", "https://legacy.test.evil.test", "https://sub.legacy.test", "https://legacy.test:8443", "https://legacy.test/", "https://legacy.test, https://primary.test"} {
		if s.allowsOrigin(origin) {
			t.Errorf("accepted %s", origin)
		}
	}
}

func TestOriginMiddlewarePreservesBoundary(t *testing.T) {
	s := &Server{Auth: &auth.Service{BaseURL: "https://primary.test"}, AllowedOrigins: []string{"https://legacy.test"}}
	handler := s.middleware(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { w.WriteHeader(204) }))
	for _, tc := range []struct {
		method, origin string
		want           int
	}{
		{"POST", "https://legacy.test", 204}, {"PATCH", "https://primary.test", 204},
		{"POST", "https://evil.test", 403}, {"POST", "null", 403},
		{"GET", "https://evil.test", 204}, {"POST", "", 204}, // CLI/no-origin behavior unchanged.
	} {
		r := httptest.NewRequest(tc.method, "https://legacy.test/api/auth/login", nil)
		r.Header.Set("Origin", tc.origin)
		r.Header.Set("X-Forwarded-Host", "primary.test")
		w := httptest.NewRecorder()
		handler.ServeHTTP(w, r)
		if w.Code != tc.want {
			t.Errorf("%s %s: got %d want %d", tc.method, tc.origin, w.Code, tc.want)
		}
		if w.Header().Get("Access-Control-Allow-Origin") != "" {
			t.Fatal("must not enable cross-origin reads")
		}
	}
}
