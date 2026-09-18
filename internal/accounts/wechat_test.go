package accounts

import (
	"context"
	"testing"
	"time"
	"xuetangx/internal/domain"
)

type fakeWeChatRunner struct {
	cookie string
}

func (f fakeWeChatRunner) Login(_ context.Context, onQR func(string, time.Time)) (string, error) {
	onQR("https://mp.weixin.qq.com/cgi-bin/showqrcode?ticket=test", time.Now().Add(time.Minute))
	return f.cookie, nil
}

type fakeConnector struct{ gotRole, gotCookie string }

func (f *fakeConnector) Connect(_ context.Context, _ string, role, cookie string) (domain.Account, error) {
	f.gotRole, f.gotCookie = role, cookie
	return domain.Account{ID: "account-1", UserID: 101, Role: role, Connected: true}, nil
}

func TestWeChatLoginConnectsAndNeverReturnsCookie(t *testing.T) {
	connector := &fakeConnector{}
	login := NewWeChatLogin(connector, fakeWeChatRunner{cookie: "csrftoken=secret; sessionid=private"})
	view, err := login.Start(context.Background(), "owner-1", "primary")
	if err != nil {
		t.Fatal(err)
	}
	if view.Status != "waiting_scan" && view.Status != "connected" {
		t.Fatalf("unexpected initial status: %+v", view)
	}
	for i := 0; i < 20; i++ {
		view, err = login.Status("owner-1", view.ID)
		if err != nil {
			t.Fatal(err)
		}
		if view.Status == "connected" {
			break
		}
		time.Sleep(5 * time.Millisecond)
	}
	if view.Status != "connected" || view.Account.UserID != 101 {
		t.Fatalf("login did not connect: %+v", view)
	}
	if connector.gotRole != "primary" || connector.gotCookie == "" {
		t.Fatalf("connector was not called: role=%q cookie=%q", connector.gotRole, connector.gotCookie)
	}
	if view.QRURL != "" || view.Message == "" {
		t.Fatalf("completed view leaked QR or missed message: %+v", view)
	}
}

func TestWeChatLoginBindsSessionsToOwnerAndCancelsPrevious(t *testing.T) {
	connector := &fakeConnector{}
	login := NewWeChatLogin(connector, fakeWeChatRunner{cookie: "csrftoken=secret"})
	first, err := login.Start(context.Background(), "owner-1", "test")
	if err != nil {
		t.Fatal(err)
	}
	second, err := login.Start(context.Background(), "owner-1", "test")
	if err != nil {
		t.Fatal(err)
	}
	if first.ID == second.ID {
		t.Fatal("session id was reused")
	}
	if status, err := login.Status("other-owner", second.ID); err == nil || status.ID != "" {
		t.Fatal("session visible to another owner")
	}
	old, err := login.Status("owner-1", first.ID)
	if err != nil {
		t.Fatal(err)
	}
	if old.Status != "cancelled" && old.Status != "connected" {
		t.Fatalf("old session was not cancelled: %+v", old)
	}
}

func TestWeChatLoginRejectsUnknownRole(t *testing.T) {
	login := NewWeChatLogin(&fakeConnector{}, fakeWeChatRunner{})
	if _, err := login.Start(context.Background(), "owner-1", "collector"); err == nil {
		t.Fatal("unknown role accepted")
	}
}
