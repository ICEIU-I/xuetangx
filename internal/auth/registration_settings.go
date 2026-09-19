package auth

import (
	"context"
	"fmt"
	"github.com/jackc/pgx/v5"
	"xuetangx/internal/fault"
)

func (s *Service) RegistrationVerificationRequired(ctx context.Context) (bool, error) {
	if s.DB == nil {
		return false, fmt.Errorf("registration settings unavailable")
	}
	var required bool
	err := s.DB.Pool.QueryRow(ctx, "SELECT email_verification_required FROM registration_settings WHERE id=true").Scan(&required)
	return required, err
}

func registrationPolicy(ctx context.Context, tx pgx.Tx) (bool, error) {
	var required bool
	// Registration and a settings change have a defined transaction ordering.
	err := tx.QueryRow(ctx, "SELECT email_verification_required FROM registration_settings WHERE id=true FOR SHARE").Scan(&required)
	return required, err
}

func (s *Service) SetRegistrationVerification(ctx context.Context, actor string, enabled bool) error {
	return s.DB.Tx(ctx, func(tx pgx.Tx) error {
		var admin bool
		if err := tx.QueryRow(ctx, "SELECT EXISTS(SELECT 1 FROM users WHERE id=$1 AND admin AND NOT disabled)", actor).Scan(&admin); err != nil {
			return err
		}
		if !admin {
			return fault.New("FORBIDDEN", "需要管理员权限")
		}
		_, err := tx.Exec(ctx, "UPDATE registration_settings SET email_verification_required=$1,updated_at=now() WHERE id=true", enabled)
		return err
	})
}
