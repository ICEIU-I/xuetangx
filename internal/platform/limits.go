package platform

import (
	"net/http"
	"regexp"
	"strconv"
	"strings"
	"time"
	"xuetangx/internal/platform/wire"
)

var limitedWords = regexp.MustCompile(`(?i)throttl|too many requests|请求过于频繁|操作过于频繁|限流`)
var secondsPattern = regexp.MustCompile(`(?i)([0-9]+(?:\.[0-9]+)?)\s*(?:seconds?|秒)`)

func RateLimited(r Response) bool {
	// A 403 has its own bounded retry policy, even if its body also mentions throttling.
	if r.Status == 403 {
		return false
	}
	return r.Status == 429 || (r.JSON["success"] == false && limitedWords.MatchString(wire.String(r.JSON["detail"])+wire.String(r.JSON["msg"])+wire.String(r.JSON["code"])))
}
func Cooldown(r Response, now time.Time) time.Time {
	v := strings.TrimSpace(r.RetryAfter)
	if v != "" {
		if n, e := strconv.ParseFloat(v, 64); e == nil && n >= 0 && n < 86400*365 {
			return now.Add(time.Duration(n * float64(time.Second)))
		}
		if d, e := http.ParseTime(v); e == nil {
			return d
		}
	}
	if m := secondsPattern.FindStringSubmatch(wire.String(r.JSON["detail"]) + " " + wire.String(r.JSON["msg"])); m != nil {
		n, _ := strconv.ParseFloat(m[1], 64)
		if n < 86400*365 {
			return now.Add(time.Duration(n * float64(time.Second)))
		}
	}
	// Do not invent a fixed client-side wait when the platform does not provide
	// one. Callers still keep their bounded retry budgets, while an explicit
	// Retry-After or response message remains authoritative.
	return now
}
