package httpapi

import (
	"fmt"
	"net/http"
	"net/url"
	"regexp"
	"strconv"
	"xuetangx/internal/domain"
	"xuetangx/internal/fault"
	"xuetangx/internal/platform"
	"xuetangx/internal/platform/wire"
	"xuetangx/internal/questions"
)

var videoURL = regexp.MustCompile(`/video/([0-9]+)/?$`)

func (s *Server) advancedRoutes(m *http.ServeMux) {
	m.Handle("GET /api/video/courses", s.require(func(w http.ResponseWriter, r *http.Request) {
		a, e := s.Accounts.Require(r.Context(), principal(r).User.ID, "primary")
		if e != nil {
			writeError(w, e)
			return
		}
		courses, e := s.Catalog.Courses(r.Context(), a)
		if e != nil {
			writeError(w, e)
			return
		}
		writeJSON(w, 200, map[string]any{"ok": true, "courses": courses})
	}))
	for name, kind := range map[string]string{"video": "video", "article": "article", "discussion": "discussion", "answer-bank": "collector", "homework": "homework"} {
		run, state, stop := "/api/"+name+"/run", "/api/"+name+"/state", "/api/"+name+"/stop"
		if kind == "homework" {
			run, state, stop = "/api/run", "/api/run-state", "/api/stop"
		}
		m.Handle("POST "+run, s.require(func(w http.ResponseWriter, r *http.Request) {
			var input struct {
				CourseURL        string   `json:"courseUrl"`
				URL              string   `json:"url"`
				Concurrency      int      `json:"concurrency"`
				SubmitUnanswered bool     `json:"submitUnanswered"`
				Targets          []string `json:"targets"`
			}
			if e := body(w, r, &input); e != nil {
				writeError(w, e)
				return
			}
			v := domain.Start{CourseURL: input.CourseURL, Concurrency: input.Concurrency, Modules: []string{kind}, Targets: input.Targets}
			if kind == "collector" {
				v.SubmitUnanswered = &input.SubmitUnanswered
			}
			if v.CourseURL == "" {
				v.CourseURL = input.URL
				if kind == "video" {
					parsed, _ := url.Parse(input.URL)
					matches := videoURL.FindStringSubmatch(parsed.Path)
					if matches == nil {
						writeError(w, fault.New("INVALID_INPUT", "请输入单视频链接"))
						return
					}
					v.UnitID, _ = strconv.ParseInt(matches[1], 10, 64)
				}
			}
			j, e := s.Engine.Start(r.Context(), principal(r).User.ID, v)
			if e != nil {
				writeError(w, e)
				return
			}
			writeJSON(w, 202, map[string]any{"ok": true, "state": legacyState(kind, &j)})
		}))
		m.Handle("GET "+state, s.require(func(w http.ResponseWriter, r *http.Request) {
			j, e := s.latest(r, kind)
			if e != nil {
				writeError(w, e)
				return
			}
			writeJSON(w, 200, legacyState(kind, j))
		}))
		m.Handle("POST "+stop, s.require(func(w http.ResponseWriter, r *http.Request) {
			j, e := s.latest(r, kind)
			if e == nil && j != nil {
				_, e = s.Engine.Control(r.Context(), principal(r).User.ID, j.ID, "stop", kind)
			}
			if e != nil {
				writeError(w, e)
				return
			}
			writeJSON(w, 200, map[string]bool{"ok": true})
		}))
		if kind == "video" || kind == "article" || kind == "discussion" {
			m.Handle("POST /api/"+name+"/scan", s.require(func(w http.ResponseWriter, r *http.Request) { s.scan(w, r, kind) }))
		}
	}
	m.Handle("GET /api/status", s.require(s.status))
	m.Handle("GET /api/answers", s.require(func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, 200, map[string]any{"count": 0, "list": []any{}})
	}))
	s.answerBankRoutes(m)
	m.Handle("POST /api/video/inspect", s.require(s.inspect))
}
func (s *Server) scan(w http.ResponseWriter, r *http.Request, kind string) {
	var v struct {
		CourseURL string `json:"courseUrl"`
	}
	if e := body(w, r, &v); e != nil {
		writeError(w, e)
		return
	}
	a, e := s.Accounts.Require(r.Context(), principal(r).User.ID, "primary")
	if e != nil {
		writeError(w, e)
		return
	}
	inv, e := s.Catalog.Discover(r.Context(), a, v.CourseURL)
	if e != nil {
		writeError(w, e)
		return
	}
	items := []any{}
	completed := 0
	for _, u := range inv.Units {
		if u.Kind == kind {
			items = append(items, map[string]any{"leafId": u.ID, "title": u.Title, "completed": u.Progress == 1, "locked": u.Locked})
			if u.Progress == 1 {
				completed++
			}
		}
	}
	out := map[string]any{"ok": true, "course": inv.Course, "total": len(items), "totalVideos": len(items), "completed": completed}
	key := kind + "s"
	if kind == "discussion" {
		key = "discussions"
	}
	out[key] = items
	writeJSON(w, 200, out)
}
func (s *Server) status(w http.ResponseWriter, r *http.Request) {
	a, e := s.Accounts.Require(r.Context(), principal(r).User.ID, "primary")
	if e != nil {
		writeError(w, e)
		return
	}
	inv, e := s.Catalog.Discover(r.Context(), a, r.URL.Query().Get("courseUrl"))
	if e == nil {
		e = s.Catalog.Exercises(r.Context(), a, &inv)
	}
	if e != nil {
		writeError(w, e)
		return
	}
	sections := []any{}
	total, done, right := 0, 0, 0
	for _, ex := range inv.Exercises {
		d, correct, missing := 0, 0, 0
		for _, p := range ex.Problems {
			n, _ := questions.Count(p)
			if n > 0 {
				d++
			}
			user, _ := wire.Decode(p.User)
			if user["is_right"] == true {
				correct++
			}
			_, ok, err := s.Engine.Bank.Lookup(r.Context(), inv.Course, ex, p)
			if err != nil {
				writeError(w, err)
				return
			}
			if !ok {
				missing++
			}
		}
		sections = append(sections, map[string]any{"name": ex.Title, "total": len(ex.Problems), "done": d, "right": correct, "missing": missing, "err": ex.Error})
		total += len(ex.Problems)
		done += d
		right += correct
	}
	writeJSON(w, 200, map[string]any{"ok": true, "sections": sections, "totalQ": total, "doneQ": done, "rightQ": right})
}
func (s *Server) inspect(w http.ResponseWriter, r *http.Request) {
	var v struct{ URL string }
	if e := body(w, r, &v); e != nil {
		writeError(w, e)
		return
	}
	target, e := platform.ParseCourse(v.URL)
	if e != nil {
		writeError(w, e)
		return
	}
	parsed, _ := url.Parse(v.URL)
	m := videoURL.FindStringSubmatch(parsed.Path)
	if m == nil {
		writeError(w, fault.New("INVALID_INPUT", "请填写视频链接"))
		return
	}
	id, _ := strconv.ParseInt(m[1], 10, 64)
	a, e := s.Accounts.Require(r.Context(), principal(r).User.ID, "primary")
	if e != nil {
		writeError(w, e)
		return
	}
	inv, e := s.Catalog.Discover(r.Context(), a, target.URL)
	if e != nil {
		writeError(w, e)
		return
	}
	for _, u := range inv.Units {
		if u.ID == id && u.Kind == "video" {
			leaf, e := s.Catalog.Leaf(r.Context(), a, inv.Course, u)
			if e != nil {
				writeError(w, e)
				return
			}
			courseID, _ := wire.ID(leaf["course_id"])
			d, e := s.Catalog.Data(r.Context(), a, "GET", fmt.Sprintf("/video-log/get_video_watch_progress/?cid=%d&user_id=%d&classroom_id=%d&video_type=video&vtype=rate&video_id=%d", courseID, a.UserID, target.ClassroomID, id), nil)
			if e != nil {
				writeError(w, e)
				return
			}
			p := wire.Obj(d[fmt.Sprint(id)])
			writeJSON(w, 200, map[string]any{"video": map[string]any{"url": v.URL, "title": u.Title, "leafId": id}, "progress": map[string]any{"rate": p["rate"], "completed": wire.True(p["completed"]), "watchLength": p["watch_length"]}, "durationSeconds": p["video_length"]})
			return
		}
	}
	writeError(w, fault.New("NOT_FOUND", "视频不属于该课程"))
}
