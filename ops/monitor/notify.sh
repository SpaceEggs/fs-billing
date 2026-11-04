#!/usr/bin/env bash
# 运维邮件通知（阶段 10）：供 check-clock.sh、health-check.sh 与 systemd 的
# OnFailure=fs-billing-notify@%n.service 调用。
#
# 不连接应用、不访问数据库：只读 /etc/fs-billing/app.env 的 SMTP 配置与
# /etc/fs-billing/monitor.env 的收件人，所以 Worker 或 PostgreSQL 整体宕机时仍能发信。
# 用 curl 的 SMTP/SMTPS 支持，不依赖 sendmail；Debian 包 curl 已在引导脚本的安装列表里。
#
#   notify.sh --subject '主题' [--body '正文']     # 正文也可从标准输入读
#   notify.sh --unit fs-billing-backup.service     # 附带 systemctl 状态与最近日志
set -euo pipefail
umask 077

app_env=${APP_ENV_FILE:-/etc/fs-billing/app.env}
monitor_env=${MONITOR_ENV_FILE:-/etc/fs-billing/monitor.env}
unit=''
subject=''
body=''

usage() {
  cat <<'EOF'
用法：notify.sh [--unit <单元名>] [--subject <主题>] [--body <正文>]

  --unit     失败单元名；主题与正文从 systemctl status、journalctl 生成
  --subject  主题；未给 --unit 时必填
  --body     正文；未给时从标准输入读取
EOF
}

fail() {
  printf '通知失败：%s\n' "$*" >&2
  exit 1
}

while (($#)); do
  case $1 in
    --unit)
      (($# >= 2)) || fail '--unit 需要单元名'
      unit=$2
      shift 2
      ;;
    --subject)
      (($# >= 2)) || fail '--subject 需要主题'
      subject=$2
      shift 2
      ;;
    --body)
      (($# >= 2)) || fail '--body 需要正文'
      body=$2
      shift 2
      ;;
    -h | --help)
      usage
      exit 0
      ;;
    *)
      usage >&2
      fail "未知参数：$1"
      ;;
  esac
done

if [[ -r $app_env ]]; then
  # shellcheck source=/dev/null
  . "$app_env"
fi
if [[ -r $monitor_env ]]; then
  # shellcheck source=/dev/null
  . "$monitor_env"
fi

smtp_host=${SMTP_HOST:-}
smtp_port=${SMTP_PORT:-465}
smtp_secure=${SMTP_SECURE:-true}
smtp_user=${SMTP_USER:-}
smtp_pass=${SMTP_PASS:-}
smtp_timeout=${SMTP_TIMEOUT_MS:-15000}
mail_from=${MAIL_FROM:-}
notify_to=${NOTIFY_TO:-}

[[ -n $smtp_host ]] || fail "没有 SMTP_HOST（$app_env）；邮件未配置，无法通知"
[[ -n $mail_from ]] || fail "没有 MAIL_FROM（$app_env）"
[[ -n $notify_to ]] || fail "没有 NOTIFY_TO（$monitor_env）；不知道发给谁"

if [[ -n $unit ]]; then
  [[ -n $subject ]] || subject="【FS-Billing】单元失败：$unit"
  body=$(
    {
      printf '单元：%s\n' "$unit"
      printf '主机：%s\n' "$(hostname)"
      printf '时间：%s\n\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
      printf '== systemctl status ==\n'
      systemctl status --no-pager --full "$unit" 2>&1 || true
      printf '\n== journalctl（最近 40 行）==\n'
      journalctl -u "$unit" -n 40 --no-pager 2>&1 || true
    }
  )
elif [[ -z $body ]] && [[ ! -t 0 ]]; then
  body=$(cat)
fi
[[ -n $subject ]] || fail '必须给 --subject 或 --unit'

# 主题单行化；中文按 RFC 2047 编码，避免邮件客户端按 Latin-1 显示乱码。
subject=$(printf '%s' "$subject" | tr -d '\r\n')
[[ -n $subject ]] || fail '主题为空'
encoded_subject=$(printf '%s' "$subject" | base64 | tr -d '\n')
recipients=()
IFS=', ' read -r -a recipients <<<"$notify_to"
((${#recipients[@]} > 0)) || fail 'NOTIFY_TO 为空'

message=$(mktemp)
trap 'rm -f -- "$message"' EXIT
{
  printf 'From: %s\n' "$mail_from"
  printf 'To: %s\n' "$notify_to"
  printf 'Subject: =?UTF-8?B?%s?=\n' "$encoded_subject"
  printf 'Date: %s\n' "$(date -R)"
  printf 'Message-ID: <%s.%s@%s>\n' "$(date +%s%N)" "$$" "$(hostname)"
  printf 'MIME-Version: 1.0\n'
  printf 'Content-Type: text/plain; charset=UTF-8\n'
  printf 'Content-Transfer-Encoding: 8bit\n\n'
  printf '%s\n' "$body"
} >"$message"

if [[ $smtp_secure == true ]]; then
  url="smtps://$smtp_host:$smtp_port"
else
  # 只有回环测试服务器（Mailpit）允许明文；生产必须 SMTP_SECURE=true。
  # 这里强制执行：非回环主机一律拒绝，避免把凭据明文发到网络上。
  case $smtp_host in
    127.0.0.1 | ::1 | localhost) ;;
    *)
      fail "SMTP_SECURE 不是 true，SMTP_HOST=$smtp_host 不是回环地址；拒绝明文发送（凭据会以明文经过网络）"
      ;;
  esac
  url="smtp://$smtp_host:$smtp_port"
fi

curl_args=(
  --silent --show-error --fail
  --max-time "$((smtp_timeout / 1000 > 0 ? smtp_timeout / 1000 : 1))"
  --url "$url"
  --mail-from "$mail_from"
  --upload-file "$message"
  # SMTP 服务器可能拒绝裸 LF；--crlf 把正文行尾转成 CRLF。
  --crlf
)
for recipient in "${recipients[@]}"; do
  [[ -n $recipient ]] || continue
  curl_args+=(--mail-rcpt "$recipient")
done
if [[ $smtp_secure == true ]]; then
  curl_args+=(--ssl-reqd)
fi
if [[ -n $smtp_user ]]; then
  [[ -n $smtp_pass ]] || fail '设置了 SMTP_USER 却没有 SMTP_PASS'
  # 凭据不能出现在 argv（ps 可见）；通过 --config 从文件描述符读取。
  # 进程替换必须直接放在 curl 的命令行上，文件描述符才会在 curl 运行期间保持打开。
  # curl 配置的双引号字符串里，反斜杠与双引号都要转义。
  escaped_user=${smtp_user//\\/\\\\}
  escaped_user=${escaped_user//\"/\\\"}
  escaped_pass=${smtp_pass//\\/\\\\}
  escaped_pass=${escaped_pass//\"/\\\"}
  curl "${curl_args[@]}" \
    --config <(printf 'user = "%s:%s"\n' "$escaped_user" "$escaped_pass") ||
    fail "发送邮件到 $smtp_host:$smtp_port 失败"
else
  curl "${curl_args[@]}" || fail "发送邮件到 $smtp_host:$smtp_port 失败"
fi
printf '已发送通知：%s\n' "$subject"
