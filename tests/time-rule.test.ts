import { ESLint, Linter } from 'eslint';
import tseslint from 'typescript-eslint';
import { expect, test } from 'vitest';
import { localTimeRestrictedSyntax } from '../tooling/eslint/guardrails.ts';

function lint(code: string) {
  return new Linter().verify(code, {
    languageOptions: { parser: tseslint.parser },
    rules: { 'no-restricted-syntax': ['error', ...localTimeRestrictedSyntax] },
  });
}

function reportsLocalTime(code: string) {
  const messages = lint(code);
  expect(messages.every((message) => !message.fatal)).toBe(true);
  expect(
    messages.some(
      (message) =>
        message.ruleId === 'no-restricted-syntax' &&
        message.message.includes('改用') &&
        message.message.includes('beijing-time.ts'),
    ),
  ).toBe(true);
}

test.each([
  'const dayLabel = i => { const x = new Date(2026, 7, 31 + i); return `${x.getMonth() + 1}-${x.getDate()}`; };',
  'const nowStr = () => { const d = new Date(); return `${d.getHours()}:${d.getMinutes()}`; };',
  'const d = new Date(); d.getDate();',
  'const d = new Date(); d.getFullYear();',
  'const d = new Date(); d.getDay();',
  'const d = new Date(); d.setHours(0, 0, 0, 0);',
  'const d = new Date(); d.setDate(1);',
  'const d = new Date(); d.toLocaleDateString();',
  'const d = new Date(); d.toDateString();',
  'const d = new Date(); d.getMinutes();',
  'const d = new Date(); d.getSeconds();',
  'const d = new Date(); d.getMilliseconds();',
  'const d = new Date(); d.setMinutes(0);',
  'const d = new Date(); d.setSeconds(0);',
  'const d = new Date(); d.setMilliseconds(0);',
  'const d = new Date(); d.setMonth(0);',
  'const d = new Date(); d.setFullYear(2026);',
  'const d = new Date(); d.toLocaleTimeString();',
  'const d = new Date(); d.toTimeString();',
  'const d = new Date(); d.toLocaleString();',
  "const d = new Date(); d['getDate']();",
  "const d = new Date(); d['toLocaleString']();",
  "const d = new Date(); d['toLocaleTimeString']();",
  'const x = new Date(2026, 7);',
  'const x = new Date(2026, 7, 31, 12, 0, 0);',
])('rejects local-timezone Date usage: %s', reportsLocalTime);

test.each([
  'const x = new Date();',
  'const x = new Date(1_725_000_000_000);',
  "const x = new Date('2026-09-29T00:00:00+08:00');",
  'const x = Date.UTC(2026, 7, 31);',
  'const d = new Date(); d.getUTCDay();',
  'const d = new Date(); d.getUTCHours();',
  "const d = new Date(); d['getUTCHours']();",
  'const d = new Date(); d.getTime();',
  'const d = new Date(); d.setTime(0);',
  'const d = new Date(); d.getTimezoneOffset();',
  "const n = 12345; n.toLocaleString('en-US');",
  "const d = new Date(); d.toLocaleString('en-US');",
  'const d = new Date(); d.toISOString();',
])('allows UTC, ISO, and numeric toLocaleString: %s', (code) => {
  expect(lint(code)).toEqual([]);
});

test.each([
  'packages/rating/src/time.ts',
  'apps/web/src/pages/admin/unassigned.tsx',
])(
  'repository ESLint config protects %s',
  async (filePath) => {
    const results = await new ESLint().lintText(
      'export const month = new Date(2026, 7, 31).getMonth();',
      { filePath },
    );
    const messages = results.flatMap((result) => result.messages);
    expect(
      messages.some(
        (message) =>
          message.ruleId === 'no-restricted-syntax' &&
          message.message.includes('beijing-time.ts'),
      ),
    ).toBe(true);
  },
  30_000,
);

test('repository config flags literal computed local Date access', async () => {
  const results = await new ESLint().lintText(
    "export const day = new Date()['getDate']();\nexport const label = new Date().toLocaleString();",
    { filePath: 'packages/rating/src/time.ts' },
  );
  const messages = results.flatMap((result) => result.messages);
  expect(
    messages.filter(
      (message) =>
        message.ruleId === 'no-restricted-syntax' &&
        message.message.includes('beijing-time.ts'),
    ),
  ).toHaveLength(2);
}, 30_000);

test('repository config leaves tests unrestricted', async () => {
  const results = await new ESLint().lintText(
    'export const month = new Date(2026, 7, 31).getMonth();',
    { filePath: 'packages/rating/src/time.test.ts' },
  );
  expect(
    results
      .flatMap((result) => result.messages)
      .some((message) => message.message.includes('beijing-time.ts')),
  ).toBe(false);
}, 30_000);
