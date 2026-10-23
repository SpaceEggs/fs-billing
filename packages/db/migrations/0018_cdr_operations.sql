SET LOCAL lock_timeout = '5s';
--> statement-breakpoint
-- 话单运维（阶段 8 PR 1）：未归属话单的分配批次与处理字段、状态 superseded、
-- 删除话单的元数据与守卫、操作日志的可空操作者（bootstrap 等没有管理员的事件）与索引、新的告警类型。
-- 上线前开发库可直接改：unassigned_cdrs 没有生产数据。

-- 分配批次（只增）：一次分配 = 一行，幂等键在租户内唯一。
CREATE TABLE unassigned_assignments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants,
  idempotency_key text NOT NULL CHECK (btrim(idempotency_key) <> ''),
  requested_by uuid NOT NULL REFERENCES admins,
  -- 按分组选择时的标签（空串表示标签为空的分组），按勾选时为空。
  source_tag text,
  -- 请求（选择 + 预览数字）的摘要：同键重放时核对是同一个请求。
  request_digest text NOT NULL CHECK (btrim(request_digest) <> ''),
  assigned_count integer NOT NULL CHECK (assigned_count >= 0),
  no_rate_count integer NOT NULL CHECK (no_rate_count >= 0),
  blocked_count integer NOT NULL CHECK (blocked_count >= 0),
  charge_total numeric NOT NULL CHECK (charge_total >= 0),
  balance_before numeric NOT NULL,
  balance_after numeric NOT NULL,
  -- 扣费流水落入的北京月（1 日）。
  affected_months date[] NOT NULL,
  -- 同事务写入的操作日志 id。
  audit_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT unassigned_assignments_tenant_idempotency_key UNIQUE (tenant_id, idempotency_key)
);
--> statement-breakpoint
CREATE TRIGGER unassigned_assignments_append_only BEFORE UPDATE OR DELETE ON unassigned_assignments
  FOR EACH ROW EXECUTE FUNCTION reject_mutation();
--> statement-breakpoint
CREATE TRIGGER unassigned_assignments_no_truncate BEFORE TRUNCATE ON unassigned_assignments
  FOR EACH STATEMENT EXECUTE FUNCTION reject_mutation();
--> statement-breakpoint
ALTER TABLE unassigned_assignments ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY staff_only ON unassigned_assignments
  USING (app_is_operator()) WITH CHECK (app_is_operator());
--> statement-breakpoint
GRANT SELECT, INSERT ON unassigned_assignments TO fs_billing_app;
--> statement-breakpoint
-- 未归属话单的新列。hangup_cause / unverified 在分配时写进 cdrs；其余供 PR 2 的入库加固使用。
ALTER TABLE unassigned_cdrs
  ADD COLUMN hangup_cause text NOT NULL DEFAULT '',
  ADD COLUMN unverified boolean NOT NULL DEFAULT false,
  ADD COLUMN raw_sha256 text,
  ADD COLUMN push_count integer NOT NULL DEFAULT 1 CHECK (push_count >= 1),
  ADD COLUMN last_pushed_at timestamptz,
  ADD COLUMN candidate_call_uuid uuid,
  ADD COLUMN superseded_by_call_uuid uuid,
  ADD COLUMN assignment_id uuid REFERENCES unassigned_assignments;
--> statement-breakpoint
-- 第四个状态 superseded：系统自动解决（修正重推成功），没有操作人。
ALTER TABLE unassigned_cdrs
  DROP CONSTRAINT unassigned_cdrs_status_check,
  DROP CONSTRAINT unassigned_cdrs_status_shape;
--> statement-breakpoint
ALTER TABLE unassigned_cdrs
  ADD CONSTRAINT unassigned_cdrs_status_check
    CHECK (status IN ('pending', 'ignored', 'assigned', 'superseded')),
  ADD CONSTRAINT unassigned_cdrs_status_shape CHECK (CASE status
    WHEN 'pending' THEN ignore_reason IS NULL AND assigned_tenant_id IS NULL
      AND resolved_by IS NULL AND resolved_at IS NULL
      AND superseded_by_call_uuid IS NULL AND assignment_id IS NULL
    WHEN 'ignored' THEN btrim(coalesce(ignore_reason, '')) <> '' AND assigned_tenant_id IS NULL
      AND resolved_by IS NOT NULL AND resolved_at IS NOT NULL
      AND superseded_by_call_uuid IS NULL AND assignment_id IS NULL
    WHEN 'assigned' THEN assigned_tenant_id IS NOT NULL AND ignore_reason IS NULL
      AND resolved_by IS NOT NULL AND resolved_at IS NOT NULL
      AND superseded_by_call_uuid IS NULL AND assignment_id IS NOT NULL
    ELSE resolved_at IS NOT NULL AND resolved_by IS NULL AND superseded_by_call_uuid IS NOT NULL
      AND ignore_reason IS NULL AND assigned_tenant_id IS NULL AND assignment_id IS NULL
  END);
--> statement-breakpoint
CREATE INDEX unassigned_cdrs_status_tag ON unassigned_cdrs (status, tenant_tag);
--> statement-breakpoint
CREATE INDEX unassigned_cdrs_status_time
  ON unassigned_cdrs (status, (coalesce(answered_at, started_at)) DESC, id);
--> statement-breakpoint
-- 无 UUID 的无效推送以原文 SHA-256 去重（PR 2 写入 raw_sha256）。
CREATE UNIQUE INDEX unassigned_cdrs_invalid_body ON unassigned_cdrs (raw_sha256)
  WHERE call_uuid IS NULL AND status IN ('pending', 'ignored');
--> statement-breakpoint
-- 删除话单的元数据放在账单头部（与置 details_deleted 同一条 UPDATE）。
-- 允许标志为真而三列为空：e2e 辅助直接置标志，页面此时只显示「话单已删除」。
ALTER TABLE monthly_statements
  ADD COLUMN details_deleted_at timestamptz,
  ADD COLUMN details_deleted_by uuid REFERENCES admins,
  ADD COLUMN details_deleted_count integer CHECK (details_deleted_count >= 0);
--> statement-breakpoint
ALTER TABLE monthly_statements ADD CONSTRAINT monthly_statements_deletion_meta CHECK (
  (details_deleted_at IS NULL) = (details_deleted_by IS NULL)
  AND (details_deleted_at IS NULL) = (details_deleted_count IS NULL)
  AND (details_deleted_at IS NULL OR details_deleted)
);
--> statement-breakpoint
-- 守卫触发器增加一条：三个元数据列只能在 details_deleted 由假变真的同一条 UPDATE 里写入，之后不可改。
CREATE OR REPLACE FUNCTION monthly_statements_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  figures_changed boolean;
BEGIN
  IF NEW.id IS DISTINCT FROM OLD.id OR NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
     OR NEW.month IS DISTINCT FROM OLD.month THEN
    RAISE EXCEPTION '账单的编号、租户和月份不可修改' USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.details_deleted AND NOT NEW.details_deleted THEN
    RAISE EXCEPTION '账单的话单已删除标志不可回退' USING ERRCODE = 'check_violation';
  END IF;
  IF (NEW.details_deleted_at, NEW.details_deleted_by, NEW.details_deleted_count)
     IS DISTINCT FROM
     (OLD.details_deleted_at, OLD.details_deleted_by, OLD.details_deleted_count)
     AND NOT (NOT OLD.details_deleted AND NEW.details_deleted) THEN
    RAISE EXCEPTION '话单删除记录只能在置删除标志的同一次更新里写入，之后不可修改'
      USING ERRCODE = 'check_violation';
  END IF;
  figures_changed :=
    (NEW.opening_balance, NEW.recharge, NEW.gift, NEW.adjustment, NEW.call_charges,
     NEW.closing_balance, NEW.call_minutes, NEW.calls, NEW.breakdown_gap)
    IS DISTINCT FROM
    (OLD.opening_balance, OLD.recharge, OLD.gift, OLD.adjustment, OLD.call_charges,
     OLD.closing_balance, OLD.call_minutes, OLD.calls, OLD.breakdown_gap);
  IF OLD.details_deleted AND (
       figures_changed
       OR NEW.version IS DISTINCT FROM OLD.version
       OR NEW.generated_at IS DISTINCT FROM OLD.generated_at
       OR NEW.first_generated_at IS DISTINCT FROM OLD.first_generated_at
       OR NEW.generated_by IS DISTINCT FROM OLD.generated_by
     ) THEN
    RAISE EXCEPTION '话单已删除的月份不能重新生成账单' USING ERRCODE = 'check_violation';
  END IF;
  IF figures_changed AND NEW.version IS DISTINCT FROM OLD.version + 1 THEN
    RAISE EXCEPTION '账单数字变化时版本必须恰好加 1（% → %）', OLD.version, NEW.version
      USING ERRCODE = 'check_violation';
  END IF;
  IF NOT figures_changed AND NEW.version NOT IN (OLD.version, OLD.version + 1) THEN
    RAISE EXCEPTION '账单版本只能保持或加 1（% → %）', OLD.version, NEW.version
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
-- 操作日志：没有管理员的事件（auth:bootstrap 等）用 actor_label 标明来源，admin_id 与 actor_label 恰有其一。
ALTER TABLE operation_logs
  ALTER COLUMN admin_id DROP NOT NULL,
  ADD COLUMN actor_label text CHECK (btrim(actor_label) <> '');
--> statement-breakpoint
ALTER TABLE operation_logs ADD CONSTRAINT operation_logs_actor_check
  CHECK ((admin_id IS NOT NULL) <> (actor_label IS NOT NULL));
--> statement-breakpoint
CREATE INDEX operation_logs_created ON operation_logs (created_at DESC, id);
--> statement-breakpoint
CREATE INDEX operation_logs_tenant_created ON operation_logs (tenant_id, created_at DESC);
--> statement-breakpoint
CREATE INDEX operation_logs_action_created ON operation_logs (action, created_at DESC);
--> statement-breakpoint
-- 运维只读审计函数：返回列变了（多一列 actor_label，操作者可空），只能 DROP 再 CREATE，然后重新授权。
DROP FUNCTION audit_operation_logs(text, text, timestamptz, timestamptz);
--> statement-breakpoint
CREATE FUNCTION audit_operation_logs(
  p_tenant_code text DEFAULT NULL,
  p_action text DEFAULT NULL,
  p_from timestamptz DEFAULT NULL,
  p_to timestamptz DEFAULT NULL
)
RETURNS TABLE(id uuid, created_at timestamptz, admin_id uuid, admin_email text,
  admin_name text, tenant_code text, action text, target text, details jsonb, actor_label text)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT l.id, l.created_at, l.admin_id, u.email, a.name, t.code, l.action, l.target, l.details,
    l.actor_label
  FROM public.operation_logs l
  LEFT JOIN public.admins a ON a.id = l.admin_id
  LEFT JOIN auth."user" u ON u.id = a.auth_user_id
  LEFT JOIN public.tenants t ON t.id = l.tenant_id
  WHERE (p_tenant_code IS NULL OR upper(t.code) = upper(p_tenant_code))
    AND (p_action IS NULL OR l.action = p_action)
    AND (p_from IS NULL OR l.created_at >= p_from)
    AND (p_to IS NULL OR l.created_at < p_to)
  ORDER BY l.created_at DESC, l.id;
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION audit_operation_logs(text, text, timestamptz, timestamptz) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION audit_operation_logs(text, text, timestamptz, timestamptz) TO fs_billing_audit;
--> statement-breakpoint
-- 重建后审计角色的权限仍必须是白名单（同 0014 的末尾检查）。
DO $$
DECLARE
  problems text;
BEGIN
  SELECT string_agg(v.line, '；' ORDER BY v.n) INTO problems
  FROM audit_role_violations() WITH ORDINALITY v(line, n);
  IF problems IS NOT NULL THEN
    RAISE EXCEPTION 'fs_billing_audit 超出只读权限：%；迁移不会自动清理，请人工核查后再执行', problems;
  END IF;
END $$;
--> statement-breakpoint
-- 告警类型：审计写入失败（PR 4）、原始话单归档失败（PR 3）。
ALTER TABLE system_alerts DROP CONSTRAINT system_alerts_kind_check;
--> statement-breakpoint
ALTER TABLE system_alerts ADD CONSTRAINT system_alerts_kind_check
  CHECK (kind IN ('auth_timeout', 'cdr_failed', 'email_failed', 'partition_failed', 'statement_mismatch',
    'audit_failed', 'raw_archive_failed'));
