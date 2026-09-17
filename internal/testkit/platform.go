package testkit

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"sync"
	"testing"
	"xuetangx/internal/platform"
	"xuetangx/internal/platform/wire"
)

type Platform struct {
	Server                       *httptest.Server
	Client                       *platform.Client
	mu                           sync.Mutex
	Answers, Posts               map[int64]int
	Videos, Articles             map[int64]bool
	Submitted                    []int64
	EnrollmentRequired, Enrolled bool
	EnrollmentCalls              int
}

func MockPlatform(t testing.TB) *Platform {
	t.Helper()
	p := &Platform{Answers: map[int64]int{}, Posts: map[int64]int{}, Videos: map[int64]bool{}, Articles: map[int64]bool{}}
	p.Server = httptest.NewServer(http.HandlerFunc(p.handle))
	var e error
	p.Client, e = platform.NewTestClient(p.Server.URL)
	if e != nil {
		t.Fatal(e)
	}
	t.Cleanup(p.Server.Close)
	return p
}
func (p *Platform) handle(w http.ResponseWriter, r *http.Request) {
	p.mu.Lock()
	defer p.mu.Unlock()
	cookie, _ := r.Cookie("sessionid")
	uid := int64(0)
	if cookie != nil {
		uid, _ = strconv.ParseInt(cookie.Value, 10, 64)
	}
	if uid == 0 {
		w.WriteHeader(401)
		return
	}
	write := func(data any) {
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(wire.Object{"success": true, "data": data})
	}
	q := r.URL.Query()
	var body wire.Object
	if r.Method == "POST" {
		if r.Header.Get("X-CSRFToken") == "" {
			w.WriteHeader(403)
			return
		}
		_ = json.NewDecoder(r.Body).Decode(&body)
	}
	switch {
	case r.URL.Path == "/api/v1/u/user/basic_profile/":
		write(wire.Object{"user_id": uid, "name": fmt.Sprintf("Student %d", uid)})
	case r.URL.Path == "/api/v1/lms/product/get_product_basic_info/":
		write(wire.Object{"id": 99, "sign": "s", "course_sign": "c"})
	case r.URL.Path == "/api/v1/lms/product/classroom/":
		write(wire.Object{"current": []any{wire.Object{"classroom_id": 12}}})
	case r.URL.Path == "/api/v1/lms/product/sku_pay_detail/":
		write(wire.Object{"product_id": 99, "sku_info": []any{wire.Object{"sku_id": 1102, "current_price": 0, "status": 5}}})
	case r.URL.Path == "/api/v1/lms/order/entries_free_sku/99/":
		if uid != 202 || q.Get("sid") != "1102" || r.Method != "POST" {
			w.WriteHeader(400)
			return
		}
		p.EnrollmentCalls++
		p.Enrolled = true
		write(wire.Object{})
	case r.URL.Path == "/api/v1/lms/user/user-courses/":
		if p.EnrollmentRequired && uid == 202 && !p.Enrolled {
			write(wire.Object{"pages": 1, "product_list": []any{}})
			return
		}
		write(wire.Object{"pages": 1, "product_list": []any{wire.Object{"classroom_id": 12, "sign": "s", "course_sign": "c", "name": "模拟课程"}}})
	case r.URL.Path == "/api/v1/lms/learn/course/chapter":
		write(wire.Object{"course_chapter": []any{wire.Object{"id": 11, "leaf_type": 0, "name": "视频"}, wire.Object{"id": 22, "leaf_type": 3, "name": "图文"}, wire.Object{"id": 33, "leaf_type": 4, "name": "讨论"}, wire.Object{"id": 34, "leaf_type": 5, "name": "练习"}}})
	case r.URL.Path == "/api/v1/lms/learn/course/schedule":
		progress := wire.Object{"11": 0, "22": 0, "33": 0, "34": 0}
		if p.Videos[uid] {
			progress["11"] = 1
		}
		if p.Articles[uid] {
			progress["22"] = 1
		}
		if p.Posts[uid] > 0 {
			progress["33"] = 1
		}
		write(wire.Object{"leaf_schedules": progress})
	case strings.HasPrefix(r.URL.Path, "/api/v1/lms/learn/leaf_info/"):
		parts := strings.Split(strings.Trim(r.URL.Path, "/"), "/")
		leaf, _ := strconv.ParseInt(parts[len(parts)-1], 10, 64)
		typ := map[int64]int{11: 0, 22: 3, 33: 4, 34: 5}[leaf]
		write(wire.Object{"id": leaf, "classroom_id": 12, "leaf_type": typ, "sku_id": uid + 900, "course_id": 99, "user_id": uid, "finish": p.Articles[uid], "content_info": wire.Object{"leaf_type_id": 56, "media": wire.Object{"ccid": "example", "type": "video", "duration": 10}}})
	case strings.HasPrefix(r.URL.Path, "/api/v1/lms/exercise/get_exercise_list/"):
		user := wire.Object{"my_count": p.Answers[uid], "is_right": p.Answers[uid] > 0, "is_show_answer": p.Answers[uid] > 0}
		if p.Answers[uid] > 0 {
			user["answer"] = []string{"A"}
		}
		write(wire.Object{"problems": []any{wire.Object{"problem_id": 78, "index": 1, "content": wire.Object{"Type": "SingleChoice", "Body": "Question", "Options": []any{wire.Object{"key": "A", "value": "Correct"}, wire.Object{"key": "B", "value": "Wrong"}}}, "user": user}}})
	case r.URL.Path == platform.SubmitPath:
		p.Answers[uid]++
		p.Submitted = append(p.Submitted, uid)
		write(wire.Object{"is_correct": true, "is_show_answer": true, "answer": []string{"A"}})
	case r.URL.Path == "/video-log/get_video_watch_progress/":
		write(wire.Object{q.Get("video_id"): wire.Object{"completed": p.Videos[uid], "video_length": 10, "rate": 0}})
	case strings.HasPrefix(r.URL.Path, "/api/v1/lms/service/playurl/"):
		write(wire.Object{"duration": 10, "sources": wire.Object{"quality10": []string{"https://cdn.example.test/v.mp4"}}})
	case r.URL.Path == "/video-log/heartbeat/":
		for _, v := range wire.Array(body["heart_data"]) {
			if wire.Obj(v)["et"] == "videoend" {
				p.Videos[uid] = true
			}
		}
		write(wire.Object{})
	case strings.HasPrefix(r.URL.Path, "/api/v1/lms/learn/user_article_finish/"):
		p.Articles[uid] = true
		write(wire.Object{})
	case r.URL.Path == "/api/v1/lms/forum/unit/discussion/":
		write(wire.Object{"id": 77, "classroom_id": 12, "chapter_id": 33, "user_id": 88, "user_comment_num": p.Posts[uid]})
	case r.URL.Path == "/api/v1/lms/forum/comment/":
		p.Posts[uid]++
		write(wire.Object{"id": 999})
	case r.URL.Path == "/api/v1/lms/learn/chapter/schedule":
		schedule := 0
		if p.Posts[uid] > 0 {
			schedule = 1
		}
		write(wire.Object{"leaf_schedule": schedule})
	default:
		w.WriteHeader(404)
		json.NewEncoder(w).Encode(wire.Object{"success": false})
	}
}
func (p *Platform) Counts(uid int64) (int, int) {
	p.mu.Lock()
	defer p.mu.Unlock()
	return p.Answers[uid], p.Posts[uid]
}

func (p *Platform) RequireCollectorEnrollment() {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.EnrollmentRequired = true
}
func (p *Platform) Joins() int { p.mu.Lock(); defer p.mu.Unlock(); return p.EnrollmentCalls }
