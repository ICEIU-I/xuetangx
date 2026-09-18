package platform

import (
	"context"
	"errors"
	"time"
	"xuetangx/internal/domain"
)

const MaxAccessRetries = 5

func (b *Broker) Call(ctx context.Context, a domain.Account, method, path string, body any) (Response, error) {
	accessRetries, networkRetries := 0, 0
	for {
		r, e := b.Request(ctx, a, method, path, body)
		if e == nil {
			if r.Status == 403 {
				if accessRetries < MaxAccessRetries {
					accessRetries++
					// Re-enter the broker queue: every request for this account shares the cooldown.
					continue
				}
				r.AccessRetries = accessRetries
			}
			// Keep explicit rejections as responses so operation journals record rejected, not unknown.
			// Submission and effect services retain ownership of their existing 429 retry budgets.
			return r, nil
		}
		var network *TransportError
		if path == SubmitPath || networkRetries >= 2 || !errors.As(e, &network) || !network.Transient || (network.Connected && !ReadOnly(method, path)) {
			return r, e
		}
		networkRetries++
		if e = Wait(ctx, time.Duration(networkRetries)*time.Second); e != nil {
			return r, e
		}
	}
}

func Wait(ctx context.Context, delay time.Duration) error {
	timer := time.NewTimer(max(delay, 0))
	defer timer.Stop()
	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-timer.C:
		return nil
	}
}
