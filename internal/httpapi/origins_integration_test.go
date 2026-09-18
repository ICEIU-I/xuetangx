package httpapi_test

import (
	"bytes"
	"encoding/base64"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"xuetangx/internal/auth"
	"xuetangx/internal/httpapi"
	"xuetangx/internal/mail"
	"xuetangx/internal/secure"
	"xuetangx/internal/testkit"
	"xuetangx/internal/workflow"
)

func TestBothOriginsShareUsersAndRetainCSRF(t *testing.T) {
	db := testkit.Database(t)
	keys := &secure.Keys{Active: "k", Values: map[string]string{"k": base64.StdEncoding.EncodeToString(bytes.Repeat([]byte{7}, 32))}}
	a := auth.New(db, &mail.Queue{DB: db, Keys: keys}, "https://primary.test")
	a.RequireEmailVerification = false
	s := httpapi.New(a, nil, &workflow.Engine{}, nil)
	s.EmailDisabled = true
	s.AllowedOrigins = []string{"https://legacy.test"}
	server := httptest.NewServer(s.Handler())
	defer server.Close()
	call := func(path, origin, body string, cookies []*http.Cookie, csrf string) (int, []*http.Cookie, []byte) {
		t.Helper()
		r, _ := http.NewRequest("POST", server.URL+path, strings.NewReader(body))
		r.Header.Set("Content-Type", "application/json")
		r.Header.Set("Origin", origin)
		r.Header.Set("X-CSRF-Token", csrf)
		for _, c := range cookies {
			r.AddCookie(c)
		}
		res, err := http.DefaultClient.Do(r)
		if err != nil {
			t.Fatal(err)
		}
		defer res.Body.Close()
		raw, err := io.ReadAll(res.Body)
		if err != nil {
			t.Fatal(err)
		}
		return res.StatusCode, res.Cookies(), raw
	}
	payload := `{"email":"dual@example.test","password":"local-test-password"}`
	code, _, raw := call("/api/auth/register", "https://legacy.test", payload, nil, "")
	if code != 202 {
		t.Fatalf("legacy register: %d %s", code, raw)
	}
	var userID string
	for _, origin := range []string{"https://primary.test", "https://legacy.test"} {
		code, cookies, raw := call("/api/auth/login", origin, payload, nil, "")
		if code != 200 {
			t.Fatalf("%s login: %d %s", origin, code, raw)
		}
		var login struct {
			CSRF string
			User struct{ ID string }
		}
		if err := json.Unmarshal(raw, &login); err != nil {
			t.Fatal(err)
		}
		if login.CSRF == "" || login.User.ID == "" {
			t.Fatal("missing identity/CSRF")
		}
		if userID != "" && userID != login.User.ID {
			t.Fatal("origins must share users")
		}
		userID = login.User.ID
		if len(cookies) != 2 {
			t.Fatal("expected session and CSRF cookies")
		}
		for _, c := range cookies {
			if c.Domain != "" || !c.Secure || c.SameSite != http.SameSiteLaxMode {
				t.Fatal("cookie boundary changed")
			}
		}
		for _, bad := range []struct{ origin, csrf string }{{origin, ""}, {origin, "wrong"}, {"", login.CSRF}, {"https://evil.test", login.CSRF}, {"null", login.CSRF}} {
			status, _, _ := call("/api/auth/logout", bad.origin, `{}`, cookies, bad.csrf)
			if status != 403 {
				t.Errorf("bad logout %q: %d", bad.origin, status)
			}
		}
		status, _, body := call("/api/auth/logout", origin, `{}`, cookies, login.CSRF)
		if status != 200 {
			t.Fatalf("valid logout %s: %d %s", origin, status, body)
		}
	}
	for _, origin := range []string{"https://evil.test", "https://sub.legacy.test", "http://legacy.test"} {
		status, _, _ := call("/api/auth/register", origin, payload, nil, "")
		if status != 403 {
			t.Errorf("unlisted register %s: %d", origin, status)
		}
	}
}
