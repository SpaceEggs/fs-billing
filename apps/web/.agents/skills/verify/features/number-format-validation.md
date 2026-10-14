# Number and amount validation

Rating boundaries validate dialed syntax and finite decimal amounts/rates, retain precision, and format money for display. Source: `packages/rating/src/dialed.ts`, `money.ts`, `money.test.ts`, and number-boundary cases in `authorize.test.ts`.

## Sub-features

- `number-dialed` normalizes an optional `+` and 1–17 ASCII digits. `+` and `00` mark international numbers; domestic forms gain `86` after removing one leading zero. The result must have 6–15 digits and start with 1–9.
- `number-decimal` rejects nonfinite values; rates must be nonnegative and at most four Decimal decimal places.
- `number-display` shows two decimals using half-up rounding without changing the amount.
- `number-currency` rejects mixed-currency addition through types and a runtime guard.

## How to get to it (user POV)

- Run the package tests and typecheck from the repository root. Callers use `normalizeDialedNumber`, `resolveBillingNumber`, `parseDialedNumber`, `decimal`, `money`, `rate`, `formatMoney`, and `addMoney`.

## Driving it with package commands

Preconditions: installed dependencies.

```sh
pnpm test packages/rating/src/money.test.ts packages/rating/src/authorize.test.ts packages/rating/src/dialed.test.ts
pnpm --filter @fs-billing/rating typecheck
```

- Require both commands to exit 0. Normalization accepts `+447700900123` and `00447700900123` as `447700900123`; whitespace, empty strings, letters, and invalid normalized lengths reject.
- `NaN` and infinities reject. Negative rates and excessive Decimal precision reject. Money may be negative and retain more than two decimal places.
- Display fixtures include `0.005` → `0.01`, `1.2345` → `1.23`, and `-35.2` → `-35.20`. Mixed currency addition is rejected; record test and typecheck summaries.

## Gotchas

- `parseDialedNumber` validates already normalized 6–15 digit numbers. `normalizeDialedNumber` handles dialed prefixes; neither accepts whitespace.
- Decimal constructors accept Decimal.js string syntax; CSV separately requires ordinary decimal syntax and counts textual decimal places, including trailing zeros.
- Currency is typed as CNY/USD; untyped callers do not get constructor runtime currency validation. Display rounding must not be used as the stored charge.
