import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { expect, test } from 'vitest';

const lua = spawnSync('lua5.3', ['-v']);

test.skipIf(!process.env.CI && lua.error?.message.includes('ENOENT') === true)(
  'FreeSWITCH rejects malformed destinations before fallback authorization',
  () => {
    const result = spawnSync(
      'lua5.3',
      ['freeswitch/tests/billing_authorize_test.lua'],
      { encoding: 'utf8' },
    );
    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
    expect(result.stdout).toBe('billing_authorize fallback tests passed\n');
  },
);

const dialplan = readFileSync('freeswitch/dialplan/billing.xml', 'utf8');
const expression = dialplan.match(
  /field="destination_number" expression="([^"]+)"/,
);
if (!expression?.[1]) throw new Error('Missing outbound destination condition');
const outbound = new RegExp(expression[1]);
const bridgeExpression = dialplan.match(
  /field="\$\{billing_destination\}" expression="([^"]+)"/,
);
const bridgeDestination = bridgeExpression?.[1]
  ? new RegExp(bridgeExpression[1])
  : /[\s\S]*/;

test.each([
  '44712345678|evil',
  '44712345678,evil',
  '44712345678/evil',
  '+4471x',
])('dialplan rejects bridge separators in %s', (destination) => {
  expect(outbound.test(destination)).toBe(false);
});

test.each(['44712345678', '+44712345678', '0044712345678'])(
  'dialplan routes valid number %s to authorization',
  (destination) => {
    expect(outbound.test(destination)).toBe(true);
  },
);

test.each([
  '44712345678|evil',
  '44712345678,evil',
  '44712345678/evil',
  '0044712345678',
  '1234567890123456',
])('bridge context refuses unsafe destination %s', (destination) => {
  expect(bridgeDestination.test(destination)).toBe(false);
});

test.each(['1', '44712345678', '123456789012345'])(
  'bridge context accepts normalized destination %s',
  (destination) => {
    expect(bridgeDestination.test(destination)).toBe(true);
  },
);

test.each(['destination_number', '${billing_destination}'])(
  'dialplan responds 484 and hangs up for a failed %s condition',
  (field) => {
    const condition = [
      ...dialplan.matchAll(
        /<condition\s+field="([^"]+)" expression="[^"]+">([\s\S]*?)<\/condition>/g,
      ),
    ].find((match) => match[1] === field);
    expect(condition?.[2]).toContain(
      '<anti-action application="respond" data="484" />',
    );
    expect(condition?.[2]).toContain(
      '<anti-action application="hangup" data="INVALID_NUMBER_FORMAT" />',
    );
  },
);
