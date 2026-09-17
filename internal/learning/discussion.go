package learning

import (
	"context"
	"fmt"
	"net/url"
	"xuetangx/internal/domain"
	"xuetangx/internal/fault"
	"xuetangx/internal/platform/wire"
)

func (r *Runner) discussion(ctx context.Context, in Input, u domain.Unit) (string, error) {
	leaf, e := r.leaf(ctx, in.Course, u)
	if e != nil {
		return "", e
	}
	topic, e := r.request(ctx, "GET", fmt.Sprintf("/api/v1/lms/forum/unit/discussion/?product_sign=%s&leaf_id=%d&classroom_id=%d&topic_type=4&channel=xt", url.QueryEscape(in.Course.Sign), u.ID, in.Course.ClassroomID), nil)
	if e != nil {
		return "", e
	}
	cid, _ := wire.Int(topic["classroom_id"])
	lid, _ := wire.Int(topic["chapter_id"])
	count, valid := wire.Int(topic["user_comment_num"])
	if cid != in.Course.ClassroomID || lid != u.ID || !valid || count < 0 {
		return "", fault.New("INVALID_METADATA", "无法确认讨论身份或发言记录")
	}
	posted := false
	if count == 0 {
		var result struct {
			Posted bool `json:"posted"`
		}
		e = r.Call(ctx, "publish-discussion", map[string]any{"leafId": u.ID}, &result)
		if e != nil {
			return "", e
		}
		posted = result.Posted
	}
	sku, e := wire.ID(leaf["sku_id"])
	if e != nil {
		return "", e
	}
	e = r.verify(ctx, func() (bool, error) {
		d, e := r.request(ctx, "POST", "/api/v1/lms/learn/chapter/schedule", wire.Object{"leaf_id": u.ID, "classroom_id": in.Course.ClassroomID, "sku_id": sku})
		return wire.True(d["leaf_schedule"]), e
	})
	if posted {
		return "completed", e
	}
	return "skipped", e
}
