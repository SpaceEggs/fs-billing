-- 阶段 2 验收查询。以应用角色执行，预期中的报错会原样打印：
--   psql "$APP_DATABASE_URL" -X -f docs/evidence/phase-2/acceptance.sql
-- 所有写操作都在 ROLLBACK 的事务里，不改变库中数据。
\set ON_ERROR_STOP 0
\set ON_ERROR_ROLLBACK on
\pset footer off

BEGIN;
SET LOCAL app.scope = 'admin';
SELECT id AS abc001 FROM tenants WHERE code = 'ABC001' \gset
SELECT id AS gzt007 FROM tenants WHERE code = 'GZT007' \gset
COMMIT;

\echo '== 应用角色'
SELECT current_user, rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user;

\echo '== 余额流水 UPDATE / DELETE'
BEGIN;
SET LOCAL app.scope = 'admin';
UPDATE ledger_entries SET amount = 0;
ROLLBACK;
BEGIN;
SET LOCAL app.scope = 'admin';
DELETE FROM ledger_entries;
ROLLBACK;

\echo '== 以 ABC001 身份 SELECT * FROM cdrs（SQL 中没有租户条件）'
BEGIN;
SET LOCAL app.scope = 'tenant';
SELECT set_config('app.tenant_id', :'abc001', true) IS NOT NULL AS tenant_set;
SELECT * FROM cdrs ORDER BY started_at;
SELECT count(*) AS cdrs, count(DISTINCT tenant_id) AS tenants FROM cdrs;

\echo '== ABC001 余额（流水合计与缓存）'
SELECT sum(amount) AS ledger_total, count(*) AS entries FROM ledger_entries;
SELECT balance FROM tenant_balances;
ROLLBACK;

\echo '== 未声明身份'
SELECT (SELECT count(*) FROM cdrs) AS cdrs, (SELECT count(*) FROM ledger_entries) AS ledger;

\echo '== 同一 UUID 插入两次'
BEGIN;
SET LOCAL app.scope = 'admin';
INSERT INTO cdrs (tenant_id, call_uuid, started_at, ended_at, caller, callee)
VALUES (:'abc001', 'e0000000-0000-4000-8000-000000000001', now(), now(), '075586001234', '8613800138000');
INSERT INTO cdrs (tenant_id, call_uuid, started_at, ended_at, caller, callee)
VALUES (:'abc001', 'e0000000-0000-4000-8000-000000000001', now(), now(), '075586001234', '8613800138000');
ROLLBACK;

\echo '== 未归属与正式话单共用 UUID 登记表'
BEGIN;
SET LOCAL app.scope = 'admin';
INSERT INTO unassigned_cdrs (tenant_tag, call_uuid, reason, started_at, ended_at, caller, callee)
VALUES ('ABC01', 'e0000000-0000-4000-8000-000000000003', '找不到租户',
        '2026-10-12 11:00:00+08', '2026-10-12 11:00:30+08', '075586001299', '6591234567');
\echo '-- 分配给 ABC001：认领未归属的登记'
INSERT INTO cdrs (tenant_id, call_uuid, started_at, ended_at, caller, callee)
VALUES (:'abc001', 'e0000000-0000-4000-8000-000000000003',
        '2026-10-12 11:00:00+08', '2026-10-12 11:00:30+08', '075586001299', '6591234567');
\echo '-- 同一 UUID 再给 GZT007'
INSERT INTO cdrs (tenant_id, call_uuid, started_at, ended_at, caller, callee)
VALUES (:'gzt007', 'e0000000-0000-4000-8000-000000000003',
        '2026-10-12 11:00:00+08', '2026-10-12 11:00:30+08', '075586001299', '6591234567');
\echo '-- 已在正式话单中的 UUID 再进未归属话单'
INSERT INTO unassigned_cdrs (tenant_tag, call_uuid, reason, started_at, ended_at, caller, callee)
VALUES ('ABC01', 'a0000001-0000-4000-8000-000000000001', '找不到租户',
        '2026-09-28 14:03:10+08', '2026-09-28 14:07:12+08', '075586001234', '447700900123');
ROLLBACK;

\echo '== 流水发生时间'
BEGIN;
SET LOCAL app.scope = 'admin';
\echo '-- 种子中 ABC001 按 occurred_at 的北京月份汇总通话扣费'
SELECT to_char(occurred_at AT TIME ZONE 'Asia/Shanghai', 'YYYY-MM') AS month,
       sum(amount) AS call_charges, count(*) AS entries
FROM ledger_entries WHERE tenant_id = :'abc001' AND kind = 'call_charge' GROUP BY 1 ORDER BY 1;
\echo '-- 应用角色回填 created_at 的人工调账被拒绝'
INSERT INTO ledger_entries (tenant_id, kind, amount, note, created_by, idempotency_key, occurred_at, created_at)
SELECT :'abc001', 'adjustment', -1, '倒填', id, 'adjust-backfill',
       '2026-09-01 00:00:00+08', '2026-09-01 00:00:00+08'
FROM admins WHERE email = 'lijun@example.com';
\echo '-- 人工操作倒填发生时间'
INSERT INTO ledger_entries (tenant_id, kind, amount, created_by, idempotency_key, occurred_at)
SELECT :'abc001', 'recharge', 100, id, 'recharge-backdated', '2026-09-30 12:00:00+08'
FROM admins WHERE email = 'lijun@example.com';
ROLLBACK;

\echo '== 原始话单：原文逐字节保存（空白、键序、重复键），payload 为规范化副本'
BEGIN;
SET LOCAL app.scope = 'admin';
INSERT INTO raw_cdrs (body, received_at)
VALUES (E'{ "variables" : {"uuid":"7f1c2a9e-0d3b-4c5e-8a6f-1b2c3d4e5f60",\n  "billsec":"230",  "billsec":"231"},\t"z":1, "a":[ 1 ,2 ] }\n',
        '2026-10-31 23:59:59+08')
RETURNING tableoid::regclass AS partition,
          body = E'{ "variables" : {"uuid":"7f1c2a9e-0d3b-4c5e-8a6f-1b2c3d4e5f60",\n  "billsec":"230",  "billsec":"231"},\t"z":1, "a":[ 1 ,2 ] }\n' AS body_identical,
          octet_length(body) AS bytes, payload;
\echo '-- 不是合法 JSON 的原文也保存，payload 为空'
INSERT INTO raw_cdrs (body, received_at) VALUES ('{"uuid": "truncated', '2026-11-01 00:00:00+08')
RETURNING tableoid::regclass AS partition, body, payload IS NULL AS payload_null;
ROLLBACK;
\d+ raw_cdrs

\echo '== 系统告警类型含 partition_failed'
BEGIN;
SET LOCAL app.scope = 'admin';
INSERT INTO system_alerts (kind, description)
VALUES ('partition_failed', '建分区 cdrs_2026_12 失败') RETURNING kind, description;
INSERT INTO system_alerts (kind, description) VALUES ('disk_full', '未定义的类型');
ROLLBACK;

\echo '== 下月分区：迁移已建出当月与下月，下月话单直接落入分区；下月的每日任务再建出其后一个月'
BEGIN;
SET LOCAL app.scope = 'admin';
INSERT INTO cdrs (tenant_id, call_uuid, started_at, ended_at, caller, callee)
VALUES (:'abc001', 'e0000000-0000-4000-8000-000000000002',
        (date_trunc('month', now() AT TIME ZONE 'Asia/Shanghai') + interval '1 month 1 hour') AT TIME ZONE 'Asia/Shanghai',
        (date_trunc('month', now() AT TIME ZONE 'Asia/Shanghai') + interval '1 month 1 hour') AT TIME ZONE 'Asia/Shanghai',
        '075586001234', '8613800138000')
RETURNING tableoid::regclass AS partition, started_at;
SELECT cdr_ensure_partitions(now() + interval '1 month');
\d+ cdrs
ROLLBACK;

\echo '== 费率版本：同一费率表相同生效时间'
BEGIN;
SET LOCAL app.scope = 'admin';
INSERT INTO rate_versions (tenant_id, effective_from) VALUES (:'abc001', '2026-10-01 00:00:00+08');
ROLLBACK;

\echo '== 费率版本：已排定未来版本时新建立即生效版本'
BEGIN;
SET LOCAL app.scope = 'admin';
INSERT INTO rate_versions (tenant_id, effective_from) VALUES (:'abc001', now() + interval '7 days')
RETURNING effective_from;
INSERT INTO rate_versions (tenant_id) VALUES (:'abc001');
ROLLBACK;

\echo '== 费率版本：开户后首个立即生效版本'
BEGIN;
SET LOCAL app.scope = 'admin';
WITH t AS (
  INSERT INTO tenants (code, name, currency, overdraft_limit)
  VALUES ('NEW001', '验收新开户', 'CNY', 100) RETURNING id
)
INSERT INTO rate_versions (tenant_id) SELECT id FROM t
RETURNING effective_from, effective_from <= now() AS effective_now;
ROLLBACK;
