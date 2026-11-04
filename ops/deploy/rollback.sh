#!/usr/bin/env bash
# 在服务器 B 上切回上一个已发布的 release。迁移不回滚，所以旧代码必须与已应用的
# 迁移兼容一个版本；跨大版本回滚前先读 docs/ops-runbook.md「回滚」。
#
#   ops/deploy/rollback.sh            切回当前版本之前最近的一个 release
#   ops/deploy/rollback.sh <sha>      切回指定 release
#   ops/deploy/rollback.sh --list     列出本机 release
set -euo pipefail

release_root=/opt/fs-billing/releases

usage() {
  cat <<'EOF'
用法：rollback.sh [--list | <sha> | <release 目录>]

不带参数时切回最近一个不是 current 的 release。
迁移不会回滚；请确认旧代码与新 schema 兼容。
EOF
}

fail() {
  printf '错误：%s\n' "$*" >&2
  exit 1
}

case ${1:-} in
  -h | --help)
    usage
    exit 0
    ;;
esac

[[ $EUID -eq 0 ]] || fail '必须以 root 执行'
[[ -d $release_root ]] || fail "找不到 $release_root"

current=$(readlink -f "$release_root/current" 2>/dev/null || true)

list_releases() {
  while read -r _ path; do
    suffix=''
    [[ $path == "$current" ]] && suffix=' (current)'
    printf '%s%s\n' "$path" "$suffix"
    if [[ -f $path/DEPLOYED_COMMIT ]]; then
      printf '  DEPLOYED_COMMIT=%s\n' "$(cat "$path/DEPLOYED_COMMIT")"
    fi
  done < <(
    find "$release_root" -mindepth 1 -maxdepth 1 -type d -printf '%T@ %p\n' |
      sort -rn
  )
}

case ${1:-} in
  --list)
    list_releases
    exit 0
    ;;
esac

if [[ -n ${1:-} ]]; then
  if [[ $1 == /* ]]; then
    target=$1
  else
    target=$release_root/$1
  fi
else
  [[ -n $current ]] || fail 'current 链接不存在，没有可回滚的版本'
  mapfile -t candidates < <(
    find "$release_root" -mindepth 1 -maxdepth 1 -type d -printf '%T@ %p\n' |
      sort -rn | awk '{ print $2 }'
  )
  target=''
  for candidate in "${candidates[@]}"; do
    if [[ $candidate != "$current" && -f $candidate/DEPLOYED_COMMIT ]]; then
      target=$candidate
      break
    fi
  done
  [[ -n $target ]] || fail '找不到更早的、已成功发布的 release'
fi

[[ -d $target ]] || fail "release 不存在：$target"
target=$(readlink -f "$target")
[[ $target != "$current" ]] || fail '目标就是当前 release'
[[ -f $target/apps/api/src/main.ts ]] || fail "目标不像完整 release：$target"
[[ -f $target/DEPLOYED_COMMIT ]] ||
  fail "目标没有 DEPLOYED_COMMIT，可能从未成功发布：$target"

printf '回滚：%s -> %s\n' "${current:-（无）}" "$target"
ln -sfn "$target" "$release_root/current.tmp"
mv -Tf "$release_root/current.tmp" "$release_root/current"
systemctl restart fs-billing-api fs-billing-worker

api_host=$(sed -n 's/^API_HOST=//p' /etc/fs-billing/app.env | tail -n 1)
api_port=$(sed -n 's/^API_PORT=//p' /etc/fs-billing/app.env | tail -n 1)
worker_host=$(sed -n 's/^WORKER_HOST=//p' /etc/fs-billing/app.env | tail -n 1)
worker_port=$(sed -n 's/^WORKER_PORT=//p' /etc/fs-billing/app.env | tail -n 1)
api_host=${api_host:-127.0.0.1}
api_port=${api_port:-3000}
worker_host=${worker_host:-127.0.0.1}
worker_port=${worker_port:-3001}

wait_http() {
  label=$1
  url=$2
  for _ in $(seq 1 30); do
    if curl --noproxy '*' --fail --silent --show-error --max-time 5 \
      --output /dev/null "$url" 2>/dev/null; then
      echo "健康检查通过：$label（$url）"
      return 0
    fi
    sleep 1
  done
  echo "健康检查失败：$label（$url）" >&2
  return 1
}

wait_http API "http://$api_host:$api_port/api/health"
wait_http Worker "http://$worker_host:$worker_port/health"

cat <<'EOF'
回滚完成。注意：数据库迁移没有回滚；若旧代码与新 schema 不兼容，请立即停止
服务并联系开发处理，不要继续写入。
EOF
