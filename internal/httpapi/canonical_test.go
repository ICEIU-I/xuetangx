package httpapi

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"testing/fstest"
	"xuetangx/internal/auth"
	"xuetangx/internal/workflow"
)

func canonicalServer() *Server {
	s := New(&auth.Service{BaseURL: "https://primary.test"}, nil, &workflow.Engine{}, nil)
	s.Assets = fstest.MapFS{"index.html": {Data: []byte("<html>app</html>")}, "assets/app.js": {Data: []byte("console.log('app')")}}
	return s
}

func TestCanonicalPageRedirect(t *testing.T) {
	s := canonicalServer()
	for _, tc := range []struct{ method, path, want string }{
		{"GET", "/", "https://primary.test/"},
		{"HEAD", "/learn", "https://primary.test/learn"},
		{"GET", "/tasks/abc?tab=info", "https://primary.test/tasks/abc?tab=info"},
		{"GET", "/admin/answers?course=12&next=https%3A%2F%2Fevil.test", "https://primary.test/admin/answers?course=12&next=https%3A%2F%2Fevil.test"},
		{"GET", "/tasks/a%2Fb?q=%26", "https://primary.test/tasks/a%2Fb?q=%26"},
		{"GET", "/index.html", "https://primary.test/index.html"},
	} {
		r := httptest.NewRequest(tc.method, "https://legacy.test"+tc.path, nil)
		r.Header.Set("X-Forwarded-Host", "evil.test")
		r.Header.Set("X-Forwarded-Proto", "http")
		w := httptest.NewRecorder()
		s.Handler().ServeHTTP(w, r)
		if w.Code != 302 || w.Header().Get("Location") != tc.want {
			t.Errorf("%s: %d %q", tc.path, w.Code, w.Header().Get("Location"))
		}
		if w.Header().Get("Cache-Control") != "no-store" {
			t.Error("migration redirect must not be cached")
		}
		if strings.Contains(w.Header().Get("Location"), "#") {
			t.Error("fragment inheritance must remain intact")
		}
		if tc.method == "HEAD" && w.Body.Len() != 0 {
			t.Error("HEAD must be bodyless")
		}
	}
}

func TestCanonicalHostAndNonHTMLRequestsAreUnchanged(t *testing.T) {
	s := canonicalServer()
	for _, host := range []string{"primary.test", "PRIMARY.TEST", "primary.test:443"} {
		r := httptest.NewRequest("GET", "http://"+host+"/learn", nil) // HTTP backend behind HTTPS proxy
		w := httptest.NewRecorder()
		s.Handler().ServeHTTP(w, r)
		if w.Code != 200 || w.Header().Get("Location") != "" {
			t.Errorf("canonical host loop %s: %d", host, w.Code)
		}
	}
	for _, tc := range []struct {
		method, path, origin string
		want                 int
	}{
		{"GET", "/assets/app.js", "", 200}, {"GET", "/missing.js", "", 404},
		{"GET", "/health/live", "", 200}, {"GET", "/api/auth/config", "", 503},
		{"GET", "/api/missing", "", 404},
		{"POST", "/api/auth/register", "https://legacy.test", 403},
		{"POST", "/api/auth/login", "https://primary.test", 400}, // reaches body validation, not DB
		{"POST", "/learn", "https://primary.test", 404},
	} {
		r := httptest.NewRequest(tc.method, "https://legacy.test"+tc.path, nil)
		r.Header.Set("Origin", tc.origin)
		w := httptest.NewRecorder()
		s.Handler().ServeHTTP(w, r)
		if w.Code != tc.want || w.Header().Get("Location") != "" {
			t.Errorf("%s %s: %d redirect %q", tc.method, tc.path, w.Code, w.Header().Get("Location"))
		}
	}
	s.Auth.BaseURL = "http://localhost:8788"
	r := httptest.NewRequest("GET", "http://127.0.0.1:8788/", nil)
	w := httptest.NewRecorder()
	s.Handler().ServeHTTP(w, r)
	if w.Code != 200 {
		t.Fatalf("development host changed: %d", w.Code)
	}
	s.Auth.BaseURL = "https://primary.test"
	for _, path := range []string{"/health", "/health/unknown", "/api", "/api/unknown"} {
		r := httptest.NewRequest("GET", "https://legacy.test"+path, nil)
		if s.redirectToPublicSite(httptest.NewRecorder(), r) {
			t.Errorf("service namespace redirected: %s", path)
		}
	}
}

func TestRedirectNeverUsesRequestAuthority(t *testing.T) {
	s := canonicalServer()
	r := httptest.NewRequest("GET", "https://attacker.test//evil.test/path", nil)
	w := httptest.NewRecorder()
	if !s.redirectToPublicSite(w, r) || w.Header().Get("Location") != "https://primary.test//evil.test/path" {
		t.Fatal("request controlled destination")
	}
	for _, method := range []string{http.MethodPost, http.MethodPatch, http.MethodDelete} {
		r.Method = method
		w = httptest.NewRecorder()
		if s.redirectToPublicSite(w, r) {
			t.Error("write must never be redirected")
		}
	}
}
