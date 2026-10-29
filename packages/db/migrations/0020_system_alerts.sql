SET LOCAL lock_timeout = '5s';
--> statement-breakpoint
-- 告警模型（阶段 9 PR 1）：system_alerts 增加结构化身份（subject_key）、最近事件时间、事件次数，
-- 以及邮件通知的状态列（PR 2 起使用）。同一 (kind, subject_key) 同时只有一条未恢复的告警。
ALTER TABLE system_alerts
  ADD COLUMN subject_key text CHECK (subject_key IS NULL OR btrim(subject_key) <> ''),
  ADD COLUMN last_seen_at timestamptz NOT NULL DEFAULT now(),
  ADD COLUMN occurrences integer NOT NULL DEFAULT 1 CHECK (occurrences >= 1),
  ADD COLUMN notify boolean NOT NULL DEFAULT false,
  ADD COLUMN notified_start_at timestamptz,
  ADD COLUMN last_digest_at timestamptz,
  ADD COLUMN digest_cursor integer NOT NULL DEFAULT 0 CHECK (digest_cursor >= 0),
  ADD COLUMN notified_recovered_at timestamptz;
--> statement-breakpoint
-- 回填：历史告警一律不发邮件（notify = false），并标记开始与恢复都已通知；
-- last_seen_at 取 coalesce(recovered_at, started_at)。
UPDATE system_alerts SET
  last_seen_at = coalesce(recovered_at, started_at),
  notified_start_at = started_at,
  notified_recovered_at = recovered_at;
--> statement-breakpoint
-- 未恢复的月账单核对与归档告警按原来的描述前缀格式补上 subject_key，之后沿用新逻辑恢复：
--   statement_mismatch：描述以「<租户编码> <YYYY-MM> 」开头 → statement:<租户 id>:<YYYY-MM>
--   raw_archive_failed：描述以「原始话单归档 <YYYY-MM> 」开头 → archive:<YYYY-MM>
-- 同一个键若有多条未恢复的旧行（旧逻辑会把多余的恢复掉，正常不会出现），只给最早的一条键，其余保持无键，不破坏唯一索引。
-- 其余未恢复的旧行 subject_key 保持空，不参与合并和自动恢复；已恢复的旧行不回填。
WITH candidate AS (
  SELECT id, kind, started_at,
    CASE kind
      WHEN 'statement_mismatch' THEN 'statement:' || tenant_id::text || ':' ||
        substring(description FROM '^\S+ (\d{4}-\d{2}) ')
      ELSE 'archive:' || substring(description FROM '^原始话单归档 (\d{4}-\d{2}) ')
    END AS derived_key
  FROM system_alerts
  WHERE recovered_at IS NULL
    AND ((kind = 'statement_mismatch' AND tenant_id IS NOT NULL
          AND description ~ '^\S+ \d{4}-\d{2} ')
      OR (kind = 'raw_archive_failed' AND description ~ '^原始话单归档 \d{4}-\d{2} '))
), ranked AS (
  SELECT id, derived_key,
    row_number() OVER (PARTITION BY kind, derived_key ORDER BY started_at, id) AS n
  FROM candidate
)
UPDATE system_alerts a SET subject_key = r.derived_key
FROM ranked r WHERE a.id = r.id AND r.n = 1;
--> statement-breakpoint
CREATE UNIQUE INDEX system_alerts_open_subject ON system_alerts (kind, subject_key)
  WHERE recovered_at IS NULL AND subject_key IS NOT NULL;
--> statement-breakpoint
CREATE INDEX system_alerts_started_at ON system_alerts (started_at DESC);
--> statement-breakpoint
CREATE INDEX system_alerts_open ON system_alerts (recovered_at) WHERE recovered_at IS NULL;
--> statement-breakpoint
-- 未归属 / 校验失败这一族告警（unassigned:*、invalid-cdr:*）的事务级互斥。入库停放、修正稿、忽略、分配和恢复扫描
-- 先拿它再碰待处理行与告警行，避免各路径加锁顺序不一致成环。应用角色不能直接调 pg_advisory_*（0000），
-- 所以经 SECURITY DEFINER 函数；键的写法同 tenant_lock_key / 分区锁（hashtextextended('<前缀>:…', 0)）。
-- 注意 lock_tenants 要求事务里还没有别的锁：先 lock_tenants，再调本函数。
CREATE FUNCTION lock_alert_family() RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF NOT app_is_operator() THEN
    RAISE EXCEPTION '告警互斥锁只允许管理员或系统身份' USING ERRCODE = 'insufficient_privilege';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('alerts:unassigned', 0));
END $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION lock_alert_family() FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION lock_alert_family() TO fs_billing_app;
