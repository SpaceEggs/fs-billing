#!/usr/bin/env bash
set +x
set -euo pipefail
: "${WORKER_SHARED_KEY:?缺少 WORKER_SHARED_KEY}"
export BILLING_WORKER_URL=${BILLING_WORKER_URL:-http://127.0.0.1:3001}
# 清除 vanilla 外呼入口，避免默认 context 与 profile 掩盖测试结果。
rm -rf /etc/freeswitch/sip_profiles /etc/freeswitch/dialplan /etc/freeswitch/directory
mkdir -p /etc/freeswitch/sip_profiles /etc/freeswitch/dialplan /etc/freeswitch/directory
cp -a /opt/fs-integration/conf/autoload_configs/. /etc/freeswitch/autoload_configs/
cp -a /opt/fs-integration/conf/sip_profiles/. /etc/freeswitch/sip_profiles/
cp -a /opt/fs-integration/conf/directory/. /etc/freeswitch/directory/
ln -sf /opt/fs-billing/dialplan/billing.xml /etc/freeswitch/dialplan/billing.xml
lua5.3 - /opt/fs-integration/conf/vars.xml.template /etc/freeswitch/vars.xml <<'LUA'
local input = assert(io.open(arg[1]))
local xml = input:read('*a')
input:close()
local function escape(value)
  assert(not value:find('[%c]'), '配置值不能含控制字符')
  return (value:gsub('&', '&amp;'):gsub('"', '&quot;'):gsub('<', '&lt;'):gsub('>', '&gt;'))
end
xml = xml:gsub('@BILLING_WORKER_URL@', function() return escape(assert(os.getenv('BILLING_WORKER_URL'))) end)
xml = xml:gsub('@WORKER_SHARED_KEY@', function() return escape(assert(os.getenv('WORKER_SHARED_KEY'))) end)
local output = assert(io.open(arg[2], 'w'))
output:write(xml)
output:close()
LUA
chmod 0600 /etc/freeswitch/vars.xml
# 测试减少重试等待；生产配置只读挂载且不变。
sed -e 's/name="timeout" value="5"/name="timeout" value="1"/' \
    -e 's/name="retries" value="3"/name="retries" value="1"/' \
    -e 's/name="delay" value="5"/name="delay" value="1"/' \
    /opt/fs-billing/autoload_configs/json_cdr.conf.xml > /etc/freeswitch/autoload_configs/json_cdr.conf.xml
mkdir -p /var/lib/freeswitch/cdr/archive /var/lib/freeswitch/cdr/retry
exec freeswitch -nf -nonat
