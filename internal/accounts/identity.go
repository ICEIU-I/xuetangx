package accounts

import (
	"context"
	"fmt"

	"github.com/jackc/pgx/v5"
)

// Serialize private/shared identity checks across service instances.
func lockPlatformIdentity(ctx context.Context, tx pgx.Tx, id int64) error {
	_, err := tx.Exec(ctx, "SELECT pg_advisory_xact_lock(hashtextextended($1,0))", fmt.Sprintf("platform-identity:%d", id))
	return err
}
