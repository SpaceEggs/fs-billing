#!/usr/bin/env bash
# 服务器 B（Debian 13）的一次性引导：系统包、运行用户与目录、Node、自签证书、
# 各服务配置、数据库与两个环境文件。可重复执行；已存在的 env 文件和证书不覆盖。
# 重跑会重启 nginx、PostgreSQL 与 sshd，避免在业务高峰执行。
#
# 代码发布不在这里做，见 ops/deploy/deploy.sh。执行前请先把仓库拷到服务器：
#   git ls-files -z -- . ':(exclude)design/**' ':(exclude).claude/**' ':(exclude)docs/evidence/**' |
#     COPYFILE_DISABLE=1 tar --null -T - -czf fs-billing-bootstrap.tar.gz
#   scp fs-billing-bootstrap.tar.gz root@<B>:/root/
#   ssh root@<B> 'mkdir -p /root/fs-billing-bootstrap && tar -xzf /root/fs-billing-bootstrap.tar.gz -C /root/fs-billing-bootstrap'
#   ssh root@<B> '/root/fs-billing-bootstrap/ops/deploy/bootstrap-server.sh --public-ip <B_IP> --fs-a-ip <A_IP>'
set -euo pipefail

script_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
repo_root=$(cd "$script_dir/../.." && pwd)
public_ip=''
fs_a_ip=''
worker_host=127.0.0.1
skip_ssh_check=false

usage() {
  cat <<'EOF'
用法：bootstrap-server.sh --public-ip <B 的公网 IPv4> --fs-a-ip <服务器 A 的 IPv4> [选项]

  --public-ip <IPv4>     自签证书的 SAN，也是 BETTER_AUTH_URL 的地址（必填）
  --fs-a-ip <IPv4>       允许访问 Worker 3001 的服务器 A 地址（必填；A 未到位可先用占位地址）
                         直连时填 A 的来源地址；走 WireGuard 时填 A 的公网地址（供 UDP 规则使用）
  --worker-host <IPv4>   Worker 监听地址，默认 127.0.0.1；跨机访问时设为 B 的内网或 WireGuard 地址
  --source <目录>        仓库副本，默认本脚本所在仓库
  --skip-ssh-check       没有找到非空 authorized_keys 时仍然继续（会关闭密码登录，慎用）
  -h, --help             显示本帮助
EOF
}

fail() {
  printf '错误：%s\n' "$*" >&2
  exit 1
}

cleanup_paths=()
cleanup() {
  local path
  for path in "${cleanup_paths[@]}"; do
    rm -rf -- "$path"
  done
}
trap cleanup EXIT

note() {
  printf '==> %s\n' "$*"
}

valid_ipv4() {
  local ip=$1 octet
  local -a octets=()
  [[ $ip =~ ^([0-9]{1,3}\.){3}[0-9]{1,3}$ ]] || return 1
  IFS=. read -ra octets <<<"$ip"
  for octet in "${octets[@]}"; do
    ((octet <= 255)) || return 1
  done
}

while (($#)); do
  case $1 in
    --public-ip)
      [[ -n ${2:-} ]] || fail '--public-ip 需要值'
      public_ip=$2
      shift 2
      ;;
    --fs-a-ip)
      [[ -n ${2:-} ]] || fail '--fs-a-ip 需要值'
      fs_a_ip=$2
      shift 2
      ;;
    --worker-host)
      [[ -n ${2:-} ]] || fail '--worker-host 需要值'
      worker_host=$2
      shift 2
      ;;
    --source)
      [[ -n ${2:-} ]] || fail '--source 需要值'
      repo_root=$2
      shift 2
      ;;
    --skip-ssh-check)
      skip_ssh_check=true
      shift
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

[[ $EUID -eq 0 ]] || fail '必须以 root 执行'
[[ -d /run/systemd/system ]] || fail '没有运行中的 systemd，本脚本只能用于真实服务器'
[[ -f $repo_root/package.json && -d $repo_root/ops ]] ||
  fail "--source 不像仓库根：$repo_root"
[[ -n $public_ip ]] || fail '必须指定 --public-ip'
[[ -n $fs_a_ip ]] || fail '必须指定 --fs-a-ip'
valid_ipv4 "$public_ip" || fail "--public-ip 不是 IPv4 地址：$public_ip"
valid_ipv4 "$fs_a_ip" || fail "--fs-a-ip 不是 IPv4 地址：$fs_a_ip"
valid_ipv4 "$worker_host" || fail "--worker-host 不是 IPv4 地址：$worker_host"

# shellcheck disable=SC1091
. /etc/os-release
[[ ${ID:-} == debian && ${VERSION_ID:-} == 13 ]] ||
  fail "仅支持 Debian 13，当前是 ${PRETTY_NAME:-未知系统}"

export DEBIAN_FRONTEND=noninteractive

note '安装系统包'
apt-get update
apt-get install -y --no-install-recommends \
  postgresql-17 nginx nftables chrony certbot python3-certbot-nginx \
  curl ca-certificates jq unzip tar xz-utils openssl build-essential

note '创建运行用户与目录'
if ! id -u fs-billing >/dev/null 2>&1; then
  useradd --system --user-group --home-dir /var/lib/fs-billing \
    --shell /usr/sbin/nologin fs-billing
fi
install -d -m 0755 -o root -g root /opt/fs-billing /opt/fs-billing/releases
install -d -m 0700 -o fs-billing -g fs-billing /var/lib/fs-billing
install -d -m 0700 -o fs-billing -g fs-billing /var/lib/fs-billing/archive
install -d -m 0700 -o root -g root /var/lib/fs-billing/monitor
install -d -m 0700 -o root -g root /root/backups

note '安装 Node'
"$repo_root/ops/deploy/install-node.sh"

note '安装自签证书（已存在则保留）'
install -d -m 0750 -o root -g root /etc/ssl/fs-billing
if [[ ! -s /etc/ssl/fs-billing/fullchain.pem || ! -s /etc/ssl/fs-billing/privkey.pem ]]; then
  openssl req -x509 -newkey rsa:2048 -sha256 -days 365 -nodes \
    -subj "/CN=$public_ip" \
    -addext "subjectAltName=IP:$public_ip" \
    -keyout /etc/ssl/fs-billing/privkey.pem \
    -out /etc/ssl/fs-billing/fullchain.pem >/dev/null 2>&1
  chmod 0600 /etc/ssl/fs-billing/privkey.pem
  chmod 0644 /etc/ssl/fs-billing/fullchain.pem
else
  printf '已有证书，未覆盖：/etc/ssl/fs-billing/fullchain.pem\n'
fi

note '安装 systemd 单元'
install -m 0644 "$repo_root/ops/deploy/systemd/fs-billing-api.service" /etc/systemd/system/
install -m 0644 "$repo_root/ops/deploy/systemd/fs-billing-worker.service" /etc/systemd/system/
systemctl daemon-reload

note '安装 nginx 配置'
install -m 0644 "$repo_root/ops/deploy/nginx/fs-billing.conf" /etc/nginx/conf.d/fs-billing.conf
# Debian 默认站点也监听 80 并可能抢走请求；生产只使用 fs-billing.conf。
rm -f /etc/nginx/sites-enabled/default
if ! nginx -t; then
  rm -f /etc/nginx/conf.d/fs-billing.conf
  fail 'nginx 配置校验失败，已移除 fs-billing.conf'
fi
systemctl enable nginx
systemctl restart nginx

note '安装 PostgreSQL 配置'
install -d -m 0755 /etc/postgresql/17/main/conf.d
install -m 0644 "$repo_root/ops/deploy/postgres/fs-billing.conf" \
  /etc/postgresql/17/main/conf.d/fs-billing.conf
systemctl enable --now postgresql
systemctl restart postgresql

note '安装 sshd 仅密钥片段'
install -d -m 0755 /etc/ssh/sshd_config.d
if ! $skip_ssh_check; then
  mapfile -t authorized_keys < <(
    find /root/.ssh /home -type f -name authorized_keys -size +0c 2>/dev/null || true
  )
  ((${#authorized_keys[@]})) ||
    fail '没有找到非空的 authorized_keys；关闭密码登录会锁死。确认密钥后重跑，或显式加 --skip-ssh-check'
fi
install -m 0644 "$repo_root/ops/deploy/sshd/fs-billing.conf" \
  /etc/ssh/sshd_config.d/00-fs-billing.conf
if ! sshd -t -f /etc/ssh/sshd_config; then
  rm -f /etc/ssh/sshd_config.d/00-fs-billing.conf
  fail 'sshd 配置校验失败，已移除 00-fs-billing.conf；原登录方式保持不变'
fi
# sshd 对同一项只采用最先读到的值，sshd_config.d 按文件名字典序加载；
# 云镜像常带 50-cloud-init.conf（PasswordAuthentication yes），所以本片段用 00-
# 前缀排在它前面。语法通过不等于生效，再核对合并后的有效配置。
sshd_effective=$(sshd -T 2>/dev/null) || {
  rm -f /etc/ssh/sshd_config.d/00-fs-billing.conf
  fail 'sshd -T 读取有效配置失败，已移除 00-fs-billing.conf；原登录方式保持不变'
}
if ! grep -qx 'passwordauthentication no' <<<"$sshd_effective" ||
  ! grep -qx 'kbdinteractiveauthentication no' <<<"$sshd_effective"; then
  rm -f /etc/ssh/sshd_config.d/00-fs-billing.conf
  fail 'sshd 有效配置不是仅密钥登录（有更早加载的片段覆盖本片段）；已移除 00-fs-billing.conf，登录方式保持不变'
fi
systemctl reload ssh

note '安装 journald 配置'
install -d -m 0755 /etc/systemd/journald.conf.d
install -m 0644 "$repo_root/ops/journald/fs-billing.conf" \
  /etc/systemd/journald.conf.d/fs-billing.conf
install -d -m 2750 -o root -g systemd-journal /var/log/journal
systemctl restart systemd-journald

note '准备数据库与 /etc/fs-billing'
install -d -m 0750 -o root -g fs-billing /etc/fs-billing

if [[ -e /etc/fs-billing/owner.env || -e /etc/fs-billing/app.env ]]; then
  [[ -f /etc/fs-billing/owner.env && -f /etc/fs-billing/app.env ]] ||
    fail 'owner.env 与 app.env 必须同时存在；只找到一个时请恢复另一个或先移走再重跑'
  printf '保留现有 /etc/fs-billing/owner.env 与 app.env\n'
  role_exists=$(runuser -u postgres -- psql -X -tAc \
    "SELECT 1 FROM pg_roles WHERE rolname = 'fs_billing'") ||
    fail '查询 PostgreSQL 角色失败'
  [[ $role_exists == 1 ]] ||
    fail 'owner.env 已存在，但 PostgreSQL 角色 fs_billing 不存在；请恢复角色或手工处理'
else
  note '生成数据库 owner 角色与两个环境文件'
  owner_password=$(openssl rand -hex 24)
  app_password=$(openssl rand -hex 24)
  auth_password=$(openssl rand -hex 24)
  better_auth_secret=$(openssl rand -hex 32)
  worker_shared_key=$(openssl rand -hex 24)

  role_exists=$(runuser -u postgres -- psql -X -tAc \
    "SELECT 1 FROM pg_roles WHERE rolname = 'fs_billing'") ||
    fail '查询 PostgreSQL 角色失败'
  if [[ $role_exists != 1 ]]; then
    runuser -u postgres -- psql -X -v ON_ERROR_STOP=1 <<SQL
\set pw $owner_password
SELECT format('CREATE ROLE fs_billing LOGIN SUPERUSER PASSWORD %L', :'pw') \gexec
SQL
  else
    runuser -u postgres -- psql -X -v ON_ERROR_STOP=1 <<SQL
\set pw $owner_password
SELECT format('ALTER ROLE fs_billing WITH LOGIN SUPERUSER PASSWORD %L', :'pw') \gexec
SQL
  fi

  owner_env=$(mktemp)
  app_env=$(mktemp)
  cleanup_paths+=("$owner_env" "$app_env")

  cat >"$owner_env" <<EOF
# 仅 root 与运维命令读取（0600 root:root）。迁移、queue:migrate、auth:bootstrap 用。
# 纯 KEY=value，不含空格与引号；键与 app.env 中的同名键必须保持一致。
# 标记生产环境：owner.env 未设 NODE_ENV 时，空库上误跑 db:seed 会写入演示数据。
NODE_ENV=production
DATABASE_URL=postgresql://fs_billing:$owner_password@127.0.0.1:5432/fs_billing
APP_DATABASE_URL=postgresql://fs_billing_app:$app_password@127.0.0.1:5432/fs_billing
AUTH_DATABASE_URL=postgresql://fs_billing_auth:$auth_password@127.0.0.1:5432/fs_billing
BETTER_AUTH_SECRET=$better_auth_secret
BETTER_AUTH_URL=https://$public_ip
EOF

  cat >"$app_env" <<EOF
# 服务进程读取（0640 root:fs-billing）。这里不放 owner DATABASE_URL。
# 纯 KEY=value，不含空格与引号，使 systemd 与 Node 的解析一致。
NODE_ENV=production
APP_DATABASE_URL=postgresql://fs_billing_app:$app_password@127.0.0.1:5432/fs_billing
AUTH_DATABASE_URL=postgresql://fs_billing_auth:$auth_password@127.0.0.1:5432/fs_billing
BETTER_AUTH_SECRET=$better_auth_secret
BETTER_AUTH_URL=https://$public_ip
BETTER_AUTH_TRUSTED_ORIGINS=https://$public_ip
API_HOST=127.0.0.1
API_PORT=3000
WORKER_HOST=$worker_host
WORKER_PORT=3001
WORKER_SHARED_KEY=$worker_shared_key
WORKER_ALLOWED_IPS=$fs_a_ip
RAW_CDR_ARCHIVE_DIR=/var/lib/fs-billing/archive
# SMTP 不启用时保持注释；启用后按场景填写，SMTP_PASS 只放本文件。
# SMTP_HOST=smtp.example.com
# SMTP_PORT=465
# SMTP_SECURE=true
# SMTP_USER=billing@example.com
# SMTP_PASS=replace-me
# MAIL_FROM=billing@example.com
# APP_PUBLIC_URL=https://$public_ip
EOF

  install -m 0600 -o root -g root "$owner_env" /etc/fs-billing/owner.env
  install -m 0640 -o root -g fs-billing "$app_env" /etc/fs-billing/app.env

  unset owner_password app_password auth_password better_auth_secret worker_shared_key
fi

db_exists=$(runuser -u postgres -- psql -X -tAc \
  "SELECT 1 FROM pg_database WHERE datname = 'fs_billing'") ||
  fail '查询 PostgreSQL 数据库失败'
if [[ $db_exists != 1 ]]; then
  runuser -u postgres -- createdb -O fs_billing fs_billing
fi

note '安装 nftables 规则'
firewall_tmp=$(mktemp)
cleanup_paths+=("$firewall_tmp")
sed "s/^define FS_A_IP = .*/define FS_A_IP = $fs_a_ip/" \
  "$repo_root/ops/firewall/nftables-b.conf" >"$firewall_tmp"
nft -c -f "$firewall_tmp"
nft -f "$firewall_tmp"
install -m 0644 "$firewall_tmp" /etc/nftables.conf
systemctl enable nftables
systemctl restart nftables

note '启用服务单元（首次部署前 API/Worker 还没有 current，先只 enable）'
systemctl enable fs-billing-api fs-billing-worker

note '启用 chrony'
install -d -m 0755 /etc/chrony/conf.d
install -m 0644 "$repo_root/ops/monitor/chrony/fs-billing.conf" \
  /etc/chrony/conf.d/fs-billing.conf
systemctl enable --now chrony
systemctl restart chrony

cat <<EOF

引导完成。接下来：
  1. 核对 /etc/fs-billing/app.env（权限 0640 root:fs-billing）与 owner.env（0600 root:root）。
  2. 在工作站执行 ops/deploy/deploy.sh root@$public_ip，发布第一个版本。
  3. 用 ops/firewall/verify-ports.sh 验证端口边界。
  4. 自签证书指纹：openssl x509 -in /etc/ssl/fs-billing/fullchain.pem -noout -fingerprint -sha256
  5. Worker 监听 $worker_host:3001，白名单为 $fs_a_ip；如走 WireGuard，见 ops/firewall/wireguard-*.conf.example。
EOF
