import { ESLint } from 'eslint';
import { expect, test } from 'vitest';

test('repository config keeps R1, R2 and R3 on the same worker file', async () => {
  const results = await new ESLint().lintText(
    [
      'export const month = new Date(2026, 7, 31).getMonth();',
      'export const write = (tx: { insert: (t: unknown) => unknown }, systemAlerts: unknown) => tx.insert(systemAlerts);',
      'export const fail = (error: unknown) => { console.error(error); };',
    ].join('\n'),
    { filePath: 'apps/worker/src/app.ts' },
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
        message.ruleId === 'no-restricted-syntax' &&
        message.message.includes('raiseAlert'),
    ),
  ).toBe(true);
  expect(
    messages.some(
      (message) =>
        message.ruleId === 'no-restricted-globals' &&
        message.message.includes('pino'),
    ),
  ).toBe(true);
}, 30_000);
