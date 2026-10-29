#!/bin/sh
# 越线路径的耗时：同一事务里让一个小租户的余额在阈值上下来回 3000 次（每次越线入队一封、回线重新上膛），回滚，不改库。
run() {
  printf '%s round %s ' "$1" "$3"
  docker exec -i fsb-p9pr3-pg psql -q -U fs_billing -d fs_billing_perf_p9pr3 -v action="$2" < /tmp/p9pr3-cross.sql 2>&1 | grep -o 'per_crossing_pair_us=.*'
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
