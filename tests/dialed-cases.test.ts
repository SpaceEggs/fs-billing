import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';
import {
  DIALED_CASES_PATH,
  invalidCases,
  loadDialedCases,
  parseDialedCases,
  unescapeField,
  validCases,
} from './dialed-cases.js';

const lua = spawnSync('lua5.3', ['-v']);

describe('shared dialed number cases', () => {
  test('the shared case file is well formed and read by both sides', () => {
    const text = readFileSync(DIALED_CASES_PATH, 'utf8');
    expect(text.endsWith('\n')).toBe(true);
    expect(text).not.toContain('\r');
    // 每个非注释行都是 valid 或 invalid，字段个数对；parseDialedCases 对任何坏行抛错。
    const cases = loadDialedCases();
    const lines = text
      .split('\n')
      .filter((line) => line !== '' && !line.startsWith('#'));
    expect(cases).toHaveLength(lines.length);
    expect(validCases(cases).length).toBeGreaterThanOrEqual(10);
    expect(invalidCases(cases).length).toBeGreaterThanOrEqual(20);
    // 同一个拨号不能重复，更不能既合法又非法。
    const dialed = cases.map((c) => c.dialed);
    expect(new Set(dialed).size).toBe(dialed.length);
    for (const c of validCases(cases)) {
      expect(c.billing).toMatch(/^[1-9][0-9]{5,14}$/);
    }
  });

  // 无 lua5.3 的本机跳过，CI 必跑（同 tests/billing-authorize.test.ts）。
  test.skipIf(
    !process.env.CI && lua.error?.message.includes('ENOENT') === true,
  )('the Lua test reads the same number of cases', () => {
    const cases = loadDialedCases();
    const result = spawnSync(
      'lua5.3',
      ['freeswitch/tests/billing_authorize_test.lua'],
      { encoding: 'utf8' },
    );
    expect(result.status).toBe(0);
    expect(result.stdout).toContain(
      `dialed cases: ${validCases(cases).length} valid, ${invalidCases(cases).length} invalid\n`,
    );
  });

  test('parses fields, escapes and comments', () => {
    expect(
      parseDialedCases(
        [
          '# 注释',
          '',
          'valid\t+44 1\t4471',
          'valid\t\\s44\\s\t4471',
          'invalid\t\\e',
          'invalid\ta\\tb\\nc\\rd\\\\e',
          '',
        ].join('\n'),
      ),
    ).toEqual([
      { kind: 'valid', dialed: '+44 1', billing: '4471' },
      { kind: 'valid', dialed: ' 44 ', billing: '4471' },
      { kind: 'invalid', dialed: '' },
      { kind: 'invalid', dialed: 'a\tb\nc\rd\\e' },
    ]);
  });

  test.each([
    'unknown\t1',
    'valid\t1',
    'valid\t1\t2\t3',
    'invalid\t1\t2',
    'invalid',
    'invalid\t\\x',
    'invalid\t1\\',
  ])('rejects the malformed line %j', (line) => {
    expect(() => parseDialedCases(`${line}\n`)).toThrow();
  });

  test('unescapes every supported escape', () => {
    expect(unescapeField('\\t\\n\\r\\s\\e\\\\')).toBe('\t\n\r \\');
  });
});
