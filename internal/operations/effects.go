package operations

import (
	"context"
	"errors"
	"time"
	"xuetangx/internal/domain"
	"xuetangx/internal/fault"
	"xuetangx/internal/platform"
	"xuetangx/internal/platform/wire"
)

func retryableEffectKind(kind string) bool {
	// Video heartbeats and article completion are idempotent progress updates.
	// Replaying them after a lost response cannot create a duplicate user action;
	// discussion posts and enrollment writes must still be reviewed when their
	// result is unknown.
	return kind == "video" || kind == "article"
}

func retryableEffectError(err error) bool {
	var transport *platform.TransportError
	return errors.As(err, &transport) && transport.Transient
}

func (s *Service) Effect(ctx context.Context, a domain.Account, c domain.Course, leaf int64, kind, suffix, method, path string, body any) (platform.Response, error) {
	key := Key(kind, a, c, leaf, 0, suffix)
	ch := s.group.DoChan(key, func() (any, error) {
		r, e := s.Journal.Load(ctx, key, kind, a, c, leaf, 0, suffix)
		if e != nil {
			return nil, e
		}
		retryable := retryableEffectKind(kind)
		if (r.State == "posted" || r.State == "confirmed") && !retryable {
			return platform.Response{Status: 200, JSON: wire.Object{"success": true, "data": r.Result}}, nil
		}
		if r.State != "new" && r.State != "rejected" && r.State != "not_sent" && !(retryable && (r.State == "unknown" || r.State == "pending" || r.State == "posted" || r.State == "confirmed")) {
			return nil, fault.New("REVIEW_REQUIRED", "上次操作结果不确定，未重复发送")
		}
		attempt := 0
		for {
			if err := ctx.Err(); err != nil {
				return nil, err
			}
			if retryable && r.State != "new" && r.State != "rejected" && r.State != "not_sent" {
				complete, err := s.progressComplete(ctx, a, c, leaf, kind)
				if err != nil {
					return nil, err
				}
				if complete {
					if err = s.Journal.Save(ctx, &r, "confirmed", r.Retries, false, nil); err != nil {
						return nil, err
					}
					return platform.Response{Status: 200, JSON: wire.Object{"success": true, "data": r.Result}}, nil
				}
			}
			if e = s.Journal.Save(ctx, &r, "pending", r.Retries, false, nil); e != nil {
				return nil, e
			}
			response, err := s.Call(ctx, a, method, path, body)
			if err != nil {
				saveCtx, cancel := context.WithTimeout(context.WithoutCancel(ctx), 5*time.Second)
				saveErr := s.Journal.Save(saveCtx, &r, "unknown", r.Retries, false, nil)
				cancel()
				if saveErr != nil {
					return nil, saveErr
				}
				if !retryable || !retryableEffectError(err) {
					return nil, err
				}
				if e = s.Wait(ctx, platform.Backoff(attempt)); e != nil {
					return nil, e
				}
				attempt = min(attempt+1, 7)
				continue
			}
			if platform.RateLimited(response) {
				if e = s.Journal.Save(ctx, &r, "rejected", r.Retries, false, nil); e != nil {
					return nil, e
				}
				delay := max(time.Until(platform.Cooldown(response, time.Now())), platform.Backoff(attempt))
				if e = s.Wait(ctx, delay); e != nil {
					return nil, e
				}
				attempt = min(attempt+1, 7)
				continue
			}
			data, e := response.Data()
			if e != nil {
				state := "unknown"
				if response.Status == 401 || response.Status == 403 || response.JSON["success"] == false {
					state = "rejected"
				}
				if saveErr := s.Journal.Save(ctx, &r, state, r.Retries, false, nil); saveErr != nil {
					return nil, saveErr
				}
				if retryable && response.Status >= 500 {
					if e = s.Wait(ctx, platform.Backoff(attempt)); e != nil {
						return nil, e
					}
					attempt = min(attempt+1, 7)
					continue
				}
				return nil, e
			}
			if e = s.Journal.Save(ctx, &r, "posted", r.Retries, false, data); e != nil {
				return nil, e
			}
			return response, nil
		}
	})
	select {
	case <-ctx.Done():
		return platform.Response{}, ctx.Err()
	case r := <-ch:
		if r.Err != nil {
			return platform.Response{}, r.Err
		}
		return r.Val.(platform.Response), nil
	}
}
