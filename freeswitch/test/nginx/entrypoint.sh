#!/bin/sh
set +x
set -eu
: "${WORKER_SHARED_KEY:?缺少 WORKER_SHARED_KEY}"
# 密钥只允许不会改变 nginx 引号语义的字符。
case "$WORKER_SHARED_KEY" in
    *[!A-Za-z0-9._=/+-]*) echo 'WORKER_SHARED_KEY 含不支持的字符' >&2; exit 1 ;;
esac
rm -f /etc/nginx/conf.d/default.conf
umask 077
envsubst '${WORKER_SHARED_KEY}' < /templates/billing-cdr.conf.template > /etc/nginx/conf.d/billing-cdr.conf
exec nginx -g 'daemon off;'
