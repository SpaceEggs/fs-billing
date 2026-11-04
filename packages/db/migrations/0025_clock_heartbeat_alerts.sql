SET LOCAL lock_timeout = '5s';
--> statement-breakpoint
-- 阶段 10 验收 8：时钟偏差与心跳中断接入系统告警（用户决定 3）。
-- 阈值由 Worker 的 /clock 判断，这里只放宽 system_alerts.kind 的 CHECK。
-- 警告与严重是两种独立告警：clock_skew（≥1 秒）、clock_skew_critical（≥5 秒），
-- 越过 5 秒时两条都开、各发一封开始通知（用户 2026-11-04 决定）。
ALTER TABLE system_alerts DROP CONSTRAINT system_alerts_kind_check;
--> statement-breakpoint
ALTER TABLE system_alerts ADD CONSTRAINT system_alerts_kind_check
  CHECK (kind IN ('auth_timeout', 'cdr_failed', 'email_failed', 'partition_failed', 'statement_mismatch',
    'audit_failed', 'raw_archive_failed', 'clock_skew', 'clock_skew_critical', 'fs_heartbeat'));
