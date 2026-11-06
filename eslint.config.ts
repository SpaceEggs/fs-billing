import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import prettier from 'eslint-config-prettier';
import money from './tooling/eslint/money.ts';
import i18nAllowlist from './tooling/eslint/i18n-allowlist.json' with { type: 'json' };
import {
  alertRestrictedSyntax,
  consoleRestrictedGlobals,
  consoleRestrictedImports,
  eslintCommentsPlugin,
  fetchRestrictedGlobals,
  i18nRestrictedSyntax,
  ledgerRestrictedSyntax,
  localTimeRestrictedSyntax,
} from './tooling/eslint/guardrails.ts';

const sourceExt = '{ts,tsx,mts,mjs,js,cjs}';

const testFiles = [
  `**/*.test.${sourceExt}`,
  `**/*.spec.${sourceExt}`,
  '**/test/**',
  'tests/**',
  'apps/web/e2e/**',
];

const ledgerWriteFiles = [
  'packages/db/src/ledger.ts',
  'packages/db/src/alerts.ts',
  'packages/db/src/seed-alerts.ts',
];

export default tseslint.config(
  {
    ignores: [
      '**/node_modules/**',
      '**/dist/**',
      '**/coverage/**',
      'design/**',
      '.audit/**',
      'apps/web/test-results/**',
      'apps/web/playwright-report/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  {
    files: ['**/*.ts', '**/*.tsx', '**/*.mts'],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },
  {
    // .mjs/.js/.cjs 不进 tsconfig。api/worker/db 的 .mts 与 web 以外的 .tsx 也不在内，
    // 类型规则跑不起来；关掉之后语法护栏仍然生效。
    files: [`**/*.{mjs,js,cjs,mts}`],
    ignores: ['tooling/**/*.mts'],
    ...tseslint.configs.disableTypeChecked,
  },
  {
    files: ['**/*.tsx'],
    ignores: ['apps/web/**/*.tsx'],
    ...tseslint.configs.disableTypeChecked,
  },
  {
    files: ['.cursor/skills/verify-fs-billing/scripts/*.mjs'],
    ignores: ['.cursor/skills/verify-fs-billing/scripts/browser-fns.mjs'],
    languageOptions: {
      globals: {
        process: 'readonly',
        console: 'readonly',
        URL: 'readonly',
        fetch: 'readonly',
        setTimeout: 'readonly',
      },
    },
  },
  {
    // page.evaluate 回调在浏览器内执行，只有这个文件拿浏览器全局变量、不拿 Node 的。
    files: ['.cursor/skills/verify-fs-billing/scripts/browser-fns.mjs'],
    languageOptions: {
      globals: {
        document: 'readonly',
        Event: 'readonly',
        localStorage: 'readonly',
      },
    },
  },
  {
    files: [
      'packages/rating/**/*.ts',
      'packages/db/**/*.ts',
      'apps/worker/**/*.ts',
      'apps/web/src/**/*.{ts,tsx}',
    ],
    plugins: { money },
    rules: { 'money/no-number-money': 'error' },
  },
  {
    files: ['apps/web/src/**/*.{ts,tsx}'],
    rules: {
      // TanStack Router 以抛出 redirect() 结果的方式跳转。
      '@typescript-eslint/only-throw-error': [
        'error',
        {
          allow: [
            {
              from: 'package',
              package: '@tanstack/router-core',
              name: 'Redirect',
            },
          ],
        },
      ],
    },
  },
  {
    files: [`**/*.${sourceExt}`],
    ignores: testFiles,
    rules: {
      'no-restricted-syntax': ['error', ...localTimeRestrictedSyntax],
    },
  },
  {
    files: [`**/*.${sourceExt}`],
    ignores: [...testFiles, ...ledgerWriteFiles],
    rules: {
      'no-restricted-syntax': [
        'error',
        ...localTimeRestrictedSyntax,
        ...ledgerRestrictedSyntax,
        ...alertRestrictedSyntax,
      ],
    },
  },
  {
    files: [
      `apps/api/src/**/*.${sourceExt}`,
      `apps/worker/src/**/*.${sourceExt}`,
      `packages/db/src/**/*.${sourceExt}`,
    ],
    // bin 是迁移/种子 CLI，stdout 就是产品（同 apps/*/scripts）。
    ignores: [...testFiles, 'packages/db/src/bin/**'],
    languageOptions: {
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
  },
  {
    plugins: { '@eslint-community/eslint-comments': eslintCommentsPlugin },
    linterOptions: { reportUnusedDisableDirectives: 'error' },
    rules: {
      '@eslint-community/eslint-comments/require-description': [
        'error',
        { ignore: ['eslint-enable'] },
      ],
    },
  },
  {
    files: [`apps/web/src/**/*.${sourceExt}`],
    ignores: [...testFiles, 'apps/web/src/i18n/**', ...i18nAllowlist],
    rules: {
      'no-restricted-syntax': [
        'error',
        ...localTimeRestrictedSyntax,
        ...ledgerRestrictedSyntax,
        ...alertRestrictedSyntax,
        ...i18nRestrictedSyntax,
      ],
    },
  },
  {
    files: [`apps/web/src/**/*.${sourceExt}`],
    ignores: [...testFiles, 'apps/web/src/lib/api.ts'],
    languageOptions: {
      globals: {
        fetch: 'readonly',
        XMLHttpRequest: 'readonly',
        globalThis: 'readonly',
        self: 'readonly',
        window: 'readonly',
        global: 'readonly',
      },
    },
    rules: {
      'no-restricted-globals': ['error', fetchRestrictedGlobals],
    },
  },
  prettier,
);
