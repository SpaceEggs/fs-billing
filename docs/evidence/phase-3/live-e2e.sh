#!/usr/bin/env bash
# 验证脚本（非业务代码）：真实启动 worker 进程，curl 打接口，psql 查库
set -u
cd /workspace/fs-billing
export WORKER_SHARED_KEY=verify-key-0123456789abcdef WORKER_ALLOWED_IPS=127.0.0.1 WORKER_PORT=3901
K=$WORKER_SHARED_KEY; U=http://127.0.0.1:3901
Q(){ docker exec fs-billing-postgres-1 psql -U fs_billing -tAc "$1"; }
start(){ (cd apps/worker && exec node --import tsx --env-file-if-exists=../../.env src/main.ts) >>/tmp/worker-live.log 2>&1 & WP=$!; for i in $(seq 50); do curl -s -o /dev/null $U/authorize && break; sleep 0.3; done; }
mk(){ python3 - "$@" <<'PY'
import json,sys,uuid
d=json.load(open('freeswitch/examples/sample-cdr.json')); v=d['variables']
v['uuid']=sys.argv[1]; d['core-uuid']=d.get('core-uuid')
for kv in sys.argv[2:]:
  k,val=kv.split('=',1); v[k]=val
open('/tmp/cdr-%s.json'%sys.argv[1],'w').write(json.dumps(d))
PY
}
post(){ curl -s -o /dev/null -w "%{http_code}" -H "x-billing-key: $K" -H 'content-type: application/json' --data-binary @/tmp/cdr-$1.json $U/cdr; }
echo "API 进程: $(pgrep -af 'apps/api' | grep -v pgrep || echo 无（API 未运行）)"
start; echo "worker pid $WP"
BAL0=$(Q "select coalesce(sum(amount),0) from ledger_entries l join tenants t on t.id=l.tenant_id where t.code='ABC001'")
A=$(python3 -c "import uuid;print(uuid.uuid4())"); mk $A
echo "[1] 同一话单 POST 两次: $(post $A) $(post $A)"; sleep 4
echo "    raw_cdrs=$(Q "select count(*) from raw_cdrs where body like '%$A%'") cdrs=$(Q "select count(*) from cdrs where call_uuid='$A'") ledger=$(Q "select count(*) from ledger_entries where idempotency_key like '%$A%'")"
echo "    cdr: $(Q "select charge,unverified,answered_at from cdrs where call_uuid='$A'")  ledger: $(Q "select kind,amount,occurred_at from ledger_entries where idempotency_key like '%$A%'")"
BAL1=$(Q "select coalesce(sum(amount),0) from ledger_entries l join tenants t on t.id=l.tenant_id where t.code='ABC001'"); echo "    余额变化 $BAL0 -> $BAL1"
echo "[4] 无密钥: $(curl -s -o /dev/null -w %{http_code} -H 'content-type: application/json' -d '{}' $U/cdr)  错密钥: $(curl -s -o /dev/null -w %{http_code} -H 'x-billing-key: wrong-wrong-wrong-wrong' -H 'content-type: application/json' -d '{}' $U/authorize)"
B=$(python3 -c "import uuid;print(uuid.uuid4())"); mk $B billing_tenant=ABC01
echo "[5] ABC01: $(post $B)"; sleep 3
echo "    unassigned: $(Q "select tenant_tag,reason,status from unassigned_cdrs where call_uuid='$B'")  ledger=$(Q "select count(*) from ledger_entries where idempotency_key like '%$B%'")"
echo "[10] 授权 +44 / 0044 / 44abc:"
for n in '+447700900123' '00447700900123' '44abc'; do echo "    $n -> $(curl -s -w ' %{http_code}' -H "x-billing-key: $K" -H 'content-type: application/json' -d "{\"tenant\":\"ABC001\",\"callee\":\"$n\",\"uuid\":\"$(python3 -c "import uuid;print(uuid.uuid4())")\"}" $U/authorize)"; done
echo "    正常 447700900123 -> $(curl -s -w ' %{http_code}' -H "x-billing-key: $K" -H 'content-type: application/json' -d "{\"tenant\":\"ABC001\",\"callee\":\"447700900123\",\"uuid\":\"$(python3 -c "import uuid;print(uuid.uuid4())")\"}" $U/authorize)"
C=$(python3 -c "import uuid;print(uuid.uuid4())"); mk $C destination_number=+447700900123
echo "    话单 +447700900123: HTTP $(post $C)"; sleep 3
echo "    unassigned: $(Q "select reason,status from unassigned_cdrs where call_uuid='$C'") ledger=$(Q "select count(*) from ledger_entries where idempotency_key like '%$C%'") alerts: $(Q "select kind from system_alerts where description like '%$C%' limit 3")"
D=$(python3 -c "import uuid;print(uuid.uuid4())"); mk $D
echo "[7] POST 后立即 kill -9 worker: $(post $D)"; kill -9 $WP; wait $WP 2>/dev/null
echo "    杀后: cdrs=$(Q "select count(*) from cdrs where call_uuid='$D'") ledger=$(Q "select count(*) from ledger_entries where idempotency_key like '%$D%'")"
start; echo "    重启 pid $WP"; post $D >/dev/null; sleep 6
echo "    重启+重推后: cdrs=$(Q "select count(*) from cdrs where call_uuid='$D'") ledger=$(Q "select count(*) from ledger_entries where idempotency_key like '%$D%'")"
kill $WP; wait $WP 2>/dev/null
WORKER_ALLOWED_IPS=127.0.0.2; export WORKER_ALLOWED_IPS; start
echo "[4] 白名单 127.0.0.2，自 127.0.0.1 带正确密钥: $(curl -s -o /dev/null -w %{http_code} -H "x-billing-key: $K" -H 'content-type: application/json' -d '{}' $U/authorize)"
kill $WP; wait $WP 2>/dev/null
