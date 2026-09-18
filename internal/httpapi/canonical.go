package httpapi

import (
	"net/http"
	"net/url"
	"strings"
)

// Only HTML GET/HEAD requests use this redirect. API writes are never replayed
// to another origin; cookies and strict Origin/CSRF checks remain unchanged.
func (s *Server) redirectToPublicSite(w http.ResponseWriter, r *http.Request) bool {
	if s.Auth == nil || (r.Method != http.MethodGet && r.Method != http.MethodHead) {
		return false
	}
	if r.URL.Path == "/health" || strings.HasPrefix(r.URL.Path, "/health/") || r.URL.Path == "/api" || strings.HasPrefix(r.URL.Path, "/api/") {
		return false
	}
	base, err := url.Parse(s.Auth.BaseURL)
	if err != nil || base.Scheme != "https" || base.Host == "" || base.User != nil || base.Path != "" || base.RawQuery != "" || base.Fragment != "" {
		return false
	}
	if strings.EqualFold(strings.TrimSuffix(r.Host, ":443"), strings.TrimSuffix(base.Host, ":443")) {
		return false
	}
	// The destination origin comes only from configuration, never forwarded headers.
	base.Path = r.URL.Path
	base.RawPath = r.URL.RawPath
	base.RawQuery = r.URL.RawQuery
	base.ForceQuery = r.URL.ForceQuery
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("Referrer-Policy", "no-referrer")
	http.Redirect(w, r, base.String(), http.StatusFound)
	return true
}
