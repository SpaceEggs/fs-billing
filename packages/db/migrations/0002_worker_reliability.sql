-- 对账状态随话单永久保存，不依赖 pg-boss 终态任务的保留时间。
ALTER TABLE cdrs
  ADD COLUMN reconcile_attempts integer NOT NULL DEFAULT 0,
  ADD COLUMN reconciled_at timestamptz,
  ADD COLUMN reconcile_alerted boolean NOT NULL DEFAULT false;
GRANT UPDATE (reconcile_attempts, reconciled_at, reconcile_alerted) ON cdrs TO fs_billing_app;
--> statement-breakpoint
-- 校验失败的待办允许未知 UUID/时间，必须能定位原文；未知字段不能用于认领。
ALTER TABLE unassigned_cdrs
  ALTER COLUMN call_uuid DROP NOT NULL,
  ALTER COLUMN started_at DROP NOT NULL,
  ALTER COLUMN ended_at DROP NOT NULL,
  ADD COLUMN raw_id uuid,
  ADD COLUMN raw_received_at timestamptz,
  -- 原文按月归档/分离；保存定位键，不用外键阻止分区维护。
  ADD CONSTRAINT unassigned_raw_ref CHECK ((raw_id IS NULL) = (raw_received_at IS NULL)) NOT VALID,
  ADD CONSTRAINT unassigned_cdr_shape CHECK (
    (call_uuid IS NOT NULL AND started_at IS NOT NULL AND ended_at IS NOT NULL)
    OR (raw_id IS NOT NULL AND raw_received_at IS NOT NULL AND status <> 'assigned')
  ) NOT VALID;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION unassigned_cdrs_register_call_uuid() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  -- 只有已校验的通话身份和时间才能占用闸门，校验失败的原文不阻止修正重推。
  IF NEW.call_uuid IS NOT NULL AND NEW.started_at IS NOT NULL AND NEW.ended_at IS NOT NULL THEN
    INSERT INTO call_uuids (call_uuid, tenant_id, started_at)
    VALUES (NEW.call_uuid, NULL, NEW.started_at);
  END IF;
  RETURN NEW;
END $$;
