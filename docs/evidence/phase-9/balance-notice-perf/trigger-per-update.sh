#!/bin/sh
# 触发器本身的耗时：同一事务里对 PORTALBIG 的缓存余额连续 UPDATE 20000 次（回滚，不改库），交替启用/停用触发器。
run() {
  printf '%s round %s ' "$1" "$3"
  docker exec -i fsb-p9pr3-pg psql -q -U fs_billing -d fs_billing_perf_p9pr3 -v action="$2" < /tmp/p9pr3-micro.sql 2>&1 | grep -o 'per_update_us=.*'
}
for round in 1 3 5; do
  run before disable "$round"
  run after enable "$round"
done
for round in 2 4; do
  run after enable "$round"
  run before disable "$round"
done
docker exec fsb-p9pr3-pg psql -q -U fs_billing -d fs_billing_perf_p9pr3 -c "alter table tenant_balances enable trigger tenant_balances_notice"
