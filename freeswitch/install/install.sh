#!/usr/bin/env bash
set +x
set -euo pipefail

# 官方包与 mod_lua 的 Lua ABI 一起锁定；不安装含无关模块的 meta-all。
FS_VERSION='1.11.3-release-33213556856-ef32e20529~trixie~amd64-1~trixie+1'
LUA_CURL_VERSION='0.3.13-1'
LUA_CJSON_VERSION='2.1.0+dfsg-2.2+b2'
token_file=${1:-${SIGNALWIRE_TOKEN_FILE:-/run/secrets/signalwire_token}}
auth_file=/etc/apt/auth.conf.d/fs-billing-signalwire.conf
source_file=/etc/apt/sources.list.d/fs-billing-signalwire.list
[[ $EUID == 0 ]] || { echo '必须以 root 执行' >&2; exit 1; }
work_dir=$(mktemp -d)
cleanup() {
    rm -f "$auth_file" "$source_file"
    rm -rf "$work_dir"
}
trap cleanup EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM
rm -f "$auth_file" "$source_file"
# 精确版本是 amd64 trixie 包；其他平台不能静默安装别的版本。
. /etc/os-release
[[ $ID == debian && $VERSION_ID == 13 && $(dpkg --print-architecture) == amd64 ]] || {
    echo '仅支持 Debian 13 amd64' >&2; exit 1;
}
[[ -s $token_file && -r $token_file ]] || { echo 'SignalWire token 文件不可读或为空' >&2; exit 1; }
token=$(cat "$token_file")
[[ $token != *[[:space:]]* ]] || { echo 'SignalWire token 不能包含空白' >&2; exit 1; }
export DEBIAN_FRONTEND=noninteractive
apt-mark showauto | sed 's/:.*//' | sort -u > "$work_dir/auto-before"
apt-get update
apt-get install -y --no-install-recommends ca-certificates curl gnupg
install -d -m 0755 /etc/apt/auth.conf.d /usr/share/keyrings
umask 077
printf 'machine freeswitch.signalwire.com login signalwire password %s\n' "$token" > "$auth_file"
unset token
curl --fail --silent --show-error --netrc-file "$auth_file" \
    https://freeswitch.signalwire.com/repo/deb/debian-release/signalwire-freeswitch-repo.gpg \
    -o "$work_dir/key"
if head -c 10 "$work_dir/key" | grep -q -- '-----BEGIN'; then
    gpg --batch --dearmor < "$work_dir/key" > "$work_dir/key.gpg"
else
    cp "$work_dir/key" "$work_dir/key.gpg"
fi
install -m 0644 "$work_dir/key.gpg" /usr/share/keyrings/fs-billing-signalwire.gpg
umask 022
printf '%s\n' 'deb [signed-by=/usr/share/keyrings/fs-billing-signalwire.gpg] https://freeswitch.signalwire.com/repo/deb/debian-release/ trixie main' > "$source_file"
cat > /etc/apt/preferences.d/fs-billing-freeswitch <<PINS
Package: freeswitch* libfreeswitch1
Pin: version $FS_VERSION
Pin-Priority: 1001
PINS
apt-get update
packages=(freeswitch libfreeswitch1 freeswitch-conf-vanilla freeswitch-systemd
    freeswitch-mod-lua freeswitch-mod-sofia freeswitch-mod-json-cdr
    freeswitch-mod-commands freeswitch-mod-dptools freeswitch-mod-console
    freeswitch-mod-dialplan-xml freeswitch-mod-event-socket freeswitch-mod-hash
    freeswitch-mod-logfile)
pinned=()
for package in "${packages[@]}"; do pinned+=("$package=$FS_VERSION"); done
apt-get install -y --allow-downgrades --no-install-recommends "${pinned[@]}" \
    "lua-cjson=$LUA_CJSON_VERSION" lua5.3 libcurl4t64
if [[ $(cat /proc/1/comm) == systemd ]]; then
    systemctl disable --now freeswitch
fi
apt-mark manual libcurl4t64

# Debian lua-curl 是 v2 且缺少 5.3；显式构建 Lua-cURLv3 的 5.3 模块。
if ! lua5.3 -e "assert(require('cURL')._VERSION == '0.3.13'); require('cURL.safe')" 2>/dev/null; then
    build_packages=(build-essential liblua5.3-dev libcurl4-openssl-dev luarocks)
    remove_packages=()
    for package in "${build_packages[@]}"; do
        if ! dpkg-query -W -f='${Status}' "$package" 2>/dev/null | grep -q 'install ok installed'; then
            remove_packages+=("$package")
        fi
    done
    apt-get install -y --no-install-recommends "${build_packages[@]}"
    curl_multiarch=$(dpkg-architecture -qDEB_HOST_MULTIARCH)
    luarocks --lua-version=5.3 --tree=/usr/local install Lua-cURL "$LUA_CURL_VERSION" \
        CURL_INCDIR="/usr/include/$curl_multiarch" CURL_LIBDIR="/usr/lib/$curl_multiarch"
    # 不让 autoremove 删除安装前已标记为自动安装的包。
    if ((${#remove_packages[@]})); then
        apt-get purge -y "${remove_packages[@]}"
        apt-get --simulate autoremove -y > "$work_dir/autoremove"
        awk '/^Remv / { print $2 }' "$work_dir/autoremove" | sed 's/:.*//' | sort -u > "$work_dir/auto-remove"
        if [[ -z $(comm -12 "$work_dir/auto-before" "$work_dir/auto-remove") ]]; then
            apt-get autoremove -y
        fi
    fi
fi
lua5.3 -e "require('cURL.safe'); require('cjson.safe')"
ldd /usr/lib/freeswitch/mod/mod_lua.so | grep 'liblua5.3'
