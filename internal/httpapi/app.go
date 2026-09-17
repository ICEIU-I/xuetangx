package httpapi

import (
	"io/fs"
	"net"
	"net/http"
	"sync"
	"xuetangx/internal/accounts"
	"xuetangx/internal/auth"
	"xuetangx/internal/catalog"
	"xuetangx/internal/jobs"
	"xuetangx/internal/workflow"
)

type Server struct {
	Auth           *auth.Service
	Accounts       *accounts.Service
	Engine         *workflow.Engine
	Jobs           *jobs.Repository
	Catalog        *catalog.Service
	Assets         fs.FS
	EmailDisabled  bool
	TrustedProxies []*net.IPNet
	limiter        auth.Limiter
	hashSlots      chan struct{}
	sseMu          sync.Mutex
	sse            map[string]int
}

func New(a *auth.Service, ac *accounts.Service, e *workflow.Engine, c *catalog.Service) *Server {
	return &Server{Auth: a, Accounts: ac, Engine: e, Jobs: e.Jobs, Catalog: c, hashSlots: make(chan struct{}, 4), sse: map[string]int{}}
}
func (s *Server) Handler() http.Handler {
	m := http.NewServeMux()
	s.authRoutes(m)
	s.accountRoutes(m)
	s.jobRoutes(m)
	s.advancedRoutes(m)
	s.adminRoutes(m)
	m.Handle("GET /api/events", s.require(s.events))
	m.HandleFunc("GET /health/live", func(w http.ResponseWriter, r *http.Request) { writeJSON(w, 200, map[string]bool{"ok": true}) })
	m.HandleFunc("GET /health/ready", func(w http.ResponseWriter, r *http.Request) {
		if !s.Engine.Ready() {
			writeError(w, unavailable())
			return
		}
		writeJSON(w, 200, map[string]bool{"ok": true})
	})
	m.HandleFunc("/api/", func(w http.ResponseWriter, r *http.Request) { http.NotFound(w, r) })
	m.Handle("/", s.static())
	return s.middleware(m)
}
