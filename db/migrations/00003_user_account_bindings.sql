-- +goose Up
ALTER TABLE platform_accounts DROP CONSTRAINT platform_accounts_platform_user_id_key;
ALTER TABLE platform_accounts ADD CONSTRAINT platform_accounts_owner_platform_key UNIQUE(owner_id,platform_user_id);
CREATE INDEX platform_accounts_platform_user_id_idx ON platform_accounts(platform_user_id);
CREATE UNIQUE INDEX shared_collector_platform_identity ON platform_accounts(platform_user_id) WHERE shared_collector;

-- +goose Down
-- Refuse rollback while multiple users have bindings; never delete their data.
ALTER TABLE platform_accounts ADD CONSTRAINT platform_accounts_platform_user_id_key UNIQUE(platform_user_id);
DROP INDEX shared_collector_platform_identity;
DROP INDEX platform_accounts_platform_user_id_idx;
ALTER TABLE platform_accounts DROP CONSTRAINT platform_accounts_owner_platform_key;
