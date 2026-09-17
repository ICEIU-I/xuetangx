package learning

import (
	"context"
	"encoding/json"
	"sync"
	"time"
	"xuetangx/internal/domain"
	"xuetangx/internal/fault"
	"xuetangx/internal/platform"
	"xuetangx/internal/platform/wire"
)

type Input struct {
	Kind             string            `json:"kind"`
	Course           domain.Course     `json:"course"`
	Units            []domain.Unit     `json:"units"`
	Exercises        []domain.Exercise `json:"exercises"`
	Concurrency      int               `json:"concurrency"`
	UserID           int64             `json:"userId"`
	Role             string            `json:"role"`
	SubmitUnanswered bool              `json:"submitUnanswered"`
}
type Result struct {
	Status  string `json:"status"`
	Message string `json:"message"`
	Total   int    `json:"total"`
}
type Progress struct {
	Total   int          `json:"total"`
	Message string       `json:"message"`
	Item    *domain.Item `json:"item,omitempty"`
}
type RPC func(context.Context, string, any, any) error
type Runner struct {
	Call     RPC
	Progress func(Progress)
	Wake     <-chan struct{}
	Wait     func(context.Context, time.Duration) error
}

func (r *Runner) Run(ctx context.Context, in Input) (Result, error) {
	if r.Wait == nil {
		r.Wait = platform.Wait
	}
	if in.Concurrency < 1 || in.Concurrency > 3 {
		return Result{}, fault.New("INVALID_INPUT", "并发数须为 1–3")
	}
	switch in.Kind {
	case "homework":
		return r.homework(ctx, in)
	case "collector":
		return r.collect(ctx, in)
	case "video", "article", "discussion":
		return r.media(ctx, in)
	}
	return Result{}, fault.New("INVALID_INPUT", "任务类型无效")
}
func (r *Runner) request(ctx context.Context, method, path string, body any) (wire.Object, error) {
	var response platform.Response
	e := r.Call(ctx, "request", map[string]any{"method": method, "endpoint": path, "body": body}, &response)
	if e != nil {
		return nil, e
	}
	return response.Data()
}
func (r *Runner) emit(total int, item *domain.Item, message string) {
	if r.Progress != nil {
		r.Progress(Progress{total, message, item})
	}
}
func (r *Runner) verify(ctx context.Context, check func() (bool, error)) error {
	for _, d := range []time.Duration{0, time.Second, 2 * time.Second} {
		if e := r.Wait(ctx, d); e != nil {
			return e
		}
		ok, e := check()
		if e != nil {
			return e
		}
		if ok {
			return nil
		}
	}
	return fault.New("UNCONFIRMED", "后端尚未确认完成")
}
func pool(ctx context.Context, n, count int, fn func(int) error) error {
	child, cancel := context.WithCancel(ctx)
	defer cancel()
	jobs := make(chan int)
	var wg sync.WaitGroup
	var first error
	var mu sync.Mutex
	for w := 0; w < min(n, count); w++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for {
				select {
				case <-child.Done():
					return
				case i, ok := <-jobs:
					if !ok {
						return
					}
					if e := fn(i); e != nil {
						mu.Lock()
						if first == nil {
							first = e
						}
						mu.Unlock()
						cancel()
						return
					}
				}
			}
		}()
	}
send:
	for i := 0; i < count; i++ {
		select {
		case <-child.Done():
			break send
		case jobs <- i:
		}
	}
	close(jobs)
	wg.Wait()
	if first != nil {
		return first
	}
	return ctx.Err()
}
func fatal(e error) bool {
	switch fault.Code(e) {
	case "ACCOUNT_REQUIRED", "ACCOUNT_CHANGED", "ACCESS_DENIED", "RATE_LIMITED", "UNAVAILABLE":
		return true
	}
	return false
}
func decode(v any, target any) error { return json.Unmarshal(wire.JSON(v), target) }
