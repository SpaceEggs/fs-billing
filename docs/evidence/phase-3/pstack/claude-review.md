Warning: no stdin data received in 3s, proceeding without it. If piping from a slow command, redirect stdin explicitly: < /dev/null to skip, or wait longer.
I found no blockers. All three fixes behave correctly, there are 4 SHOULDs (two are docs that now describe the old behavior) and 7 NITs. I edited no files. The 31 non-database tests pass (`tests/cdr-time.test.ts`, `tests/billing-authorize.test.ts`, `apps/worker/src/app.test.ts`), with `lua5.3` installed. I did not run `pnpm test:db`, so `cdr-time.db.test.ts` and the live-repro script are unverified.

## SHOULD

1. **`freeswitch/README.md:12` now says the opposite of what happens.** It says numbers with non-digit characters "仍交给 Worker 返回 号码格式错误". After this change, the dialplan or Lua rejects them before any `/authorize` request: Lua answers 484, and the dialplan regex sends them to "no route". Update the README to describe the new rule.

2. **`docs/worker-api.md:71-72` and the `/authorize` section are out of date.** They mention only `start_epoch`/`end_epoch`/`answer_epoch`, with `answer_epoch` defaulting to 0. They need to say:
   - `*_uepoch` takes priority over `*_epoch`.
   - Each `*_uepoch` must agree with its `*_epoch` (same whole second).
   - Times are cut to milliseconds.
   - `/authorize` returns 503 `{"error":"授权服务暂不可用"}`, and Lua treats that as the 1800 s unverified fallback.

3. **The number rule now lives in four places with three different length limits:**
   - `packages/rating/src/dialed.ts:13`: digits, not starting `00`, no length limit.
   - `freeswitch/scripts/billing_authorize.lua:41`: adds a 15-digit maximum.
   - `freeswitch/dialplan/billing.xml:5`: allows `{1,15}` after an optional `00`.
   - `freeswitch/dialplan/billing.xml:18`: `(?!00)[0-9]{1,15}`.

   You asked for the same rule as the rating module, but rating still accepts 16+ digits on `/authorize` and `/cdr`. Either add the 15-digit cap to `parseDialedNumber`, so rating is the single definition and Lua mirrors it, or explicitly document 15 as a FreeSWITCH-only limit.

4. **The outbound dialplan regex changes what the caller hears (`billing.xml:5`).** A number like `4471x` or a 16-digit number now fails the only extension in the `billing` context. FreeSWITCH then hangs up with NO_ROUTE_DESTINATION (SIP 404), not the 484 that Lua sends. Meanwhile, the 484 cases in `freeswitch/tests/billing_authorize_test.lua:59-61` (`4471x`, `' 4471'`, `|evil`) can never reach Lua in production. Two options:
   - Keep the dialplan loose (`^(.+)$`) and let Lua be the gate, which gives a single 484 behavior.
   - Add an anti-action `respond 484` to the outbound condition.

   I'd keep the regex for defense in depth and add the anti-action.

## NIT

5. **`billing.xml:18`: a failing bridge-context check has no explicit response.** In the FreeSWITCH XML dialplan, conditions in one extension are ANDed (`break="on-false"` by default), and a failing condition runs only its own anti-actions. So if the `${billing_destination}` check fails, `respond 503` (on the third condition) does not run. `execute_extension` finds no match and the outer `hangup NORMAL_CLEARING` runs instead. It's safe because no bridge happens, but add an anti-action `respond 484` there if you want an explicit response.

6. **`packages/shared/src/worker.ts:89-91, 117-128`: the same microsecond expression is computed twice.** `uepoch ?? epoch*1e6` appears in both `superRefine` and the final transform, and `answeredAt` repeats it twice within the transform. Compute `startUs`/`answerUs`/`endUs` once in the `variables` transform at `:70`. Also, the seconds-level checks at `:101-103` are now implied by the microsecond checks plus the same-second agreement checks. They're kept only for the `billsec`/`duration` logic, which is fine, but could carry a comment.

7. **`worker.ts`: the timestamp semantics look correct.** Unanswered calls send `answer_epoch=0` / `answer_uepoch=0`, and those map to `answeredAt=null`. A mismatched pair such as `answer_epoch>0` with `answer_uepoch=0` is rejected. Truncating to milliseconds keeps ordering, so a `.900` answer picks the rate that took effect at `.500`. Writing millisecond `started_at` into partitions and `call_uuids` is fine: it doesn't change which partition a row lands in, and dedup is on `call_uuid` only. The only open point is the `billsec`/`duration` arithmetic: I'm checking that `duration = end_epoch - start_epoch` matches FreeSWITCH from memory of `switch_channel_set_timestamps`, not from the source.

8. **`/authorize` 503 during a real outage (`apps/worker/src/app.ts:72-75`).** The Lua timeout (1500 ms) is shorter than `WORKER_DB_CONNECTION_TIMEOUT_MS` (5000 ms by default). When the database hangs rather than refusing connections, Lua times out and falls back before the 503 arrives. The fix mainly helps the fast-fail case and keeps error details out of the response body. The same applies to `/cdr`: it can now take up to two connection timeouts (insert, then alert) before answering 503. Behavior is unchanged in both cases (Lua still falls back), so this is informational.

9. **`apps/worker/src/app.test.ts:36-60` is tied to implementation details.** It spies on `db.transaction` and asserts the call count (`expectedTransactions`), which assumes `withSystem` maps to exactly one `db.transaction` call. The status and body assertions are what matter; I'd drop the count. The test does fail on main: the unhandled error becomes a 500 whose message includes "private".

10. **`tests/billing-authorize.test.ts:7` skips silently when `lua5.3` is missing.** Local `pnpm check` can pass without running the Lua harness; only CI guarantees it. That's acceptable given the CI step, but consider failing when `CI` is set. On `.github/workflows/ci.yml:29`: `apt-get update` on every run is slow and can fail on network flakes; `apt-get install --no-install-recommends` or a cached setup action would be steadier.

11. **`docs/evidence/phase-3/live-repro-pstack.sh`:**
    - It hardcodes `cd /workspace/fs-billing`, port 3902 and the container name `fs-billing-postgres-1`.
    - It `docker stop`s the shared dev Postgres.
    - It uses `set -u` without `-e`.
    - It inserts a tenant without `lock_tenants`.

    It's evidence rather than product code, but drop "pstack" from the filename and parameterize the path and container, or keep it out of the commit.

## Checks that passed

- **Tests fail on main.** The Lua harness: main sends an auth request for `|evil`. `cdr-time.test.ts`: main strips `answer_uepoch`, so the `.900` case gets rate 0.1, and invalid `uepoch` values are accepted. `cdr-time.db.test.ts`: rate 0.1 with `.000` timestamps on main. The dialplan regex tests: main's `^(.+)$` matches `|evil`.
- **Lua validation order.** Validation runs before the config check and before the HTTP call. A malformed number never reaches `allow(1800, true)`.
- **Phase-2 rules.** The diff adds no new locks, transactions, retries or partition creation. `recordAlert` keeps its existing `lockTenants(tx, [])` and is now just wrapped as best-effort. Money code is untouched.
