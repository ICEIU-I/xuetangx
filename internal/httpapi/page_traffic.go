package httpapi

import (
	"log/slog"
	"net/http"
	"strings"
	"sync"
	"time"
)

const (
	trafficHours = 24
	trafficDays  = 30
)

type trafficPoint struct {
	Start int64  `json:"start"`
	Views *int64 `json:"views"`
}

type trafficSnapshot struct {
	StartedAt      int64          `json:"startedAt"`
	CapturedAt     int64          `json:"capturedAt"`
	TotalPageViews int64          `json:"totalPageViews"`
	Hourly         []trafficPoint `json:"hourly,omitempty"`
	Range          string         `json:"range"`
	Interval       string         `json:"interval"`
	Points         []trafficPoint `json:"points"`
}

type trafficBucket struct {
	period int64
	views  int64
}

type pageTraffic struct {
	mu           sync.Mutex
	startedAt    time.Time
	lastRecorded time.Time
	now          func() time.Time
	hours        [trafficHours]trafficBucket
	days         [trafficDays]trafficBucket
	file         string
	writeFailed  bool
}

func newPageTraffic(now time.Time) *pageTraffic {
	return &pageTraffic{startedAt: now.UTC(), lastRecorded: now.UTC(), now: time.Now}
}
func ringIndex(value, size int64) int { return int((value%size + size) % size) }

func (t *pageTraffic) recordNow() {
	if t != nil {
		t.record(t.now())
	}
}

func (t *pageTraffic) record(now time.Time) {
	if t == nil || now.Before(t.startedAt) {
		return
	}
	h := now.UTC().Truncate(time.Hour).Unix() / 3600
	d := now.UTC().Truncate(24*time.Hour).Unix() / 86400
	t.mu.Lock()
	defer t.mu.Unlock()
	if now.After(t.lastRecorded) {
		t.lastRecorded = now.UTC()
	}
	currentHour := t.lastRecorded.Truncate(time.Hour).Unix() / 3600
	currentDay := t.lastRecorded.Truncate(24*time.Hour).Unix() / 86400
	t.pruneLocked(t.lastRecorded)
	hb := &t.hours[ringIndex(h, trafficHours)]
	if h >= currentHour-trafficHours+1 && hb.period <= h {
		if hb.period != h {
			*hb = trafficBucket{period: h}
		}
		hb.views++
	}
	db := &t.days[ringIndex(d, trafficDays)]
	if d >= currentDay-trafficDays+1 && db.period <= d {
		if db.period != d {
			*db = trafficBucket{period: d}
		}
		db.views++
	}
	if err := t.saveLocked(t.lastRecorded); err != nil {
		if !t.writeFailed {
			slog.Warn("page traffic persistence unavailable")
		}
		t.writeFailed = true
	} else {
		if t.writeFailed {
			slog.Info("page traffic persistence restored")
		}
		t.writeFailed = false
	}
}

func (t *pageTraffic) pruneLocked(now time.Time) {
	hour := now.UTC().Truncate(time.Hour).Unix() / 3600
	day := now.UTC().Truncate(24*time.Hour).Unix() / 86400
	for i, b := range t.hours {
		if b.period < hour-trafficHours+1 {
			t.hours[i] = trafficBucket{}
		}
	}
	for i, b := range t.days {
		if b.period < day-trafficDays+1 {
			t.days[i] = trafficBucket{}
		}
	}
}

func (t *pageTraffic) snapshot(now time.Time) trafficSnapshot { return t.snapshotRange(now, "24h") }

func (t *pageTraffic) snapshotRange(now time.Time, trafficRange string) trafficSnapshot {
	now = now.UTC()
	if trafficRange != "7d" && trafficRange != "30d" {
		trafficRange = "24h"
	}
	out := trafficSnapshot{Range: trafficRange}
	if t != nil {
		t.mu.Lock()
		defer t.mu.Unlock()
		out.StartedAt = t.startedAt.UnixMilli()
		if now.Before(t.lastRecorded) {
			now = t.lastRecorded
		}
	}
	out.CapturedAt = now.UnixMilli()
	count, interval := trafficHours, "hour"
	if trafficRange == "7d" {
		count, interval = 7, "day"
	}
	if trafficRange == "30d" {
		count, interval = 30, "day"
	}
	out.Interval = interval
	if interval == "hour" {
		out.Hourly = make([]trafficPoint, count)
	} else {
		out.Points = make([]trafficPoint, count)
	}
	for i := 0; i < count; i++ {
		var start time.Time
		var period int64
		if interval == "hour" {
			start = now.Truncate(time.Hour).Add(time.Duration(i-count+1) * time.Hour)
			period = start.Unix() / 3600
		} else {
			start = now.Truncate(24*time.Hour).AddDate(0, 0, i-count+1)
			period = start.Unix() / 86400
		}
		point := trafficPoint{Start: start.UnixMilli()}
		if t != nil {
			boundary := t.startedAt.Truncate(time.Hour)
			if interval != "hour" {
				boundary = t.startedAt.Truncate(24 * time.Hour)
			}
			if !start.Before(boundary) {
				v := int64(0)
				if interval == "hour" {
					if b := t.hours[ringIndex(period, trafficHours)]; b.period == period {
						v = b.views
					}
				} else {
					if b := t.days[ringIndex(period, trafficDays)]; b.period == period {
						v = b.views
					}
				}
				point.Views = &v
				out.TotalPageViews += v
			}
		}
		if interval == "hour" {
			out.Hourly[i] = point
		} else {
			out.Points[i] = point
		}
	}
	if interval == "hour" {
		out.Points = out.Hourly
	}
	return out
}

func isTrafficPage(path string) bool {
	switch path {
	case "/", "/index.html", "/learn", "/tasks", "/tools", "/settings", "/admin", "/admin/collectors", "/admin/users", "/admin/answers", "/admin/settings":
		return true
	}
	for _, prefix := range []string{"/tasks/", "/admin/users/"} {
		if strings.HasPrefix(path, prefix) {
			return validUUID(strings.TrimPrefix(path, prefix))
		}
	}
	return false
}
func isTrafficDocument(r *http.Request) bool {
	if r.Method != http.MethodGet || !isTrafficPage(r.URL.Path) || r.Header.Get("Range") != "" {
		return false
	}
	if dest := r.Header.Get("Sec-Fetch-Dest"); dest != "" && dest != "document" {
		return false
	}
	for _, h := range []string{"Purpose", "Sec-Purpose", "X-Purpose", "X-Moz"} {
		p := strings.ToLower(r.Header.Get(h))
		if strings.Contains(p, "prefetch") || strings.Contains(p, "prerender") {
			return false
		}
	}
	return true
}

type trafficResponse struct {
	http.ResponseWriter
	status int
}

func (w *trafficResponse) WriteHeader(status int) {
	if w.status == 0 {
		w.status = status
	}
	w.ResponseWriter.WriteHeader(status)
}
func (w *trafficResponse) Write(b []byte) (int, error) {
	if w.status == 0 {
		w.status = http.StatusOK
	}
	return w.ResponseWriter.Write(b)
}
func (w *trafficResponse) Unwrap() http.ResponseWriter { return w.ResponseWriter }
