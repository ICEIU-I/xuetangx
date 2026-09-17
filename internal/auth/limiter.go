package auth

import (
	"sync"
	"time"
)

type bucket struct {
	Count int
	Until time.Time
}
type Limiter struct {
	mu      sync.Mutex
	entries map[string]bucket
}

func (l *Limiter) Allow(key string, limit int, window time.Duration) bool {
	l.mu.Lock()
	defer l.mu.Unlock()
	if l.entries == nil {
		l.entries = map[string]bucket{}
	}
	now := time.Now()
	if len(l.entries) > 10000 {
		for k, b := range l.entries {
			if !now.Before(b.Until) {
				delete(l.entries, k)
			}
		}
		if len(l.entries) > 20000 {
			return false
		}
	}
	b := l.entries[key]
	if !now.Before(b.Until) {
		b = bucket{Until: now.Add(window)}
	}
	if b.Count >= limit {
		return false
	}
	b.Count++
	l.entries[key] = b
	return true
}
