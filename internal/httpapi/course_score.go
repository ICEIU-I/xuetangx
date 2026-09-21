package httpapi

import (
	"context"
	"github.com/jackc/pgx/v5"
	"net/http"
	"time"
	"xuetangx/internal/catalog"
	"xuetangx/internal/domain"
	"xuetangx/internal/fault"
	"xuetangx/internal/platform"
)

func (s *Server) courseScore(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	ctx, cancel := context.WithTimeout(r.Context(), 12*time.Second)
	defer cancel()
	owner := principal(r).User.ID
	account, err := s.Accounts.Require(ctx, owner, "primary")
	if err != nil {
		writeError(w, err)
		return
	}
	target := catalog.FixedCourse()
	if raw := r.URL.Query().Get("courseUrl"); raw != "" {
		target, err = platform.ParseCourse(raw)
		if err != nil {
			writeError(w, err)
			return
		}
	}
	if !catalog.IsFixedCourse(target) {
		// Resolve only this account's known enrolled classroom, not another
		// user's catalog. The platform authorizes the actual grade read too.
		err = s.Catalog.DB.Pool.QueryRow(ctx, `SELECT c.title,c.url FROM courses c JOIN account_courses ac ON ac.course_id=c.id
		 WHERE ac.account_id=$1 AND c.classroom_id=$2 AND c.sign=$3 AND c.course_sign=$4`, account.ID, target.ClassroomID, target.Sign, target.CourseSign).Scan(&target.Title, &target.URL)
		if err == pgx.ErrNoRows {
			writeError(w, fault.New("ENROLLMENT_REQUIRED", "请刷新已选课程列表后再查询成绩"))
			return
		}
		if err != nil {
			writeError(w, err)
			return
		}
	}
	waiting := func(readyAt *int64) {
		writeJSON(w, http.StatusOK, map[string]any{"ok": true, "primaryId": account.UserID, "course": target, "available": false, "waiting": true, "retryAt": readyAt, "message": "平台暂时限制访问，稍后自动更新"})
	}
	// A display read must not sit in the background task's unlimited retry loop.
	// Preserve the broker's account-wide cooldown and credential validation.
	if limit := s.Engine.Broker.State(account.UserID); limit.Blocked && limit.Scope == "account" {
		waiting(limit.ReadyAt)
		return
	}
	var response platform.Response
	reader := &catalog.Service{Request: func(ctx context.Context, a domain.Account, method, path string, body any) (platform.Response, error) {
		var err error
		response, err = s.Engine.Broker.Request(ctx, a, method, path, body)
		return response, err
	}}
	score, readErr := reader.Score(ctx, account, target)
	// Never return a late response from a replaced or disconnected account.
	current, err := s.Accounts.Require(r.Context(), owner, "primary")
	if err != nil {
		writeError(w, err)
		return
	}
	if current.ID != account.ID || current.Revision != account.Revision {
		writeError(w, fault.New("ACCOUNT_CHANGED", "平台账号已切换"))
		return
	}
	if readErr != nil {
		if limit := s.Engine.Broker.State(account.UserID); limit.Blocked && limit.Scope == "account" {
			waiting(limit.ReadyAt)
			return
		}
		switch fault.Code(readErr) {
		case "ACCOUNT_REQUIRED", "ACCOUNT_CHANGED":
			writeError(w, readErr)
		case "RATE_LIMITED", "ACCESS_DENIED":
			ready := platform.Cooldown(response, time.Now())
			if !ready.After(time.Now()) {
				ready = time.Now().Add(15 * time.Second)
			}
			readyAt := ready.UnixMilli()
			waiting(&readyAt)
		default:
			writeError(w, fault.New("UNAVAILABLE", "成绩更新失败，将自动重试"))
		}
		return
	}
	out := map[string]any{"ok": true, "primaryId": account.UserID, "course": score.Course, "available": score.Available, "breakdown": score.Breakdown, "updatedAt": time.Now().UnixMilli()}
	if score.Available {
		out["score"] = score.Value
	} else {
		out["message"] = "平台暂无成绩"
	}
	writeJSON(w, http.StatusOK, out)
}
