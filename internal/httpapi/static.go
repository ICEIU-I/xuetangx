package httpapi

import (
	"io/fs"
	"net/http"
	"path"
	"strings"
)

func (s *Server) static() http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != "GET" && r.Method != "HEAD" {
			http.NotFound(w, r)
			return
		}
		if s.Assets == nil {
			http.Error(w, "Frontend assets are not built. Run make build.", 503)
			return
		}
		name := strings.TrimPrefix(path.Clean(r.URL.Path), "/")
		if name == "." || name == "" {
			name = "index.html"
		}
		if info, e := fs.Stat(s.Assets, name); e != nil || info.IsDir() {
			if strings.Contains(path.Base(name), ".") {
				http.NotFound(w, r)
				return
			}
			name = "index.html"
		}
		copy := r.Clone(r.Context())
		copy.URL.Path = "/" + name
		if name == "index.html" {
			if s.redirectToPublicSite(w, r) {
				return
			}
			w.Header().Set("Cache-Control", "no-store")
			copy.URL.Path = "/"
		}
		http.FileServer(http.FS(s.Assets)).ServeHTTP(w, copy)
	})
}
