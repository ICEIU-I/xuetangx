package httpapi

import (
	"net/http"
	"xuetangx/internal/fault"
)

func (s *Server) adminRegistrationRoutes(m *http.ServeMux) {
	m.Handle("GET /api/admin/registration-settings", s.admin(s.authConfig))
	m.Handle("PUT /api/admin/registration-settings", s.admin(func(w http.ResponseWriter, r *http.Request) {
		var v struct {
			EmailVerificationRequired *bool `json:"emailVerificationRequired"`
		}
		if err := body(w, r, &v); err != nil {
			writeError(w, err)
			return
		}
		if v.EmailVerificationRequired == nil {
			writeError(w, fault.New("INVALID_INPUT", "请明确设置邮箱验证码开关"))
			return
		}
		if *v.EmailVerificationRequired && s.emailUnavailable(w) {
			return
		}
		if err := s.Auth.SetRegistrationVerification(r.Context(), principal(r).User.ID, *v.EmailVerificationRequired); err != nil {
			writeError(w, err)
			return
		}
		s.authConfig(w, r)
	}))
}
