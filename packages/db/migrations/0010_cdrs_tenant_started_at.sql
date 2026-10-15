-- Safe only pre-launch on dev/CI/empty databases: this plain partitioned index
-- build blocks writes. The migrator runs in a transaction. After launch, build
-- new indexes on large partitioned tables per partition with CREATE INDEX
-- CONCURRENTLY outside the migration transaction, then attach them to a parent
-- index created ON ONLY, following a runbook (docs/plan.md, stage 10).
CREATE INDEX cdrs_tenant_started_at ON cdrs (tenant_id, started_at);
