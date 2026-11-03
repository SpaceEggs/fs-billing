import { ESLint } from 'eslint';
import { expect, test } from 'vitest';

const eslint = new ESLint();

const consoleEsm =
  'export const fail = (error: unknown) => { console.error(error); };';
const consoleCjs =
  'module.exports.fail = (error) => { console.error(error); };';
const fetchEsm = 'export const load = () => fetch("/api/health");';
const fetchCjs = 'module.exports.load = () => fetch("/api/health");';
const dateEsm = 'export const month = new Date(2026, 7, 31);';
const dateCjs = 'module.exports.month = new Date(2026, 7, 31);';
const alertEsm =
  'export const write = (tx: { insert: (t: unknown) => unknown }, systemAlerts: unknown) => tx.insert(systemAlerts);';
const alertCjs =
  'module.exports.write = (tx, systemAlerts) => tx.insert(systemAlerts);';

const flagged = [
  [
    'apps/api/src/app.ts',
    'scrubErrorForLog',
    'no-restricted-globals',
    consoleEsm,
  ],
  [
    'apps/api/src/x.tsx',
    'scrubErrorForLog',
    'no-restricted-globals',
    consoleEsm,
  ],
  [
    'apps/api/src/x.mts',
    'scrubErrorForLog',
    'no-restricted-globals',
    consoleEsm,
  ],
  [
    'apps/api/src/x.mjs',
    'scrubErrorForLog',
    'no-restricted-globals',
    consoleEsm,
  ],
  [
    'apps/worker/src/x.js',
    'scrubErrorForLog',
    'no-restricted-globals',
    consoleEsm,
  ],
  [
    'packages/db/src/x.cjs',
    'scrubErrorForLog',
    'no-restricted-globals',
    consoleCjs,
  ],
  ['apps/web/src/lib/session.ts', 'callApi', 'no-restricted-globals', fetchEsm],
  ['apps/web/src/main.tsx', 'callApi', 'no-restricted-globals', fetchEsm],
  ['apps/web/src/x.mts', 'callApi', 'no-restricted-globals', fetchEsm],
  ['apps/web/src/x.mjs', 'callApi', 'no-restricted-globals', fetchEsm],
  ['apps/web/src/x.js', 'callApi', 'no-restricted-globals', fetchEsm],
  ['apps/web/src/x.cjs', 'callApi', 'no-restricted-globals', fetchCjs],
  [
    'apps/worker/src/app.ts',
    'beijing-time.ts',
    'no-restricted-syntax',
    dateEsm,
  ],
  [
    'apps/web/src/pages/login.tsx',
    'beijing-time.ts',
    'no-restricted-syntax',
    dateEsm,
  ],
  ['apps/worker/src/x.mts', 'beijing-time.ts', 'no-restricted-syntax', dateEsm],
  ['apps/worker/src/x.mjs', 'beijing-time.ts', 'no-restricted-syntax', dateEsm],
  [
    'packages/rating/src/x.js',
    'beijing-time.ts',
    'no-restricted-syntax',
    dateEsm,
  ],
  [
    'packages/rating/src/x.cjs',
    'beijing-time.ts',
    'no-restricted-syntax',
    dateCjs,
  ],
  ['apps/worker/src/app.ts', 'raiseAlert', 'no-restricted-syntax', alertEsm],
  ['packages/db/src/x.tsx', 'raiseAlert', 'no-restricted-syntax', alertEsm],
  ['packages/db/src/x.mts', 'raiseAlert', 'no-restricted-syntax', alertEsm],
  ['packages/db/src/x.mjs', 'raiseAlert', 'no-restricted-syntax', alertEsm],
  ['apps/api/src/x.js', 'raiseAlert', 'no-restricted-syntax', alertEsm],
  ['apps/worker/src/x.cjs', 'raiseAlert', 'no-restricted-syntax', alertCjs],
] as const;

test.each(flagged)(
  '%s reports %s',
  async (filePath, needle, ruleId, code) => {
    const results = await eslint.lintText(code, { filePath });
    expect(
      results
        .flatMap((result) => result.messages)
        .some(
          (message) =>
            !message.fatal &&
            message.ruleId === ruleId &&
            message.message.includes('改用') &&
            message.message.includes(needle),
        ),
    ).toBe(true);
  },
  30_000,
);

test('verify scripts may use console, fetch, and non-local Date formatting', async () => {
  const results = await eslint.lintText(
    [
      'console.log(new Date().toISOString());',
      'await fetch("https://example.test");',
      'export const label = (1).toLocaleString("en-US");',
    ].join('\n'),
    { filePath: '.cursor/skills/verify-fs-billing/scripts/drive.mjs' },
  );
  const messages = results.flatMap((result) => result.messages);
  expect(messages.some((message) => message.fatal)).toBe(false);
  expect(
    messages.some(
      (message) =>
        message.message.includes('scrubErrorForLog') ||
        message.message.includes('callApi') ||
        message.message.includes('beijing-time.ts'),
    ),
  ).toBe(false);
}, 30_000);

test('bin and test files stay exempt on the added extensions', async () => {
  const samples = [
    ['packages/db/src/bin/seed.mjs', consoleEsm, 'scrubErrorForLog'],
    ['packages/rating/src/time.test.mjs', dateEsm, 'beijing-time.ts'],
    ['apps/web/src/session.test.mjs', fetchEsm, 'callApi'],
    ['packages/db/src/usage.db.test.mjs', alertEsm, 'raiseAlert'],
  ] as const;
  for (const [filePath, code, needle] of samples) {
    const results = await eslint.lintText(code, { filePath });
    expect(
      results
        .flatMap((result) => result.messages)
        .some((message) => message.message.includes(needle)),
    ).toBe(false);
  }
}, 30_000);
