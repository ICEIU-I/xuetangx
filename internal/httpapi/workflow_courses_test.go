package httpapi_test

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strconv"
	"strings"
	"sync"
	"testing"

	"xuetangx/internal/accounts"
	"xuetangx/internal/auth"
	"xuetangx/internal/catalog"
	"xuetangx/internal/domain"
	"xuetangx/internal/httpapi"
	"xuetangx/internal/jobs"
	"xuetangx/internal/platform"
	"xuetangx/internal/platform/wire"
	"xuetangx/internal/secure"
	"xuetangx/internal/testkit"
	"xuetangx/internal/workflow"
)

type courseTransport struct {
	mu            sync.Mutex
	fail          bool
	calls         []string
	wait, release chan struct{}
}

func (t *courseTransport) Do(ctx context.Context, method, path string, _ any, cookie string) (platform.Response, error) {
	t.mu.Lock()
	t.calls = append(t.calls, method+" "+path)
	fail := t.fail
	wait, release := t.wait, t.release
	t.mu.Unlock()
	if method != "GET" {
		panic("course browsing must be read only")
	}
	u, _ := url.Parse(path)
	uid := "101"
	if strings.Contains(cookie, "sessionid=202") {
		uid = "202"
	}
	d := wire.Object{}
	switch u.Path {
	case "/api/v1/lms/user/user-courses/":
		if wait != nil {
			select {
			case wait <- struct{}{}:
			default:
			}
			select {
			case <-release:
			case <-ctx.Done():
				return platform.Response{}, ctx.Err()
			}
		}
		if fail {
			return platform.Response{Status: 503}, nil
		}
		fixed := catalog.FixedCourse()
		items := []any{}
		if u.Query().Get("page") == "1" {
			items = append(items, wire.Object{"classroom_id": fixed.ClassroomID, "sign": fixed.Sign, "course_sign": fixed.CourseSign, "name": fixed.Title})
		} else {
			n, _ := strconv.ParseInt(uid, 10, 64)
			items = append(items, wire.Object{"classroom_id": n, "sign": "math", "course_sign": "math", "name": "Math " + uid})
		}
		d = wire.Object{"pages": 2, "product_list": items}
	case "/api/v1/lms/learn/get_evaluation_detail/":
		d = wire.Object{"total_score_and_schedule": wire.Object{"user_score": 42}}
	}
	return platform.Response{Status: 200, JSON: wire.Object{"success": true, "data": d}}, nil
}
func TestWorkflowChoicesAndSelectedScoreAreAccountScoped(t *testing.T) {
	db := testkit.Database(t)
	ctx := context.Background()
	keys := &secure.Keys{Active: "k", Values: map[string]string{"k": base64.StdEncoding.EncodeToString([]byte(strings.Repeat("a", 32)))}}
	ac := accounts.New(db, keys, func(_ context.Context, cookie string) (int64, string, error) {
		if strings.Contains(cookie, "sessionid=202") {
			return 202, "Second", nil
		}
		return 101, "First", nil
	})
	a := auth.New(db, nil, "https://example.test")
	transport := &courseTransport{}
	broker := platform.NewBroker(ac, transport)
	defer broker.Close()
	cat := &catalog.Service{DB: db, Request: broker.Request}
	engine := &workflow.Engine{DB: db, Accounts: ac, Catalog: cat, Broker: broker, Jobs: &jobs.Repository{DB: db}}
	s := httpapi.New(a, ac, engine, cat)
	user := func(email string) auth.Login {
		t.Helper()
		if err := a.Bootstrap(ctx, email, "x"); err != nil {
			t.Fatal(err)
		}
		l, err := a.Login(ctx, email, "x")
		if err != nil {
			t.Fatal(err)
		}
		return l
	}
	first, second := user("first@example.test"), user("second@example.test")
	get := func(l auth.Login, path string) *httptest.ResponseRecorder {
		r := httptest.NewRequest("GET", path, nil)
		r.AddCookie(&http.Cookie{Name: "xuetangx_session", Value: l.Token})
		w := httptest.NewRecorder()
		s.Handler().ServeHTTP(w, r)
		return w
	}
	choices := func(l auth.Login) ([]catalog.CourseChoice, string) {
		t.Helper()
		w := get(l, "/api/workflow/courses")
		if w.Code != 200 {
			t.Fatal(w.Code, w.Body.String())
		}
		var result struct {
			Courses []catalog.CourseChoice
			Warning string
		}
		if err := json.Unmarshal(w.Body.Bytes(), &result); err != nil {
			t.Fatal(err)
		}
		return result.Courses, result.Warning
	}
	list, _ := choices(first)
	if len(list) != 1 || list[0].Enrolled {
		t.Fatal("disconnected list", list)
	}
	if _, err := ac.Connect(ctx, first.User.ID, "primary", "csrftoken=test; sessionid=101"); err != nil {
		t.Fatal(err)
	}
	if _, err := ac.Connect(ctx, second.User.ID, "primary", "csrftoken=test; sessionid=202"); err != nil {
		t.Fatal(err)
	}
	list, warning := choices(first)
	if len(list) != 2 || !list[0].Fixed || !list[0].Enrolled || list[1].ClassroomID != 101 || warning != "" {
		t.Fatal(list, warning)
	}
	other, _ := choices(second)
	if len(other) != 2 || other[1].ClassroomID != 202 {
		t.Fatal("account list leak", other)
	}
	path := "/api/workflow/course-score?" + url.Values{"courseUrl": {list[1].URL}}.Encode()
	w := get(first, path)
	if w.Code != 200 {
		t.Fatal(w.Code, w.Body.String())
	}
	var score struct {
		Course    domain.Course
		PrimaryID int64
		Score     float64
	}
	if err := json.Unmarshal(w.Body.Bytes(), &score); err != nil {
		t.Fatal(err)
	}
	if score.Course.ClassroomID != 101 || score.PrimaryID != 101 || score.Score != 42 {
		t.Fatal("wrong selected course score", score)
	}
	w = get(second, path)
	if w.Code != 400 || !strings.Contains(w.Body.String(), "ENROLLMENT_REQUIRED") {
		t.Fatal("cross-account score accepted", w.Code)
	}
	transport.mu.Lock()
	transport.fail = true
	transport.mu.Unlock()
	list, warning = choices(first)
	if len(list) != 1 || warning == "" {
		t.Fatal("upstream failure disguised as empty list")
	}
	transport.mu.Lock()
	transport.fail = false
	transport.wait = make(chan struct{}, 1)
	transport.release = make(chan struct{})
	transport.mu.Unlock()
	result := make(chan *httptest.ResponseRecorder, 1)
	go func() { result <- get(first, "/api/workflow/courses") }()
	<-transport.wait
	if err := ac.Disconnect(ctx, first.User.ID, "primary"); err != nil {
		t.Fatal(err)
	}
	close(transport.release)
	w = <-result
	if w.Code != 400 || !strings.Contains(w.Body.String(), "ACCOUNT_CHANGED") {
		t.Fatal("stale account response accepted", w.Code, w.Body.String())
	}
	transport.mu.Lock()
	defer transport.mu.Unlock()
	for _, call := range transport.calls {
		if !strings.HasPrefix(call, "GET ") {
			t.Fatal("unexpected write")
		}
	}
	if !strings.Contains(strings.Join(transport.calls, "\n"), "page=2") {
		t.Fatal("pagination not read")
	}
}
