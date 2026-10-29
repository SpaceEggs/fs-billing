SET LOCAL lock_timeout = '5s';
--> statement-breakpoint
-- 邮件发件箱（阶段 9 PR 2）：业务事务只往这里写一行「要发这封邮件」，由 Worker 定时分发。
-- 不存渲染后的正文，只存模板名和渲染所需的快照（params）；收件人是入队时的快照。
CREATE TABLE email_outbox (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  dedupe_key text NOT NULL UNIQUE CHECK (btrim(dedupe_key) <> ''),
  template text NOT NULL
    CHECK (template IN ('balance_low', 'balance_suspended', 'alert_start', 'alert_digest', 'alert_recovered', 'test')),
  params jsonb NOT NULL,
  recipients text[] NOT NULL,
  tenant_id uuid REFERENCES tenants,
  status text NOT NULL
    CHECK (status IN ('pending', 'sending', 'sent', 'failed', 'skipped')),
  skip_reason text,
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  locked_until timestamptz,
  last_error text CHECK (last_error IS NULL OR char_length(last_error) <= 300),
  accepted text[],
  rejected text[],
  created_at timestamptz NOT NULL DEFAULT now(),
  sent_at timestamptz,
  -- 跳过的邮件必须写明原因；其余状态不带原因。
  CONSTRAINT email_outbox_skip_reason_check CHECK ((status = 'skipped') = (skip_reason IS NOT NULL)),
  -- 要发的邮件必须有收件人；入队时没有收件人的记为 skipped（no_recipients）。
  CONSTRAINT email_outbox_recipients_check CHECK (status = 'skipped' OR cardinality(recipients) > 0),
  CONSTRAINT email_outbox_sent_at_check CHECK ((status = 'sent') = (sent_at IS NOT NULL))
);
--> statement-breakpoint
-- 分发器按 (status, next_attempt_at) 找到期的邮件；只有待发和发送中的行进索引。
CREATE INDEX email_outbox_due ON email_outbox (status, next_attempt_at)
  WHERE status IN ('pending', 'sending');
--> statement-breakpoint
ALTER TABLE email_outbox ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY staff_only ON email_outbox
  USING (app_is_operator()) WITH CHECK (app_is_operator());
--> statement-breakpoint
-- 应用角色没有 DELETE：清理只经下面的 SECURITY DEFINER 函数。
GRANT SELECT, INSERT, UPDATE ON email_outbox TO fs_billing_app;
--> statement-breakpoint
-- 余额类通知实际发出后，分发器在标记 sent 的同一事务里插一行 balance_alert_deliveries 并记下 outbox_id；
-- UNIQUE 保证同一封邮件只记一次。
ALTER TABLE balance_alert_deliveries
  ADD COLUMN outbox_id uuid UNIQUE REFERENCES email_outbox;
--> statement-breakpoint
-- 清理满 180 天的已结束行（sent、failed、skipped），避免收件人地址在发件箱里长期堆积（决定 6）。
-- balance_alert_deliveries 只增不改（触发器拒绝 UPDATE/DELETE），外键又不能悬空，所以被它引用的发件箱行不清理：
-- 这些行的收件人本来就永久保存在 balance_alert_deliveries.recipients 里。返回删除的行数。
CREATE FUNCTION email_outbox_purge() RETURNS bigint
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  removed bigint;
BEGIN
  IF NOT app_is_operator() THEN
    RAISE EXCEPTION '清理发件箱只允许管理员或系统身份' USING ERRCODE = 'insufficient_privilege';
  END IF;
  DELETE FROM email_outbox o
  WHERE o.status IN ('sent', 'failed', 'skipped')
    AND coalesce(o.sent_at, o.created_at) < now() - interval '180 days'
    AND NOT EXISTS (SELECT 1 FROM balance_alert_deliveries d WHERE d.outbox_id = o.id);
  GET DIAGNOSTICS removed = ROW_COUNT;
  RETURN removed;
END $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION email_outbox_purge() FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION email_outbox_purge() TO fs_billing_app;
