SET LOCAL lock_timeout = '5s';
--> statement-breakpoint
-- 月账单（阶段 7）：0000 建的 monthly_statements 补上通话数、版本、生成人、核对状态；
-- 按国家、按日的明细各一张只增表；守卫触发器；system_alerts 增加 statement_mismatch。
-- 头部六个数来自流水（occurred_at 的北京月），通话数与明细来自话单（answered_at 的北京月/日）。
ALTER TABLE monthly_statements
  ADD COLUMN calls integer NOT NULL DEFAULT 0,
  ADD COLUMN version integer NOT NULL DEFAULT 1,
  ADD COLUMN first_generated_at timestamptz NOT NULL DEFAULT now(),
  ADD COLUMN generated_by uuid REFERENCES admins,
  ADD COLUMN breakdown_gap numeric NOT NULL DEFAULT 0,
  ADD COLUMN reconcile_status text NOT NULL DEFAULT 'unchecked',
  ADD COLUMN reconciled_at timestamptz,
  ADD COLUMN reconcile_diff numeric;
--> statement-breakpoint
ALTER TABLE monthly_statements
  ADD CONSTRAINT monthly_statements_calls_check CHECK (calls >= 0),
  ADD CONSTRAINT monthly_statements_version_check CHECK (version >= 1),
  ADD CONSTRAINT monthly_statements_reconcile_status_check
    CHECK (reconcile_status IN ('unchecked', 'ok', 'stale', 'inconsistent')),
  ADD CONSTRAINT monthly_statements_id_tenant_id_key UNIQUE (id, tenant_id);
--> statement-breakpoint
-- 表里此前没有代码写过行；已有的行把首次生成时间对齐到生成时间。
UPDATE monthly_statements SET first_generated_at = generated_at;
--> statement-breakpoint
-- 明细表只增：重新生成时追加新版本的行，读取只取头部当前版本的行。
CREATE TABLE monthly_statement_countries (
  statement_id uuid NOT NULL,
  tenant_id uuid NOT NULL,
  version integer NOT NULL CHECK (version >= 1),
  country text NOT NULL CHECK (btrim(country) <> ''),
  calls integer NOT NULL CHECK (calls >= 0),
  minutes numeric NOT NULL CHECK (minutes >= 0),
  charge numeric NOT NULL CHECK (charge >= 0),
  PRIMARY KEY (statement_id, version, country),
  FOREIGN KEY (statement_id, tenant_id) REFERENCES monthly_statements (id, tenant_id)
);
--> statement-breakpoint
CREATE TABLE monthly_statement_days (
  statement_id uuid NOT NULL,
  tenant_id uuid NOT NULL,
  version integer NOT NULL CHECK (version >= 1),
  day date NOT NULL,
  calls integer NOT NULL CHECK (calls >= 0),
  minutes numeric NOT NULL CHECK (minutes >= 0),
  charge numeric NOT NULL CHECK (charge >= 0),
  PRIMARY KEY (statement_id, version, day),
  FOREIGN KEY (statement_id, tenant_id) REFERENCES monthly_statements (id, tenant_id)
);
--> statement-breakpoint
CREATE TRIGGER monthly_statement_countries_append_only BEFORE UPDATE OR DELETE ON monthly_statement_countries
  FOR EACH ROW EXECUTE FUNCTION reject_mutation();
--> statement-breakpoint
CREATE TRIGGER monthly_statement_countries_no_truncate BEFORE TRUNCATE ON monthly_statement_countries
  FOR EACH STATEMENT EXECUTE FUNCTION reject_mutation();
--> statement-breakpoint
CREATE TRIGGER monthly_statement_days_append_only BEFORE UPDATE OR DELETE ON monthly_statement_days
  FOR EACH ROW EXECUTE FUNCTION reject_mutation();
--> statement-breakpoint
CREATE TRIGGER monthly_statement_days_no_truncate BEFORE TRUNCATE ON monthly_statement_days
  FOR EACH STATEMENT EXECUTE FUNCTION reject_mutation();
--> statement-breakpoint
-- 策略同 0000 的 DO 块；tenant_read 直接写成 0015 的 InitPlan 形式。
DO $$
DECLARE
  target text;
BEGIN
  FOREACH target IN ARRAY ARRAY['monthly_statement_countries', 'monthly_statement_days'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', target);
    EXECUTE format($policy$
      CREATE POLICY tenant_read ON %I FOR SELECT USING (
        (SELECT app_is_operator())
        OR ((SELECT app_scope()) = 'tenant' AND tenant_id = (SELECT app_tenant_id()))
      )$policy$, target);
    EXECUTE format('CREATE POLICY operator_insert ON %I FOR INSERT WITH CHECK (app_is_operator())', target);
    EXECUTE format(
      'CREATE POLICY operator_update ON %I FOR UPDATE USING (app_can_see(tenant_id)) WITH CHECK (app_is_operator())',
      target);
    EXECUTE format('CREATE POLICY operator_delete ON %I FOR DELETE USING (app_is_operator())', target);
  END LOOP;
END $$;
--> statement-breakpoint
GRANT SELECT, INSERT ON monthly_statement_countries, monthly_statement_days TO fs_billing_app;
--> statement-breakpoint
-- 已删除话单的月份（details_deleted）不能重新生成：数据库层的最后一道防线。
-- 阶段 8 删除话单时在同一事务里把对应月份置真；服务层先检查并返回 409，触发器兜底。
CREATE FUNCTION monthly_statements_guard() RETURNS trigger
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
CREATE TRIGGER monthly_statements_guard BEFORE UPDATE ON monthly_statements
  FOR EACH ROW EXECUTE FUNCTION monthly_statements_guard();
--> statement-breakpoint
-- 核对任务（阶段 7）：账单期末与流水合计不一致时开一条告警，重新生成后恢复。
ALTER TABLE system_alerts DROP CONSTRAINT system_alerts_kind_check;
--> statement-breakpoint
ALTER TABLE system_alerts ADD CONSTRAINT system_alerts_kind_check
  CHECK (kind IN ('auth_timeout', 'cdr_failed', 'email_failed', 'partition_failed', 'statement_mismatch'));
