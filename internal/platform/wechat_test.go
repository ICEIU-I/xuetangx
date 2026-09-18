package platform_test

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/coder/websocket"
	"xuetangx/internal/platform"
)

func TestWeChatLoginExchangesTokenForPlatformCookies(t *testing.T) {
	ticket := "https://mp.weixin.qq.com/cgi-bin/showqrcode?ticket=test-ticket"
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/":
			http.SetCookie(w, &http.Cookie{Name: "csrftoken", Value: "seed", Path: "/"})
			w.WriteHeader(http.StatusOK)
		case "/wsapp/":
			conn, err := websocket.Accept(w, r, &websocket.AcceptOptions{InsecureSkipVerify: true})
			if err != nil {
				return
			}
			defer conn.Close(websocket.StatusNormalClosure, "")
			_, request, err := conn.Read(r.Context())
			if err != nil || !strings.Contains(string(request), `"purpose":"login"`) || !strings.Contains(string(request), `"xtbz":"xt"`) {
				t.Errorf("unexpected websocket request: %s, %v", request, err)
				return
			}
			qr, _ := json.Marshal(map[string]any{"op": "requestlogin", "ticket": ticket, "expire_seconds": 60})
			_ = conn.Write(r.Context(), websocket.MessageText, qr)
			success, _ := json.Marshal(map[string]any{"op": "loginsuccess", "token": "one-time-token"})
			_ = conn.Write(r.Context(), websocket.MessageText, success)
		case "/api/v1/u/login/wx/":
			if r.Header.Get("X-CSRFToken") != "seed" || r.Header.Get("xtbz") != "xt" {
				t.Errorf("missing platform login headers")
			}
			http.SetCookie(w, &http.Cookie{Name: "sessionid", Value: "platform-session", Path: "/"})
			http.SetCookie(w, &http.Cookie{Name: "csrftoken", Value: "platform-csrf", Path: "/"})
			w.Header().Set("Content-Type", "application/json")
			_, _ = w.Write([]byte(`{"success":true,"data":{}}`))
		default:
			http.NotFound(w, r)
		}
	}))
	defer server.Close()
	wsURL := "ws" + strings.TrimPrefix(server.URL, "http") + "/wsapp/"
	client := platform.NewWeChatClientForTest(server.URL, wsURL, nil)
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	var qr string
	cookie, err := client.Login(ctx, func(value string, expires time.Time) { qr = value })
	if err != nil {
		t.Fatal(err)
	}
	if qr != ticket {
		t.Fatalf("QR callback = %q", qr)
	}
	if cookie != "csrftoken=platform-csrf; sessionid=platform-session" && cookie != "sessionid=platform-session; csrftoken=platform-csrf" {
		t.Fatalf("unexpected cookie header: %q", cookie)
	}
}

func TestWeChatLoginRejectsUntrustedQRCode(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/wsapp/" {
			w.WriteHeader(http.StatusOK)
			return
		}
		conn, err := websocket.Accept(w, r, &websocket.AcceptOptions{InsecureSkipVerify: true})
		if err != nil {
			return
		}
		defer conn.Close(websocket.StatusNormalClosure, "")
		_, _, _ = conn.Read(r.Context())
		_ = conn.Write(r.Context(), websocket.MessageText, []byte(`{"op":"requestlogin","ticket":"https://evil.example/qrcode"}`))
	}))
	defer server.Close()
	wsURL := "ws" + strings.TrimPrefix(server.URL, "http") + "/wsapp/"
	client := platform.NewWeChatClientForTest(server.URL, wsURL, nil)
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if _, err := client.Login(ctx, nil); err == nil {
		t.Fatal("untrusted QR was accepted")
	}
}
