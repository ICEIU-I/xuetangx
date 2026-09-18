package platform

import (
	"context"
	"errors"
	"time"
	"xuetangx/internal/domain"
)

func (b *Broker) Call(ctx context.Context, a domain.Account, method, path string, body any) (Response, error) {
	networkRetries, accessRetries := 0, 0
	for {
		r, e := b.Request(ctx, a, method, path, body)
		if e == nil {
			if ReadOnly(method, path) && (RateLimited(r) || r.Status >= 500) {
				delay := max(time.Until(Cooldown(r, time.Now())), Backoff(networkRetries))
				networkRetries = min(networkRetries+1, 7)
				if e = Wait(ctx, delay); e != nil {
					return r, e
				}
				continue
			}
			if r.Status == 403 {
				// Each retry re-enters the shared account cooldown; pause/stop
				// cancels the same context even after the former retry limit.
				b.extendAccessCooldown(a.UserID, accessRetries)
				accessRetries = min(accessRetries+1, 5)
				continue
			}
			// Keep explicit rejections as responses so operation journals record rejected, not unknown.
			// Operation services journal explicit rate rejections before retrying.
			return r, nil
		}
		var network *TransportError
		if path == SubmitPath || !errors.As(e, &network) || !network.Transient || (network.Connected && !ReadOnly(method, path)) {
			return r, e
		}
		networkRetries = min(networkRetries+1, 7)
		if e = Wait(ctx, Backoff(networkRetries-1)); e != nil {
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
