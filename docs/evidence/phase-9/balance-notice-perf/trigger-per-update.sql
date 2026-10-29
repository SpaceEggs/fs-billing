\set ON_ERROR_STOP on
ALTER TABLE tenant_balances :action TRIGGER tenant_balances_notice;
BEGIN;
DO $$
DECLARE
  big uuid := '00000000-0000-4000-8000-000000000001';
  t0 timestamptz := clock_timestamp();
  n int := 20000;
BEGIN
  FOR i IN 1..n LOOP
    UPDATE tenant_balances SET balance = balance - 0.01, updated_at = now() WHERE tenant_id = big;
  END LOOP;
  RAISE NOTICE 'per_update_us=%', round(extract(epoch FROM clock_timestamp() - t0) * 1000000 / n, 2);
END $$;
ROLLBACK;
