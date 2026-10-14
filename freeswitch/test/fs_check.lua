local failed = false
local function check(condition, name)
    local line = (condition and 'PASS ' or 'FAIL ') .. name .. '\n'
    freeswitch.consoleLog(condition and 'NOTICE' or 'ERR', line)
    if stream then stream:write(line) end
    if not condition then failed = true end
end

check(_VERSION == 'Lua 5.3', 'lua_version')
local curl_ok, curl = pcall(require, 'cURL.safe')
check(curl_ok and type(curl.easy) == 'function', 'cURL.safe' .. (curl_ok and '' or ': ' .. tostring(curl)))
local json_ok, json = pcall(require, 'cjson.safe')
check(json_ok and type(json.decode) == 'function', 'cjson.safe' .. (json_ok and '' or ': ' .. tostring(json)))
if json_ok then
    local value = json.decode('{"n":60}')
    local number = type(value) == 'table' and value.n
    local integer = type(number) == 'number' and math.tointeger and math.tointeger(number)
    check(integer == 60 and math.type(integer) == 'integer' and tostring(integer) == '60',
        'json_integer_conversion')
end
check(not failed, 'FS_CHECK')
