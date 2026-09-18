package httpapi_test

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/url"
	"testing"

	"xuetangx/internal/auth"
	"xuetangx/internal/bank"
	"xuetangx/internal/httpapi"
	"xuetangx/internal/jobs"
	"xuetangx/internal/testkit"
	"xuetangx/internal/workflow"
)

func TestAnswerBankOverviewRequiresAdminNotPlatformAccount(t *testing.T) {
	db := testkit.Database(t)
	ctx := context.Background()
	a := auth.New(db, nil, "https://console.test")
	a.RequireEmailVerification = false
	if err := a.Bootstrap(ctx, "admin@example.test", "test-password"); err != nil {
		t.Fatal(err)
	}
	if err := a.Register(ctx, "ordinary@example.test", "test-password"); err != nil {
		t.Fatal(err)
	}
	engine := &workflow.Engine{Bank: &bank.Service{DB: db}, Jobs: &jobs.Repository{DB: db}}
	handler := httpapi.New(a, nil, engine, nil).Handler()
	for _, test := range []struct {
		email  string
		status int
	}{
		{"", http.StatusUnauthorized},
		{"ordinary@example.test", http.StatusForbidden},
		{"admin@example.test", http.StatusOK},
	} {
		req := httptest.NewRequest("GET", "/api/answer-bank?limit=20", nil)
		if test.email != "" {
			login, err := a.Login(ctx, test.email, "test-password")
			if err != nil {
				t.Fatal(err)
			}
			req.AddCookie(&http.Cookie{Name: "xuetangx_session", Value: login.Token})
		}
		response := httptest.NewRecorder()
		handler.ServeHTTP(response, req)
		if response.Code != test.status {
			t.Fatalf("%s: status %d body %s", test.email, response.Code, response.Body.String())
		}
		if test.status == http.StatusOK {
			var result struct {
				Courses []bank.CourseBank
				Total   int
			}
			if err := json.Unmarshal(response.Body.Bytes(), &result); err != nil || result.Courses == nil || result.Total != 0 {
				t.Fatalf("overview: %s (%v)", response.Body.String(), err)
			}
		}
		if test.email == "ordinary@example.test" {
			for _, path := range []string{"/api/answer-bank/12", "/api/answer-bank/12?download=1"} {
				req.URL, _ = url.Parse(path)
				response = httptest.NewRecorder()
				handler.ServeHTTP(response, req)
				if response.Code != http.StatusForbidden {
					t.Fatalf("ordinary user accessed %s: %d", path, response.Code)
				}
			}
		}
	}
}
