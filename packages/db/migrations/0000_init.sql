DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'fs_billing_app') THEN
    CREATE ROLE fs_billing_app NOLOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOINHERIT;
  END IF;
END $$;

GRANT USAGE ON SCHEMA public TO fs_billing_app;
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
ALTER DEFAULT PRIVILEGES REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;

-- 会话身份：事务内 set_config('app.scope', 'tenant' | 'admin', true)；未设置时策略为假。
CREATE FUNCTION app_scope() RETURNS text
LANGUAGE sql STABLE AS $$ SELECT current_setting('app.scope', true) $$;

CREATE FUNCTION app_tenant_id() RETURNS uuid
LANGUAGE sql STABLE AS $$ SELECT nullif(current_setting('app.tenant_id', true), '')::uuid $$;

CREATE FUNCTION app_can_see(row_tenant uuid) RETURNS boolean
LANGUAGE sql STABLE AS $$
  SELECT CASE app_scope()
    WHEN 'admin' THEN true
    WHEN 'tenant' THEN coalesce(row_tenant = app_tenant_id(), false)
    ELSE false
  END
$$;

CREATE FUNCTION reject_mutation() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% 只能新增，禁止 %', TG_TABLE_NAME, TG_OP
    USING ERRCODE = 'insufficient_privilege';
END $$;

-- 租户

CREATE TABLE tenants (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code text NOT NULL UNIQUE CHECK (code ~ '^[A-Za-z0-9]+$'),
  name text NOT NULL CHECK (btrim(name) <> ''),
  currency text NOT NULL CHECK (currency IN ('CNY', 'USD')),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
  overdraft_limit numeric NOT NULL CHECK (overdraft_limit >= 0),
  contact_name text NOT NULL DEFAULT '',
  contact_phone text NOT NULL DEFAULT '',
  remark text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE FUNCTION tenants_freeze_identity() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.code <> OLD.code OR NEW.currency <> OLD.currency OR NEW.id <> OLD.id THEN
    RAISE EXCEPTION '租户编码和币种创建后不可修改' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER tenants_freeze_identity BEFORE UPDATE ON tenants
  FOR EACH ROW EXECUTE FUNCTION tenants_freeze_identity();

CREATE TABLE admins (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email text NOT NULL UNIQUE,
  name text NOT NULL CHECK (btrim(name) <> ''),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
  last_login_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE portal_accounts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants,
  email text NOT NULL UNIQUE,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
  last_login_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- 费率：每个租户一张表（design §6.1），版本是整表快照。

CREATE TABLE rate_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants,
  effective_from timestamptz NOT NULL DEFAULT now(),
  created_by uuid REFERENCES admins,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT rate_versions_tenant_effective_from_key UNIQUE (tenant_id, effective_from),
  UNIQUE (id, tenant_id)
);

CREATE TABLE rate_entries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  rate_version_id uuid NOT NULL,
  prefix text NOT NULL CHECK (prefix ~ '^[0-9]+$' AND prefix !~ '^00'),
  country text NOT NULL CHECK (btrim(country) <> ''),
  rate numeric NOT NULL CHECK (rate >= 0 AND scale(rate) <= 4),
  FOREIGN KEY (rate_version_id, tenant_id) REFERENCES rate_versions (id, tenant_id) ON DELETE CASCADE,
  UNIQUE (rate_version_id, prefix)
);

-- 新版本必须晚于所有已有版本：已排定未来版本时，插入立即生效的版本被拒绝。
CREATE FUNCTION rate_versions_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  latest timestamptz;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    RAISE EXCEPTION '费率版本不可修改' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF TG_OP = 'DELETE' THEN
    IF OLD.effective_from <= now() THEN
      RAISE EXCEPTION '已生效的费率版本不可删除' USING ERRCODE = 'insufficient_privilege';
    END IF;
    RETURN OLD;
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('rate_versions:' || NEW.tenant_id::text, 0));
  SELECT max(effective_from) INTO latest FROM rate_versions WHERE tenant_id = NEW.tenant_id;
  IF NEW.effective_from < latest THEN
    IF latest > now() THEN
      RAISE EXCEPTION '已排定 % 生效的新版本，请先修改该未来版本', latest
        USING ERRCODE = 'check_violation';
    END IF;
    RAISE EXCEPTION '新版本的生效时间必须晚于当前版本（%）', latest
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER rate_versions_guard BEFORE INSERT OR UPDATE OR DELETE ON rate_versions
  FOR EACH ROW EXECUTE FUNCTION rate_versions_guard();

-- 条目只能在未来版本或本事务新建的版本上增删；已生效的版本是历史，不可改。
CREATE FUNCTION rate_entries_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  version rate_versions%ROWTYPE;
  row_version uuid;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    RAISE EXCEPTION '费率条目不可修改，请新建版本' USING ERRCODE = 'insufficient_privilege';
  END IF;
  row_version := CASE TG_OP WHEN 'INSERT' THEN NEW.rate_version_id ELSE OLD.rate_version_id END;
  SELECT * INTO version FROM rate_versions WHERE id = row_version;
  -- 插入时由外键报错；删除时版本已不存在，说明是取消未来版本的级联删除。
  IF NOT FOUND THEN
    RETURN CASE TG_OP WHEN 'INSERT' THEN NEW ELSE OLD END;
  END IF;
  IF version.effective_from <= now()
     AND (SELECT xmin FROM rate_versions WHERE id = row_version) <> pg_current_xact_id()::xid THEN
    RAISE EXCEPTION '已生效的费率版本不可修改，请新建版本' USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN CASE TG_OP WHEN 'INSERT' THEN NEW ELSE OLD END;
END $$;

CREATE TRIGGER rate_entries_guard BEFORE INSERT OR UPDATE OR DELETE ON rate_entries
  FOR EACH ROW EXECUTE FUNCTION rate_entries_guard();

-- 余额流水：只增；余额 = 合计。

CREATE TABLE ledger_entries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants,
  kind text NOT NULL
    CHECK (kind IN ('recharge', 'credit_recharge', 'gift', 'adjustment', 'call_charge')),
  amount numeric NOT NULL,
  note text NOT NULL DEFAULT '',
  created_by uuid REFERENCES admins,
  idempotency_key text NOT NULL CHECK (idempotency_key <> ''),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ledger_entries_tenant_idempotency_key UNIQUE (tenant_id, idempotency_key),
  UNIQUE (id, tenant_id, kind),
  CONSTRAINT ledger_entries_kind_shape CHECK (CASE kind
    WHEN 'call_charge' THEN amount < 0 AND created_by IS NULL
    WHEN 'adjustment' THEN amount <> 0 AND created_by IS NOT NULL AND btrim(note) <> ''
    ELSE amount > 0 AND created_by IS NOT NULL
  END)
);

CREATE INDEX ledger_entries_tenant_created_at ON ledger_entries (tenant_id, created_at);

CREATE TRIGGER ledger_entries_append_only BEFORE UPDATE OR DELETE ON ledger_entries
  FOR EACH ROW EXECUTE FUNCTION reject_mutation();
CREATE TRIGGER ledger_entries_no_truncate BEFORE TRUNCATE ON ledger_entries
  FOR EACH STATEMENT EXECUTE FUNCTION reject_mutation();

-- 待收款 → 已收款：结算是一条独立事件，原流水不变。
CREATE TABLE receivable_settlements (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  ledger_entry_id uuid NOT NULL UNIQUE,
  entry_kind text NOT NULL DEFAULT 'credit_recharge' CHECK (entry_kind = 'credit_recharge'),
  received_on date NOT NULL,
  note text NOT NULL DEFAULT '',
  confirmed_by uuid NOT NULL REFERENCES admins,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (ledger_entry_id, tenant_id, entry_kind)
    REFERENCES ledger_entries (id, tenant_id, kind)
);

CREATE TRIGGER receivable_settlements_append_only BEFORE UPDATE OR DELETE ON receivable_settlements
  FOR EACH ROW EXECUTE FUNCTION reject_mutation();
CREATE TRIGGER receivable_settlements_no_truncate BEFORE TRUNCATE ON receivable_settlements
  FOR EACH STATEMENT EXECUTE FUNCTION reject_mutation();

CREATE VIEW receivables WITH (security_invoker = true) AS
SELECT
  e.id AS ledger_entry_id,
  e.tenant_id,
  e.amount,
  e.note,
  e.created_by,
  e.created_at,
  CASE WHEN s.id IS NULL THEN 'pending' ELSE 'received' END AS status,
  s.received_on,
  s.confirmed_by
FROM ledger_entries e
LEFT JOIN receivable_settlements s ON s.ledger_entry_id = e.id
WHERE e.kind = 'credit_recharge';

-- 缓存余额：只由触发器维护，可由 balance_discrepancies 核对、rebuild_tenant_balances 重算。
CREATE TABLE tenant_balances (
  tenant_id uuid PRIMARY KEY REFERENCES tenants,
  balance numeric NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE FUNCTION tenants_open_balance() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  INSERT INTO tenant_balances (tenant_id) VALUES (NEW.id);
  RETURN NULL;
END $$;

CREATE TRIGGER tenants_open_balance AFTER INSERT ON tenants
  FOR EACH ROW EXECUTE FUNCTION tenants_open_balance();

CREATE FUNCTION ledger_entries_apply_balance() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  UPDATE tenant_balances
  SET balance = balance + NEW.amount, updated_at = now()
  WHERE tenant_id = NEW.tenant_id;
  RETURN NULL;
END $$;

CREATE TRIGGER ledger_entries_apply_balance AFTER INSERT ON ledger_entries
  FOR EACH ROW EXECUTE FUNCTION ledger_entries_apply_balance();

CREATE VIEW balance_discrepancies WITH (security_invoker = true) AS
SELECT t.id AS tenant_id, t.code, b.balance AS cached_balance, coalesce(l.total, 0) AS ledger_total
FROM tenants t
LEFT JOIN tenant_balances b ON b.tenant_id = t.id
LEFT JOIN (
  SELECT tenant_id, sum(amount) AS total FROM ledger_entries GROUP BY tenant_id
) l ON l.tenant_id = t.id
WHERE b.balance IS DISTINCT FROM coalesce(l.total, 0);

CREATE FUNCTION rebuild_tenant_balances() RETURNS integer
LANGUAGE sql AS $$
  WITH totals AS (
    SELECT t.id AS tenant_id, coalesce(sum(e.amount), 0) AS total
    FROM tenants t LEFT JOIN ledger_entries e ON e.tenant_id = t.id
    GROUP BY t.id
  ), fixed AS (
    UPDATE tenant_balances b SET balance = totals.total, updated_at = now()
    FROM totals
    WHERE b.tenant_id = totals.tenant_id AND b.balance <> totals.total
    RETURNING 1
  )
  SELECT count(*)::integer FROM fixed
$$;

-- 话单：按北京时间自然月分区；通话 UUID 由非分区登记表保证全局唯一。

CREATE TABLE cdr_call_uuids (
  call_uuid uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants,
  started_at timestamptz NOT NULL
);

CREATE TABLE cdrs (
  tenant_id uuid NOT NULL REFERENCES tenants,
  call_uuid uuid NOT NULL,
  started_at timestamptz NOT NULL,
  answered_at timestamptz,
  ended_at timestamptz NOT NULL,
  caller text NOT NULL,
  callee text NOT NULL,
  duration_seconds integer NOT NULL DEFAULT 0 CHECK (duration_seconds >= 0),
  billed_minutes numeric NOT NULL DEFAULT 0 CHECK (billed_minutes >= 0),
  matched_prefix text,
  country text,
  rate numeric CHECK (rate >= 0 AND scale(rate) <= 4),
  charge numeric NOT NULL DEFAULT 0 CHECK (charge >= 0),
  hangup_cause text NOT NULL DEFAULT '',
  unverified boolean NOT NULL DEFAULT false,
  received_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (call_uuid, started_at),
  CHECK (ended_at >= started_at),
  CONSTRAINT cdrs_answered_shape CHECK (
    CASE WHEN answered_at IS NULL
      THEN duration_seconds = 0 AND billed_minutes = 0 AND charge = 0
      ELSE answered_at >= started_at AND answered_at <= ended_at
        AND matched_prefix IS NOT NULL AND country IS NOT NULL AND rate IS NOT NULL
    END
  )
) PARTITION BY RANGE (started_at);

CREATE INDEX cdrs_tenant_answered_at ON cdrs (tenant_id, answered_at);

CREATE FUNCTION cdrs_register_call_uuid() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  INSERT INTO cdr_call_uuids (call_uuid, tenant_id, started_at)
  VALUES (NEW.call_uuid, NEW.tenant_id, NEW.started_at);
  RETURN NEW;
END $$;

CREATE TRIGGER cdrs_register_call_uuid BEFORE INSERT ON cdrs
  FOR EACH ROW EXECUTE FUNCTION cdrs_register_call_uuid();

CREATE FUNCTION cdr_ensure_partition(moment timestamptz) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  month_start timestamp := date_trunc('month', moment AT TIME ZONE 'Asia/Shanghai');
  partition_name text := 'cdrs_' || to_char(month_start, 'YYYY_MM');
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('cdr_partitions', 0));
  IF to_regclass(partition_name) IS NULL THEN
    EXECUTE format(
      'CREATE TABLE %I PARTITION OF cdrs FOR VALUES FROM (%L) TO (%L)',
      partition_name,
      month_start AT TIME ZONE 'Asia/Shanghai',
      (month_start + interval '1 month') AT TIME ZONE 'Asia/Shanghai'
    );
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', partition_name);
  END IF;
  RETURN partition_name;
END $$;

-- 建当月与下月分区；幂等，可每日调度。
CREATE FUNCTION cdr_ensure_partitions(moment timestamptz DEFAULT now()) RETURNS SETOF text
LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT cdr_ensure_partition(moment)
  UNION ALL
  SELECT cdr_ensure_partition(
    (date_trunc('month', moment AT TIME ZONE 'Asia/Shanghai') + interval '1 month')
      AT TIME ZONE 'Asia/Shanghai'
  )
$$;

CREATE TABLE raw_cdrs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid REFERENCES tenants,
  call_uuid uuid NOT NULL UNIQUE,
  payload jsonb NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now()
);

-- 租户标签缺失、找不到租户、无费率或号码格式错误的话单，等待人工处理。
CREATE TABLE unassigned_cdrs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_tag text NOT NULL DEFAULT '',
  call_uuid uuid NOT NULL UNIQUE,
  reason text NOT NULL CHECK (btrim(reason) <> ''),
  started_at timestamptz NOT NULL,
  answered_at timestamptz,
  ended_at timestamptz NOT NULL,
  caller text NOT NULL,
  callee text NOT NULL,
  duration_seconds integer NOT NULL DEFAULT 0 CHECK (duration_seconds >= 0),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'ignored', 'assigned')),
  ignore_reason text,
  assigned_tenant_id uuid REFERENCES tenants,
  resolved_by uuid REFERENCES admins,
  resolved_at timestamptz,
  received_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT unassigned_cdrs_status_shape CHECK (CASE status
    WHEN 'pending' THEN ignore_reason IS NULL AND assigned_tenant_id IS NULL
      AND resolved_by IS NULL AND resolved_at IS NULL
    WHEN 'ignored' THEN btrim(coalesce(ignore_reason, '')) <> '' AND assigned_tenant_id IS NULL
      AND resolved_by IS NOT NULL AND resolved_at IS NOT NULL
    ELSE assigned_tenant_id IS NOT NULL AND ignore_reason IS NULL
      AND resolved_by IS NOT NULL AND resolved_at IS NOT NULL
  END)
);

-- 账单、日志、告警、余额提醒

CREATE TABLE monthly_statements (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants,
  month date NOT NULL CHECK (extract(day FROM month) = 1),
  opening_balance numeric NOT NULL,
  recharge numeric NOT NULL CHECK (recharge >= 0),
  gift numeric NOT NULL CHECK (gift >= 0),
  adjustment numeric NOT NULL,
  call_charges numeric NOT NULL CHECK (call_charges >= 0),
  closing_balance numeric NOT NULL,
  call_minutes numeric NOT NULL CHECK (call_minutes >= 0),
  details_deleted boolean NOT NULL DEFAULT false,
  generated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, month),
  CONSTRAINT monthly_statements_balanced CHECK (
    closing_balance = opening_balance + recharge + gift + adjustment - call_charges
  )
);

CREATE TABLE operation_logs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  admin_id uuid NOT NULL REFERENCES admins,
  tenant_id uuid REFERENCES tenants,
  action text NOT NULL CHECK (btrim(action) <> ''),
  target text NOT NULL DEFAULT '',
  details jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TRIGGER operation_logs_append_only BEFORE UPDATE OR DELETE ON operation_logs
  FOR EACH ROW EXECUTE FUNCTION reject_mutation();
CREATE TRIGGER operation_logs_no_truncate BEFORE TRUNCATE ON operation_logs
  FOR EACH STATEMENT EXECUTE FUNCTION reject_mutation();

CREATE TABLE system_alerts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid REFERENCES tenants,
  kind text NOT NULL CHECK (kind IN ('auth_timeout', 'cdr_failed', 'email_failed')),
  description text NOT NULL,
  started_at timestamptz NOT NULL DEFAULT now(),
  recovered_at timestamptz CHECK (recovered_at >= started_at),
  affected_calls integer NOT NULL DEFAULT 0 CHECK (affected_calls >= 0)
);

CREATE TABLE balance_alert_settings (
  tenant_id uuid PRIMARY KEY REFERENCES tenants,
  threshold numeric NOT NULL,
  emails text[] NOT NULL DEFAULT '{}'
);

CREATE TABLE balance_alert_deliveries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants,
  kind text NOT NULL CHECK (kind IN ('low_balance', 'suspended')),
  balance numeric NOT NULL,
  recipients text[] NOT NULL,
  sent_at timestamptz NOT NULL DEFAULT now()
);

CREATE TRIGGER balance_alert_deliveries_append_only BEFORE UPDATE OR DELETE ON balance_alert_deliveries
  FOR EACH ROW EXECUTE FUNCTION reject_mutation();
CREATE TRIGGER balance_alert_deliveries_no_truncate BEFORE TRUNCATE ON balance_alert_deliveries
  FOR EACH STATEMENT EXECUTE FUNCTION reject_mutation();

-- 行级安全

ALTER TABLE tenants ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON tenants
  USING (app_can_see(id)) WITH CHECK (app_can_see(id));

DO $$
DECLARE
  name text;
BEGIN
  FOREACH name IN ARRAY ARRAY[
    'portal_accounts', 'rate_versions', 'rate_entries', 'ledger_entries',
    'receivable_settlements', 'tenant_balances', 'cdrs', 'monthly_statements',
    'balance_alert_settings', 'balance_alert_deliveries'
  ] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', name);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I USING (app_can_see(tenant_id)) WITH CHECK (app_can_see(tenant_id))',
      name
    );
  END LOOP;
  FOREACH name IN ARRAY ARRAY[
    'admins', 'raw_cdrs', 'unassigned_cdrs', 'operation_logs', 'system_alerts', 'cdr_call_uuids'
  ] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', name);
    EXECUTE format(
      'CREATE POLICY admin_only ON %I USING (app_scope() = ''admin'') WITH CHECK (app_scope() = ''admin'')',
      name
    );
  END LOOP;
END $$;

-- 应用角色权限：流水、结算、日志、发送记录只有 SELECT/INSERT。

GRANT SELECT, INSERT, UPDATE ON tenants, admins, portal_accounts, unassigned_cdrs,
  monthly_statements, system_alerts, balance_alert_settings TO fs_billing_app;
GRANT SELECT, INSERT, DELETE ON rate_versions, rate_entries, cdrs TO fs_billing_app;
GRANT SELECT, INSERT ON ledger_entries, receivable_settlements, raw_cdrs, operation_logs,
  balance_alert_deliveries TO fs_billing_app;
GRANT SELECT ON tenant_balances, receivables, balance_discrepancies TO fs_billing_app;

REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA public FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_scope(), app_tenant_id(), app_can_see(uuid),
  cdr_ensure_partitions(timestamptz) TO fs_billing_app;

SELECT cdr_ensure_partitions();
