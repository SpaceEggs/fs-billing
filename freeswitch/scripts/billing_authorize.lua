local destination = session:getVariable('destination_number') or ''
session:setVariable('billing_dialed_number', destination)

-- 依赖与 mod_lua 使用相同 Lua ABI 的 Lua-cURL 和 lua-cjson；密钥只放全局配置，不写通道变量。
local curl = require('cURL.safe')
local json = require('cjson.safe')
local api = freeswitch.API()
local url = api:execute('global_getvar', 'billing_worker_url')
local key = api:execute('global_getvar', 'billing_shared_key')

-- 边界：授权响应与 packages/shared/src/worker.ts 的放行/拒绝形状一致。
local sip_codes = { [400] = true, [402] = true, [403] = true, [404] = true, [484] = true }
local function decision(body)
    local value = json.decode(body)
    if type(value) ~= 'table' then return nil end
    -- cjson 将 JSON 整数解成浮点数；先转整数，避免拼出 +60.0 或 SIP 402.0。
    local seconds = type(value.maxSeconds) == 'number' and math.tointeger(value.maxSeconds)
    local sip_code = type(value.sipCode) == 'number' and math.tointeger(value.sipCode)
    if value.allowed == true and seconds and seconds >= 1 and seconds <= 14400 then
        return { allowed = true, seconds = seconds, billing_number = value.billingNumber }
    end
    if value.allowed == false and sip_codes[sip_code]
        and type(value.reason) == 'string' then
        return { allowed = false, sip_code = sip_code }
    end
    return nil
end

local function allow(seconds, unverified)
    session:setVariable('billing_authorized', 'true')
    session:setVariable('billing_unverified', unverified and 'true' or 'false')
    -- 在 A-leg 接通后才开始计时，振铃不占用授权时长；不要提前 answer。
    local timer = 'sched_hangup +' .. seconds .. ' ALLOTTED_TIMEOUT'
    if session:answered() then
        session:execute('sched_hangup', '+' .. seconds .. ' ALLOTTED_TIMEOUT')
    else
        session:setVariable('execute_on_answer', timer)
    end
end

if not session:ready() then return end
session:setVariable('billing_authorized', 'false')
local routed_digits = destination:gsub('^%+', '')
local billing_number
if destination:match('^%+') then
    billing_number = destination:sub(2)
elseif destination:match('^00') then
    billing_number = destination:sub(3)
else
    billing_number = '86' .. destination:gsub('^0', '')
end
-- Worker 核验此投影；本地校验也覆盖授权超时放行的通话。
if not routed_digits:match('^[0-9]+$') or #routed_digits > 17
    or not billing_number:match('^[1-9][0-9]*$') or #billing_number < 6 or #billing_number > 15 then
    session:execute('respond', '484')
    session:hangup('INVALID_NUMBER_FORMAT')
    return
end
session:setVariable('billing_destination', destination)
session:setVariable('billing_number', billing_number)

if not url or not url:match('^http://[%d%.]+:%d+$') or not key or #key < 16
    or key:find('[\r\n]') then
    freeswitch.consoleLog('ERR', '计费授权配置错误\n')
    session:execute('respond', '503')
    session:hangup('SERVICE_UNAVAILABLE')
    return
end

local request = assert(json.encode({
    tenant = session:getVariable('billing_tenant') or '',
    callee = billing_number,
    dialedNumber = destination,
    billingNumber = billing_number,
    uuid = session:get_uuid(),
}))
local chunks = {}
local handle, init_error = curl.easy({
    url = url .. '/authorize',
    post = true,
    postfields = request,
    httpheader = { 'Content-Type: application/json', 'X-Billing-Key: ' .. key },
    timeout_ms = 1500,
    connecttimeout_ms = 1500,
    nosignal = true,
    proxy = '',
    writefunction = function(chunk)
        chunks[#chunks + 1] = chunk
        return #chunk
    end,
})
if not handle then error(init_error) end
local completed = handle:perform()
local status = handle:getinfo_response_code()
handle:close()
if not session:ready() then return end
local result = completed and (status == 200 or status == 400)
    and decision(table.concat(chunks)) or nil
if result then
    if result.allowed then
        if result.billing_number ~= billing_number then
            freeswitch.consoleLog('ERR', '计费授权号码不一致\n')
            session:execute('respond', '503')
            session:hangup('CALL_REJECTED')
            return
        end
        allow(result.seconds, false)
    else
        session:execute('respond', tostring(result.sip_code))
        session:hangup('CALL_REJECTED')
    end
elseif status == 401 or status == 403 or status == 400 then
    -- 配置或请求错误不按网络超时放行；不把响应正文（可能含凭据）写入日志。
    freeswitch.consoleLog('ERR', '计费授权请求被拒绝 HTTP ' .. status .. '\n')
    session:execute('respond', '503')
    session:hangup('CALL_REJECTED')
else
    freeswitch.consoleLog('WARNING', '计费授权无有效响应 uuid=' .. session:get_uuid() .. '\n')
    allow(1800, true)
end
