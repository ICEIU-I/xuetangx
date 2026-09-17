package httpapi

import (
	"fmt"
	"net/http"
	"xuetangx/internal/domain"
)

func legacyState(kind string, j *domain.Job) map[string]any {
	empty := map[string]any{"status": "idle", "message": "", "total": 0, "done": 0, "processed": 0, "correct": 0, "failed": 0, "result": nil}
	if j == nil || j.Modules[kind] == nil {
		return empty
	}
	m := j.Modules[kind]
	status := m.Status
	switch status {
	case "queued", "scanning", "waiting_answers", "waiting_rate_limit":
		status = "running"
	case "blocked", "waiting_account", "waiting_enrollment":
		status = "error"
	}
	results := []any{}
	for _, v := range m.Results {
		results = append(results, map[string]any{"leafId": v.UnitID, "unitId": v.UnitID, "problemId": v.ProblemID, "title": v.Title, "status": v.Status, "error": v.Error, "url": fmt.Sprintf("%s/%s/%d", j.Course.URL, kind, v.UnitID)})
	}
	out := map[string]any{"status": status, "message": m.Message, "jobId": j.ID, "revision": j.Revision, "course": j.Course, "courseUrl": j.Course.URL, "concurrency": j.Concurrency, "total": m.Total, "processed": m.Processed, "completed": m.Completed, "failed": m.Failed, "skipped": m.Skipped, "results": results}
	switch kind {
	case "video":
		out["mode"] = "course"
		out["totalVideos"] = m.Total
		out["processedVideos"] = m.Processed
		out["completedVideos"] = m.Completed
		out["skippedVideos"] = m.Skipped
		out["failedVideos"] = m.Failed
		out["recentResults"] = results
		if status == "done" || status == "partial" {
			out["result"] = map[string]any{"kind": "batch", "results": results}
		}
	case "homework":
		out["done"] = m.Processed
		out["correct"] = m.Completed
		out["ratePerMin"] = 0
		out["etaSec"] = 0
	case "collector":
		out["totalQuestions"] = j.Coverage.Total
		out["capturedAnswers"] = j.Coverage.Captured
		out["missingAnswers"] = j.Coverage.Missing
		out["totalExercises"] = 0
		out["processedExercises"] = 0
		if status == "done" {
			out["result"] = map[string]any{"course": j.Course}
		}
	}
	return out
}
func (s *Server) latest(r *http.Request, kind string) (*domain.Job, error) {
	a, e := s.Accounts.Get(r.Context(), principal(r).User.ID, "primary")
	if e != nil || !a.Connected {
		return nil, e
	}
	list, _, e := s.Jobs.List(r.Context(), principal(r).User.ID, 100, 0)
	if e != nil {
		return nil, e
	}
	for _, j := range list {
		if j.PrimaryID == a.UserID && j.Modules[kind] != nil {
			return &j, nil
		}
	}
	return nil, nil
}
