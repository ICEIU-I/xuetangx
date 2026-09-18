package platform

import (
	"context"
	"errors"
	"strings"
	"sync/atomic"
	"testing"
	"time"
	"xuetangx/internal/domain"
	"xuetangx/internal/fault"
	"xuetangx/internal/platform/wire"
)

func TestAccessRetryWaitsAndRecoversReadsAndWrites(t *testing.T) {
	for _, path := range []string{"/api/v1/lms/exercise/get_exercise_list/1/2/", SubmitPath, "/video-log/heartbeat/"} {
		t.Run(path, func(t *testing.T) {
			var calls atomic.Int32
			var previous time.Time
			b := NewBroker(credentials{}, transportFunc(func(_ context.Context, _, _ string, _ any, _ string) (Response, error) {
				n := calls.Add(1)
				if n > 1 && time.Since(previous) < 30*time.Millisecond {
					t.Error("request ignored server cooldown")
				}
				previous = time.Now()
				if n <= 2 {
					return Response{Status: 403, RetryAfter: "0.03"}, nil
				}
				return Response{Status: 200, JSON: wire.Object{"success": true}}, nil
			}))
			defer b.Close()
			method := "POST"
			if strings.Contains(path, "get_exercise_list") {
				method = "GET"
			}
			ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
			defer cancel()
			r, e := b.Call(ctx, domain.Account{UserID: 1}, method, path, nil)
			if e != nil || r.Status != 200 || calls.Load() != 3 || b.State(1).Blocked {
				t.Fatalf("response=%+v error=%v calls=%d", r, e, calls.Load())
			}
		})
	}
}

func TestAccessRetryStopsAfterFiveRetries(t *testing.T) {
	var calls atomic.Int32
	b := NewBroker(credentials{}, transportFunc(func(_ context.Context, _, _ string, _ any, _ string) (Response, error) {
		calls.Add(1)
		return Response{Status: 403, RetryAfter: "0.001"}, nil
	}))
	defer b.Close()
	r, e := b.Call(context.Background(), domain.Account{UserID: 1}, "POST", SubmitPath, nil)
	if e != nil || calls.Load() != 6 || r.Status != 403 || r.AccessRetries != 5 {
		t.Fatalf("response=%+v error=%v calls=%d", r, e, calls.Load())
	}
	_, e = r.Data()
	if fault.Code(e) != "ACCESS_DENIED" || !strings.Contains(e.Error(), "已冷却重试 5 次") {
		t.Fatal(e)
	}
}

func TestAccessCooldownBlocksWholeAccountButNotOthers(t *testing.T) {
	var calls atomic.Int32
	b := NewBroker(credentials{}, transportFunc(func(_ context.Context, _, path string, _ any, _ string) (Response, error) {
		calls.Add(1)
		if path == "/denied" {
			return Response{Status: 403, RetryAfter: "0.2"}, nil
		}
		return Response{Status: 200}, nil
	}))
	defer b.Close()
	a := domain.Account{UserID: 7, ID: "one", Owner: "owner1"}
	if _, e := b.Request(context.Background(), a, "GET", "/denied", nil); e != nil {
		t.Fatal(e)
	}
	s := b.State(7)
	if !s.Blocked || s.ReadyAt == nil || s.Reason != "access_denied" || s.Scope != "account" || *s.ReadyAt-time.Now().UnixMilli() < 150 {
		t.Fatalf("missing server-provided account cooldown: %+v", s)
	}
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	if _, e := b.Request(ctx, domain.Account{UserID: 8}, "GET", "/read", nil); e != nil {
		t.Fatal("other account blocked", e)
	}
	// The same real platform user remains blocked across owners and account IDs.
	for _, method := range []string{"GET", "POST"} {
		ctx, cancel := context.WithTimeout(context.Background(), 40*time.Millisecond)
		_, e := b.Request(ctx, domain.Account{UserID: 7, ID: "two", Owner: "owner2"}, method, SubmitPath, nil)
		cancel()
		if !errors.Is(e, context.DeadlineExceeded) {
			t.Fatal("same user escaped cooldown", e)
		}
	}
	if calls.Load() != 2 {
		t.Fatal("blocked requests reached transport", calls.Load())
	}
}

func TestAccessRetryWithoutServerDelayDoesNotWaitFixedMinute(t *testing.T) {
	var calls atomic.Int32
	b := NewBroker(credentials{}, transportFunc(func(_ context.Context, _, _ string, _ any, _ string) (Response, error) {
		if calls.Add(1) == 1 {
			return Response{Status: 403}, nil
		}
		return Response{Status: 200}, nil
	}))
	defer b.Close()
	start := time.Now()
	r, err := b.Call(context.Background(), domain.Account{UserID: 1}, "GET", "/read", nil)
	if err != nil || r.Status != 200 || calls.Load() != 2 || time.Since(start) >= time.Second {
		t.Fatalf("missing server delay should not impose a fixed wait: response=%+v error=%v calls=%d elapsed=%s", r, err, calls.Load(), time.Since(start))
	}
}

func TestAccessCooldownCancelAndCloseDoNotReplay(t *testing.T) {
	for _, mode := range []string{"cancel", "close"} {
		t.Run(mode, func(t *testing.T) {
			var calls atomic.Int32
			seen := make(chan struct{}, 1)
			b := NewBroker(credentials{}, transportFunc(func(_ context.Context, _, _ string, _ any, _ string) (Response, error) {
				calls.Add(1)
				seen <- struct{}{}
				return Response{Status: 403, RetryAfter: "1"}, nil
			}))
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			done := make(chan error, 1)
			go func() { _, e := b.Call(ctx, domain.Account{UserID: 1}, "POST", SubmitPath, nil); done <- e }()
			select {
			case <-seen:
			case <-time.After(time.Second):
				t.Fatal("request not sent")
			}
			if mode == "cancel" {
				cancel()
			} else {
				b.Close()
			}
			select {
			case e := <-done:
				if e == nil {
					t.Fatal("cancel ignored")
				}
			case <-time.After(time.Second):
				t.Fatal("cooldown did not stop")
			}
			if mode == "cancel" {
				b.Close()
			}
			if calls.Load() != 1 {
				t.Fatal("replayed after cancel", calls.Load())
			}
		})
	}
}

func TestAccessRetryDoesNotReplayOtherFailures(t *testing.T) {
	for _, mode := range []string{"401", "429", "business", "unknown_write"} {
		t.Run(mode, func(t *testing.T) {
			var calls atomic.Int32
			b := NewBroker(credentials{}, transportFunc(func(_ context.Context, _, _ string, _ any, _ string) (Response, error) {
				calls.Add(1)
				switch mode {
				case "401":
					return Response{Status: 401}, nil
				case "429":
					return Response{Status: 429}, nil
				case "business":
					return Response{Status: 200, JSON: wire.Object{"success": false}}, nil
				default:
					return Response{}, &TransportError{Connected: true, Transient: true}
				}
			}))
			defer b.Close()
			_, _ = b.Call(context.Background(), domain.Account{UserID: 1}, "POST", "/video-log/heartbeat/", nil)
			if calls.Load() != 1 {
				t.Fatal("unexpected replay", calls.Load())
			}
		})
	}
}

func TestAccessCooldownServerDelayFormats(t *testing.T) {
	now := time.Now().Truncate(time.Second)
	for _, r := range []Response{
		{Status: 403, RetryAfter: "2"},
		{Status: 403, RetryAfter: now.Add(2 * time.Second).UTC().Format("Mon, 02 Jan 2006 15:04:05 GMT")},
		{Status: 403, JSON: wire.Object{"msg": "请等待 2 秒"}},
	} {
		if got := Cooldown(r, now); !got.Equal(now.Add(2 * time.Second)) {
			t.Fatal("server delay ignored", got)
		}
	}
	if got := Cooldown(Response{Status: 403}, now); !got.Equal(now) {
		t.Fatalf("client invented a fixed delay: %s", got.Sub(now))
	}
}
