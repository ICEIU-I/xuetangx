package httpapi

import (
	"net/http/httptest"
	"testing"
	"testing/fstest"
	"time"

	"xuetangx/internal/auth"
	"xuetangx/internal/workflow"
)

func trafficServer(at time.Time) *Server {
	s := New(&auth.Service{BaseURL: "http://localhost:8788"}, nil, &workflow.Engine{}, nil)
	s.Assets = fstest.MapFS{"index.html": {Data: []byte("<html>app</html>")}, "assets/app.js": {Data: []byte("app")}}
	s.traffic = newPageTraffic(at)
	return s
}

func TestPageTrafficCountsOnlySuccessfulKnownDocuments(t *testing.T) {
	start := time.Date(2026, 9, 19, 23, 58, 0, 0, time.UTC)
	s := trafficServer(start)
	s.traffic.now = func() time.Time { return start.Add(time.Minute) }
	request := func(method, path string, headers map[string]string) *httptest.ResponseRecorder {
		r := httptest.NewRequest(method, "http://localhost:8788"+path, nil)
		for k, v := range headers {
			r.Header.Set(k, v)
		}
		w := httptest.NewRecorder()
		s.Handler().ServeHTTP(w, r)
		return w
	}
	if w := request("GET", "/learn", nil); w.Code != 200 {
		t.Fatal(w.Code)
	}
	request("HEAD", "/learn", nil)
	request("GET", "/assets/app.js", nil)
	request("GET", "/missing", nil)
	request("GET", "/learn", map[string]string{"Range": "bytes=0-1"})
	request("GET", "/learn", map[string]string{"Sec-Fetch-Dest": "empty"})
	request("GET", "/learn", map[string]string{"Purpose": "prefetch"})
	// A dynamic route is known only when its ID is a valid UUID.
	request("GET", "/tasks/not-a-uuid", nil)
	id := "123e4567-e89b-12d3-a456-426614174000"
	if w := request("GET", "/tasks/"+id, nil); w.Code != 200 {
		t.Fatal(w.Code)
	}
	captured := start.Add(time.Minute)
	got := s.traffic.snapshot(captured)
	if got.TotalPageViews != 2 {
		t.Fatalf("traffic counts: %+v", got)
	}
	for _, point := range got.Hourly {
		observed := point.Start >= start.Truncate(time.Hour).UnixMilli()
		if observed != (point.Views != nil) {
			t.Fatalf("coverage boundary: %+v", got.Hourly)
		}
	}
}

func TestPageTrafficSnapshotUsesRecentUTCWindowAndNulls(t *testing.T) {
	start := time.Date(2026, 9, 19, 23, 59, 0, 0, time.UTC)
	tracker := newPageTraffic(start)
	tracker.record(start)
	tracker.record(start.Add(2 * time.Minute))
	got := tracker.snapshot(start.Add(2 * time.Minute))
	if got.StartedAt != start.UnixMilli() || got.TotalPageViews != 2 {
		t.Fatalf("snapshot metadata: %+v", got)
	}
	seen := 0
	for _, point := range got.Hourly {
		if point.Views != nil {
			seen++
			if *point.Views != 1 {
				t.Fatalf("cross-hour buckets: %+v", got.Hourly)
			}
		}
	}
	if seen != 2 {
		t.Fatalf("expected two observed hours: %+v", got.Hourly)
	}
	if got.Hourly[0].Views != nil {
		t.Fatal("pre-start bucket must be null")
	}
	week := tracker.snapshotRange(start.Add(2*time.Minute), "7d")
	if week.Range != "7d" || week.Interval != "day" || len(week.Points) != 7 || week.TotalPageViews != 2 {
		t.Fatalf("7d range: %+v", week)
	}
	month := tracker.snapshotRange(start.Add(2*time.Minute), "30d")
	if month.Range != "30d" || month.Interval != "day" || len(month.Points) != 30 || month.TotalPageViews != 2 {
		t.Fatalf("30d range: %+v", month)
	}
	if !isTrafficPage("/admin") || isTrafficPage("/not-a-page") || isTrafficPage("/assets/app.js") {
		t.Fatal("page allowlist mismatch")
	}
}

func TestPageTrafficConcurrentRecord(t *testing.T) {
	tracker := newPageTraffic(time.Now().Add(-time.Minute))
	done := make(chan struct{})
	for i := 0; i < 32; i++ {
		go func() {
			for j := 0; j < 100; j++ {
				tracker.record(time.Now())
			}
			done <- struct{}{}
		}()
	}
	for i := 0; i < 32; i++ {
		<-done
	}
	if tracker.snapshot(time.Now()).TotalPageViews != 3200 {
		t.Fatal("concurrent views lost")
	}
}

func TestPageTrafficEmptyAndUnknownSnapshots(t *testing.T) {
	now := time.Date(2026, 9, 19, 23, 59, 0, 0, time.FixedZone("Offset", 7*3600))
	var tracker *pageTraffic
	tracker.record(now)
	got := tracker.snapshotRange(now, "7d")
	if got.StartedAt != 0 || len(got.Points) != 7 || got.TotalPageViews != 0 {
		t.Fatalf("nil tracker snapshot: %+v", got)
	}
	for _, point := range got.Points {
		if point.Views != nil || point.Start%(24*3600*1000) != 0 {
			t.Fatalf("nil tracker bucket: %+v", point)
		}
	}
	tracker = newPageTraffic(now.Add(-48 * time.Hour))
	got = tracker.snapshotRange(now, "7d")
	for i, point := range got.Points {
		if i < 4 && point.Views != nil {
			t.Fatal("unobserved day is not null")
		}
		if i >= 4 && (point.Views == nil || *point.Views != 0) {
			t.Fatal("observed empty day is not zero")
		}
	}
	if got = tracker.snapshotRange(now, "unbounded"); got.Range != "24h" || len(got.Points) != 24 {
		t.Fatal("invalid range was not bounded")
	}
}
