# Call pricing

The rating caller rounds whole talk seconds to a billing cycle and multiplies Decimal minutes by the rate without rounding the charge. Source: `packages/rating/src/billing.ts`, `billing.test.ts`, and `money.ts`.

## Sub-features

- `pricing-default` applies the default 60/60-second cycle.
- `pricing-cycle` supports explicit initial/increment cycles such as 6/6 or 1/1.
- `pricing-precision` keeps fractional charges until display formatting.

## How to get to it (user POV)

- Run package acceptance from the repository root; callers use `priceCall`, `billedSeconds`, and `billedMinutes`. There is no charging HTTP route yet.

## Driving it with package commands

Preconditions: installed dependencies.

```sh
pnpm test packages/rating/src/billing.test.ts
```

- Require exit 0. Zero seconds charges zero; one second bills one minute. 190, 230, and 240 seconds bill four minutes; 241 seconds bills five.
- At `0.0333`, 61 seconds costs exactly `0.0666`, displayed as `0.07`. Seven seconds on 6/6 bills 12 seconds, or `0.2` minutes.
- Save command, summary, and exit code.

## Gotchas

- Negative/fractional talk seconds and nonpositive/fractional cycle seconds throw.
- The four-hour cap belongs to authorization; pricing itself does not impose it.
- Pricing does not insert a CDR or ledger entry. Database charge events use negative amounts, whereas this function returns a nonnegative cost.
