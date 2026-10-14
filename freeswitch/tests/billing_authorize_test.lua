local script = arg[1] or 'freeswitch/scripts/billing_authorize.lua'

local function run(destination, response, ready, http_status)
    local variables = { destination_number = destination, billing_tenant = 'tenant1' }
    local actions = {}
    local requests = 0
    local request
    local hangup
    session = {
        ready = function() return ready ~= false and hangup == nil end,
        answered = function() return false end,
        getVariable = function(_, name) return variables[name] end,
        setVariable = function(_, name, value) variables[name] = value end,
        get_uuid = function() return '00000000-0000-4000-8000-000000000001' end,
        execute = function(_, application, data) actions[application] = data end,
        hangup = function(_, cause) hangup = cause end,
    }
    freeswitch = {
        API = function()
            return { execute = function(_, _, name)
                if name == 'billing_worker_url' then return 'http://127.0.0.1:3000' end
                return 'shared-test-key-1234'
            end }
        end,
        consoleLog = function() end,
    }
    package.loaded['cjson.safe'] = {
        encode = function(value) request = value; return '{}' end,
        decode = function() return type(response) == 'table' and response or nil end,
    }
    package.loaded['cURL.safe'] = {
        easy = function(options)
            requests = requests + 1
            return {
                perform = function()
                    if response == 'timeout' then return nil end
                    options.writefunction('invalid response')
                    return true
                end,
                getinfo_response_code = function() return http_status or (response == '5xx' and 503 or 200) end,
                close = function() end,
            }
        end,
    }
    dofile(script)
    if variables.billing_authorized == 'true' then
        session:execute('bridge', 'sofia/gateway/upstream/' .. variables.billing_destination)
    end
    return variables, actions, requests, hangup, request
end

local failures = {}
local function check(condition, message)
    if not condition then failures[#failures + 1] = message end
end

for _, response in ipairs({ 'timeout', '5xx', 'invalid' }) do
    for _, destination in ipairs({
        '44712345678|evil', '44712345678,evil', '44712345678/evil',
        '', '+', '0', '1', '+1', '0044', '000044712345678', '4471x', ' 4471', '4471 ', '44 71',
        '4471\n', '4471\r', '44\t71',
        '1234567890123456', '+1234567890123456', '001234567890123456',
        '00123456789012345678', '+0044712345678',
    }) do
        local variables, actions, requests, hangup = run(destination, response)
        local label = response .. ' ' .. destination
        check(variables.billing_authorized == 'false', label .. ' must not be allowed')
        check(variables.billing_dialed_number == destination, label .. ' must preserve original dialed number before rejecting')
        check(actions.bridge == nil, label .. ' must not bridge')
        check(requests == 0, label .. ' must reject before requesting authorization')
        check(actions.respond == '484', label .. ' must respond 484')
        check(hangup == 'INVALID_NUMBER_FORMAT', label .. ' must hang up for invalid number')
    end
    for _, case in ipairs({
        { '13800138000', '8613800138000' },
        { '07551234567', '867551234567' },
        { '13051234567', '8613051234567' },
        { '+13051234567', '13051234567' },
        { '+44712345678', '44712345678' },
        { '0044712345678', '44712345678' },
        { '00123456789012345', '123456789012345' },
    }) do
        local destination, expected_billing = case[1], case[2]
        local variables, actions, requests, hangup, request = run(destination, response)
        check(variables.billing_authorized == 'true', response .. ' valid number must be allowed')
        check(variables.billing_unverified == 'true', response .. ' must mark billing unverified')
        check(variables.execute_on_answer == 'sched_hangup +1800 ALLOTTED_TIMEOUT',
            response .. ' must limit fallback to 1800 seconds after answer')
        check(actions.bridge == 'sofia/gateway/upstream/' .. destination, response .. ' must bridge original number')
        check(variables.destination_number == destination, response .. ' must preserve destination_number')
        check(variables.billing_dialed_number == destination, response .. ' must preserve CDR dialed number')
        check(variables.billing_number == expected_billing, response .. ' must set normalized billing_number')
        check(requests == 1 and hangup == nil, response .. ' must attempt authorization without hanging up')
        check(request.callee == expected_billing and request.dialedNumber == destination,
            response .. ' must send normalized callee and original dialedNumber')
    end
end

for _, seconds in ipairs({ 60, 60.0 }) do
    local variables, actions, _, _, request = run('+44712345678',
        { allowed = true, maxSeconds = seconds, billingNumber = '44712345678' })
    check(variables.execute_on_answer == 'sched_hangup +60 ALLOTTED_TIMEOUT',
        tostring(seconds) .. ' must produce an integer timer')
    check(variables.billing_unverified == 'false', 'valid allowance must be verified')
    check(actions.bridge == 'sofia/gateway/upstream/+44712345678', 'valid allowance must bridge original number')
    check(variables.billing_number == '44712345678', 'valid allowance must set verified billing number')
    check(request.callee == '44712345678' and request.dialedNumber == '+44712345678'
        and request.billingNumber == '44712345678', 'authorize must send dialed number and billing projection')
end

for _, wrong_billing in ipairs({ '8613800138000', 1234, false, 'missing' }) do
    local variables, actions, _, hangup = run('+44712345678',
        { allowed = true, maxSeconds = 60, billingNumber = wrong_billing ~= 'missing' and wrong_billing or nil })
    check(variables.billing_authorized == 'false' and actions.bridge == nil,
        'worker billing mismatch must fail closed')
    check(actions.respond == '503' and hangup == 'CALL_REJECTED',
        'worker billing mismatch must reject without fallback')
end

local not_ready, _, not_ready_requests = run('+44712345678', 'timeout', false)
check(not_ready.billing_dialed_number == '+44712345678' and not_ready_requests == 0,
    'unready session must preserve original dialed number before returning')

local fractional = run('44712345678', { allowed = true, maxSeconds = 60.5 })
check(fractional.billing_unverified == 'true', 'fractional allowance must use invalid-response fallback')
check(fractional.execute_on_answer == 'sched_hangup +1800 ALLOTTED_TIMEOUT',
    'fractional allowance must use the fallback timer')

local denied, deny_actions, _, deny_hangup = run('44712345678',
    { allowed = false, sipCode = 402.0, reason = 'insufficient_balance' })
check(deny_actions.respond == '402', 'float SIP code must produce respond 402')
check(denied.billing_authorized == 'false' and deny_actions.bridge == nil,
    'business rejection must not bridge')
check(deny_hangup == 'CALL_REJECTED', 'business rejection must hang up')

local invalid_number, invalid_actions = run('13800138000',
    { allowed = false, sipCode = 484, reason = 'invalid_number' })
check(invalid_number.billing_authorized == 'false' and invalid_actions.respond == '484',
    'worker number rejection must respond 484 without fallback')

local bad_request, bad_request_actions, _, bad_request_hangup = run('44712345678',
    { allowed = false, sipCode = 400, reason = 'bad_request' }, true, 400)
check(bad_request.billing_authorized == 'false' and bad_request_actions.bridge == nil,
    'HTTP 400 with unsupported SIP code must not bridge')
check(bad_request_actions.respond == '503' and bad_request_hangup == 'CALL_REJECTED',
    'HTTP 400 with unsupported SIP code must respond 503')

local invalid_code = run('44712345678',
    { allowed = false, sipCode = 402.5, reason = 'insufficient_balance' })
check(invalid_code.billing_unverified == 'true', 'fractional SIP code must use invalid-response fallback')

assert(#failures == 0, table.concat(failures, '\n'))
print('billing_authorize fallback tests passed')
