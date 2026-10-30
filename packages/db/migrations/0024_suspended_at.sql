SET LOCAL lock_timeout = '5s';
--> statement-breakpoint
-- 已停机的历史租户时间未知，保留 NULL；此后状态越线时记录。
ALTER TABLE balance_notice_state ADD COLUMN suspended_at timestamptz;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION tenant_balances_notice() RETURNS trigger
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
  INSERT INTO balance_notice_state (tenant_id, low_active, low_seq, suspended_active, suspended_seq, suspended_at, updated_at)
  VALUES (NEW.tenant_id, v_low_now, v_low_seq, v_susp_now, v_susp_seq, CASE WHEN v_fire_susp THEN now() END, now())
  ON CONFLICT (tenant_id) DO UPDATE SET
    low_active = EXCLUDED.low_active, low_seq = EXCLUDED.low_seq,
    suspended_at = CASE WHEN balance_notice_state.suspended_active IS DISTINCT FROM EXCLUDED.suspended_active THEN CASE WHEN EXCLUDED.suspended_active THEN now() ELSE NULL END ELSE balance_notice_state.suspended_at END,
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
CREATE OR REPLACE FUNCTION sync_balance_notice_state(p_tenant_id uuid) RETURNS void
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
    low_active = EXCLUDED.low_active,
    suspended_at = CASE WHEN balance_notice_state.suspended_active IS DISTINCT FROM EXCLUDED.suspended_active THEN CASE WHEN EXCLUDED.suspended_active THEN now() ELSE NULL END ELSE balance_notice_state.suspended_at END,
    suspended_active = EXCLUDED.suspended_active,
    updated_at = EXCLUDED.updated_at;
END $$;
--> statement-breakpoint
-- 新建时可用额度为零的租户从开户时刻起停机；旧租户仍不猜测时间。
CREATE OR REPLACE FUNCTION tenants_open_balance_notice() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  INSERT INTO balance_notice_state (tenant_id, suspended_active, suspended_at)
  VALUES (NEW.id, NEW.overdraft_limit <= 0, CASE WHEN NEW.overdraft_limit <= 0 THEN now() END)
  ON CONFLICT (tenant_id) DO NOTHING;
  RETURN NULL;
END $$;
