#!/usr/bin/env bash
# 验证脚本（非业务代码）：DB 宕机返回 503 + 亚秒级应答时间选费率
set -u
cd /workspace/fs-billing
export WORKER_SHARED_KEY=verify-key-0123456789abcdef WORKER_ALLOWED_IPS=127.0.0.1 WORKER_PORT=3902
K=$WORKER_SHARED_KEY; U=http://127.0.0.1:3902; PG=fs-billing-postgres-1
Q(){ docker exec $PG psql -U fs_billing -tAc "$1"; }
(cd apps/worker && exec node --import tsx --env-file-if-exists=../../.env src/main.ts) >>/tmp/worker-repro.log 2>&1 & WP=$!
for i in $(seq 50); do curl -s -o /dev/null $U/authorize && break; sleep 0.3; done
S=1791774000  # 2026-10-12T03:00:00Z
mk(){ python3 - "$@" <<'PY'
import json,sys
d=json.load(open('freeswitch/examples/sample-cdr.json')); v=d['variables']
v['uuid']=sys.argv[1]
for kv in sys.argv[2:]:
  k,val=kv.split('=',1); v[k]=val
open('/tmp/cdr-%s.json'%sys.argv[1],'w').write(json.dumps(d))
PY
}
post(){ curl -s -w " HTTP %{http_code}" -H "x-billing-key: $K" -H 'content-type: application/json' --data-binary @/tmp/cdr-$1.json $U/cdr; }
echo "== A: Postgres 停机时 POST /cdr"
A=$(python3 -c "import uuid;print(uuid.uuid4())"); mk $A
docker stop $PG >/dev/null; echo "   postgres: $(docker inspect -f '{{.State.Status}}' $PG)"
echo "   /cdr -> $(post $A)"
echo "   /authorize -> $(curl -s -w ' HTTP %{http_code}' -H "x-billing-key: $K" -H 'content-type: application/json' -d "{\"tenant\":\"ABC001\",\"callee\":\"447700900123\",\"uuid\":\"$A\"}" $U/authorize)"
docker start $PG >/dev/null; for i in $(seq 60); do docker exec $PG pg_isready -U fs_billing >/dev/null 2>&1 && break; sleep 1; done
echo "   postgres: $(docker inspect -f '{{.State.Health.Status}}' $PG 2>/dev/null)"
sleep 3; echo "   重推(FreeSWITCH 重试) -> $(post $A)"; sleep 4
echo "   cdrs=$(Q "select count(*) from cdrs where call_uuid='$A'") ledger=$(Q "select count(*) from ledger_entries where idempotency_key='call:$A'")"
echo "== B: .500 费率变更后 .900 应答"
T=$(Q "select id from tenants where code='LIVE900'")
[ -z "$T" ] && T=$(Q "insert into tenants(code,name,currency,overdraft_limit) values('LIVE900','亚秒费率验证租户','CNY',100) returning id" | head -1)
if [ "$(Q "select count(*) from rate_versions where tenant_id='$T'")" = 0 ]; then
  docker exec -i $PG psql -U fs_billing -q -v ON_ERROR_STOP=1 >/dev/null <<SQL
begin;
select set_config('app.scope','admin',true);
select lock_tenants(array['$T']::uuid[]);
with v as (insert into rate_versions(tenant_id,effective_from) values('$T', to_timestamp($S)) returning id)
insert into rate_entries(tenant_id,rate_version_id,prefix,country,rate) select '$T',id,'44','英国',0.01 from v;
with v as (insert into rate_versions(tenant_id,effective_from) values('$T', to_timestamp($S) + interval '500 milliseconds') returning id)
insert into rate_entries(tenant_id,rate_version_id,prefix,country,rate) select '$T',id,'44','英国',0.99 from v;
commit;
SQL
fi
echo "   rate_versions: $(Q "select string_agg(effective_from::text||'=>'||e.rate,' ; ' order by effective_from) from rate_versions v join rate_entries e on e.rate_version_id=v.id where v.tenant_id='$T'")"
B=$(python3 -c "import uuid;print(uuid.uuid4())")
mk $B billing_tenant=LIVE900 start_epoch=$((S-9)) start_uepoch=$(((S-9)*1000000+100000)) answer_epoch=$S answer_uepoch=$((S*1000000+900000)) end_epoch=$((S+60)) end_uepoch=$(((S+60)*1000000+950000)) billsec=60 duration=69
echo "   /cdr -> $(post $B)"; sleep 5
echo "   cdr: $(Q "select rate,charge,started_at,answered_at,ended_at from cdrs where call_uuid='$B'")"
echo "   ledger: $(Q "select amount,occurred_at from ledger_entries where idempotency_key='call:$B'")"
kill $WP; wait $WP 2>/dev/null
