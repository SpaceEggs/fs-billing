DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'fs_billing_app') THEN
    CREATE ROLE fs_billing_app NOLOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOINHERIT;
  END IF;
END $$;

GRANT USAGE ON SCHEMA public TO fs_billing_app;
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
ALTER DEFAULT PRIVILEGES REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;

-- 会话身份：事务内 set_config('app.scope', 'tenant' | 'admin' | 'system', true)；未设置时策略为假。
-- tenant（客户门户）只读本租户；admin（管理后台）与 system（Worker）可见全部并可写。
CREATE FUNCTION app_scope() RETURNS text
LANGUAGE sql STABLE AS $$ SELECT current_setting('app.scope', true) $$;

CREATE FUNCTION app_tenant_id() RETURNS uuid
LANGUAGE sql STABLE AS $$ SELECT nullif(current_setting('app.tenant_id', true), '')::uuid $$;

CREATE FUNCTION app_is_operator() RETURNS boolean
LANGUAGE sql STABLE AS $$ SELECT coalesce(app_scope() IN ('admin', 'system'), false) $$;

CREATE FUNCTION app_can_see(row_tenant uuid) RETURNS boolean
LANGUAGE sql STABLE AS $$
  SELECT app_is_operator()
    OR (app_scope() = 'tenant' AND coalesce(row_tenant = app_tenant_id(), false))
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
  tenant uuid;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    RAISE EXCEPTION '费率版本不可修改' USING ERRCODE = 'insufficient_privilege';
  END IF;
  -- 先锁再读时钟。now() 停在事务开始，等锁期间可能跨过生效时间。
  tenant := CASE WHEN TG_OP = 'DELETE' THEN OLD.tenant_id ELSE NEW.tenant_id END;
  PERFORM pg_advisory_xact_lock(hashtextextended('rate_versions:' || tenant::text, 0));
  IF TG_OP = 'DELETE' THEN
    IF OLD.effective_from <= clock_timestamp() THEN
      RAISE EXCEPTION '已生效的费率版本不可删除' USING ERRCODE = 'insufficient_privilege';
    END IF;
    RETURN OLD;
  END IF;
  SELECT max(effective_from) INTO latest FROM rate_versions WHERE tenant_id = NEW.tenant_id;
  IF NEW.effective_from < latest THEN
    IF latest > clock_timestamp() THEN
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
  tenant uuid;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    RAISE EXCEPTION '费率条目不可修改，请新建版本' USING ERRCODE = 'insufficient_privilege';
  END IF;
  row_version := CASE TG_OP WHEN 'INSERT' THEN NEW.rate_version_id ELSE OLD.rate_version_id END;
  tenant := CASE TG_OP WHEN 'INSERT' THEN NEW.tenant_id ELSE OLD.tenant_id END;
  -- 与 rate_versions_guard 同一把锁，拿到之后再用 clock_timestamp() 判断是否已生效。
  PERFORM pg_advisory_xact_lock(hashtextextended('rate_versions:' || tenant::text, 0));
  SELECT * INTO version FROM rate_versions WHERE id = row_version;
  -- 插入时由外键报错；删除时版本已不存在，说明是取消未来版本的级联删除。
  IF NOT FOUND THEN
    RETURN CASE TG_OP WHEN 'INSERT' THEN NEW ELSE OLD END;
  END IF;
  IF version.effective_from <= clock_timestamp()
     AND (SELECT xmin FROM rate_versions WHERE id = row_version) <> pg_current_xact_id()::xid THEN
    RAISE EXCEPTION '已生效的费率版本不可修改，请新建版本' USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN CASE TG_OP WHEN 'INSERT' THEN NEW ELSE OLD END;
END $$;

CREATE TRIGGER rate_entries_guard BEFORE INSERT OR UPDATE OR DELETE ON rate_entries
  FOR EACH ROW EXECUTE FUNCTION rate_entries_guard();

-- 余额流水：只增；余额 = 合计。账单按 occurred_at（北京时间日/月）归属：
-- 通话扣费为接通时间，人工操作即写入时间。

CREATE TABLE ledger_entries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants,
  kind text NOT NULL
    CHECK (kind IN ('recharge', 'credit_recharge', 'gift', 'adjustment', 'call_charge')),
  amount numeric NOT NULL,
  note text NOT NULL DEFAULT '',
  created_by uuid REFERENCES admins,
  idempotency_key text NOT NULL CHECK (idempotency_key <> ''),
  occurred_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ledger_entries_tenant_idempotency_key UNIQUE (tenant_id, idempotency_key),
  UNIQUE (id, tenant_id, kind),
  CONSTRAINT ledger_entries_kind_shape CHECK (CASE kind
    WHEN 'call_charge' THEN amount < 0 AND created_by IS NULL
    WHEN 'adjustment' THEN amount <> 0 AND created_by IS NOT NULL AND btrim(note) <> ''
      AND occurred_at = created_at
    ELSE amount > 0 AND created_by IS NOT NULL AND occurred_at = created_at
  END)
);

CREATE INDEX ledger_entries_tenant_occurred_at ON ledger_entries (tenant_id, occurred_at);

CREATE TRIGGER ledger_entries_append_only BEFORE UPDATE OR DELETE ON ledger_entries
  FOR EACH ROW EXECUTE FUNCTION reject_mutation();
CREATE TRIGGER ledger_entries_no_truncate BEFORE TRUNCATE ON ledger_entries
  FOR EACH STATEMENT EXECUTE FUNCTION reject_mutation();

-- 应用角色不能指定写入时间。Drizzle 的 INSERT 会列出 created_at 并写 DEFAULT，
-- 列权限会把这次合法插入一起拒绝，所以在这里拒绝非 now() 的值。owner 写种子的历史时间。
CREATE FUNCTION ledger_entries_stamp_created_at() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF current_user = 'fs_billing_app' AND NEW.created_at IS DISTINCT FROM now() THEN
    RAISE EXCEPTION 'created_at 由数据库生成' USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER ledger_entries_stamp_created_at BEFORE INSERT ON ledger_entries
  FOR EACH ROW EXECUTE FUNCTION ledger_entries_stamp_created_at();

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

-- 锁协议：按 tenant_id 顺序锁 tenant_balances 的行。流水触发器更新该行，锁持有到提交。
-- READ COMMITTED 下每条语句各取快照。第一条 FOR UPDATE 只锁住自己快照里的余额行。
-- 锁等待期间提交的新租户不在这个集合里。下一条语句若用新快照把它算进合计再 UPDATE，
-- 而它还有未提交扣费，UPDATE 会等扣费提交后用旧合计覆盖触发器刚写上的金额。
-- 所以第一条锁返回后对 tenants 加 SHARE：挡住之后的开户，并等正在进行的开户提交。
-- SHARE 与扣费在 tenants 上的外键 FOR KEY SHARE 不冲突，不会和已持有的余额行锁死锁。
-- 接着再按 tenant_id 锁住当前快照的全部余额行，未提交扣费等到提交。求和与 UPDATE
-- 只处理这个锁住的集合，并用再下一条语句的新快照，刚等到的扣费已经计入。
-- 重算拿到某行的锁之后才插入的流水会等重算提交，再按 balance = balance + amount 累加。
CREATE FUNCTION rebuild_tenant_balances() RETURNS integer
LANGUAGE plpgsql AS $$
DECLARE
  locked uuid[];
  fixed integer;
BEGIN
  PERFORM 1 FROM tenant_balances ORDER BY tenant_id FOR UPDATE;
  LOCK TABLE tenants IN SHARE MODE;
  SELECT coalesce(array_agg(tenant_id ORDER BY tenant_id), '{}'::uuid[]) INTO locked
  FROM (SELECT tenant_id FROM tenant_balances ORDER BY tenant_id FOR UPDATE) AS held;
  WITH totals AS (
    SELECT held_id AS tenant_id, coalesce(sum(e.amount), 0) AS total
    FROM unnest(locked) AS held_id
    LEFT JOIN ledger_entries e ON e.tenant_id = held_id
    GROUP BY held_id
  ), updated AS (
    UPDATE tenant_balances b SET balance = totals.total, updated_at = now()
    FROM totals
    WHERE b.tenant_id = totals.tenant_id AND b.balance <> totals.total
    RETURNING 1
  )
  SELECT count(*)::integer INTO fixed FROM updated;
  RETURN fixed;
END $$;

-- 话单：按北京时间自然月分区。通话 UUID 由非分区登记表保证全局唯一，
-- 正式话单与未归属话单共用：tenant_id 为空表示未归属，只能被认领一次。

CREATE TABLE call_uuids (
  call_uuid uuid PRIMARY KEY,
  tenant_id uuid REFERENCES tenants,
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

-- 认领未归属的登记，或新登记；登记已属于某个租户时与普通唯一冲突相同地报错。
CREATE FUNCTION cdrs_register_call_uuid() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  INSERT INTO call_uuids AS registered (call_uuid, tenant_id, started_at)
  VALUES (NEW.call_uuid, NEW.tenant_id, NEW.started_at)
  ON CONFLICT (call_uuid) DO UPDATE SET tenant_id = EXCLUDED.tenant_id
    WHERE registered.tenant_id IS NULL;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'duplicate key value violates unique constraint "call_uuids_pkey"'
      USING ERRCODE = 'unique_violation', CONSTRAINT = 'call_uuids_pkey', TABLE = 'call_uuids',
        DETAIL = format('Key (call_uuid)=(%s) already exists.', NEW.call_uuid);
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER cdrs_register_call_uuid BEFORE INSERT ON cdrs
  FOR EACH ROW EXECUTE FUNCTION cdrs_register_call_uuid();

-- 原始话单：body 是收到的原文，payload 由它派生。下列转换错误得到 NULL，原文仍写入。
-- 22P02 非法 JSON，22P05 jsonb 不接受的转义（\u0000），22003 数值超出 numeric。
CREATE FUNCTION jsonb_or_null(body text) RETURNS jsonb
LANGUAGE plpgsql IMMUTABLE AS $$
BEGIN
  RETURN body::jsonb;
EXCEPTION
  WHEN SQLSTATE '22P02' OR SQLSTATE '22P05' OR SQLSTATE '22003' THEN
    RETURN NULL;
END $$;

CREATE TABLE raw_cdrs (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  tenant_id uuid REFERENCES tenants,
  call_uuid uuid,
  body text NOT NULL,
  payload jsonb GENERATED ALWAYS AS (jsonb_or_null(body)) STORED,
  received_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (id, received_at)
) PARTITION BY RANGE (received_at);

-- 先无锁检查，缺分区时才加锁并再查一次，入库路径上调用不会互相串行。
CREATE FUNCTION ensure_month_partition(parent text, moment timestamptz) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  month_start timestamp := date_trunc('month', moment AT TIME ZONE 'Asia/Shanghai');
  partition_name text := parent || '_' || to_char(month_start, 'YYYY_MM');
BEGIN
  IF NOT app_is_operator() THEN
    RAISE EXCEPTION '建分区只允许管理员或系统身份' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF parent NOT IN ('cdrs', 'raw_cdrs') THEN
    RAISE EXCEPTION '% 不是按月分区的表', parent USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF to_regclass(partition_name) IS NOT NULL THEN
    RETURN partition_name;
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('partition:' || partition_name, 0));
  IF to_regclass(partition_name) IS NULL THEN
    EXECUTE format(
      'CREATE TABLE %I PARTITION OF %I FOR VALUES FROM (%L) TO (%L)',
      partition_name,
      parent,
      month_start AT TIME ZONE 'Asia/Shanghai',
      (month_start + interval '1 month') AT TIME ZONE 'Asia/Shanghai'
    );
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', partition_name);
  END IF;
  RETURN partition_name;
END $$;

-- 建 cdrs 与 raw_cdrs 的当月与下月分区；幂等，可每日调度。
CREATE FUNCTION cdr_ensure_partitions(moment timestamptz DEFAULT now()) RETURNS SETOF text
LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT ensure_month_partition(parent, month)
  FROM unnest(ARRAY['cdrs', 'raw_cdrs']) AS parent,
    unnest(ARRAY[
      moment,
      (date_trunc('month', moment AT TIME ZONE 'Asia/Shanghai') + interval '1 month')
        AT TIME ZONE 'Asia/Shanghai'
    ]) WITH ORDINALITY AS months (month, n)
  ORDER BY parent, n
$$;

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

CREATE FUNCTION unassigned_cdrs_register_call_uuid() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  INSERT INTO call_uuids (call_uuid, tenant_id, started_at)
  VALUES (NEW.call_uuid, NULL, NEW.started_at);
  RETURN NEW;
END $$;

CREATE TRIGGER unassigned_cdrs_register_call_uuid BEFORE INSERT ON unassigned_cdrs
  FOR EACH ROW EXECUTE FUNCTION unassigned_cdrs_register_call_uuid();

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
  kind text NOT NULL
    CHECK (kind IN ('auth_timeout', 'cdr_failed', 'email_failed', 'partition_failed')),
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

-- 行级安全：按命令分开的策略（同一命令的多条 permissive 策略是 OR 合并，所以没有 ALL 策略）。
-- 租户身份只能 SELECT 本租户；写入只允许管理员与系统身份。UPDATE 的 USING 用可见性、
-- WITH CHECK 用写权限，租户改自己的行会报错而不是静默影响 0 行；DELETE 没有 WITH CHECK，
-- 租户的删除影响 0 行。

DO $$
DECLARE
  target record;
BEGIN
  FOR target IN SELECT * FROM (VALUES
    ('tenants', 'id'), ('portal_accounts', 'tenant_id'), ('rate_versions', 'tenant_id'),
    ('rate_entries', 'tenant_id'), ('ledger_entries', 'tenant_id'),
    ('receivable_settlements', 'tenant_id'), ('tenant_balances', 'tenant_id'),
    ('cdrs', 'tenant_id'), ('monthly_statements', 'tenant_id'),
    ('balance_alert_settings', 'tenant_id'), ('balance_alert_deliveries', 'tenant_id')
  ) AS t (name, tenant_column) LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', target.name);
    EXECUTE format('CREATE POLICY tenant_read ON %I FOR SELECT USING (app_can_see(%I))',
      target.name, target.tenant_column);
    EXECUTE format('CREATE POLICY operator_insert ON %I FOR INSERT WITH CHECK (app_is_operator())',
      target.name);
    EXECUTE format(
      'CREATE POLICY operator_update ON %I FOR UPDATE USING (app_can_see(%I)) WITH CHECK (app_is_operator())',
      target.name, target.tenant_column);
    EXECUTE format('CREATE POLICY operator_delete ON %I FOR DELETE USING (app_is_operator())',
      target.name);
  END LOOP;
  FOR target IN SELECT * FROM (VALUES
    ('admins', 'app_scope() = ''admin'''), ('operation_logs', 'app_scope() = ''admin'''),
    ('raw_cdrs', 'app_is_operator()'), ('unassigned_cdrs', 'app_is_operator()'),
    ('system_alerts', 'app_is_operator()'), ('call_uuids', 'app_is_operator()')
  ) AS t (name, allowed) LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', target.name);
    EXECUTE format('CREATE POLICY staff_only ON %I USING (%s) WITH CHECK (%s)',
      target.name, target.allowed, target.allowed);
  END LOOP;
END $$;

-- 应用角色权限：流水、结算、日志、发送记录只有 SELECT/INSERT。该表没有 UPDATE。

GRANT SELECT, INSERT, UPDATE ON tenants, admins, portal_accounts, unassigned_cdrs,
  monthly_statements, system_alerts, balance_alert_settings TO fs_billing_app;
GRANT SELECT, INSERT, DELETE ON rate_versions, rate_entries, cdrs TO fs_billing_app;
GRANT SELECT, INSERT ON ledger_entries, receivable_settlements, raw_cdrs, operation_logs,
  balance_alert_deliveries TO fs_billing_app;
GRANT SELECT ON tenant_balances, receivables, balance_discrepancies TO fs_billing_app;

REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA public FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_scope(), app_tenant_id(), app_is_operator(), app_can_see(uuid),
  jsonb_or_null(text), cdr_ensure_partitions(timestamptz) TO fs_billing_app;
