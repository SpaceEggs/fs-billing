import { ESLint, Linter } from 'eslint';
import tseslint from 'typescript-eslint';
import { expect, test } from 'vitest';
import {
  alertRestrictedSyntax,
  ledgerRestrictedSyntax,
  localTimeRestrictedSyntax,
} from '../tooling/eslint/guardrails.ts';

function lint(code: string) {
  return new Linter().verify(code, {
    languageOptions: { parser: tseslint.parser },
    rules: {
      'no-restricted-syntax': [
        'error',
        ...localTimeRestrictedSyntax,
        ...ledgerRestrictedSyntax,
        ...alertRestrictedSyntax,
      ],
    },
  });
}

function reports(code: string, needle: string) {
  const messages = lint(code);
  expect(messages.every((message) => !message.fatal)).toBe(true);
  expect(
    messages.some(
      (message) =>
        message.ruleId === 'no-restricted-syntax' &&
        message.message.includes('改用') &&
        message.message.includes(needle),
    ),
  ).toBe(true);
}

test.each([
  "await tx.insert(ledgerEntries).values({ tenantId, kind: 'adjustment', amount: '-5.00' })",
  "await tx.insert(schema.ledgerEntries).values({ tenantId, kind: 'adjustment', amount: '-5.00' })",
  "insert(ledgerEntries).values({ tenantId, kind: 'adjustment', amount: '-5.00' })",
  "insert(schema.ledgerEntries).values({ kind: 'adjustment' })",
])('rejects direct ledger inserts: %s', (code) => {
  reports(code, 'appendLedgerEntry');
});

test.each([
  "tx.insert(schema.systemAlerts).values({ tenantId, kind: 'audit_failed', description: '重置密码的审计写入失败' })",
  "await tx.insert(systemAlerts).values({ tenantId, kind: 'statement_mismatch', description: wanted.description })",
  "insert(schema.systemAlerts).values({ kind: 'audit_failed' })",
])('rejects direct alert inserts: %s', (code) => {
  reports(code, 'raiseAlert');
});

test.each([
  'await appendLedgerEntry(tx, tenant, entry);',
  'await appendLedgerEntries(tx, entries);',
  'await raiseAlert(tx, input);',
  'await recoverAlert(tx, id);',
  'await tx.insert(calls).values({ tenantId });',
  'await tx.select().from(ledgerEntries);',
])('allows helpers and other tables: %s', (code) => {
  expect(lint(code)).toEqual([]);
});

test('repository config flags inserts outside the write-path modules', async () => {
  const results = await new ESLint().lintText(
    'export const write = (tx: { insert: (t: unknown) => unknown }, systemAlerts: unknown) => tx.insert(systemAlerts);',
    { filePath: 'apps/worker/src/app.ts' },
  );
  expect(
    results
      .flatMap((result) => result.messages)
      .some(
        (message) =>
          message.ruleId === 'no-restricted-syntax' &&
          message.message.includes('raiseAlert'),
      ),
  ).toBe(true);
}, 30_000);

test('repository config allows insert in ledger.ts and seed-alerts.ts', async () => {
  const sample =
    'export const write = (tx: { insert: (t: unknown) => unknown }, ledgerEntries: unknown) => tx.insert(ledgerEntries);';
  for (const filePath of [
    'packages/db/src/ledger.ts',
    'packages/db/src/alerts.ts',
    'packages/db/src/seed-alerts.ts',
    'packages/db/src/usage.db.test.ts',
    'packages/db/test/statements.ts',
  ]) {
    const results = await new ESLint().lintText(sample, { filePath });
    expect(
      results
        .flatMap((result) => result.messages)
        .some((message) => message.message.includes('appendLedgerEntry')),
    ).toBe(false);
  }
}, 30_000);
