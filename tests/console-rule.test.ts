import { ESLint, Linter } from 'eslint';
import tseslint from 'typescript-eslint';
import { expect, test } from 'vitest';
import {
  consoleRestrictedGlobals,
  consoleRestrictedImports,
} from '../tooling/eslint/guardrails.ts';

function lint(code: string) {
  return new Linter().verify(code, {
    languageOptions: {
      parser: tseslint.parser,
      sourceType: 'module',
      globals: {
        console: 'readonly',
        globalThis: 'readonly',
        self: 'readonly',
        window: 'readonly',
        global: 'readonly',
      },
    },
    rules: {
      'no-restricted-globals': ['error', consoleRestrictedGlobals],
      'no-restricted-imports': ['error', consoleRestrictedImports],
    },
  });
}

test.each([
  'console.error(error);',
  "console.log('ingest failed', err);",
  'console.table(rows);',
  'console.warn(msg);',
  'globalThis.console.error(err);',
  'window.console.error(err);',
  'self.console.error(err);',
  'global.console.error(err);',
  "import { error } from 'node:console';",
  "import { error } from 'console';",
])('rejects console.*: %s', (code) => {
  const messages = lint(code);
  expect(messages.every((message) => !message.fatal)).toBe(true);
  expect(
    messages.some(
      (message) =>
        (message.ruleId === 'no-restricted-globals' ||
          message.ruleId === 'no-restricted-imports') &&
        message.message.includes('改用') &&
        message.message.includes('scrubErrorForLog'),
    ),
  ).toBe(true);
});

test.each([
  "process.stdout.write('迁移完成\\n');",
  'logger.error({ err: scrubErrorForLog(err) }, "ingest failed");',
  'export function wrap(console: { error: (err: unknown) => void }, err: unknown) { console.error(err); }',
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
          (message.ruleId === 'no-restricted-globals' ||
            message.ruleId === 'no-restricted-imports') &&
          message.message.includes('scrubErrorForLog'),
      ),
  ).toBe(true);
}, 30_000);

test('repository config flags globalThis.console and console imports', async () => {
  const results = await new ESLint().lintText(
    [
      'export const fail = (err: unknown) => { globalThis.console.error(err); };',
      "import { error } from 'node:console';",
      "import { log } from 'console';",
      'export const report = (err: unknown) => error(err) ?? log(err);',
    ].join('\n'),
    { filePath: 'apps/api/src/logging.ts' },
  );
  const messages = results.flatMap((result) => result.messages);
  expect(
    messages.some(
      (message) =>
        message.ruleId === 'no-restricted-globals' &&
        message.message.includes('scrubErrorForLog'),
    ),
  ).toBe(true);
  expect(
    messages.filter(
      (message) =>
        message.ruleId === 'no-restricted-imports' &&
        message.message.includes('scrubErrorForLog'),
    ),
  ).toHaveLength(2);
}, 30_000);

test('repository config leaves CLI bin unrestricted', async () => {
  const results = await new ESLint().lintText(
    "import { error } from 'node:console';\nconsole.table([{ code: 'ABC001' }]);\nerror('done');\n",
    { filePath: 'packages/db/src/bin/seed.ts' },
  );
  expect(
    results
      .flatMap((result) => result.messages)
      .some((message) => message.message.includes('scrubErrorForLog')),
  ).toBe(false);
}, 30_000);
