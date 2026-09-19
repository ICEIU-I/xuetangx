package httpapi_test

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"regexp"
	"strings"
	"testing"

	"xuetangx/internal/auth"
	"xuetangx/internal/httpapi"
	"xuetangx/internal/mail"
	"xuetangx/internal/secure"
	"xuetangx/internal/testkit"
	"xuetangx/internal/workflow"
)

type registrationInbox struct{ body string }

func (i *registrationInbox) Send(_ context.Context, _, _, body string) error {
	i.body = body
	return nil
}
func TestHTTPRegistrationVerificationAndAdminSettings(t *testing.T) {
	db := testkit.Database(t)
	ctx := context.Background()
	keys := &secure.Keys{Active: "k", Values: map[string]string{"k": base64.StdEncoding.EncodeToString([]byte(strings.Repeat("a", 32)))}}
	box := &registrationInbox{}
	q := &mail.Queue{DB: db, Keys: keys, Sender: box}
	a := auth.New(db, q, "https://site.test")
	if err := a.Bootstrap(ctx, "admin@example.test", "x"); err != nil {
		t.Fatal(err)
	}
	s := httpapi.New(a, nil, &workflow.Engine{}, nil)
	server := httptest.NewServer(s.Handler())
	defer server.Close()
	call := func(method, path string, value any, cookies []*http.Cookie, csrf string) (int, string) {
		t.Helper()
		data, _ := json.Marshal(value)
		req, _ := http.NewRequest(method, server.URL+path, strings.NewReader(string(data)))
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("Origin", a.BaseURL)
		if csrf != "" {
			req.Header.Set("X-CSRF-Token", csrf)
		}
		for _, c := range cookies {
			req.AddCookie(c)
		}
		res, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		defer res.Body.Close()
		raw, err := io.ReadAll(res.Body)
		if err != nil {
			t.Fatal(err)
		}
		return res.StatusCode, string(raw)
	}
	login := func(email string) ([]*http.Cookie, string) {
		t.Helper()
		data, _ := json.Marshal(map[string]string{"email": email, "password": "x"})
		req, _ := http.NewRequest("POST", server.URL+"/api/auth/login", strings.NewReader(string(data)))
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("Origin", a.BaseURL)
		res, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		defer res.Body.Close()
		var payload struct{ CSRF string }
		if err = json.NewDecoder(res.Body).Decode(&payload); err != nil || res.StatusCode != 200 {
			t.Fatal("login failed", res.StatusCode)
		}
		return res.Cookies(), payload.CSRF
	}
	expect := func(want, status int, raw string) {
		t.Helper()
		if status != want {
			t.Fatalf("want status %d, got %d: %s", want, status, raw)
		}
	}
	status, raw := call("GET", "/api/auth/config", nil, nil, "")
	expect(200, status, raw)
	if !strings.Contains(raw, `"emailVerificationRequired":true`) {
		t.Fatal("not default on")
	}
	status, raw = call("POST", "/api/auth/register", map[string]any{"email": "user@example.test", "password": "x", "emailVerificationRequired": false}, nil, "")
	expect(400, status, raw)
	if !strings.Contains(raw, "EMAIL_CODE_REQUIRED") {
		t.Fatal(raw)
	}
	status, raw = call("POST", "/api/auth/registration-code", map[string]string{"email": "user@example.test"}, nil, "")
	expect(202, status, raw)
	if err := q.Tick(ctx); err != nil {
		t.Fatal(err)
	}
	code := regexp.MustCompile(`你的验证码：([0-9]{6})`).FindStringSubmatch(box.body)[1]
	if strings.Contains(raw, code) {
		t.Fatal("code exposed in response")
	}
	status, raw = call("POST", "/api/auth/register", map[string]string{"email": "user@example.test", "password": "x", "code": code}, nil, "")
	expect(202, status, raw)
	userCookies, userCSRF := login("user@example.test")
	adminCookies, adminCSRF := login("admin@example.test")
	for _, tc := range []struct {
		method  string
		cookies []*http.Cookie
		csrf    string
		want    int
	}{{"GET", nil, "", 401}, {"GET", userCookies, "", 403}, {"PUT", userCookies, userCSRF, 403}, {"PUT", adminCookies, "", 403}} {
		status, raw = call(tc.method, "/api/admin/registration-settings", map[string]bool{"emailVerificationRequired": false}, tc.cookies, tc.csrf)
		expect(tc.want, status, raw)
	}
	status, raw = call("PUT", "/api/admin/registration-settings", map[string]any{}, adminCookies, adminCSRF)
	expect(400, status, raw)
	status, raw = call("PUT", "/api/admin/registration-settings", map[string]bool{"emailVerificationRequired": false}, adminCookies, adminCSRF)
	expect(200, status, raw)
	status, raw = call("GET", "/api/auth/config", nil, nil, "")
	expect(200, status, raw)
	if !strings.Contains(raw, `"emailVerificationRequired":false`) {
		t.Fatal("public policy stale")
	}
	status, raw = call("POST", "/api/auth/register", map[string]string{"email": "direct@example.test", "password": "x"}, nil, "")
	expect(202, status, raw)
	status, raw = call("PUT", "/api/admin/registration-settings", map[string]bool{"emailVerificationRequired": true}, adminCookies, adminCSRF)
	expect(200, status, raw)
	status, raw = call("POST", "/api/auth/register", map[string]string{"email": "stale@example.test", "password": "x"}, nil, "")
	expect(400, status, raw)
	required, err := auth.New(db, q, a.BaseURL).RegistrationVerificationRequired(ctx)
	if err != nil || !required {
		t.Fatal("policy lost on new service")
	}
	s.EmailDisabled = true
	status, raw = call("POST", "/api/auth/registration-code", map[string]string{"email": "nomail@example.test"}, nil, "")
	expect(503, status, raw)
	status, raw = call("PUT", "/api/admin/registration-settings", map[string]bool{"emailVerificationRequired": true}, adminCookies, adminCSRF)
	expect(503, status, raw)
	status, raw = call("PUT", "/api/admin/registration-settings", map[string]bool{"emailVerificationRequired": false}, adminCookies, adminCSRF)
	expect(200, status, raw)
}
