import { ESLint, Linter } from 'eslint';
import tseslint from 'typescript-eslint';
import { expect, test } from 'vitest';
import { eslintCommentsPlugin } from '../tooling/eslint/guardrails.ts';

function lint(code: string) {
  return new Linter().verify(code, {
    languageOptions: { parser: tseslint.parser },
    plugins: { '@eslint-community/eslint-comments': eslintCommentsPlugin },
    linterOptions: { reportUnusedDisableDirectives: 'error' },
    rules: {
      '@eslint-community/eslint-comments/require-description': [
        'error',
        { ignore: ['eslint-enable'] },
      ],
    },
  });
}

test('rejects eslint-disable without a description', () => {
  const messages = lint(
    '/* eslint-disable no-console */\nexport const x = 1;\n',
  );
  expect(
    messages.some(
      (message) =>
        message.ruleId ===
          '@eslint-community/eslint-comments/require-description' &&
        message.message.includes('改用'),
    ),
  ).toBe(true);
});

test('allows eslint-disable with a reason', () => {
  const messages = lint(
    '/* eslint-disable no-console -- leftover */\nexport const x = 1;\n',
  );
  expect(
    messages.some(
      (message) =>
        message.ruleId ===
        '@eslint-community/eslint-comments/require-description',
    ),
  ).toBe(false);
});

test('repository config reports an undescribed disable', async () => {
  const results = await new ESLint().lintText(
    '/* eslint-disable no-console */\nexport const ok = 1;\n',
    { filePath: 'apps/api/src/app.ts' },
  );
  expect(
    results
      .flatMap((result) => result.messages)
      .some(
        (message) =>
          message.ruleId ===
            '@eslint-community/eslint-comments/require-description' &&
          message.message.includes('改用'),
      ),
  ).toBe(true);
}, 30_000);

test('repository config reports an unused disable', async () => {
  const results = await new ESLint().lintText(
    '/* eslint-disable no-console -- leftover */\nexport const ok = 1;\n',
    { filePath: 'apps/api/src/app.ts' },
  );
  expect(
    results
      .flatMap((result) => result.messages)
      .some(
        (message) =>
          message.message.includes('Unused eslint-disable') ||
          message.ruleId ===
            '@eslint-community/eslint-comments/no-unused-disable',
      ),
  ).toBe(true);
}, 30_000);
