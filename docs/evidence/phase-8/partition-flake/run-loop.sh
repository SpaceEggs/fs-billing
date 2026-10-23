#!/bin/bash
# 重复运行一个数据库测试文件（或整套），逐次记录目标测试「启动维护立即建分区」的结果。
# 用法：run-loop.sh <仓库目录> <输出目录> <次数> [测试文件，缺省为整套 test:db]
# 前提：docker compose 里的 PostgreSQL 已启动；每次运行都在全新的 fs_billing_test 库上进行（global-setup）。
# 同一个库名，所以不能和另一份 pnpm test:db 同时运行。
REPO=$1
OUT=$2
RUNS=$3
FILE=${4:-}
HERE=$(cd "$(dirname "$0")" && pwd)
mkdir -p "$OUT"
cd "$REPO" || exit 1
: > "$OUT/summary.tsv"
for i in $(seq 1 "$RUNS"); do
  npx vitest run --config vitest.db.config.ts $FILE \
    --reporter=json --outputFile="$OUT/run-$i.json" > "$OUT/run-$i.out" 2>&1
  code=$?
  node "$HERE/summarize.mjs" "$OUT/run-$i.json" "$i" "$code" >> "$OUT/summary.tsv"
done
echo done > "$OUT/DONE"
