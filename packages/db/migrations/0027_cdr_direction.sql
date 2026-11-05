SET LOCAL lock_timeout = '5s';
--> statement-breakpoint
-- 呼入话单（docs/inbound-cdr-design.md）：老话单都是呼出，默认值保证升级时无需回填。
-- 缺失或无法识别的 billing_direction 由 Worker 按呼出处理，与旧 FreeSWITCH 配置兼容。
-- IF NOT EXISTS 让历史回填测试可以先手动补列再跑完整迁移；正常部署不会命中已存在分支。
ALTER TABLE cdrs ADD COLUMN IF NOT EXISTS direction text NOT NULL DEFAULT 'outbound'
  CHECK (direction IN ('outbound', 'inbound'));
--> statement-breakpoint
-- 只有呼出接通话单需要国家、前缀和费率快照；呼入暂时不收费，接通话单的计费分钟与费用必须为 0。
-- 未接通的两种方向都保持零时长、零计费分钟、零费用。
ALTER TABLE cdrs DROP CONSTRAINT IF EXISTS cdrs_answered_shape;
--> statement-breakpoint
-- 未归属待办也保留方向：未知租户的呼入之后被分配时仍按呼入入库，不会补扣费。
ALTER TABLE unassigned_cdrs ADD COLUMN IF NOT EXISTS direction text NOT NULL DEFAULT 'outbound'
  CHECK (direction IN ('outbound', 'inbound'));
--> statement-breakpoint
ALTER TABLE cdrs ADD CONSTRAINT cdrs_answered_shape CHECK (
  CASE WHEN answered_at IS NULL
    THEN duration_seconds = 0 AND billed_minutes = 0 AND charge = 0
    ELSE answered_at >= started_at AND answered_at <= ended_at
      AND (
        direction = 'inbound'
        OR (matched_prefix IS NOT NULL AND country IS NOT NULL AND rate IS NOT NULL)
      )
      AND (direction = 'outbound' OR (charge = 0 AND billed_minutes = 0))
  END
);
