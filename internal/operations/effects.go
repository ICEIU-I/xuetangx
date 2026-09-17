package operations

import (
	"context"
	"time"
	"xuetangx/internal/domain"
	"xuetangx/internal/fault"
	"xuetangx/internal/platform"
	"xuetangx/internal/platform/wire"
)

func (s *Service) Effect(ctx context.Context, a domain.Account, c domain.Course, leaf int64, kind, suffix, method, path string, body any) (platform.Response, error) {
	key := Key(kind, a, c, leaf, 0, suffix)
	ch := s.group.DoChan(key, func() (any, error) {
		r, e := s.Journal.Load(ctx, key, kind, a, c, leaf, 0, suffix)
		if e != nil {
			return nil, e
		}
		if r.State == "posted" || r.State == "confirmed" {
			return platform.Response{Status: 200, JSON: wire.Object{"success": true, "data": r.Result}}, nil
		}
		if r.State != "new" && r.State != "rejected" && r.State != "not_sent" {
			return nil, fault.New("REVIEW_REQUIRED", "上次操作结果不确定，未重复发送")
		}
		for attempt := 0; attempt < 4; attempt++ {
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
				return nil, err
			}
			if platform.RateLimited(response) {
				if e = s.Journal.Save(ctx, &r, "rejected", r.Retries, false, nil); e != nil {
					return nil, e
				}
				if attempt == 3 {
					return nil, fault.New("RATE_LIMITED", "平台持续限流")
				}
				if e = s.Wait(ctx, time.Until(platform.Cooldown(response, time.Now()))); e != nil {
					return nil, e
				}
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
				return nil, e
			}
			if e = s.Journal.Save(ctx, &r, "posted", r.Retries, false, data); e != nil {
				return nil, e
			}
			return response, nil
		}
		return nil, fault.New("RATE_LIMITED", "平台持续限流")
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
