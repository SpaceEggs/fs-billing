#!/usr/bin/env bash
# 从工作站发布一个已提交的版本到服务器 B。
#
#   ops/deploy/deploy.sh root@<B_IP>
#
# 发布当前 HEAD；工作区必须干净。
# 步骤与设计一致：本机 git ls-files 打包（排除 design/、.claude/、docs/evidence/）→
# scp → releases/<sha> → pnpm install --frozen-lockfile → Web 构建 →
# 以 owner 身份 db:migrate、queue:migrate → 切换 current → 重启两个服务 →
# 健康检查 → 写 DEPLOYED_COMMIT → 只保留最近 3 个 release。
# 不运行任何 *:seed。迁移不回滚，失败时用 rollback.sh 切回上一个目录。
set -euo pipefail

usage() {
  cat <<'EOF'
用法：deploy.sh <user@host>

  user@host  服务器 B 的 SSH 目标

发布当前 HEAD 的提交。工作区必须干净；未提交的改动不会被发布。
EOF
}

fail() {
  printf '错误：%s\n' "$*" >&2
  exit 1
}

host=${1:-}
extra=${2:-}

if [[ -z $host || $host == -h || $host == --help ]]; then
  usage
  [[ -n $host ]] && exit 0
  exit 2
fi
[[ -z $extra ]] || fail '只发布当前 HEAD，不接受额外参数'

stopwatch=${FS_BILLING_STOPWATCH:-0}
[[ $stopwatch == 0 || $stopwatch == 1 ]] ||
  fail 'FS_BILLING_STOPWATCH 只能是 0 或 1'

for command in git tar scp ssh; do
  command -v "$command" >/dev/null 2>&1 || fail "缺少命令：$command"
done

repo_root=$(git rev-parse --show-toplevel)
cd "$repo_root"

sha=$(git rev-parse --short=12 HEAD)

if [[ -n $(git status --porcelain) ]]; then
  git status --short >&2
  fail '工作区不干净；先提交或清理，确保发布内容与提交一致'
fi

tarball=$(mktemp "${TMPDIR:-/tmp}/fs-billing-$sha.XXXXXX")
cleanup() {
  rm -f -- "$tarball"
}
trap cleanup EXIT

printf '打包 %s\n' "$sha"
# 只打包已跟踪文件；排除设计稿、本地工具和证据（证据不进服务器）。
# COPYFILE_DISABLE=1：macOS 的 tar 会为带扩展属性的文件追加 AppleDouble `._*`
# 条目，服务器解包后会出现垃圾文件。
git ls-files -z -- . \
  ':(exclude)design/**' \
  ':(exclude).claude/**' \
  ':(exclude)docs/evidence/**' |
  COPYFILE_DISABLE=1 tar --null -T - -czf "$tarball"

remote_tarball=/tmp/fs-billing-$sha.tar.gz
printf '上传到 %s:%s\n' "$host" "$remote_tarball"
scp -- "$tarball" "$host:$remote_tarball"

printf '在服务器上发布\n'
ssh -- "$host" bash -s -- "$sha" "$remote_tarball" "$stopwatch" <<'REMOTE'
set -euo pipefail

# 远端脚本经 bash -s 从标准输入读入。先整段定义成函数，让 bash 解析完再执行，
# 并以 /dev/null 作为标准输入调用，避免 pnpm/corepack/node 读走脚本的剩余部分。
main() {
  umask 022
  sha=$1
  remote_tarball=$2
  stopwatch_enabled=${3:-0}
  release_root=/opt/fs-billing/releases
  current_link=/opt/fs-billing/current
  release=$release_root/$sha

  [[ $EUID -eq 0 ]] || {
    echo '错误：服务器端步骤需要 root' >&2
    exit 1
  }
  [[ -f $remote_tarball ]] || {
    echo "错误：找不到 $remote_tarball" >&2
    exit 1
  }

  install -d -m 0755 -o root -g root "$release_root"

  # 先解到隐藏的临时目录，成功后再改名，避免中途失败留下半个 release。
  # 上传包与暂存目录都交给 EXIT trap：成功与失败都不留在服务器上。
  staging=$(mktemp -d "$release_root/.$sha.XXXXXX")
  trap 'rm -rf -- "$staging"; rm -f -- "$remote_tarball"' EXIT
  tar -xzf "$remote_tarball" -C "$staging"
  chown -R fs-billing:fs-billing "$staging"
  # mktemp 默认 0700；nginx 以 www-data 读取静态文件，release 根必须可进入。
  chmod 0755 "$staging"

  if [[ -e $release ]]; then
    if [[ $release == "$(readlink -f "$current_link" 2>/dev/null || true)" ]]; then
      echo "release $sha 是当前版本，复用目录并重新安装依赖"
      rm -rf -- "$staging"
    else
      echo "release $sha 已存在但未在使用，替换为本次解包"
      rm -rf -- "$release"
      mv -- "$staging" "$release"
    fi
  else
    mv -- "$staging" "$release"
  fi

  cd "$release"

  # 从零部署演练时（FS_BILLING_STOPWATCH=1）把脚本耗时单独记入 stopwatch，
  # 与人工步骤分开；日常发布不写记录。
  run_timed() {
    label=$1
    shift
    if [[ $stopwatch_enabled == 1 ]]; then
      "$release/ops/deploy/stopwatch.sh" run "$label" -- "$@"
    else
      "$@"
    fi
  }

  # pnpm 与 corepack 的缓存放在服务用户自己的 HOME 下；corepack 首次下载 pnpm 时不交互。
  install -d -m 0700 -o fs-billing -g fs-billing /var/lib/fs-billing/.cache
  run_timed 'pnpm install --frozen-lockfile' runuser -u fs-billing -- env \
    HOME=/var/lib/fs-billing \
    PATH=/usr/local/bin:/usr/bin:/bin \
    COREPACK_ENABLE_DOWNLOAD_PROMPT=0 \
    pnpm install --frozen-lockfile

  run_timed 'Web 构建' runuser -u fs-billing -- env \
    HOME=/var/lib/fs-billing \
    PATH=/usr/local/bin:/usr/bin:/bin \
    COREPACK_ENABLE_DOWNLOAD_PROMPT=0 \
    pnpm --filter @fs-billing/web build

  # 迁移与队列安装用 owner，环境只在这条命令里加载。
  set -a
  # shellcheck disable=SC1091
  . /etc/fs-billing/owner.env
  set +a
  export COREPACK_ENABLE_DOWNLOAD_PROMPT=0
  run_timed 'db:migrate' pnpm db:migrate
  run_timed 'queue:migrate' pnpm --filter @fs-billing/worker queue:migrate

  # 原子替换 current 符号链接。
  ln -sfn "$release" "$current_link.tmp"
  mv -Tf "$current_link.tmp" "$current_link"

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

  if ! wait_http API "http://$api_host:$api_port/api/health"; then
    echo "当前版本已切换但没有通过健康检查；修复后重试，或执行 $release/ops/deploy/rollback.sh 切回上一个 release" >&2
    exit 1
  fi
  if ! wait_http Worker "http://$worker_host:$worker_port/health"; then
    echo "当前版本已切换但没有通过健康检查；修复后重试，或执行 $release/ops/deploy/rollback.sh 切回上一个 release" >&2
    exit 1
  fi

  printf '%s\n' "$sha" >"$release/DEPLOYED_COMMIT"
  chown fs-billing:fs-billing "$release/DEPLOYED_COMMIT"

  # 保留最近 3 个 release；当前链接与正在使用的目录不删。
  current=$(readlink -f "$current_link" 2>/dev/null || true)
  mapfile -t releases < <(
    find "$release_root" -mindepth 1 -maxdepth 1 -type d -printf '%T@ %p\n' |
      sort -rn | awk '{ print $2 }'
  )
  for old in "${releases[@]:3}"; do
    [[ $old == "$release" || $old == "$current" ]] && continue
    echo "删除旧 release：$old"
    rm -rf -- "$old"
  done

  echo "发布完成：$sha -> $release"
}

main "$@" </dev/null
REMOTE

printf '发布完成：%s\n' "$sha"
