package learning

import (
	"context"
	"sync/atomic"
	"xuetangx/internal/domain"
	"xuetangx/internal/platform/wire"
	"xuetangx/internal/questions"
)

func (r *Runner) collect(ctx context.Context, in Input) (Result, error) {
	total := 0
	for _, ex := range in.Exercises {
		total += len(ex.Problems)
	}
	var failed atomic.Int32
	e := pool(ctx, in.Concurrency, len(in.Exercises), func(i int) error {
		ex := in.Exercises[i]
		if ex.Error != "" {
			failed.Add(1)
			r.emit(total, &domain.Item{UnitID: ex.LeafID, Status: "failed", Error: ex.Error}, ex.Error)
			return nil
		}
		for _, p := range ex.Problems {
			if ctx.Err() != nil {
				return ctx.Err()
			}
			args := map[string]any{"leafId": ex.LeafID, "problemId": p.ID}
			var captured struct {
				Ready bool `json:"ready"`
			}
			err := r.Call(ctx, "capture-answer", args, &captured)
			if err == nil && !captured.Ready && in.SubmitUnanswered {
				count, e := questions.Count(p)
				if e != nil {
					err = e
				} else if count == 0 {
					var answer wire.Object
					err = r.Call(ctx, "submit-question", args, &answer)
					if err == nil {
						err = r.Call(ctx, "capture-answer", args, &captured)
					}
				}
			}
			item := domain.Item{UnitID: ex.LeafID, ProblemID: p.ID, Status: "captured"}
			if err != nil || !captured.Ready {
				if ctx.Err() != nil {
					return ctx.Err()
				}
				if err != nil && fatal(err) {
					return err
				}
				failed.Add(1)
				item.Status = "missing"
				item.Error = "后端未公开匹配的标准答案"
				if err != nil {
					item.Error = err.Error()
				}
			}
			r.emit(total, &item, "采集题目标准答案")
		}
		return nil
	})
	if e != nil {
		return Result{}, e
	}
	status := "done"
	if failed.Load() > 0 {
		status = "partial"
	}
	return Result{status, "标准答案采集结束", total}, nil
}
