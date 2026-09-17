package workflow

import (
	"context"
	"encoding/json"
	"fmt"
	"net/url"
	"regexp"
	"strconv"
	"strings"
	"xuetangx/internal/domain"
	"xuetangx/internal/fault"
	"xuetangx/internal/learning"
	"xuetangx/internal/platform"
	"xuetangx/internal/platform/wire"
	"xuetangx/internal/questions"
	"xuetangx/internal/secure"
)

var leafPath = regexp.MustCompile(`^/api/v1/lms/learn/leaf_info/([0-9]+)/([0-9]+)/$`)
var exercisePath = regexp.MustCompile(`^/api/v1/lms/exercise/get_exercise_list/([0-9]+)/([0-9]+)/$`)
var playPath = regexp.MustCompile(`^/api/v1/lms/service/playurl/[A-Za-z0-9_-]+/$`)
var articlePath = regexp.MustCompile(`^/api/v1/lms/learn/user_article_finish/([0-9]+)/$`)

func (e *Engine) rpc(ctx context.Context, job domain.Job, account domain.Account, input learning.Input, primary domain.Inventory, method string, payload json.RawMessage) (any, error) {
	if ctx.Err() != nil {
		return nil, ctx.Err()
	}
	var args struct {
		LeafID    int64  `json:"leafId"`
		ProblemID int64  `json:"problemId"`
		Method    string `json:"method"`
		Endpoint  string `json:"endpoint"`
		Body      any    `json:"body"`
	}
	if json.Unmarshal(payload, &args) != nil {
		return nil, fault.New("INVALID_REQUEST", "无效任务请求")
	}
	switch method {
	case "lookup-answer", "capture-answer", "submit-question":
		var ex *domain.Exercise
		var p *domain.Problem
		for i := range input.Exercises {
			if input.Exercises[i].LeafID == args.LeafID {
				ex = &input.Exercises[i]
				for j := range ex.Problems {
					if ex.Problems[j].ID == args.ProblemID {
						p = &ex.Problems[j]
						break
					}
				}
				break
			}
		}
		if ex == nil || p == nil || ex.Error != "" {
			return nil, fault.New("INVALID_METADATA", "题目不属于当前任务")
		}
		matched := false
		for _, original := range primary.Exercises {
			if original.LeafID != ex.LeafID || original.ExerciseID != ex.ExerciseID {
				continue
			}
			for _, q := range original.Problems {
				if q.ID == p.ID && questions.Fingerprint(q) == questions.Fingerprint(*p) {
					matched = true
				}
			}
		}
		if !matched {
			return nil, fault.New("ANSWER_MISMATCH", "测试账号题目与正式账号版本不匹配")
		}
		if method == "submit-question" {
			if input.Kind != "homework" && input.Kind != "collector" {
				return nil, fault.New("INVALID_ROLE", "模块不能提交习题")
			}
			count, err := questions.Count(*p)
			if err != nil {
				return nil, fault.New("INVALID_METADATA", "缺少有效作答次数")
			}
			if count > 0 {
				u, _ := wire.Decode(p.User)
				u["is_correct"] = u["is_right"]
				return u, nil
			}
			if input.Kind == "collector" && !input.SubmitUnanswered {
				return nil, fault.New("INVALID_ROLE", "只读采集不能提交")
			}
			return e.Ops.Submit(ctx, account, input.Course, *ex, *p, input.Kind == "collector")
		}
		if method == "capture-answer" {
			if input.Kind != "collector" {
				return nil, fault.New("INVALID_ROLE", "模块不能采集答案")
			}
			source, _ := wire.Decode(p.User)
			if err := e.Bank.Save(ctx, account, input.Course, *ex, *p, source, "exercise_list"); err != nil {
				return nil, err
			}
		}
		_, ready, err := e.Bank.Lookup(ctx, input.Course, *ex, *p)
		if err != nil {
			return nil, err
		}
		producer, err := e.Jobs.Producer(ctx, job.Owner, job.ID)
		return map[string]any{"ready": ready, "producer": producer}, err
	case "publish-discussion":
		if input.Kind != "discussion" || !containsUnit(input, args.LeafID) {
			return nil, fault.New("INVALID_REQUEST", "讨论不属于当前任务")
		}
		path := fmt.Sprintf("/api/v1/lms/forum/unit/discussion/?product_sign=%s&leaf_id=%d&classroom_id=%d&topic_type=4&channel=xt", url.QueryEscape(input.Course.Sign), args.LeafID, input.Course.ClassroomID)
		topic, err := e.Catalog.Data(ctx, account, "GET", path, nil)
		if err != nil {
			return nil, err
		}
		cid, _ := wire.Int(topic["classroom_id"])
		leaf, _ := wire.Int(topic["chapter_id"])
		count, ok := wire.Int(topic["user_comment_num"])
		if cid != input.Course.ClassroomID || leaf != args.LeafID || !ok || count < 0 {
			return nil, fault.New("INVALID_METADATA", "无法核对讨论身份")
		}
		if count > 0 {
			return map[string]bool{"posted": false}, nil
		}
		topicID, err := wire.ID(topic["id"])
		if err != nil {
			return nil, err
		}
		author, err := wire.ID(topic["user_id"])
		if err != nil {
			return nil, err
		}
		body := wire.Object{"to_user": author, "topic_id": topicID, "content": wire.Object{"text": "1", "upload_images": []any{}}}
		_, err = e.Ops.Effect(ctx, account, input.Course, args.LeafID, "discussion", "", "POST", fmt.Sprintf("/api/v1/lms/forum/comment/?classroom_id=%d&leaf_id=%d", input.Course.ClassroomID, args.LeafID), body)
		return map[string]bool{"posted": err == nil}, err
	case "request":
		return e.forward(ctx, account, input, args.Method, args.Endpoint, args.Body)
	}
	return nil, fault.New("INVALID_REQUEST", "未知子进程操作")
}
func containsUnit(input learning.Input, id int64) bool {
	for _, u := range input.Units {
		if u.ID == id {
			return true
		}
	}
	return false
}
func (e *Engine) forward(ctx context.Context, a domain.Account, in learning.Input, method, path string, body any) (platform.Response, error) {
	denied := func() (platform.Response, error) {
		return platform.Response{}, fault.New("INVALID_REQUEST", "子进程请求超出任务范围")
	}
	u, err := url.Parse(path)
	if err != nil || u.IsAbs() || u.Host != "" || !strings.HasPrefix(path, "/") || strings.HasPrefix(path, "//") {
		return denied()
	}
	num := func(key string) int64 { n, _ := strconv.ParseInt(u.Query().Get(key), 10, 64); return n }
	class := in.Course.ClassroomID
	allowed := false
	if method == "GET" {
		if m := leafPath.FindStringSubmatch(u.Path); m != nil {
			cid, _ := strconv.ParseInt(m[1], 10, 64)
			id, _ := strconv.ParseInt(m[2], 10, 64)
			allowed = cid == class && containsUnit(in, id) && u.Query().Get("sign") == in.Course.Sign
		}
		if in.Kind == "video" {
			allowed = allowed || (u.Path == "/video-log/get_video_watch_progress/" && num("classroom_id") == class && containsUnit(in, num("video_id")) && num("user_id") == a.UserID) || playPath.MatchString(u.Path)
		}
		if in.Kind == "discussion" {
			allowed = allowed || (u.Path == "/api/v1/lms/forum/unit/discussion/" && num("classroom_id") == class && containsUnit(in, num("leaf_id")) && u.Query().Get("product_sign") == in.Course.Sign)
		}
		if in.Kind == "homework" || in.Kind == "collector" {
			if m := exercisePath.FindStringSubmatch(u.Path); m != nil {
				ex, _ := strconv.ParseInt(m[1], 10, 64)
				sku, _ := strconv.ParseInt(m[2], 10, 64)
				for _, x := range in.Exercises {
					if ex == x.ExerciseID && sku == x.SKUID {
						allowed = true
					}
				}
			}
		}
		if in.Kind == "article" {
			if m := articlePath.FindStringSubmatch(u.Path); m != nil {
				leaf, _ := strconv.ParseInt(m[1], 10, 64)
				if num("cid") != class || !containsUnit(in, leaf) || num("sid") <= 0 {
					return denied()
				}
				return e.Ops.Effect(ctx, a, in.Course, leaf, "article", "", method, path, body)
			}
		}
	} else if method == "POST" {
		b := wire.Obj(body)
		if in.Kind == "discussion" && u.Path == "/api/v1/lms/learn/chapter/schedule" {
			cid, _ := wire.Int(b["classroom_id"])
			leaf, _ := wire.Int(b["leaf_id"])
			allowed = cid == class && containsUnit(in, leaf)
		}
		if in.Kind == "video" && u.Path == "/video-log/heartbeat/" {
			data := wire.Array(b["heart_data"])
			if len(data) == 0 || len(data) > 50 {
				return denied()
			}
			stable := []wire.Object{}
			leaf := int64(0)
			for _, raw := range data {
				v := wire.Obj(raw)
				uid, _ := wire.Int(v["u"])
				cid, _ := wire.Int(v["classroomid"])
				id, _ := wire.Int(v["v"])
				if uid != a.UserID || cid != class || !containsUnit(in, id) || (leaf != 0 && id != leaf) {
					return denied()
				}
				leaf = id
				item := wire.Object{}
				for _, k := range []string{"u", "v", "cc", "d", "sq", "cp", "et"} {
					item[k] = v[k]
				}
				stable = append(stable, item)
			}
			return e.Ops.Effect(ctx, a, in.Course, leaf, "video", secure.Hash(string(wire.JSON(stable))), method, path, body)
		}
	}
	if !allowed {
		return denied()
	}
	return e.Broker.Call(ctx, a, method, path, body)
}
