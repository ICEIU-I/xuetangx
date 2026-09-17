package learning

import (
	"context"
	"fmt"
	"sync"
	"time"
	"xuetangx/internal/domain"
	"xuetangx/internal/fault"
	"xuetangx/internal/platform/wire"
	"xuetangx/internal/questions"
)

type answerState struct {
	Ready    bool   `json:"ready"`
	Producer string `json:"producer"`
}

func (r *Runner) homework(ctx context.Context, in Input) (Result, error) {
	type entry struct {
		ex domain.Exercise
		p  domain.Problem
	}
	entries := []entry{}
	results := map[string]domain.Item{}
	key := func(e entry) string { return fmt.Sprintf("%d:%d", e.ex.LeafID, e.p.ID) }
	var mu sync.Mutex
	for _, ex := range in.Exercises {
		if ex.Error != "" {
			item := domain.Item{UnitID: ex.LeafID, Status: "failed", Error: ex.Error}
			results[fmt.Sprint(ex.LeafID)] = item
			r.emit(0, &item, ex.Error)
		}
		for _, p := range ex.Problems {
			entries = append(entries, entry{ex, p})
		}
	}
	total := len(entries)
	for {
		waiting := false
		running := false
		e := pool(ctx, in.Concurrency, len(entries), func(i int) error {
			en := entries[i]
			k := key(en)
			mu.Lock()
			_, done := results[k]
			mu.Unlock()
			if done {
				return nil
			}
			item := domain.Item{UnitID: en.ex.LeafID, ProblemID: en.p.ID}
			count, err := questions.Count(en.p)
			if err != nil {
				item.Status = "failed"
				item.Error = "无法确认当前作答次数"
			} else if count > 0 {
				u, _ := wire.Decode(en.p.User)
				item.Status = "skipped"
				if u["is_right"] == false {
					item.Status = "wrong_existing"
					item.Error = "已作答但判错，不自动重答"
				}
			} else {
				args := map[string]any{"leafId": en.ex.LeafID, "problemId": en.p.ID}
				var state answerState
				if e := r.Call(ctx, "lookup-answer", args, &state); e != nil {
					return e
				}
				if !state.Ready {
					if state.Producer == "done" || state.Producer == "partial" || state.Producer == "blocked" || state.Producer == "stopped" {
						item.Status = "missing"
						item.Error = "缺少匹配的标准答案"
					} else {
						mu.Lock()
						waiting = true
						if state.Producer == "running" || state.Producer == "queued" {
							running = true
						}
						mu.Unlock()
						return nil
					}
				} else {
					var response wire.Object
					err = r.Call(ctx, "submit-question", args, &response)
					if err != nil {
						if ctx.Err() != nil {
							return ctx.Err()
						}
						if fatal(err) {
							return err
						}
						item.Status = "failed"
						item.Error = fault.Public(err)
					} else if response["is_correct"] == true || response["is_right"] == true {
						item.Status = "completed"
					} else {
						item.Status = "failed"
						item.Error = "服务器未判定作答正确"
					}
				}
			}
			mu.Lock()
			results[k] = item
			mu.Unlock()
			r.emit(total, &item, "处理课程习题")
			return nil
		})
		if e != nil {
			return Result{}, e
		}
		if !waiting {
			break
		}
		if !running {
			return Result{"waiting_answers", "等待测试账号补齐答案", total}, nil
		}
		r.emit(total, nil, "等待新答案，已知答案继续作答")
		select {
		case <-ctx.Done():
			return Result{}, ctx.Err()
		case <-r.Wake:
		case <-time.After(time.Second):
		}
	}
	for _, ex := range in.Exercises {
		if ex.Error != "" {
			continue
		}
		d, e := r.request(ctx, "GET", fmt.Sprintf("/api/v1/lms/exercise/get_exercise_list/%d/%d/", ex.ExerciseID, ex.SKUID), nil)
		if e != nil {
			return Result{}, e
		}
		fresh, e := questions.DecodeProblems(d["problems"])
		if e != nil {
			return Result{}, e
		}
		for _, p := range fresh {
			k := fmt.Sprintf("%d:%d", ex.LeafID, p.ID)
			item, ok := results[k]
			if !ok || (item.Status != "completed" && item.Status != "failed") {
				continue
			}
			var original *domain.Problem
			for i := range ex.Problems {
				if ex.Problems[i].ID == p.ID {
					original = &ex.Problems[i]
					break
				}
			}
			count, e := questions.Count(p)
			user, _ := wire.Decode(p.User)
			confirmed := e == nil && count > 0 && user["is_right"] == true && original != nil && questions.Fingerprint(*original) == questions.Fingerprint(p)
			if confirmed {
				item.Status = "completed"
				item.Error = ""
			} else if item.Status == "completed" {
				item.Status = "failed"
				item.Error = "最终回查未确认答对"
			}
			results[k] = item
			r.emit(total, &item, "最终回查作答结果")
		}
	}
	status := "done"
	for _, item := range results {
		if item.Status == "failed" || item.Status == "missing" || item.Status == "wrong_existing" {
			status = "partial"
		}
	}
	return Result{status, "课程答题已回查", total}, nil
}
