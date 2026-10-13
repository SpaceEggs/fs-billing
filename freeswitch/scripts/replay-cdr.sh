#!/bin/sh
# mod_json_cdr 重试耗尽后不会扫描落盘文件；由 cron 每分钟调用本脚本。
set -eu
retry_dir=${1:-/var/lib/freeswitch/cdr/retry}
relay_url=${2:-http://127.0.0.1:3002/cdr}

for file in "$retry_dir"/*.cdr.json; do
    [ -f "$file" ] || continue
    # 避开刚开始写入的文件；完整落盘后再读，避免模块写到一半就被重推。
    [ -n "$(find "$file" -mmin +1 -print)" ] || continue
    # 2xx 表示 Worker 已保存。失败保留原文；并发或崩溃重推由 UUID 闸门保证不重扣。
    if status=$(curl --noproxy '*' --silent --show-error --max-time 15 \
        --output /dev/null --write-out '%{http_code}' \
        --header 'Content-Type: application/json' --data-binary "@$file" "$relay_url"); then
        case "$status" in
            2??) rm -- "$file" ;;
            *) printf '话单重推失败 HTTP %s: %s\n' "$status" "$file" >&2 ;;
        esac
    else
        printf '话单重推无响应: %s\n' "$file" >&2
    fi
done
