import { ESLint, Linter } from 'eslint';
import tseslint from 'typescript-eslint';
import { expect, test } from 'vitest';
import money from '../tooling/eslint/money.ts';

function lint(code: string) {
  return new Linter().verify(code, {
    languageOptions: { parser: tseslint.parser },
    plugins: { money },
    rules: { 'money/no-number-money': 'error' },
  });
}

test.each([
  'const fee = 0.1 * 3;',
  'const fee = 10 * 3;',
  'const rate = 0.1; const x = rate; const y = x * 3;',
  'const rate = 1; let x; x = rate; const y = x + 2;',
  'const fee = 1; fee += 2;',
  'let balance = 100; balance--;',
  'function calculateFee(x: number) { return x * 3; }',
  'const calculateFee = (x: number) => x * 3;',
  'const calculateFee = (x: number) => { return x * 3; };',
  'const data = { amount: seconds / 60 };',
  'const next = tenant.balance - 100;',
  'const next = tenant["balance"] - 100;',
  'const { rate: x } = data; const y = x * 3;',
  'const rate = 1; const x = rate; { const x = 2; const y = x * 3; } const z = x * 3;',
  'const rate = 1; const n = Math.round(rate);',
  'const fee = Number("0.1");',
  'const amount = parseFloat("0.1");',
  'const x = 0.1 * 3;',
  'const rate = 1; const x = rate as number; const y = x / 60;',
  'const rate = 1; const x = condition ? rate : 0; const y = x * 60;',
])('rejects unsafe money arithmetic: %s', (code) => {
  const messages = lint(code);
  expect(
    messages.some((message) => message.ruleId === 'money/no-number-money'),
  ).toBe(true);
  expect(messages.every((message) => !message.fatal)).toBe(true);
});

test.each([
  'const fee = decimal("0.1").mul("3");',
  'const balance = decimal("100").minus("5");',
  'const rate = new Decimal("0.0480");',
  'const seconds = 60 * minutes;',
  'const nextPort = port + 1;',
  'const minutes = Math.floor(seconds / 60);',
  'const rate = 1; const x = rate; { const x = 2; const y = x * 3; }',
  'const rate = 1; function f(rateSeconds: number) { return 1; } const x = seconds * 60;',
])('allows decimal methods and ordinary integer arithmetic: %s', (code) => {
  expect(lint(code)).toEqual([]);
});

test.each(['packages/rating/src/index.ts', 'apps/worker/src/app.ts'])(
  'repository ESLint config protects %s',
  async (filePath) => {
    const results = await new ESLint().lintText('export const fee = 0.1 * 3;', {
      filePath,
    });
    expect(
      results
        .flatMap((result) => result.messages)
        .some((message) => message.ruleId === 'money/no-number-money'),
    ).toBe(true);
  },
);
