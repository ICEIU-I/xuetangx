package httpapi

import (
	"net/http"
)

func (s *Server) authConfig(w http.ResponseWriter, r *http.Request) {
	required, err := s.Auth.RegistrationVerificationRequired(r.Context())
	if err != nil {
		writeError(w, err)
		return
	}
	writeJSON(w, 200, map[string]bool{"emailEnabled": !s.EmailDisabled, "emailVerificationRequired": required})
}
func (s *Server) registrationCode(w http.ResponseWriter, r *http.Request) {
	if s.emailUnavailable(w) {
		return
	}
	var v struct{ Email string }
	if err := body(w, r, &v); err != nil {
		writeError(w, err)
		return
	}
	if !s.authLimit(w, r, "registration-mail", v.Email) {
		return
	}
	if err := s.Auth.RequestRegistrationCode(r.Context(), v.Email); err != nil {
		writeError(w, err)
		return
	}
	writeJSON(w, 202, map[string]any{"ok": true, "retryAfter": 60, "expiresIn": 600})
}
func (s *Server) register(w http.ResponseWriter, r *http.Request) {
	required, err := s.Auth.RegistrationVerificationRequired(r.Context())
	if err != nil {
		writeError(w, err)
		return
	}
	if required && s.emailUnavailable(w) {
		return
	}
	var v struct{ Email, Password, Code string }
	if err = body(w, r, &v); err != nil {
		writeError(w, err)
		return
	}
	if !s.authLimit(w, r, "register", v.Email) {
		return
	}
	release, err := s.hashSlot(r.Context())
	if err != nil {
		return
	}
	defer release()
	if err = s.Auth.Register(r.Context(), v.Email, v.Password, v.Code); err != nil {
		writeError(w, err)
		return
	}
	writeJSON(w, 202, map[string]any{"ok": true, "message": "注册成功，请登录"})
}
