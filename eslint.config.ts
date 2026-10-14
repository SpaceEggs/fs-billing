import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import prettier from 'eslint-config-prettier';
import money from './tooling/eslint/money.ts';

export default tseslint.config(
  {
    ignores: [
      '**/node_modules/**',
      '**/dist/**',
      '**/coverage/**',
      'design/**',
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
    files: ['**/*.mjs'],
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
  prettier,
);
