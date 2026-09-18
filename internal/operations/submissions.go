package operations

import (
	"context"
	"errors"
	"golang.org/x/sync/singleflight"
	"time"
	"xuetangx/internal/bank"
	"xuetangx/internal/catalog"
	"xuetangx/internal/domain"
	"xuetangx/internal/fault"
	"xuetangx/internal/platform"
	"xuetangx/internal/platform/wire"
	"xuetangx/internal/questions"
)

type Service struct {
	Journal *Journal
	Bank    *bank.Service
	Catalog *catalog.Service
	Call    catalog.Request
	Wait    func(context.Context, time.Duration) error
	Delays  []time.Duration
	Report  func(string)
	group   singleflight.Group
}

func New(j *Journal, b *bank.Service, c *catalog.Service, call catalog.Request) *Service {
	return &Service{Journal: j, Bank: b, Catalog: c, Call: call, Wait: platform.Wait, Delays: []time.Duration{time.Second, 2 * time.Second, 4 * time.Second}}
}
func (s *Service) Submit(ctx context.Context, a domain.Account, c domain.Course, ex domain.Exercise, p domain.Problem, collector bool) (wire.Object, error) {
	key := Key("question", a, c, ex.LeafID, p.ID, questions.Fingerprint(p))
	ch := s.group.DoChan(key, func() (any, error) { return s.submit(ctx, a, c, ex, p, collector, key) })
	select {
	case <-ctx.Done():
		return nil, ctx.Err()
	case r := <-ch:
		if r.Err != nil {
			return nil, r.Err
		}
		return r.Val.(wire.Object), nil
	}
}
func (s *Service) submit(ctx context.Context, a domain.Account, c domain.Course, ex domain.Exercise, p domain.Problem, collector bool, key string) (wire.Object, error) {
	if ctx.Err() != nil {
		return nil, ctx.Err()
	}
	var body wire.Object
	if collector {
		if a.Role != "test" {
			return nil, fault.New("INVALID_ROLE", "采集提交只允许测试账号")
		}
		var ok bool
		body, ok = questions.Probe(p)
		if !ok {
			return nil, fault.New("UNSUPPORTED", "题型不支持自动采集")
		}
	} else {
		if a.Role != "primary" {
			return nil, fault.New("INVALID_ROLE", "正式答题账号角色错误")
		}
		answer, ok, e := s.Bank.Lookup(ctx, c, ex, p)
		if e != nil {
			return nil, e
		}
		if !ok {
			return nil, fault.New("ANSWER_MISSING", "缺少匹配且无冲突的标准答案")
		}
		body = questions.Body(answer)
	}
	r, e := s.Journal.Load(ctx, key, "question", a, c, ex.LeafID, p.ID, questions.Fingerprint(p))
	if e != nil {
		return nil, e
	}
	if e = s.Journal.PreserveLegacy(ctx, &r, a, c, ex.LeafID, p.ID, questions.LegacyFingerprints(p)); e != nil {
		return nil, e
	}
	report := func(msg string) {
		if s.Report != nil {
			s.Report(msg)
		}
	}
	reconcile := func() (wire.Object, error) {
		report("提交结果待确认，正在回查平台作答状态")
		for _, delay := range s.Delays {
			if e := s.Wait(ctx, delay); e != nil {
				return nil, e
			}
			ps, e := s.Catalog.Problems(ctx, a, ex)
			if e != nil {
				return nil, fault.New("REVIEW_REQUIRED", "回查失败，保留待核对记录，不重发")
			}
			var current *domain.Problem
			for i := range ps {
				if ps[i].ID == p.ID {
					current = &ps[i]
					break
				}
			}
			if current == nil || questions.Fingerprint(*current) != questions.Fingerprint(p) {
				return nil, fault.New("REVIEW_REQUIRED", "回查题目缺失或版本变化，不重发")
			}
			count, e := questions.Count(*current)
			if e != nil {
				return nil, fault.New("REVIEW_REQUIRED", "回查缺少有效作答次数，不重发")
			}
			if count > 0 {
				source, _ := wire.Decode(current.User)
				source["is_correct"] = source["is_right"]
				if e = s.Journal.Save(ctx, &r, "confirmed", r.Retries, r.Retryable, source); e != nil {
					return nil, e
				}
				if e = s.Bank.Save(ctx, a, c, ex, *current, source, "exercise_list"); e != nil {
					return nil, e
				}
				return source, nil
			}
		}
		return nil, nil
	}
	retry := func(notSent bool) error {
		if r.Retries >= 2 {
			if e := s.Journal.Save(ctx, &r, "retry_exhausted", r.Retries, true, nil); e != nil {
				return e
			}
			return fault.New("SUBMISSION_RETRY_EXHAUSTED", "已达到两次自动重试上限")
		}
		if e := s.Journal.Save(ctx, &r, "retry_ready", r.Retries+1, true, nil); e != nil {
			return e
		}
		report("回查确认未作答，正在有限重试")
		if notSent {
			return s.Wait(ctx, time.Duration(r.Retries)*time.Second)
		}
		return nil
	}
	if r.State != "new" && r.State != "rejected" && r.State != "not_sent" {
		confirmed, e := reconcile()
		if e != nil {
			return nil, e
		}
		if confirmed != nil {
			return confirmed, nil
		}
		if r.State == "posted" || r.State == "confirmed" || !r.Retryable {
			return nil, fault.New("REVIEW_REQUIRED", "平台曾接收提交或错误不支持重试")
		}
		if r.State != "retry_ready" {
			if e = retry(false); e != nil {
				return nil, e
			}
		}
	} else if r.State == "not_sent" {
		if e = retry(true); e != nil {
			return nil, e
		}
	}
	body["leaf_id"] = ex.LeafID
	body["classroom_id"] = c.ClassroomID
	body["exercise_id"] = ex.ExerciseID
	body["problem_id"] = p.ID
	body["sign"] = c.Sign
	rates := 0
	for {
		if e = ctx.Err(); e != nil {
			return nil, e
		}
		if e = s.Journal.Save(ctx, &r, "pending", r.Retries, true, nil); e != nil {
			return nil, e
		}
		response, err := s.Call(ctx, a, "POST", platform.SubmitPath, body)
		if err == nil && response.Status >= 500 {
			err = &platform.TransportError{Connected: true, Transient: true}
		}
		if err != nil {
			var network *platform.TransportError
			known := errors.As(err, &network)
			notSent := known && !network.Connected
			retryable := known && network.Transient
			state := "unknown"
			if notSent {
				state = "not_sent"
			}
			if fault.Code(err) == "ACCOUNT_REQUIRED" || fault.Code(err) == "ACCESS_DENIED" {
				state = "rejected"
			}
			saveCtx, cancel := context.WithTimeout(context.WithoutCancel(ctx), 5*time.Second)
			saveErr := s.Journal.Save(saveCtx, &r, state, r.Retries, retryable || ctx.Err() != nil, nil)
			cancel()
			if saveErr != nil {
				return nil, saveErr
			}
			if ctx.Err() != nil {
				return nil, ctx.Err()
			}
			if state == "rejected" {
				return nil, err
			}
			if !notSent {
				confirmed, e := reconcile()
				if e != nil {
					return nil, e
				}
				if confirmed != nil {
					return confirmed, nil
				}
			}
			if !retryable {
				return nil, err
			}
			if e = retry(notSent); e != nil {
				return nil, e
			}
			continue
		}
		if platform.RateLimited(response) {
			if e = s.Journal.Save(ctx, &r, "rejected", r.Retries, true, nil); e != nil {
				return nil, e
			}
			delay := max(time.Until(platform.Cooldown(response, time.Now())), platform.Backoff(rates))
			rates = min(rates+1, 7)
			if e = s.Wait(ctx, delay); e != nil {
				return nil, e
			}
			continue
		}
		source, err := response.Data()
		if err != nil {
			rejected := response.JSON["success"] == false || response.Status == 400 || response.Status == 401 || response.Status == 403 || response.Status == 404 || response.Status == 422
			state := "unknown"
			if rejected {
				state = "rejected"
			}
			if e = s.Journal.Save(ctx, &r, state, r.Retries, false, nil); e != nil {
				return nil, e
			}
			if !rejected {
				confirmed, e := reconcile()
				if e != nil {
					return nil, e
				}
				if confirmed != nil {
					return confirmed, nil
				}
			}
			return nil, err
		}
		if source == nil || response.JSON["data"] == nil {
			if e = s.Journal.Save(ctx, &r, "unknown", r.Retries, false, nil); e != nil {
				return nil, e
			}
			return nil, fault.New("REVIEW_REQUIRED", "平台未返回有效提交结果")
		}
		if e = s.Journal.Save(ctx, &r, "posted", r.Retries, false, source); e != nil {
			return nil, e
		}
		if e = s.Bank.Save(ctx, a, c, ex, p, source, "submission_response"); e != nil {
			return nil, e
		}
		return source, nil
	}
}
