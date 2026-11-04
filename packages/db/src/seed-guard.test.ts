import { expect, test } from 'vitest';
import { assertSeedAllowed, SeedRefused } from './seed-guard.js';

test.each([
  ['production', false, false],
  ['production', true, false],
  ['production', true, true],
] as const)(
  'refuses NODE_ENV=production (hasData=%s, force=%s)',
  (nodeEnv, hasData, force) => {
    expect(() => assertSeedAllowed({ nodeEnv, hasData, force })).toThrow(
      SeedRefused,
    );
    expect(() => assertSeedAllowed({ nodeEnv, hasData, force })).toThrow(
      '生产环境禁止写入演示种子数据',
    );
  },
);

test('refuses a non-empty database unless --force is passed', () => {
  expect(() =>
    assertSeedAllowed({ nodeEnv: 'development', hasData: true, force: false }),
  ).toThrow(SeedRefused);
  expect(() =>
    assertSeedAllowed({ nodeEnv: undefined, hasData: true, force: false }),
  ).toThrow('数据库已有数据');
  expect(() =>
    assertSeedAllowed({ nodeEnv: 'development', hasData: true, force: true }),
  ).not.toThrow();
});

test('allows a fresh database without a switch', () => {
  for (const nodeEnv of [undefined, 'development', 'test']) {
    expect(() =>
      assertSeedAllowed({ nodeEnv, hasData: false, force: false }),
    ).not.toThrow();
  }
});
