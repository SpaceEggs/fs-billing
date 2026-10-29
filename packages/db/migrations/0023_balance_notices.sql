SET LOCAL lock_timeout = '5s';
--> statement-breakpoint
-- 余额提醒与停机通知（阶段 9 PR 3，设计「余额提醒与停机通知」、决定 24–30）。
-- 判定放在 tenant_balances 的触发器里：与流水同一事务、同一把租户锁，所有改变余额的路径（Worker 扣费、充值、赠送、调账、
-- 分配补扣费、rebuild_tenant_balances）都覆盖。触发器直接把邮件写进 email_outbox（0021），由 Worker 分发。
-- 本迁移自包含：只依赖 0000（tenants、tenant_balances、balance_alert_settings）与 0021（email_outbox），不依赖 alert_settings。

-- 每个租户一行：low_active = true 表示「已为这一轮低余额发过通知，回到阈值之上之前不再发」，
-- suspended_active 同理（可用额度 余额 + 透支额度 <= 0）。*_seq 是已入队的通知序号，用来拼发件箱的幂等键。
CREATE TABLE balance_notice_state (
  tenant_id uuid PRIMARY KEY REFERENCES tenants,
  low_active boolean NOT NULL DEFAULT false,
  low_seq integer NOT NULL DEFAULT 0 CHECK (low_seq >= 0),
  suspended_active boolean NOT NULL DEFAULT false,
  suspended_seq integer NOT NULL DEFAULT 0 CHECK (suspended_seq >= 0),
  updated_at timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
ALTER TABLE balance_notice_state ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY staff_only ON balance_notice_state
  USING (app_is_operator()) WITH CHECK (app_is_operator());
--> statement-breakpoint
-- 状态只由下面的 SECURITY DEFINER 函数写；应用角色只读（排查用）。
GRANT SELECT ON balance_notice_state TO fs_billing_app;
--> statement-breakpoint
-- 收件人规范化：去空白、小写、去重（保持首次出现的顺序），只留单个纯邮箱地址（正则与 zod 的 z.email() 默认规则一致）。
-- 带逗号、显示名、尖括号、空格的条目丢弃，不抛错：触发器和余额变动在同一事务，抛错会回滚扣费（决定 26：状态照常前进）。
-- 租户设置保存时本来就按同一规则校验；这里是对手工改库、旧数据的兜底。
CREATE FUNCTION balance_notice_recipients(emails text[]) RETURNS text[]
LANGUAGE sql IMMUTABLE SET search_path = pg_catalog, pg_temp AS $$
  SELECT coalesce(array_agg(addr ORDER BY first_seen), ARRAY[]::text[])
  FROM (
    SELECT lower(btrim(entry, E' \t\r\n')) AS addr, min(ord) AS first_seen
    FROM unnest(emails) WITH ORDINALITY AS u(entry, ord)
    WHERE lower(btrim(entry, E' \t\r\n')) ~ '^(?!\.)(?!.*\.\.)([a-z0-9_''+\-\.]*)[a-z0-9_+-]@([a-z0-9][a-z0-9\-]*\.)+[a-z]{2,}$'
    GROUP BY 1
  ) valid
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION balance_notice_recipients(text[]) FROM PUBLIC;
--> statement-breakpoint
-- 把一条余额通知写进发件箱。收件人取租户当前的通知邮箱快照（决定 25：只发租户，不抄送管理员）；
-- 停用租户（决定 27）、没有收件人（决定 26）入队为 skipped，状态机照常前进。
-- 金额一律转成字符串（模板用 moneyAmountSchema 校验，jsonb 数字会被拒绝）；params 形状见 packages/shared 的
-- balanceLowParamsSchema / balanceSuspendedParamsSchema（strict，不能多也不能少字段）。
-- 幂等键 balance_low:<租户>:<序号> / balance_suspended:<租户>:<序号>，ON CONFLICT DO NOTHING。
CREATE FUNCTION enqueue_balance_notice(
  p_tenant_id uuid, p_template text, p_seq integer, p_balance numeric, p_threshold numeric
) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  tenant record;
  configured text[];
  recipients text[];
  skip text;
  params jsonb;
BEGIN
  SELECT t.code, t.name, t.currency, t.status, t.overdraft_limit INTO tenant
  FROM tenants t WHERE t.id = p_tenant_id;
  SELECT s.emails INTO configured FROM balance_alert_settings s WHERE s.tenant_id = p_tenant_id;
  configured := coalesce(configured, ARRAY[]::text[]);
  recipients := balance_notice_recipients(configured);
  skip := CASE
    WHEN tenant.status = 'disabled' THEN 'tenant_disabled'
    WHEN cardinality(recipients) > 0 THEN NULL
    WHEN EXISTS (SELECT 1 FROM unnest(configured) AS c(entry) WHERE btrim(entry, E' \t\r\n') <> '') THEN 'invalid_recipients'
    ELSE 'no_recipients'
  END;
  params := jsonb_build_object(
    'tenantCode', tenant.code,
    'tenantName', tenant.name,
    'currency', tenant.currency,
    'balance', p_balance::text,
    'overdraftLimit', tenant.overdraft_limit::text
  );
  IF p_template = 'balance_low' THEN
    params := params || jsonb_build_object(
      'threshold', p_threshold::text,
      'available', (p_balance + tenant.overdraft_limit)::text
    );
  END IF;
  INSERT INTO email_outbox (dedupe_key, template, params, recipients, tenant_id, status, skip_reason)
  VALUES (
    p_template || ':' || p_tenant_id::text || ':' || p_seq::text,
    p_template, params, recipients, p_tenant_id,
    CASE WHEN skip IS NULL THEN 'pending' ELSE 'skipped' END, skip
  )
  ON CONFLICT (dedupe_key) DO NOTHING;
END $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION enqueue_balance_notice(uuid, text, integer, numeric, numeric) FROM PUBLIC;
--> statement-breakpoint
-- tenant_balances 的余额变化触发器（热路径，扣费每笔都会走到这里）：一条三表主键连接读出阈值、透支额度、状态，
-- 状态没变就结束（不写任何东西）；只有越线时才写状态和发件箱。
--   低余额线：阈值 T > 0 且 余额 < T（T = 0 表示不提醒，决定 24；余额恰好等于 T 不触发）
--   停机线：  余额 + 透支额度 <= 0（决定 30：只看这一条，不看「一分钟的费用」）
-- 通知 = 从线上到线下的那一次；回到线上只重新上膛，不发邮件。同一次变化同时越过两条线只发停机通知（决定 28），
-- 低余额视为已触发（low_active 置真，low_seq 不加）。
-- 调用时已持租户锁（流水触发器要求），rebuild_tenant_balances 只持余额行锁——UPDATE 本身已锁住这一行，
-- 所以同一租户的判定互相串行，状态行不需要额外的锁。
-- 租户没有状态行（旧数据、手工插入的租户）时，把变化前的余额当作「上一次状态」来推，补写状态行。
CREATE FUNCTION tenant_balances_notice() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  ctx record;
  v_threshold numeric;
  v_low_prev boolean;
  v_susp_prev boolean;
  v_low_now boolean;
  v_susp_now boolean;
  v_fire_susp boolean;
  v_fire_low boolean;
  v_low_seq integer;
  v_susp_seq integer;
BEGIN
  SELECT t.overdraft_limit AS overdraft, coalesce(s.threshold, 0) AS threshold,
         n.tenant_id IS NOT NULL AS has_state,
         n.low_active, n.low_seq, n.suspended_active, n.suspended_seq
    INTO ctx
  FROM tenants t
  LEFT JOIN balance_alert_settings s ON s.tenant_id = t.id
  LEFT JOIN balance_notice_state n ON n.tenant_id = t.id
  WHERE t.id = NEW.tenant_id;
  IF NOT FOUND THEN
    RETURN NULL;
  END IF;
  v_threshold := ctx.threshold;
  v_low_now := v_threshold > 0 AND NEW.balance < v_threshold;
  v_susp_now := NEW.balance + ctx.overdraft <= 0;
  IF ctx.has_state THEN
    v_low_prev := ctx.low_active;
    v_susp_prev := ctx.suspended_active;
    IF v_low_prev = v_low_now AND v_susp_prev = v_susp_now THEN
      RETURN NULL;
    END IF;
  ELSE
    v_low_prev := v_threshold > 0 AND OLD.balance < v_threshold;
    v_susp_prev := OLD.balance + ctx.overdraft <= 0;
  END IF;
  v_fire_susp := v_susp_now AND NOT v_susp_prev;
  v_fire_low := v_low_now AND NOT v_low_prev AND NOT v_fire_susp;
  v_low_seq := coalesce(ctx.low_seq, 0) + CASE WHEN v_fire_low THEN 1 ELSE 0 END;
  v_susp_seq := coalesce(ctx.suspended_seq, 0) + CASE WHEN v_fire_susp THEN 1 ELSE 0 END;
  INSERT INTO balance_notice_state (tenant_id, low_active, low_seq, suspended_active, suspended_seq, updated_at)
  VALUES (NEW.tenant_id, v_low_now, v_low_seq, v_susp_now, v_susp_seq, now())
  ON CONFLICT (tenant_id) DO UPDATE SET
    low_active = EXCLUDED.low_active, low_seq = EXCLUDED.low_seq,
    suspended_active = EXCLUDED.suspended_active, suspended_seq = EXCLUDED.suspended_seq,
    updated_at = EXCLUDED.updated_at;
  IF v_fire_susp THEN
    PERFORM enqueue_balance_notice(NEW.tenant_id, 'balance_suspended', v_susp_seq, NEW.balance, v_threshold);
  ELSIF v_fire_low THEN
    PERFORM enqueue_balance_notice(NEW.tenant_id, 'balance_low', v_low_seq, NEW.balance, v_threshold);
  END IF;
  RETURN NULL;
END $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION tenant_balances_notice() FROM PUBLIC;
--> statement-breakpoint
-- 新建租户：状态行随租户创建，按余额 0 初始化（不因为余额 0 而在开户当刻发邮件）。此时还没有提醒设置，
-- 所以 low_active 先为假；createTenant 写完设置后调用 sync_balance_notice_state 补齐。
CREATE FUNCTION tenants_open_balance_notice() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  INSERT INTO balance_notice_state (tenant_id, suspended_active)
  VALUES (NEW.id, NEW.overdraft_limit <= 0)
  ON CONFLICT (tenant_id) DO NOTHING;
  RETURN NULL;
END $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION tenants_open_balance_notice() FROM PUBLIC;
--> statement-breakpoint
-- 阈值或透支额度被改（设置保存）时调用，决定 29：按当前余额重新算 low_active、suspended_active，**不发邮件**，
-- 序号不动。保存设置的事务已持租户锁；这里再锁住余额行，与只持余额行锁的 rebuild_tenant_balances 串行。
-- 应用角色可以调用，所以要求管理员或系统身份（状态表的 RLS 对 SECURITY DEFINER 函数不起作用）。
CREATE FUNCTION sync_balance_notice_state(p_tenant_id uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  current_balance numeric;
  overdraft numeric;
  threshold numeric;
BEGIN
  IF NOT app_is_operator() THEN
    RAISE EXCEPTION '同步余额通知状态只允许管理员或系统身份' USING ERRCODE = 'insufficient_privilege';
  END IF;
  SELECT b.balance INTO current_balance FROM tenant_balances b WHERE b.tenant_id = p_tenant_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION '租户 % 不存在', p_tenant_id USING ERRCODE = 'no_data_found';
  END IF;
  SELECT t.overdraft_limit, coalesce(s.threshold, 0) INTO overdraft, threshold
  FROM tenants t LEFT JOIN balance_alert_settings s ON s.tenant_id = t.id
  WHERE t.id = p_tenant_id;
  INSERT INTO balance_notice_state (tenant_id, low_active, suspended_active, updated_at)
  VALUES (p_tenant_id, threshold > 0 AND current_balance < threshold, current_balance + overdraft <= 0, now())
  ON CONFLICT (tenant_id) DO UPDATE SET
    low_active = EXCLUDED.low_active, suspended_active = EXCLUDED.suspended_active,
    updated_at = EXCLUDED.updated_at;
END $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION sync_balance_notice_state(uuid) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION sync_balance_notice_state(uuid) TO fs_billing_app;
--> statement-breakpoint
-- 先建触发器：CREATE TRIGGER 对 tenant_balances 取 SHARE ROW EXCLUSIVE，等在途的写入提交并挡住新的写入，
-- 直到本迁移提交；下面的回填因此读到的是定格的余额，不会漏掉回填与触发器之间的变化。
CREATE TRIGGER tenant_balances_notice AFTER UPDATE OF balance ON tenant_balances
  FOR EACH ROW WHEN (OLD.balance IS DISTINCT FROM NEW.balance)
  EXECUTE FUNCTION tenant_balances_notice();
--> statement-breakpoint
CREATE TRIGGER tenants_open_balance_notice AFTER INSERT ON tenants
  FOR EACH ROW EXECUTE FUNCTION tenants_open_balance_notice();
--> statement-breakpoint
-- 回填：已有租户按当前余额静默初始化状态（决定 29）。升级当天已经低于阈值、已停机的租户 low_active /
-- suspended_active 取真，所以不会收到补发邮件；回填不写 email_outbox。
INSERT INTO balance_notice_state (tenant_id, low_active, suspended_active)
SELECT t.id,
  coalesce(s.threshold, 0) > 0 AND coalesce(b.balance, 0) < coalesce(s.threshold, 0),
  coalesce(b.balance, 0) + t.overdraft_limit <= 0
FROM tenants t
LEFT JOIN balance_alert_settings s ON s.tenant_id = t.id
LEFT JOIN tenant_balances b ON b.tenant_id = t.id
ON CONFLICT (tenant_id) DO NOTHING;
