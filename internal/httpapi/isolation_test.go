package httpapi_test

import (
	"bufio"
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"github.com/google/uuid"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
	"xuetangx/internal/accounts"
	"xuetangx/internal/auth"
	"xuetangx/internal/bank"
	"xuetangx/internal/catalog"
	"xuetangx/internal/httpapi"
	"xuetangx/internal/mail"
	"xuetangx/internal/operations"
	"xuetangx/internal/platform"
	"xuetangx/internal/secure"
	"xuetangx/internal/testkit"
	"xuetangx/internal/workflow"
)

func TestHTTPIdentityCSRFAndEventIsolation(t *testing.T) {
	db := testkit.Database(t)
	ctx := context.Background()
	keys := &secure.Keys{Active: "k", Values: map[string]string{"k": base64.StdEncoding.EncodeToString(bytes.Repeat([]byte{7}, 32))}}
	a := auth.New(db, &mail.Queue{DB: db, Keys: keys}, "https://console.test")
	a.RequireEmailVerification = false
	mock := testkit.MockPlatform(t)
	ac := accounts.New(db, keys, mock.Client.Authenticate)
	b := &bank.Service{DB: db}
	broker := platform.NewBroker(ac, mock.Client)
	c := &catalog.Service{DB: db, Request: broker.Call}
	engine, err := workflow.New(ctx, db, ac, b, c, broker, operations.New(&operations.Journal{DB: db}, b, c, broker.Call), 10, 2)
	if err != nil {
		t.Fatal(err)
	}
	defer engine.Close()
	s := httpapi.New(a, ac, engine, c)
	s.EmailDisabled = true
	server := httptest.NewServer(s.Handler())
	defer server.Close()
	request := func(method, path, body string, cookies []*http.Cookie, csrf, bearer string) (*http.Response, string) {
		t.Helper()
		r, _ := http.NewRequest(method, server.URL+path, strings.NewReader(body))
		r.Header.Set("Content-Type", "application/json")
		r.Header.Set("Origin", a.BaseURL)
		if csrf != "" {
			r.Header.Set("X-CSRF-Token", csrf)
		}
		if bearer != "" {
			r.Header.Set("Authorization", "Bearer "+bearer)
		}
		for _, cookie := range cookies {
			r.AddCookie(cookie)
		}
		res, e := http.DefaultClient.Do(r)
		if e != nil {
			t.Fatal(e)
		}
		raw, e := io.ReadAll(res.Body)
		res.Body.Close()
		if e != nil {
			t.Fatal(e)
		}
		return res, string(raw)
	}
	type identity struct {
		owner, csrf string
		cookies     []*http.Cookie
	}
	login := func(email string) identity {
		t.Helper()
		if e := a.Bootstrap(ctx, email, "test-password-123456"); e != nil {
			t.Fatal(e)
		}
		res, raw := request("POST", "/api/auth/login", `{"email":"`+email+`","password":"test-password-123456"}`, nil, "", "")
		if res.StatusCode != 200 {
			t.Fatalf("login: %d %s", res.StatusCode, raw)
		}
		var data struct {
			CSRF string
			User struct{ ID string }
		}
		if e := json.Unmarshal([]byte(raw), &data); e != nil {
			t.Fatal(e)
		}
		for _, cookie := range res.Cookies() {
			if !cookie.Secure || cookie.SameSite != http.SameSiteLaxMode || (cookie.Name == "xuetangx_session" && !cookie.HttpOnly) {
				t.Fatal("unsafe session cookie")
			}
		}
		return identity{data.User.ID, data.CSRF, res.Cookies()}
	}
	one, two := login("one@example.test"), login("two@example.test")
	res, _ := request("GET", "/api/workflow/state", "", nil, "", "")
	if res.StatusCode != 401 {
		t.Fatal("anonymous access", res.StatusCode)
	}
	res, _ = request("POST", "/api/tokens", `{"name":"cli"}`, one.cookies, "", "")
	if res.StatusCode != 403 {
		t.Fatal("CSRF accepted", res.StatusCode)
	}
	res, raw := request("POST", "/api/tokens", `{"name":"cli"}`, one.cookies, one.csrf, "")
	if res.StatusCode != 201 {
		t.Fatal(raw)
	}
	var token struct{ Token string }
	json.Unmarshal([]byte(raw), &token)
	res, _ = request("GET", "/api/auth/me", "", nil, "", token.Token)
	if res.StatusCode != 200 {
		t.Fatal("bearer rejected")
	}
	for _, identity := range []identity{one, two} {
		res, raw = request("POST", "/api/cookie", `{"cookie":"csrftoken=csrf; sessionid=101"}`, identity.cookies, identity.csrf, "")
		if res.StatusCode != 200 || !strings.Contains(raw, `"connected":true`) || strings.Contains(raw, "sessionid") {
			t.Fatal("same platform account could not connect privately", res.StatusCode, raw)
		}
	}
	bound, err := ac.Get(ctx, one.owner, "primary")
	if err != nil {
		t.Fatal(err)
	}
	account, course, job := bound.ID, uuid.NewString(), uuid.NewString()
	queries := []struct {
		sql  string
		args []any
	}{
		{"INSERT INTO courses(id,classroom_id,sign,course_sign,title,url) VALUES($1,12,'s','c','Private course','https://www.xuetangx.com/learn/space/s/c/12')", []any{course}},
		{"INSERT INTO jobs(id,owner_id,account_id,course_id,status,concurrency) VALUES($1,$2,$3,$4,'paused',3)", []any{job, one.owner, account, course}},
		{"INSERT INTO job_events(owner_id,job_id,event_type,payload) VALUES($1,$2::uuid,'workflow',jsonb_build_object('jobId',$2::uuid::text))", []any{one.owner, job}},
	}
	for _, q := range queries {
		if _, e := db.Pool.Exec(ctx, q.sql, q.args...); e != nil {
			t.Fatal(e)
		}
	}
	for _, method := range []string{"GET", "POST"} {
		path := "/api/workflow/" + job
		if method == "POST" {
			path += "/stop"
		}
		res, _ = request(method, path, `{}`, two.cookies, two.csrf, "")
		if res.StatusCode != 404 {
			t.Fatal("cross-user job access", res.StatusCode)
		}
	}
	res, raw = request("GET", "/api/workflow/state", "", two.cookies, "", "")
	if res.StatusCode != 200 || strings.Contains(raw, job) || strings.Contains(raw, account) {
		t.Fatal("snapshot leaked", raw)
	}
	streamCtx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	req, _ := http.NewRequestWithContext(streamCtx, "GET", server.URL+"/api/events", nil)
	for _, cookie := range two.cookies {
		req.AddCookie(cookie)
	}
	stream, e := http.DefaultClient.Do(req)
	if e != nil {
		t.Fatal(e)
	}
	scanner := bufio.NewScanner(stream.Body)
	if !scanner.Scan() || !strings.Contains(scanner.Text(), `"type":"hello"`) || strings.Contains(scanner.Text(), job) || strings.Contains(scanner.Text(), account) {
		t.Fatal("SSE leaked or failed", scanner.Text())
	}
	stream.Body.Close()
	res, _ = request("DELETE", "/api/tokens/"+secure.Hash(token.Token), `{}`, one.cookies, one.csrf, "")
	if res.StatusCode != 200 {
		t.Fatal("revocation failed")
	}
	res, _ = request("GET", "/api/auth/me", "", nil, "", token.Token)
	if res.StatusCode != 401 {
		t.Fatal("revoked token accepted")
	}
	res, raw = request("POST", "/api/auth/register", `{"email":"ordinary@example.test","password":"ordinary-password-123","admin":true}`, nil, "", "")
	if res.StatusCode != 202 {
		t.Fatal("direct registration failed", raw)
	}
	res, raw = request("POST", "/api/auth/login", `{"email":"ordinary@example.test","password":"ordinary-password-123"}`, nil, "", "")
	if res.StatusCode != 200 {
		t.Fatal("direct login failed", raw)
	}
	ordinaryCookies := res.Cookies()
	for _, path := range []string{"/api/admin/users", "/api/admin/jobs", "/api/admin/metrics", "/api/admin/conflicts", "/api/admin/collectors", "/api/admin/users/" + one.owner} {
		res, _ = request("GET", path, "", ordinaryCookies, "", "")
		if res.StatusCode != 403 {
			t.Fatal("ordinary user entered admin", path, res.StatusCode)
		}
	}

	res, raw = request("POST", "/api/admin/collectors", `{"label":"shared","cookie":"csrftoken=csrf; sessionid=202"}`, one.cookies, one.csrf, "")
	if res.StatusCode != 200 {
		t.Fatal("collector create", raw)
	}
	res, raw = request("GET", "/api/admin/collectors", "", one.cookies, "", "")
	if res.StatusCode != 200 || strings.Contains(raw, "sessionid") || strings.Contains(raw, "csrf") {
		t.Fatal("collector metadata", raw)
	}
	var collectors struct{ Accounts []struct{ ID string } }
	json.Unmarshal([]byte(raw), &collectors)
	if len(collectors.Accounts) != 1 {
		t.Fatal(raw)
	}
	res, raw = request("GET", "/api/workflow/state", "", ordinaryCookies, "", "")
	if res.StatusCode != 200 || strings.Contains(raw, collectors.Accounts[0].ID) || !strings.Contains(raw, `"sharedCollectors":1`) {
		t.Fatal("collector privacy", raw)
	}
	res, raw = request("GET", "/api/admin/users/"+one.owner, "", one.cookies, "", "")
	if res.StatusCode != 200 {
		t.Fatal("user detail", raw)
	}
	var status string
	if err = db.Pool.QueryRow(ctx, "SELECT status FROM jobs WHERE id=$1", job).Scan(&status); err != nil || status != "paused" {
		t.Fatal("collector addition resumed paused job", status, err)
	}
	res, raw = request("GET", "/api/admin/jobs", "", one.cookies, "", "")
	if res.StatusCode != 200 || !strings.Contains(raw, job) {
		t.Fatal("admin job listing failed", raw)
	}
	res, raw = request("POST", "/api/disconnect", `{}`, one.cookies, one.csrf, "")
	if res.StatusCode != 200 {
		t.Fatal("disconnect failed", raw)
	}
	res, raw = request("GET", "/api/session", "", two.cookies, "", "")
	if res.StatusCode != 200 || !strings.Contains(raw, `"connected":true`) {
		t.Fatal("disconnect affected another user", raw)
	}
	res, raw = request("POST", "/api/admin/users/"+two.owner+"/disable", `{"disabled":true}`, one.cookies, one.csrf, "")
	if res.StatusCode != 200 {
		t.Fatal("admin disable failed", raw)
	}
	res, _ = request("GET", "/api/auth/me", "", two.cookies, "", "")
	if res.StatusCode != 401 {
		t.Fatal("disabled session survived")
	}

}
