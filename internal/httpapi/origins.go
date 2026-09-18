package httpapi

// Browser writes must come from an explicitly configured origin. Never infer
// trust from Host, forwarded headers, suffixes or arbitrary subdomains.
func (s *Server) allowsOrigin(origin string) bool {
	if origin == "" || origin == "null" {
		return false
	}
	if origin == s.Auth.BaseURL {
		return true
	}
	for _, allowed := range s.AllowedOrigins {
		if origin == allowed {
			return true
		}
	}
	return false
}
