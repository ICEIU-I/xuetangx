package learning

import (
	"context"
	"fmt"
	"math"
	"net/url"
	"sort"
	"time"
	"xuetangx/internal/domain"
	"xuetangx/internal/fault"
	"xuetangx/internal/platform/wire"
	"xuetangx/internal/secure"
)

func (r *Runner) video(ctx context.Context, in Input, u domain.Unit) (string, error) {
	leaf, e := r.leaf(ctx, in.Course, u)
	if e != nil {
		return "", e
	}
	media := wire.Obj(wire.Obj(leaf["content_info"])["media"])
	cc := wire.String(media["ccid"])
	if cc == "" || (wire.String(media["type"]) != "" && wire.String(media["type"]) != "video") {
		return "", fault.New("UNSUPPORTED", "不支持该视频类型")
	}
	courseID, e := wire.ID(leaf["course_id"])
	if e != nil {
		return "", e
	}
	uid, e := wire.ID(leaf["user_id"])
	if e != nil || uid != in.UserID {
		return "", fault.New("INVALID_METADATA", "视频用户身份不匹配")
	}
	sku, e := wire.ID(leaf["sku_id"])
	if e != nil {
		return "", e
	}
	getProgress := func() (wire.Object, error) {
		d, e := r.request(ctx, "GET", fmt.Sprintf("/video-log/get_video_watch_progress/?cid=%d&user_id=%d&classroom_id=%d&video_type=video&vtype=rate&video_id=%d", courseID, uid, in.Course.ClassroomID, u.ID), nil)
		return wire.Obj(d[fmt.Sprint(u.ID)]), e
	}
	before, e := getProgress()
	if e != nil {
		return "", e
	}
	if wire.True(before["completed"]) {
		return "skipped", nil
	}
	play, e := r.request(ctx, "GET", "/api/v1/lms/service/playurl/"+url.PathEscape(cc)+"/?appid=10000", nil)
	if e != nil {
		return "", e
	}
	duration := float64(0)
	for _, v := range []any{before["video_length"], media["duration"], play["duration"], wire.Obj(play["m3u8"])["duration"]} {
		if n, valid := wire.Number(v); valid && n > 0 {
			duration = math.Ceil(n)
			break
		}
	}
	if duration <= 0 || duration > 86400 {
		return "", fault.New("INVALID_METADATA", "无法确定视频时长")
	}
	sources := wire.Obj(play["sources"])
	if len(sources) == 0 {
		sources = wire.Obj(wire.Obj(play["m3u8"])["sources"])
	}
	host := "other"
	keys := []string{}
	for k := range sources {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	for _, k := range keys {
		for _, v := range wire.Array(sources[k]) {
			if parsed, e := url.Parse(wire.String(v)); e == nil && (parsed.Scheme == "http" || parsed.Scheme == "https") {
				host = parsed.Hostname()
				break
			}
		}
	}
	base := wire.Object{"i": 5, "p": "web", "n": host, "lob": "plat2", "fp": 0, "tp": 0, "sp": 1, "u": uid, "uip": "", "c": courseID, "v": u.ID, "skuid": sku, "classroomid": fmt.Sprint(in.Course.ClassroomID), "cc": cc, "d": duration, "pg": fmt.Sprintf("%d_%s", u.ID, secure.Hash(fmt.Sprintf("%d:%d:%s:%v", uid, u.ID, cc, duration))[:8]), "t": "video", "cards_id": 0, "slide": 0, "v_url": ""}
	records := []wire.Object{}
	sequence := 0
	timestamp := time.Now().UnixMilli()
	add := func(event string, point float64) {
		sequence++
		rec := wire.Object{}
		for k, v := range base {
			rec[k] = v
		}
		rec["et"] = event
		rec["cp"] = point
		rec["ts"] = fmt.Sprint(timestamp + int64(sequence))
		rec["sq"] = sequence
		records = append(records, rec)
	}
	for _, event := range []string{"loadstart", "loadeddata", "play", "playing"} {
		add(event, 0)
	}
	for p := float64(5); p < duration; p += 5 {
		add("heartbeat", p)
	}
	add("videoend", duration)
	for offset := 0; offset < len(records); offset += 50 {
		if _, e = r.request(ctx, "POST", "/video-log/heartbeat/", wire.Object{"heart_data": records[offset:min(offset+50, len(records))]}); e != nil {
			return "", e
		}
	}
	e = r.verify(ctx, func() (bool, error) { p, e := getProgress(); return wire.True(p["completed"]), e })
	return "completed", e
}
