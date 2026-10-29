\set ON_ERROR_STOP on
ALTER TABLE tenant_balances :action TRIGGER tenant_balances_notice;
BEGIN;
DO $$
DECLARE
  small uuid := (SELECT id FROM tenants WHERE code = 'PERFMT01');
  t0 timestamptz := clock_timestamp();
  n int := 3000;
BEGIN
  UPDATE balance_notice_state SET low_active = false, low_seq = 0 WHERE tenant_id = small;
  FOR i IN 1..n LOOP
    UPDATE tenant_balances SET balance = 50, updated_at = now() WHERE tenant_id = small;   -- 越线：入队一封
    UPDATE tenant_balances SET balance = 150, updated_at = now() WHERE tenant_id = small;  -- 回到线上：重新上膛
  END LOOP;
  RAISE NOTICE 'per_crossing_pair_us=% outbox_rows=%', round(extract(epoch FROM clock_timestamp() - t0) * 1000000 / n, 2),
    (SELECT count(*) FROM email_outbox WHERE tenant_id = small AND dedupe_key LIKE 'balance_low:%');
END $$;
ROLLBACK;
