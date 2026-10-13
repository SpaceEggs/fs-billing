# Call authorization

The rating caller gets a decision from a tenant snapshot, normalized called number, and instant. `authorizeRaw` validates the raw number first; `authorize` takes a validated number. Source: `packages/rating/src/authorize.ts`, `dialed.ts`, and `authorize.test.ts`.

## Sub-features

- `authorize-allow` computes whole callable minutes from balance plus overdraft and the selected rate.
- `authorize-reject` returns an explicit rejection reason.
- `authorize-cap` limits an allowed call to 14,400 seconds.

## How to get to it (user POV)

- From the repository root, drive the package acceptance suite. The API and Worker do not yet expose an authorization endpoint.
- Package callers use exports from `@fs-billing/rating`; authorization reads the supplied snapshot and performs no reservation or ledger write.

## Driving it with package commands

Preconditions: installed project dependencies; no server or database required.

```sh
pnpm test packages/rating/src/authorize.test.ts
```

- Require exit 0 and passing authorization tests. At rate `0.0480`, balance `-35.20` plus overdraft `100` allows 1,350 minutes but caps `maxSeconds` at 14,400. Balance `-99` plus `100` at `0.05` allows 20 minutes and 1,200 seconds.
- Require exact rejection reasons: `号码格式错误`, `租户不存在`, `租户已停用`, `无费率`, `余额不足`. Raw syntax is checked before tenant existence; tenant status before rate lookup.
- Save the command, test summary, and exit code under the evidence directory.

## Gotchas

- Less than one minute of available funds rejects; zero or negative available funds reject even at zero rate. Zero rate with positive funds returns 240 minutes and the four-hour cap.
- The decision does not hold funds, enforce concurrent-call limits, or persist a charge.
- Missing effective version or matching prefix produces `无费率`; number normalization belongs outside this function.
