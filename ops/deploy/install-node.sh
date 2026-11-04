#!/usr/bin/env bash
# 安装生产用的 Node.js。Debian 13 官方源没有 Node 24，这里用官方 tarball，
# 校验 SHASUMS256.txt 后再解包到 /opt/node-v<版本>，/usr/local/bin 放链接。
# 版本取仓库根的 .node-version；可在命令前用 NODE_VERSION 覆盖。
set -euo pipefail

script_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
repo_root=$(cd "$script_dir/../.." && pwd)
install_root=/opt
bin_dir=/usr/local/bin

fail() {
  printf '%s\n' "$*" >&2
  exit 1
}

[[ $EUID -eq 0 ]] || fail '必须以 root 执行'

node_version=${NODE_VERSION:-}
if [[ -z $node_version ]]; then
  [[ -r $repo_root/.node-version ]] || fail "找不到 $repo_root/.node-version"
  node_version=$(tr -d '[:space:]' <"$repo_root/.node-version")
fi
[[ $node_version =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] ||
  fail "Node 版本格式错误：$node_version"

case $(uname -m) in
  x86_64) node_arch=x64 ;;
  aarch64 | arm64) node_arch=arm64 ;;
  *) fail "不支持的架构：$(uname -m)" ;;
esac

install_dir=$install_root/node-v$node_version

if [[ -x $install_dir/bin/node ]] &&
  [[ $("$install_dir/bin/node" --version) == "v$node_version" ]]; then
  printf 'Node %s 已安装在 %s\n' "$node_version" "$install_dir"
else
  work_dir=$(mktemp -d)
  trap 'rm -rf "$work_dir"' EXIT
  tarball=node-v$node_version-linux-$node_arch.tar.xz
  base_url=https://nodejs.org/dist/v$node_version

  printf '下载 %s\n' "$base_url/SHASUMS256.txt"
  curl --fail --silent --show-error --location --proto '=https' --tlsv1.2 \
    "$base_url/SHASUMS256.txt" -o "$work_dir/SHASUMS256.txt"
  expected=$(awk -v file="$tarball" '$2 == file { print $1 }' "$work_dir/SHASUMS256.txt")
  [[ -n $expected ]] || fail "SHASUMS256.txt 中没有 $tarball"
  if [[ -n ${NODE_SHA256:-} && ${NODE_SHA256} != "$expected" ]]; then
    fail "NODE_SHA256 与官方 SHASUMS256.txt 不一致（$tarball）"
  fi

  printf '下载 %s\n' "$base_url/$tarball"
  curl --fail --silent --show-error --location --proto '=https' --tlsv1.2 \
    "$base_url/$tarball" -o "$work_dir/$tarball"
  actual=$(sha256sum "$work_dir/$tarball" | awk '{ print $1 }')
  [[ $actual == "$expected" ]] || fail "SHA256 校验失败：$tarball"

  rm -rf "$install_dir"
  tar -xJf "$work_dir/$tarball" -C "$work_dir"
  mv "$work_dir/node-v$node_version-linux-$node_arch" "$install_dir"
  [[ -x $install_dir/bin/node ]] || fail "解包后找不到 $install_dir/bin/node"
fi

# 只链接官方 tarball 自带的四个入口；pnpm 由 corepack 生成 shim。
for name in node npm npx corepack; do
  [[ -x $install_dir/bin/$name ]] && ln -sfn "$install_dir/bin/$name" "$bin_dir/$name"
done

# packageManager 固定了 pnpm 版本，shim 首次运行按 package.json 下载。
# 引导与部署都以非交互方式执行，这里禁止 corepack 的下载确认提示。
COREPACK_ENABLE_DOWNLOAD_PROMPT=0 "$bin_dir/corepack" enable \
  --install-directory "$bin_dir" pnpm >/dev/null

[[ $("$bin_dir/node" --version) == "v$node_version" ]] ||
  fail '安装后的 node 版本与 .node-version 不一致'

printf 'Node %s 已就绪：%s/bin/node，pnpm shim 在 %s/pnpm\n' \
  "$node_version" "$install_dir" "$bin_dir"
