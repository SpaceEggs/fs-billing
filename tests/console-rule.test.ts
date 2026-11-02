import { ESLint, Linter } from 'eslint';
import tseslint from 'typescript-eslint';
import { expect, test } from 'vitest';
import { consoleRestrictedGlobals } from '../tooling/eslint/guardrails.ts';

function lint(code: string) {
  return new Linter().verify(code, {
    languageOptions: {
      parser: tseslint.parser,
      globals: { console: 'readonly' },
    },
    rules: { 'no-restricted-globals': ['error', ...consoleRestrictedGlobals] },
  });
}

test.each([
  'console.error(error);',
  "console.log('ingest failed', err);",
  'console.table(rows);',
  'console.warn(msg);',
])('rejects console.*: %s', (code) => {
  const messages = lint(code);
  expect(messages.every((message) => !message.fatal)).toBe(true);
  expect(
    messages.some(
      (message) =>
        message.ruleId === 'no-restricted-globals' &&
        message.message.includes('改用') &&
        message.message.includes('pino'),
    ),
  ).toBe(true);
});

test.each([
  "process.stdout.write('迁移完成\\n');",
  'logger.error({ err: scrubErrorForLog(err) }, "ingest failed");',
])('allows stdout and pino: %s', (code) => {
  expect(lint(code)).toEqual([]);
});

test('repository config flags console in runtime src', async () => {
  const results = await new ESLint().lintText(
    'export const fail = (error: unknown) => { console.error(error); };',
    { filePath: 'apps/api/src/app.ts' },
  );
  expect(
    results
      .flatMap((result) => result.messages)
      .some(
        (message) =>
          message.ruleId === 'no-restricted-globals' &&
          message.message.includes('pino'),
      ),
  ).toBe(true);
}, 30_000);

test('repository config leaves CLI bin unrestricted', async () => {
  const results = await new ESLint().lintText(
    'console.table([{ code: "ABC001" }]);',
    { filePath: 'packages/db/src/bin/seed.ts' },
  );
  expect(
    results
      .flatMap((result) => result.messages)
      .some((message) => message.message.includes('pino')),
  ).toBe(false);
}, 30_000);
