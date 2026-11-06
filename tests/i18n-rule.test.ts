import { ESLint, Linter } from 'eslint';
import tseslint from 'typescript-eslint';
import { expect, test } from 'vitest';
import { i18nRestrictedSyntax } from '../tooling/eslint/guardrails.ts';

function lint(code: string) {
  return new Linter().verify(code, {
    languageOptions: {
      parser: tseslint.parser,
      sourceType: 'module',
      parserOptions: { ecmaFeatures: { jsx: true } },
    },
    rules: { 'no-restricted-syntax': ['error', ...i18nRestrictedSyntax] },
  });
}

function reportsI18n(code: string) {
  const messages = lint(code);
  expect(messages.every((message) => !message.fatal)).toBe(true);
  expect(
    messages.some(
      (message) =>
        message.ruleId === 'no-restricted-syntax' &&
        message.message.includes('文案键'),
    ),
  ).toBe(true);
}

test.each([
  "const label = '中文';",
  "const label = 'English 中文';",
  'const label = `中文`;',
  'const label = `前缀 ${value} 中文`;',
  'const label = <span>中文</span>;',
  'const label = <span aria-label="语言" />;',
  "const label = <span>{'中文'}</span>;",
])('rejects hard-coded Chinese in web source: %s', reportsI18n);

test.each([
  "const label = 'Language';",
  'const label = `Hello ${value}`;',
  'const label = <span>Language</span>;',
  'const label = <span aria-label="Language" />;',
  '// 中文注释不受限制\nconst label = 1;',
  "import zh from './zh.js';\nexport const catalog = zh;",
])('allows English, comments, and imports: %s', (code) => {
  expect(lint(code)).toEqual([]);
});

test('repository config flags Chinese in a non-allowlisted web file', async () => {
  const results = await new ESLint().lintText("export const label = '中文';", {
    filePath: 'apps/web/src/components/locale-menu.tsx',
  });
  expect(
    results
      .flatMap((result) => result.messages)
      .some(
        (message) =>
          message.ruleId === 'no-restricted-syntax' &&
          message.message.includes('文案键'),
      ),
  ).toBe(true);
}, 30_000);

test('repository config leaves the allowlist, i18n adapters, and tests alone', async () => {
  for (const filePath of [
    'apps/web/src/pages/home.tsx',
    'apps/web/src/pages/admin/statements.tsx',
    'apps/web/src/i18n/detect.ts',
    'apps/web/src/components/theme-controls.test.tsx',
  ]) {
    const results = await new ESLint().lintText(
      "export const label = '中文';",
      { filePath },
    );
    expect(
      results
        .flatMap((result) => result.messages)
        .some((message) => message.message.includes('文案键')),
      filePath,
    ).toBe(false);
  }
}, 30_000);
