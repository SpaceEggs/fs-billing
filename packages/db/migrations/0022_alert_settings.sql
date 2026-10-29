SET LOCAL lock_timeout = '5s';
--> statement-breakpoint
-- 故障告警设置（阶段 9 PR 4）：单行表，管理员告警邮件的接收邮箱与汇总间隔 N。
-- id 是布尔主键加 CHECK (id)：只可能有一行（值为 true）。version 做乐观并发，保存带 expectedVersion。
CREATE TABLE alert_settings (
  id boolean PRIMARY KEY DEFAULT true CHECK (id),
  -- 小写、去重、最多 20 个、允许为空（空表示发给所有 active 管理员的登录邮箱，决定 33）；小写与去重由库函数保证。
  recipients text[] NOT NULL DEFAULT '{}' CHECK (cardinality(recipients) <= 20),
  -- 汇总邮件间隔（分钟），默认 15（决定 31）。
  digest_minutes integer NOT NULL DEFAULT 15 CHECK (digest_minutes BETWEEN 1 AND 1440),
  version integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid REFERENCES admins
);
--> statement-breakpoint
-- 默认行：Worker 读不到设置行时也能按默认值工作，保存只需 UPDATE。
INSERT INTO alert_settings (id) VALUES (true);
--> statement-breakpoint
ALTER TABLE alert_settings ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY staff_only ON alert_settings
  USING (app_is_operator()) WITH CHECK (app_is_operator());
--> statement-breakpoint
-- 没有 DELETE：设置行永远存在。
GRANT SELECT, INSERT, UPDATE ON alert_settings TO fs_billing_app;
--> statement-breakpoint
-- 管理员告警邮件的兜底收件人（决定 33）：接收邮箱为空时发给所有 active 管理员的登录邮箱。
-- 管理员邮箱不在 admins 表而在 auth."user"；admins 的 RLS 只放行 admin 作用域，auth.lookup_user_emails 同样只允许
-- admin 作用域，而 Worker 是 system 作用域，所以经这个 SECURITY DEFINER 函数。只返回邮箱，不返回姓名或 id。
CREATE FUNCTION alert_admin_emails() RETURNS SETOF text
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF NOT app_is_operator() THEN
    RAISE EXCEPTION '读取管理员邮箱只允许管理员或系统身份' USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN QUERY
    SELECT lower(u.email)
    FROM public.admins a
    JOIN auth."user" u ON u.id = a.auth_user_id
    WHERE a.status = 'active'
    ORDER BY lower(u.email);
END $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION alert_admin_emails() FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION alert_admin_emails() TO fs_billing_app;
--> statement-breakpoint
-- notify-tick 的恢复通知查询：已发过开始邮件、已恢复、还没发恢复邮件的告警。条件与查询里的谓词一致才会用这个索引；
-- 回填的历史告警是 notify = false，不在索引里。进行中的告警（开始、汇总查询）走 0020 的 system_alerts_open。
CREATE INDEX system_alerts_recovery_notice ON system_alerts (recovered_at)
  WHERE notify AND notified_start_at IS NOT NULL AND recovered_at IS NOT NULL AND notified_recovered_at IS NULL;
