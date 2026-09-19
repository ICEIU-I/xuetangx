package httpapi

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"
)

func TestTrafficFileRetainsCountsAfterRestart(t *testing.T) {
	path := filepath.Join(t.TempDir(), "metrics", "page-traffic.json")
	now := time.Date(2026, 9, 1, 23, 59, 0, 0, time.UTC)
	tracker, err := loadPageTrafficFile(path, now)
	if err != nil {
		t.Fatal(err)
	}
	tracker.record(now)
	tracker.record(now.Add(2 * time.Minute))
	tracker.record(now.Add(2 * time.Minute))
	restarted, err := loadPageTrafficFile(path, now.Add(3*time.Minute))
	if err != nil {
		t.Fatal(err)
	}
	for _, rng := range []string{"24h", "7d", "30d"} {
		got := restarted.snapshotRange(now.Add(3*time.Minute), rng)
		if got.StartedAt != now.UnixMilli() || got.TotalPageViews != 3 {
			t.Fatalf("restart lost %s counts: %+v", rng, got)
		}
	}
	restarted.record(now.Add(5 * time.Minute))
	info, err := os.Stat(path)
	if err != nil || info.Mode().Perm() != 0600 {
		t.Fatalf("private aggregate file mode: %v %v", info, err)
	}
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	var saved storedTraffic
	if err = json.Unmarshal(raw, &saved); err != nil || len(saved.Hours) != 2 || len(saved.Days) != 2 {
		t.Fatalf("stored aggregate: %s (%v)", raw, err)
	}
	if strings.Contains(string(raw), "cookie") || strings.Contains(string(raw), "path") || strings.Contains(string(raw), "user") {
		t.Fatal("unexpected request metadata in aggregate")
	}
	files, err := os.ReadDir(filepath.Dir(path))
	if err != nil || len(files) != 1 {
		t.Fatalf("temporary file not removed: %v %v", files, err)
	}
}

func TestTrafficFileBoundsThirtyDayRetention(t *testing.T) {
	path := filepath.Join(t.TempDir(), "traffic.json")
	start := time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)
	tracker, err := loadPageTrafficFile(path, start)
	if err != nil {
		t.Fatal(err)
	}
	for day := 0; day < 45; day++ {
		tracker.record(start.AddDate(0, 0, day))
	}
	now := start.AddDate(0, 0, 44)
	restarted, err := loadPageTrafficFile(path, now)
	if err != nil {
		t.Fatal(err)
	}
	for _, tc := range []struct {
		rng   string
		total int64
	}{{"24h", 1}, {"7d", 7}, {"30d", 30}} {
		got := restarted.snapshotRange(now, tc.rng)
		if got.TotalPageViews != tc.total {
			t.Fatalf("retention %s: %+v", tc.rng, got)
		}
	}
	raw, _ := os.ReadFile(path)
	var saved storedTraffic
	if err = json.Unmarshal(raw, &saved); err != nil || len(saved.Hours) != 1 || len(saved.Days) != 30 {
		t.Fatalf("unbounded aggregate retention: %s", raw)
	}
	// Idle days expire previous data even before the next request arrives.
	restarted, err = loadPageTrafficFile(path, now.AddDate(0, 0, 31))
	if err != nil {
		t.Fatal(err)
	}
	got := restarted.snapshotRange(now.AddDate(0, 0, 31), "30d")
	if got.TotalPageViews != 0 || got.StartedAt != start.UnixMilli() {
		t.Fatalf("idle pruning: %+v", got)
	}
	for _, point := range got.Points {
		if point.Views == nil || *point.Views != 0 {
			t.Fatal("observed idle day is not zero")
		}
	}
}

func TestTrafficFileCorruptionIsRejectedWithoutOverwrite(t *testing.T) {
	start := time.Date(2026, 9, 19, 8, 0, 0, 0, time.UTC)
	valid := storedTraffic{Version: 1, StartedAt: start.UnixMilli(), SavedAt: start.UnixMilli(), Hours: []storedTrafficBucket{{start.UnixMilli(), 2}}, Days: []storedTrafficBucket{{start.Truncate(24 * time.Hour).UnixMilli(), 2}}}
	encode := func(v storedTraffic) []byte {
		b, err := json.Marshal(v)
		if err != nil {
			t.Fatal(err)
		}
		return b
	}
	cases := map[string][]byte{"truncated": []byte(`{"version":1`), "empty": {}, "oversized": []byte(strings.Repeat(" ", trafficFileMaxBytes+1)), "missing": []byte(`{}`)}
	bad := valid
	bad.Version = 8
	cases["version"] = encode(bad)
	bad = valid
	bad.SavedAt = bad.StartedAt - 1
	cases["clock"] = encode(bad)
	bad = valid
	bad.Hours = []storedTrafficBucket{{start.UnixMilli(), -1}}
	cases["negative"] = encode(bad)
	bad = valid
	bad.Hours = []storedTrafficBucket{{start.UnixMilli(), 2}, {start.UnixMilli(), 3}}
	cases["duplicate"] = encode(bad)
	bad = valid
	bad.Hours = []storedTrafficBucket{{start.UnixMilli() + 1, 2}}
	cases["boundary"] = encode(bad)
	for name, raw := range cases {
		t.Run(name, func(t *testing.T) {
			path := filepath.Join(t.TempDir(), "traffic.json")
			if err := os.WriteFile(path, raw, 0600); err != nil {
				t.Fatal(err)
			}
			if _, err := loadPageTrafficFile(path, start); err == nil {
				t.Fatal("invalid file accepted")
			}
			after, _ := os.ReadFile(path)
			if string(after) != string(raw) {
				t.Fatal("damaged file overwritten")
			}
		})
	}
}

func TestTrafficFileConcurrentWritesAndRestoredTotals(t *testing.T) {
	now := time.Date(2026, 9, 19, 8, 0, 0, 0, time.UTC)
	path := filepath.Join(t.TempDir(), "traffic.json")
	tracker, err := loadPageTrafficFile(path, now)
	if err != nil {
		t.Fatal(err)
	}
	var wg sync.WaitGroup
	for n := 0; n < 8; n++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for i := 0; i < 10; i++ {
				tracker.record(now)
				tracker.snapshotRange(now, "7d")
			}
		}()
	}
	wg.Wait()
	restarted, err := loadPageTrafficFile(path, now)
	if err != nil {
		t.Fatal(err)
	}
	if got := restarted.snapshotRange(now, "30d"); got.TotalPageViews != 80 {
		t.Fatalf("concurrent durable totals: %+v", got)
	}
}

func TestConfigureTrafficFileAndWriteFailures(t *testing.T) {
	s := &Server{}
	if err := s.ConfigureTrafficFile(""); err != nil || s.traffic != nil {
		t.Fatal("empty configuration changed state")
	}
	path := filepath.Join(t.TempDir(), "traffic.json")
	if err := s.ConfigureTrafficFile(path); err != nil {
		t.Fatal(err)
	}
	original := s.traffic
	bad := filepath.Join(t.TempDir(), "bad.json")
	if err := os.WriteFile(bad, []byte("broken"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := s.ConfigureTrafficFile(bad); err == nil || s.traffic != original {
		t.Fatal("failed configuration replaced live counter")
	}
	// A filesystem error must not turn successful page delivery into a failure;
	// counts remain in memory and the next write persists the accumulated total.
	now := time.Now().UTC()
	s.traffic.file = filepath.Join(t.TempDir(), "missing", "traffic.json")
	s.traffic.record(now)
	if s.traffic.snapshot(now).TotalPageViews != 1 || !s.traffic.writeFailed {
		t.Fatal("write error discarded live count")
	}
	s.traffic.file = path
	s.traffic.record(now)
	restored, err := loadPageTrafficFile(path, now)
	if err != nil {
		t.Fatal(err)
	}
	if got := restored.snapshot(now); got.TotalPageViews != 2 || s.traffic.writeFailed {
		t.Fatalf("retry lost count: %+v", got)
	}
}

func TestTrafficFileOutOfOrderRecordsAndClockRollback(t *testing.T) {
	start := time.Date(2026, 9, 19, 23, 59, 59, 0, time.UTC)
	path := filepath.Join(t.TempDir(), "traffic.json")
	tracker, err := loadPageTrafficFile(path, start)
	if err != nil {
		t.Fatal(err)
	}
	next := start.Add(2 * time.Second)
	tracker.record(next)
	tracker.record(start) // completion from the prior hour arrived later
	restarted, err := loadPageTrafficFile(path, next)
	if err != nil {
		t.Fatalf("reversed writes made durable file invalid: %v", err)
	}
	got := restarted.snapshotRange(start, "7d")
	if got.CapturedAt != next.UnixMilli() || got.TotalPageViews != 2 {
		t.Fatalf("clock rollback invented an older empty snapshot: %+v", got)
	}
	future := start.AddDate(0, 0, 40)
	tracker.record(future)
	tracker.record(start) // this event is expired in both windows
	restarted, err = loadPageTrafficFile(path, future)
	if err != nil {
		t.Fatalf("expired write resurrected invalid buckets: %v", err)
	}
	for _, rng := range []string{"24h", "7d", "30d"} {
		got = restarted.snapshotRange(start.Add(-time.Hour), rng)
		if got.CapturedAt != future.UnixMilli() || got.TotalPageViews != 1 {
			t.Fatalf("expired event/clock rollback for %s: %+v", rng, got)
		}
	}
}
