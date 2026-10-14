\set ON_ERROR_STOP on
BEGIN;
SELECT set_config('app.scope', 'admin', true);
SELECT lock_tenants(ARRAY[]::uuid[]);
INSERT INTO admins(email, name) VALUES ('fsi@example.invalid', 'FreeSWITCH 集成验证')
ON CONFLICT(email) DO NOTHING;
INSERT INTO tenants(code, name, currency, status, overdraft_limit)
VALUES ('FSIOK', 'FreeSWITCH 放行验证', 'CNY', 'active', 0),
       ('FSIOFF', 'FreeSWITCH 停用验证', 'CNY', 'disabled', 0),
       ('FSILOW', 'FreeSWITCH 余额验证', 'CNY', 'active', 0),
       ('FSI60', 'FreeSWITCH 限时验证', 'CNY', 'active', 0)
ON CONFLICT(code) DO NOTHING;
COMMIT;

BEGIN;
SELECT set_config('app.scope', 'admin', true);
SELECT lock_tenants(ARRAY(SELECT id FROM tenants WHERE code IN ('FSIOK','FSIOFF','FSILOW','FSI60') ORDER BY id));
UPDATE tenants SET status = CASE WHEN code = 'FSIOFF' THEN 'disabled' ELSE 'active' END,
    overdraft_limit = 0 WHERE code IN ('FSIOK','FSIOFF','FSILOW','FSI60');
INSERT INTO rate_versions(tenant_id, effective_from)
SELECT id, CURRENT_TIMESTAMP FROM tenants WHERE code IN ('FSIOK','FSIOFF','FSILOW','FSI60')
ON CONFLICT(tenant_id,effective_from) DO NOTHING;
INSERT INTO rate_entries(tenant_id,rate_version_id,prefix,country,rate)
SELECT v.tenant_id,v.id,r.prefix,r.country,r.rate FROM rate_versions v JOIN tenants t ON t.id=v.tenant_id
CROSS JOIN (VALUES ('44','英国集成测试',0.01::numeric),
                   ('1','NANP 集成测试',0.03::numeric),
                   ('8613','国内手机集成测试',0.02::numeric),
                   ('86755','国内固话集成测试',0.04::numeric),
                   ('861305','无国际前缀集成测试',0.05::numeric)) r(prefix,country,rate)
WHERE t.code IN ('FSIOK','FSIOFF','FSILOW','FSI60') AND v.effective_from=CURRENT_TIMESTAMP
ON CONFLICT(rate_version_id,prefix) DO NOTHING;
-- 余额由追加调整流水恢复，保留以往话单和账本，不直接覆写余额投影。
INSERT INTO ledger_entries(tenant_id,kind,amount,note,created_by,idempotency_key)
SELECT t.id,'adjustment', target.amount-b.balance,'集成验证恢复测试余额',a.id,
       'fsi-reset:' || :'run_id' || ':' || t.code
FROM tenants t JOIN tenant_balances b ON b.tenant_id=t.id
JOIN (VALUES ('FSIOK',100::numeric),('FSIOFF',100::numeric),('FSILOW',0::numeric),('FSI60',0.01::numeric)) target(code,amount)
ON target.code=t.code CROSS JOIN admins a
WHERE a.email='fsi@example.invalid' AND target.amount<>b.balance
ON CONFLICT(tenant_id,idempotency_key) DO NOTHING;
COMMIT;
