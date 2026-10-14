# Worker call authorization

The FreeSWITCH caller asks Worker for permission before bridging. Sources: `apps/worker/src/app.ts`, `packages/shared/src/worker.ts`, and `freeswitch/scripts/billing_authorize.lua`.

## Sub-features

- `authorize-live` reads current tenant status, balance, overdraft and effective prefix rates from the app-role database.
- `authorize-reject` returns a reason and suggested SIP code for unknown/disabled tenants, missing rates or exhausted balance.
- `authorize-number` normalizes `dialedNumber`, including `+` and `00` international prefixes, and returns HTTP 400 for invalid syntax or a result outside 6–15 digits.
- `authorize-freeswitch` preserves the dialed destination, computes a separate billing projection, responds with the suggested SIP code or starts `sched_hangup +N` on answer.
- `authorize-fallback` caps a timeout/no-response call at 1800 seconds and marks its CDR unverified.
- `authorize-performance` measures 500 rate entries and 1000 sequential real HTTP requests.

## How to get to it (user POV)

Start Worker with app-role configuration and queue installation from `docs/worker-api.md`. POST `/authorize` with `X-Billing-Key` and JSON containing `tenant`, normalized `callee`, original `dialedNumber`, and `uuid`, with an optional matching `billingNumber` projection. For real calls, install the examples in `freeswitch/README.md` on the test machine.

## Driving it with HTTP and calls

```sh
pnpm test:db apps/worker/src/app.db.test.ts -t '授权'
pnpm perf:authorize
```

Require passing HTTP/DB assertions for live tenant decisions and number rejection. Save response JSON, test output and exit codes. The performance command owns an ephemeral HTTP listener, creates a dedicated tenant, and disables it after the run; rates remain. Require `passed=true` and `p95Ms < 50` with 500 entries and 1000 requests.

On FreeSWITCH, call with `+447…` and `00447…`. Require the bridge destination, request `dialedNumber`, and CDR `billing_dialed_number` to preserve the original form; request `callee` and both billing projections must contain the same normalized digits. Use a tenant with only one minute available and require answer plus about 60 seconds to hangup, excluding ringing. Test a business rejection without an upstream bridge. Stop Worker, call again, and record the 1.5-second fallback, unverified flag and answer-time timer. Restore Worker and verify the resulting CDR charge.

## Gotchas

- Authorization reserves no balance and creates no charge or UUID registration. Parallel calls can spend the same available balance; FreeSWITCH concurrency limits bound this exposure.
- Runtime uses milliseconds through Lua-cURL. Dependencies must match mod_lua's Lua ABI. Missing dependencies or invalid local configuration are setup failures.
- HTTP 401/403 and malformed-request 400 fail closed with SIP 503. Network failures, 5xx and unusable success responses use the fallback.
- API health or unit tests alone do not prove real call timers. Report the actual-call sub-features as skipped until driven on a FreeSWITCH machine.
