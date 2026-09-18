package operations

import (
	"context"
	"fmt"
	"net/url"
	"xuetangx/internal/domain"
	"xuetangx/internal/fault"
	"xuetangx/internal/platform/wire"
)

// progressComplete reads the user's current progress before recovering an
// uncertain or acknowledged progress write. A missing field never means false.
func (s *Service) progressComplete(ctx context.Context, a domain.Account, c domain.Course, leaf int64, kind string) (bool, error) {
	r, err := s.Call(ctx, a, "GET", fmt.Sprintf("/api/v1/lms/learn/leaf_info/%d/%d/?sign=%s", c.ClassroomID, leaf, url.QueryEscape(c.Sign)), nil)
	if err != nil {
		return false, err
	}
	d, err := r.Data()
	if err != nil {
		return false, err
	}
	id, _ := wire.Int(d["id"])
	cid, _ := wire.Int(d["classroom_id"])
	if id != leaf || cid != c.ClassroomID {
		return false, fault.New("INVALID_METADATA", "进度回查的课程单元不匹配")
	}
	for _, key := range []string{"is_deleted", "is_locked", "locked_reason", "upgrade_sku_id"} {
		if wire.Truthy(d[key]) {
			return false, fault.New("LOCKED", "学习单元不可访问")
		}
	}
	if kind == "article" {
		return completionField(d["finish"])
	}
	uid, _ := wire.Int(d["user_id"])
	courseID, err := wire.ID(d["course_id"])
	if err != nil || uid != a.UserID {
		return false, fault.New("INVALID_METADATA", "进度回查的账号不匹配")
	}
	r, err = s.Call(ctx, a, "GET", fmt.Sprintf("/video-log/get_video_watch_progress/?cid=%d&user_id=%d&classroom_id=%d&video_type=video&vtype=rate&video_id=%d", courseID, uid, c.ClassroomID, leaf), nil)
	if err != nil {
		return false, err
	}
	d, err = r.Data()
	if err != nil {
		return false, err
	}
	return completionField(wire.Obj(d[fmt.Sprint(leaf)])["completed"])
}

func completionField(v any) (bool, error) {
	if v == true || v == false {
		return v == true, nil
	}
	if n, ok := wire.Int(v); ok && (n == 0 || n == 1) {
		return n == 1, nil
	}
	// The platform occasionally omits the completion flag while its progress
	// update is still being indexed. Treat that as an unconfirmed state so the
	// caller backs off and checks again instead of permanently failing the item.
	return false, fault.New("UNCONFIRMED", "进度回查缺少有效完成状态")
}
