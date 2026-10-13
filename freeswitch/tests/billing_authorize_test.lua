local script = arg[1] or 'freeswitch/scripts/billing_authorize.lua'

local function run(destination, response)
    local variables = { destination_number = destination, billing_tenant = 'tenant1' }
    local actions = {}
    local requests = 0
    local hangup
    session = {
        ready = function() return hangup == nil end,
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
        encode = function() return '{}' end,
        decode = function() return nil end,
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
                getinfo_response_code = function() return response == '5xx' and 503 or 200 end,
                close = function() end,
            }
        end,
    }
    dofile(script)
    if variables.billing_authorized == 'true' then
        session:execute('bridge', 'sofia/gateway/upstream/' .. variables.billing_destination)
    end
    return variables, actions, requests, hangup
end

local failures = {}
local function check(condition, message)
    if not condition then failures[#failures + 1] = message end
end

for _, response in ipairs({ 'timeout', '5xx', 'invalid' }) do
    for _, destination in ipairs({
        '44712345678|evil', '44712345678,evil', '44712345678/evil',
        '', '+', '000044712345678', '4471x', ' 4471', '1234567890123456',
    }) do
        local variables, actions, requests, hangup = run(destination, response)
        local label = response .. ' ' .. destination
        check(variables.billing_authorized == 'false', label .. ' must not be allowed')
        check(actions.bridge == nil, label .. ' must not bridge')
        check(requests == 0, label .. ' must reject before requesting authorization')
        check(actions.respond == '484', label .. ' must respond 484')
        check(hangup == 'INVALID_NUMBER_FORMAT', label .. ' must hang up for invalid number')
    end
    for _, destination in ipairs({ '44712345678', '+44712345678', '0044712345678' }) do
        local variables, actions, requests, hangup = run(destination, response)
        check(variables.billing_authorized == 'true', response .. ' valid number must be allowed')
        check(variables.billing_unverified == 'true', response .. ' must mark billing unverified')
        check(variables.execute_on_answer == 'sched_hangup +1800 ALLOTTED_TIMEOUT',
            response .. ' must limit fallback to 1800 seconds after answer')
        check(actions.bridge == 'sofia/gateway/upstream/44712345678', response .. ' must bridge normalized number')
        check(requests == 1 and hangup == nil, response .. ' must attempt authorization without hanging up')
    end
end

assert(#failures == 0, table.concat(failures, '\n'))
print('billing_authorize fallback tests passed')
