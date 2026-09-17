package learning

import (
	"context"
	"fmt"
	"net/url"
	"sync/atomic"
	"xuetangx/internal/domain"
	"xuetangx/internal/fault"
	"xuetangx/internal/platform/wire"
)

func (r *Runner) leaf(ctx context.Context, c domain.Course, u domain.Unit) (wire.Object, error) {
	d, e := r.request(ctx, "GET", fmt.Sprintf("/api/v1/lms/learn/leaf_info/%d/%d/?sign=%s", c.ClassroomID, u.ID, url.QueryEscape(c.Sign)), nil)
	if e != nil {
		return nil, e
	}
	id, _ := wire.Int(d["id"])
	cid, _ := wire.Int(d["classroom_id"])
	typ, _ := wire.Int(d["leaf_type"])
	if id != u.ID || cid != c.ClassroomID || int(typ) != u.LeafType {
		return nil, fault.New("INVALID_METADATA", "学习单元与任务不匹配")
	}
	for _, k := range []string{"is_deleted", "is_locked", "locked_reason", "upgrade_sku_id"} {
		if wire.Truthy(d[k]) {
			return nil, fault.New("LOCKED", "学习单元不可访问")
		}
	}
	return d, nil
}
func (r *Runner) media(ctx context.Context, in Input) (Result, error) {
	var failures atomic.Int32
	total := len(in.Units)
	r.emit(total, nil, "开始处理课程单元")
	e := pool(ctx, in.Concurrency, total, func(i int) error {
		u := in.Units[i]
		item := domain.Item{UnitID: u.ID, Title: u.Title}
		var err error
		if u.Progress == 1 {
			item.Status = "skipped"
		} else if u.Locked {
			err = fault.New("LOCKED", "学习单元尚未开放")
		} else {
			switch in.Kind {
			case "video":
				item.Status, err = r.video(ctx, in, u)
			case "article":
				item.Status, err = r.article(ctx, in, u)
			case "discussion":
				item.Status, err = r.discussion(ctx, in, u)
			}
		}
		if err != nil {
			if ctx.Err() != nil {
				return ctx.Err()
			}
			if fatal(err) {
				return err
			}
			failures.Add(1)
			item.Status = "failed"
			item.Error = fault.Public(err)
		}
		r.emit(total, &item, u.Title)
		return nil
	})
	if e != nil {
		return Result{}, e
	}
	status := "done"
	if failures.Load() > 0 {
		status = "partial"
	}
	return Result{status, "课程单元处理结束", total}, nil
}
