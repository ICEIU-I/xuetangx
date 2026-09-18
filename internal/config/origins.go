package config

import (
	"fmt"
	"net"
	"net/url"
	"strconv"
	"strings"
	"unicode"
)

// parseAllowedOrigins accepts complete, exact origins, never patterns or URL paths.
// PUBLIC_BASE_URL is trusted separately and need not be repeated here.
func parseAllowedOrigins(value string, development bool) ([]string, error) {
	origins := []string{}
	if strings.TrimSpace(value) == "" {
		return origins, nil
	}
	seen := map[string]bool{}
	for _, entry := range strings.Split(value, ",") {
		origin := strings.TrimSpace(entry)
		if !validOrigin(origin, development) {
			return nil, fmt.Errorf("invalid ALLOWED_ORIGINS: expected exact %s origins", originSchemes(development))
		}
		if !seen[origin] {
			origins = append(origins, origin)
			seen[origin] = true
		}
	}
	return origins, nil
}

func originSchemes(development bool) string {
	if development {
		return "HTTP(S)"
	}
	return "HTTPS"
}

func validOrigin(value string, development bool) bool {
	if value == "" || strings.ContainsAny(value, "*?#") || strings.IndexFunc(value, unicode.IsSpace) >= 0 {
		return false
	}
	u, err := url.Parse(value)
	if err != nil || u.Host == "" || u.Opaque != "" || u.User != nil || u.Path != "" || u.RawQuery != "" || u.Fragment != "" {
		return false
	}
	if u.Scheme != "https" && (!development || u.Scheme != "http") {
		return false
	}
	host := u.Hostname()
	if strings.HasPrefix(u.Host, "[") {
		// Brackets denote IPv6; zone identifiers are not valid public origins.
		if !strings.Contains(host, ":") || net.ParseIP(host) == nil {
			return false
		}
	} else if !validOriginHost(host) {
		return false
	}
	if strings.HasSuffix(u.Host, ":") {
		return false
	}
	if port := u.Port(); port != "" {
		for _, digit := range port {
			if digit < '0' || digit > '9' {
				return false
			}
		}
		n, err := strconv.Atoi(port)
		if err != nil || n < 1 || n > 65535 {
			return false
		}
	}
	return true
}

func validOriginHost(host string) bool {
	if host == "" || strings.Contains(host, ":") {
		return false
	}
	if net.ParseIP(host) != nil {
		return true
	}
	host = strings.TrimSuffix(host, ".")
	if len(host) == 0 || len(host) > 253 {
		return false
	}
	numeric := true
	for _, label := range strings.Split(host, ".") {
		if len(label) == 0 || len(label) > 63 || label[0] == '-' || label[len(label)-1] == '-' {
			return false
		}
		for _, ch := range label {
			if ch >= '0' && ch <= '9' {
				continue
			}
			numeric = false
			if ch != '-' && !(ch >= 'a' && ch <= 'z') && !(ch >= 'A' && ch <= 'Z') {
				return false
			}
		}
	}
	// Numeric hosts must be valid IP literals, not ambiguous alternate IP forms.
	return !numeric
}
