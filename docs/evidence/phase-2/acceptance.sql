-- 阶段 2 验收查询。以应用角色执行，预期中的报错会原样打印：
--   psql "$APP_DATABASE_URL" -X -f docs/evidence/phase-2/acceptance.sql
-- 所有写操作都在 ROLLBACK 的事务里，不改变库中数据。
\set ON_ERROR_STOP 0
\pset footer off

BEGIN;
SET LOCAL app.scope = 'admin';
SELECT id AS abc001 FROM tenants WHERE code = 'ABC001' \gset
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
