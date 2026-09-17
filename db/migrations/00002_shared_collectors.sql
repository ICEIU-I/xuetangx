-- +goose Up
ALTER TABLE platform_accounts ADD COLUMN shared_collector boolean NOT NULL DEFAULT false;
ALTER TABLE platform_accounts ADD COLUMN enabled boolean NOT NULL DEFAULT true;
ALTER TABLE platform_accounts ADD COLUMN label text NOT NULL DEFAULT '';
ALTER TABLE platform_accounts ADD CONSTRAINT shared_collector_role CHECK (NOT shared_collector OR role IS NULL);
CREATE INDEX shared_collectors_available ON platform_accounts(shared_collector,enabled,valid) WHERE shared_collector;

-- +goose Down
ALTER TABLE platform_accounts DROP CONSTRAINT shared_collector_role;
DROP INDEX shared_collectors_available;
ALTER TABLE platform_accounts DROP COLUMN shared_collector, DROP COLUMN enabled, DROP COLUMN label;
