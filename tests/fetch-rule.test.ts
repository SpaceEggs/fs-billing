import { ESLint, Linter } from 'eslint';
import tseslint from 'typescript-eslint';
import { expect, test } from 'vitest';
import { fetchRestrictedGlobals } from '../tooling/eslint/guardrails.ts';

function lint(code: string) {
  return new Linter().verify(code, {
    languageOptions: {
      parser: tseslint.parser,
      sourceType: 'module',
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
  });
}

function reportsFetch(code: string) {
  const messages = lint(code);
  expect(messages.every((message) => !message.fatal)).toBe(true);
  expect(
    messages.some(
      (message) =>
        message.ruleId === 'no-restricted-globals' &&
        message.message.includes('改用') &&
        message.message.includes('callApi'),
    ),
  ).toBe(true);
}

test.each([
  'export const load = () => fetch("/api/health");',
  'export const load = () => window.fetch("/api/health");',
  'export const load = () => globalThis.fetch("/api/health");',
  'export const load = () => self.fetch("/api/health");',
  'export const load = () => global.fetch("/api/health");',
  'export const load = () => new XMLHttpRequest();',
  'export const load = () => new window.XMLHttpRequest();',
  'export const load = () => new globalThis.XMLHttpRequest();',
  'export const load = () => new self.XMLHttpRequest();',
])('rejects direct HTTP: %s', reportsFetch);

test.each([
  'export function wrap(fetch: () => Promise<unknown>) { return fetch(); }',
  'export const load = () => callApi("session");',
  'export const load = () => apiQuery("adminTenants");',
])('allows shadowed fetch and callApi: %s', (code) => {
  expect(lint(code)).toEqual([]);
});

test('repository config flags fetch and XMLHttpRequest on global objects', async () => {
  const results = await new ESLint().lintText(
    [
      'export const load = () => self.fetch("/api/health");',
      'export const open = () => new window.XMLHttpRequest();',
      'export const openToo = () => new globalThis.XMLHttpRequest();',
    ].join('\n'),
    { filePath: 'apps/web/src/lib/session.ts' },
  );
  const messages = results.flatMap((result) => result.messages);
  expect(
    messages.filter(
      (message) =>
        message.ruleId === 'no-restricted-globals' &&
        message.message.includes('callApi'),
    ),
  ).toHaveLength(3);
}, 30_000);

test('repository config flags fetch outside api.ts', async () => {
  const results = await new ESLint().lintText(
    'export const load = () => fetch("/api/health");',
    { filePath: 'apps/web/src/lib/session.ts' },
  );
  expect(
    results
      .flatMap((result) => result.messages)
      .some(
        (message) =>
          message.ruleId === 'no-restricted-globals' &&
          message.message.includes('callApi'),
      ),
  ).toBe(true);
}, 30_000);

test('repository config allows fetch in api.ts and a fetch parameter', async () => {
  const direct = await new ESLint().lintText(
    'export const load = () => fetch("/api/health");',
    { filePath: 'apps/web/src/lib/api.ts' },
  );
  expect(
    direct
      .flatMap((result) => result.messages)
      .some((message) => message.message.includes('callApi')),
  ).toBe(false);

  const shadowed = await new ESLint().lintText(
    'export function wrap(fetch: () => Promise<unknown>) { return fetch(); }',
    { filePath: 'apps/web/src/lib/receivables.ts' },
  );
  expect(
    shadowed
      .flatMap((result) => result.messages)
      .some((message) => message.message.includes('callApi')),
  ).toBe(false);
}, 30_000);

test('repository config keeps R1 and R5 on the same web file', async () => {
  const results = await new ESLint().lintText(
    'export const month = new Date(2026, 7, 31).getMonth();\nexport const load = () => fetch("/api/health");',
    { filePath: 'apps/web/src/pages/login.tsx' },
  );
  const messages = results.flatMap((result) => result.messages);
  expect(
    messages.some(
      (message) =>
        message.ruleId === 'no-restricted-syntax' &&
        message.message.includes('beijing-time.ts'),
    ),
  ).toBe(true);
  expect(
    messages.some(
      (message) =>
        message.ruleId === 'no-restricted-globals' &&
        message.message.includes('callApi'),
    ),
  ).toBe(true);
}, 30_000);
