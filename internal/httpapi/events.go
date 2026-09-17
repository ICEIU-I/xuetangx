package httpapi

import (
	"encoding/json"
	"fmt"
	"net/http"
	"strconv"
	"time"
	"xuetangx/internal/domain"
	"xuetangx/internal/platform/wire"
)

func (s *Server) events(w http.ResponseWriter, r *http.Request) {
	owner := principal(r).User.ID
	s.sseMu.Lock()
	if s.sse[owner] >= 4 {
		s.sseMu.Unlock()
		w.WriteHeader(429)
		return
	}
	s.sse[owner]++
	s.sseMu.Unlock()
	defer func() { s.sseMu.Lock(); s.sse[owner]--; s.sseMu.Unlock() }()
	cursor, _ := strconv.ParseInt(r.Header.Get("Last-Event-ID"), 10, 64)
	var latest int64
	if e := s.Auth.DB.Pool.QueryRow(r.Context(), "SELECT coalesce(max(id),0) FROM job_events WHERE owner_id=$1", owner).Scan(&latest); e != nil {
		writeError(w, e)
		return
	}
	if cursor <= 0 || cursor > latest {
		cursor = latest
	}
	state, e := s.snapshot(r.Context(), owner, 25, 0)
	if e != nil {
		writeError(w, e)
		return
	}
	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-cache")
	w.Header().Set("X-Accel-Buffering", "no")
	controller := http.NewResponseController(w)
	send := func(id int64, v any) bool {
		_ = controller.SetWriteDeadline(time.Now().Add(5 * time.Second))
		if id > 0 {
			if _, e := fmt.Fprintf(w, "id: %d\n", id); e != nil {
				return false
			}
		}
		if _, e := fmt.Fprintf(w, "data: %s\n\n", wire.JSON(v)); e != nil {
			return false
		}
		return controller.Flush() == nil
	}
	hello := map[string]any{"type": "hello", "workflow": state}
	list := state["jobs"].([]domain.Job)
	for _, kind := range []string{"homework", "video", "article", "discussion", "collector"} {
		var job *domain.Job
		for _, j := range list {
			if j.Modules[kind] != nil {
				copy := j
				job = &copy
				break
			}
		}
		v := legacyState(kind, job)
		switch kind {
		case "homework":
			for k, val := range v {
				hello[k] = val
			}
		case "collector":
			hello["answerBank"] = v
		default:
			hello[kind] = v
		}
	}
	if !send(0, hello) {
		return
	}
	ticker := time.NewTicker(time.Second)
	defer ticker.Stop()
	lastAccounts, lastLimits := "", ""
	ping := 0
	for {
		select {
		case <-r.Context().Done():
			return
		case <-ticker.C:
			if _, e := s.authenticate(r); e != nil {
				return
			}
			rows, e := s.Auth.DB.Pool.Query(r.Context(), "SELECT id,event_type,payload FROM job_events WHERE owner_id=$1 AND id>$2 ORDER BY id LIMIT 256", owner, cursor)
			if e != nil {
				return
			}
			type event struct {
				id   int64
				kind string
				raw  []byte
			}
			events := []event{}
			for rows.Next() {
				var ev event
				if e = rows.Scan(&ev.id, &ev.kind, &ev.raw); e != nil {
					rows.Close()
					return
				}
				events = append(events, ev)
			}
			e = rows.Err()
			rows.Close()
			if e != nil {
				return
			}
			for _, ev := range events {
				cursor = ev.id
				if ev.kind != "workflow" {
					continue
				}
				var data struct {
					JobID string `json:"jobId"`
				}
				if json.Unmarshal(ev.raw, &data) != nil {
					continue
				}
				j, e := s.Jobs.Get(r.Context(), owner, data.JobID)
				if e != nil {
					return
				}
				if !send(ev.id, map[string]any{"type": "workflow", "job": j}) {
					return
				}
				for kind := range j.Modules {
					v := legacyState(kind, &j)
					eventType := kind
					if kind == "collector" {
						eventType = "answer-bank"
					}
					if kind == "homework" {
						eventType = "progress"
						if status := v["status"].(string); status == "done" || status == "partial" || status == "stopped" || status == "error" {
							eventType = status
						}
						v["msg"] = v["message"]
						v["name"] = "课程答题"
					}
					v["type"] = eventType
					if !send(0, v) {
						return
					}
				}
			}
			accounts := map[string]any{}
			limits := map[string]any{}
			for _, role := range []string{"primary", "test"} {
				a, e := s.Accounts.Get(r.Context(), owner, role)
				if e != nil {
					return
				}
				accounts[role] = accountView(a)
				limits[role] = nil
				if a.Connected {
					v := wire.ObjFromJSON(s.Engine.Broker.State(a.UserID))
					v["role"] = role
					v["type"] = "rate-limit"
					limits[role] = v
				}
			}
			if hash := string(wire.JSON(accounts)); hash != lastAccounts {
				lastAccounts = hash
				if !send(0, map[string]any{"type": "accounts", "accounts": accounts}) {
					return
				}
			}
			if hash := string(wire.JSON(limits)); hash != lastLimits {
				lastLimits = hash
				for _, v := range limits {
					if v != nil && !send(0, v) {
						return
					}
				}
			}
			ping++
			if ping%15 == 0 {
				_ = controller.SetWriteDeadline(time.Now().Add(5 * time.Second))
				if _, e = fmt.Fprint(w, ": ping\n\n"); e != nil {
					return
				}
				if controller.Flush() != nil {
					return
				}
			}
		}
	}
}
