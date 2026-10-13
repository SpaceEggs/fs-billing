# Rate selection

The rating caller selects the latest effective whole-table snapshot at the answer instant, then the longest matching prefix within it. Source: `packages/rating/src/rates.ts` and `rates.test.ts` (`versionAt`, `longestPrefix`, `findRate`).

## Sub-features

- `rates-prefix` prefers `1876` over `1` and `447` over `44`.
- `rates-effective` includes the exact effective instant of a new version.
- `rates-missing` returns `undefined` when no effective version or prefix exists.

## How to get to it (user POV)

- Run the package acceptance command from the repository root. Persisted version changes have a separate [database feature](db-rate-versions.md).

## Driving it with package commands

Preconditions: installed dependencies.

```sh
pnpm test packages/rating/src/rates.test.ts
```

- Require exit 0 and passing selection tests. `18761234567` selects `1876`, `44712345678` selects `447`, `12125551234` selects `1`, and `442071234567` selects `44`.
- The Beijing boundary fixture selects `0.045` at `2026-09-30 23:59:59`, then `0.048` at `2026-10-01 00:00:00`.
- Capture the test summary and exit code.

## Gotchas

- Version selection does not require sorted input; equal effective times retain the first encountered version. Equal matching prefix lengths retain the first entry.
- A new snapshot replaces the whole table. A missing prefix does not fall back to an older version.
- These pure functions do not validate caller-created table shapes or deduplicate them. CSV and database boundaries provide additional checks.
