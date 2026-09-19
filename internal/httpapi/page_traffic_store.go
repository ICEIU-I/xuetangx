package httpapi

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"time"
)

const trafficFileMaxBytes = 64 << 10

type storedTrafficBucket struct {
	Start int64 `json:"start"`
	Views int64 `json:"views"`
}

type storedTraffic struct {
	Version   int                   `json:"version"`
	StartedAt int64                 `json:"startedAt"`
	SavedAt   int64                 `json:"savedAt"`
	Hours     []storedTrafficBucket `json:"hours"`
	Days      []storedTrafficBucket `json:"days"`
}

// ConfigureTrafficFile is called before serving requests. Empty paths keep
// in-memory collection; an unreadable or invalid existing file is never
// replaced. Only bounded anonymous aggregates are persisted.
func (s *Server) ConfigureTrafficFile(path string) error {
	if path == "" {
		return nil
	}
	now := time.Now().UTC()
	t, err := loadPageTrafficFile(path, now)
	if err != nil {
		return err
	}
	s.traffic = t
	return nil
}

func loadPageTrafficFile(path string, now time.Time) (*pageTraffic, error) {
	t := newPageTraffic(now)
	f, err := os.Open(path)
	if errors.Is(err, os.ErrNotExist) {
		if err = os.MkdirAll(filepath.Dir(path), 0700); err != nil {
			return nil, fmt.Errorf("create page traffic directory: %w", err)
		}
		t.file = path
		if err = t.saveLocked(now); err != nil {
			return nil, fmt.Errorf("initialize page traffic storage: %w", err)
		}
		return t, nil
	}
	if err != nil {
		return nil, fmt.Errorf("read page traffic storage: %w", err)
	}
	defer f.Close()
	raw, err := io.ReadAll(io.LimitReader(f, trafficFileMaxBytes+1))
	if err != nil {
		return nil, fmt.Errorf("read page traffic storage: %w", err)
	}
	if len(raw) > trafficFileMaxBytes {
		return nil, errors.New("page traffic storage is oversized")
	}
	var saved storedTraffic
	if err = json.Unmarshal(raw, &saved); err != nil {
		return nil, errors.New("page traffic storage is invalid JSON")
	}
	if err = restoreTraffic(t, saved); err != nil {
		return nil, err
	}
	t.file = path
	t.pruneLocked(now)
	return t, nil
}

func restoreTraffic(t *pageTraffic, saved storedTraffic) error {
	if saved.Version != 1 || saved.StartedAt <= 0 || saved.SavedAt < saved.StartedAt || saved.Hours == nil || saved.Days == nil || len(saved.Hours) > trafficHours || len(saved.Days) > trafficDays {
		return errors.New("page traffic storage has invalid metadata")
	}
	t.startedAt = time.UnixMilli(saved.StartedAt).UTC()
	t.lastRecorded = time.UnixMilli(saved.SavedAt).UTC()
	for _, data := range []struct {
		buckets []storedTrafficBucket
		target  []trafficBucket
		seconds int64
	}{
		{saved.Hours, t.hours[:], 3600}, {saved.Days, t.days[:], 86400},
	} {
		for _, b := range data.buckets {
			period := b.Start / (1000 * data.seconds)
			first := saved.StartedAt / (1000 * data.seconds)
			last := saved.SavedAt / (1000 * data.seconds)
			if b.Start%(1000*data.seconds) != 0 || period < first || period > last || period < last-int64(len(data.target))+1 || b.Views <= 0 || b.Views > 1<<53 {
				return errors.New("page traffic storage has invalid bucket")
			}
			index := ringIndex(period, int64(len(data.target)))
			if data.target[index].views != 0 {
				return errors.New("page traffic storage has duplicate bucket")
			}
			data.target[index] = trafficBucket{period: period, views: b.Views}
		}
	}
	return nil
}

// saveLocked writes a same-directory temporary file, fsyncs it, atomically
// renames it and syncs the directory. The old complete file survives all
// failures before rename, and readers never observe a partial JSON document.
func (t *pageTraffic) saveLocked(now time.Time) error {
	if t.file == "" {
		return nil
	}
	saved := storedTraffic{Version: 1, StartedAt: t.startedAt.UnixMilli(), SavedAt: now.UnixMilli(), Hours: []storedTrafficBucket{}, Days: []storedTrafficBucket{}}
	for _, b := range t.hours {
		if b.views > 0 {
			saved.Hours = append(saved.Hours, storedTrafficBucket{b.period * 3600 * 1000, b.views})
		}
	}
	for _, b := range t.days {
		if b.views > 0 {
			saved.Days = append(saved.Days, storedTrafficBucket{b.period * 86400 * 1000, b.views})
		}
	}
	dir := filepath.Dir(t.file)
	f, err := os.CreateTemp(dir, ".page-traffic-*.tmp")
	if err != nil {
		return err
	}
	tmp := f.Name()
	defer os.Remove(tmp)
	if err = json.NewEncoder(f).Encode(saved); err == nil {
		err = f.Sync()
	}
	closeErr := f.Close()
	if err != nil {
		return err
	}
	if closeErr != nil {
		return closeErr
	}
	if err = os.Rename(tmp, t.file); err != nil {
		return err
	}
	d, err := os.Open(dir)
	if err != nil {
		return err
	}
	defer d.Close()
	return d.Sync()
}
