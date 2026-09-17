package platform

import (
	"context"
	"sync"
	"sync/atomic"
	"testing"
	"time"
	"xuetangx/internal/domain"
	"xuetangx/internal/platform/wire"
)

type credentials struct{}

func (credentials) Credential(_ context.Context, owner, id string, revision int64) (domain.Account, string, error) {
	return domain.Account{Owner: owner, ID: id, UserID: 1}, "cookie", nil
}
func (credentials) Invalidate(context.Context, string, string, int64) error { return nil }

type transportFunc func(context.Context, string, string, any, string) (Response, error)

func (f transportFunc) Do(c context.Context, m, p string, v any, k string) (Response, error) {
	return f(c, m, p, v, k)
}
func TestNoLocalQuotaAndBoundedSubmissions(t *testing.T) {
	var live, peak, calls atomic.Int32
	b := NewBroker(credentials{}, transportFunc(func(ctx context.Context, _, _ string, _ any, _ string) (Response, error) {
		n := live.Add(1)
		defer live.Add(-1)
		for old := peak.Load(); n > old && !peak.CompareAndSwap(old, n); old = peak.Load() {
		}
		calls.Add(1)
		time.Sleep(time.Millisecond)
		return Response{Status: 200, JSON: wire.Object{"success": true}}, nil
	}))
	defer b.Close()
	var wg sync.WaitGroup
	for i := 0; i < 30; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			if _, e := b.Request(context.Background(), domain.Account{UserID: 1}, "POST", SubmitPath, nil); e != nil {
				t.Error(e)
			}
		}()
	}
	wg.Wait()
	if calls.Load() != 30 || peak.Load() > 3 {
		t.Fatalf("calls=%d peak=%d", calls.Load(), peak.Load())
	}
}
func TestThrottleUsesServerDelayAndDoesNotBlockReads(t *testing.T) {
	var calls atomic.Int32
	b := NewBroker(credentials{}, transportFunc(func(_ context.Context, m, p string, _ any, _ string) (Response, error) {
		if p == SubmitPath && calls.Add(1) == 1 {
			return Response{Status: 429, RetryAfter: "0.08"}, nil
		}
		return Response{Status: 200, JSON: wire.Object{}}, nil
	}))
	defer b.Close()
	a := domain.Account{UserID: 1}
	b.Request(context.Background(), a, "POST", SubmitPath, nil)
	if !b.State(1).Blocked {
		t.Fatal("missing cooldown")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 40*time.Millisecond)
	defer cancel()
	if _, e := b.Request(ctx, a, "GET", "/read", nil); e != nil {
		t.Fatal("read blocked", e)
	}
	if _, e := b.Request(ctx, a, "POST", SubmitPath, nil); e == nil {
		t.Fatal("submission ignored cooldown")
	}
}
