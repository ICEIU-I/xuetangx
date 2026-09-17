package learning

import (
	"context"
	"fmt"
	"xuetangx/internal/domain"
	"xuetangx/internal/platform/wire"
)

func (r *Runner) article(ctx context.Context, in Input, u domain.Unit) (string, error) {
	leaf, e := r.leaf(ctx, in.Course, u)
	if e != nil {
		return "", e
	}
	if wire.True(leaf["finish"]) {
		return "skipped", nil
	}
	sku, e := wire.ID(leaf["sku_id"])
	if e != nil {
		return "", e
	}
	if _, e = r.request(ctx, "GET", fmt.Sprintf("/api/v1/lms/learn/user_article_finish/%d/?cid=%d&sid=%d", u.ID, in.Course.ClassroomID, sku), nil); e != nil {
		return "", e
	}
	e = r.verify(ctx, func() (bool, error) { d, e := r.leaf(ctx, in.Course, u); return wire.True(d["finish"]), e })
	return "completed", e
}
