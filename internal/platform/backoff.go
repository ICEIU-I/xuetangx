package platform

import "time"

// Backoff caps the delay, not the number of attempts. Callers saturate counters
// so an indefinitely unavailable upstream never wraps into immediate retries.
func Backoff(attempt int) time.Duration {
	return min(time.Second*time.Duration(1<<min(max(attempt, 0), 6)), time.Minute)
}
