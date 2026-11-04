#!/usr/bin/env bash
# 防火墙验收：从外部确认 Worker/数据库/API 端口不可达；从服务器 A 确认 Worker 可达。
#
#   # 在任意外部主机（不是 B 本机）执行
#   ops/firewall/verify-ports.sh external <B 的公网地址>
#
#   # 在服务器 A 上执行；密钥从环境读取，不写在命令行
#   WORKER_SHARED_KEY='...' ops/firewall/verify-ports.sh from-a <B 的 Worker 地址>
#
# 期望：3001、5432、3000 从外部全部拒绝或超时；从 A 访问 /health 与带密钥的
# /authorize 都返回 200。authorize 用不存在的探测租户，不会写入数据。
set -euo pipefail

usage() {
  cat <<'EOF'
用法：
  verify-ports.sh external <B 的公网地址>
  verify-ports.sh from-a <B 的 Worker 地址>

from-a 需要环境变量 WORKER_SHARED_KEY（与 Worker 的配置一致）。
EOF
}

fail() {
  printf '错误：%s\n' "$*" >&2
  exit 2
}

failures=0
pass() {
  printf 'PASS\t%s\n' "$*"
}
fail_check() {
  printf 'FAIL\t%s\n' "$*" >&2
  failures=$((failures + 1))
}

# 关闭或过滤的端口在 5 秒内以拒绝/超时结束；能建立连接（含空响应、TLS 错误）都算开放。
probe_closed() {
  local host=$1 port=$2 code
  set +e
  curl --noproxy '*' --silent --output /dev/null \
    --connect-timeout 5 --max-time 5 "http://$host:$port/" 2>/dev/null
  code=$?
  set -e
  case $code in
    0) fail_check "$host:$port 可访问（期望拒绝或超时）" ;;
    7 | 28) pass "$host:$port 不可达（拒绝或超时）" ;;
    *) fail_check "$host:$port 连接返回 curl 退出码 $code，可能已开放" ;;
  esac
}

if [[ ${1:-} == -h || ${1:-} == --help ]]; then
  usage
  exit 0
fi

[[ $# -ge 2 ]] || {
  usage >&2
  exit 2
}

mode=$1
host=$2
[[ -n $host ]] || fail '地址不能为空'

case $mode in
  external)
    probe_closed "$host" 3001
    probe_closed "$host" 5432
    probe_closed "$host" 3000
    ;;
  from-a)
    key=${WORKER_SHARED_KEY:-}
    [[ -n $key ]] || fail 'from-a 需要在环境变量 WORKER_SHARED_KEY 中提供密钥'

    tmp=$(mktemp)
    header_file=$(mktemp)
    cleanup() {
      rm -f -- "$tmp" "$header_file"
    }
    trap cleanup EXIT
    umask 077
    printf 'X-Billing-Key: %s\n' "$key" >"$header_file"

    if body=$(curl --noproxy '*' --fail --silent --show-error --max-time 10 \
      "http://$host:3001/health"); then
      if [[ $body == *'"service":"worker"'* ]]; then
        pass "Worker /health 200：$body"
      else
        fail_check "Worker /health 返回了意外内容：$body"
      fi
    else
      fail_check "Worker /health 不可达：http://$host:3001/health"
    fi

    # 不存在的租户返回 HTTP 200（allowed=false），足以证明来源 IP、密钥与路由都通。
    payload='{"tenant":"VERIFYPROBE","callee":"8613800000000","dialedNumber":"13800000000","billingNumber":"8613800000000","uuid":"00000000-0000-4000-8000-000000000000"}'
    if status=$(curl --noproxy '*' --silent --show-error --max-time 10 \
      --output "$tmp" --write-out '%{http_code}' \
      --header 'Content-Type: application/json' \
      --header "@$header_file" \
      --data-binary "$payload" \
      "http://$host:3001/authorize"); then
      if [[ $status == 200 ]]; then
        pass "Worker /authorize 200（探测租户，不写入）"
      else
        fail_check "Worker /authorize 返回 HTTP $status：$(cat "$tmp")"
      fi
    else
      fail_check "Worker /authorize 不可达：http://$host:3001/authorize"
    fi
    ;;
  *)
    usage >&2
    fail "未知模式：$mode"
    ;;
esac

if ((failures > 0)); then
  printf '%d 项失败\n' "$failures" >&2
  exit 1
fi
printf '全部通过\n'
