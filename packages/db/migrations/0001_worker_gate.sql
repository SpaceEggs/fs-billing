-- Worker 只读 UUID 闸门，RLS 仍只允许管理员/系统身份；不能直接登记或修改。
GRANT SELECT ON call_uuids TO fs_billing_app;
--> statement-breakpoint
-- 阶段 8 的认领保持原语义。HTTP 入库声明 cdr_ingest，已有未归属登记也视为重推。
-- 检查放在同一条登记语句内，避免“先查不存在、并发未归属登记、再误认领”的竞态。
CREATE OR REPLACE FUNCTION cdrs_register_call_uuid() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  INSERT INTO call_uuids AS registered (call_uuid, tenant_id, started_at)
  VALUES (NEW.call_uuid, NEW.tenant_id, NEW.started_at)
  ON CONFLICT (call_uuid) DO UPDATE SET tenant_id = EXCLUDED.tenant_id
    WHERE registered.tenant_id IS NULL
      AND current_setting('app.cdr_ingest', true) IS DISTINCT FROM 'true';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'duplicate key value violates unique constraint "call_uuids_pkey"'
      USING ERRCODE = 'unique_violation', CONSTRAINT = 'call_uuids_pkey', TABLE = 'call_uuids',
        DETAIL = format('Key (call_uuid)=(%s) already exists.', NEW.call_uuid);
  END IF;
  RETURN NEW;
END $$;
