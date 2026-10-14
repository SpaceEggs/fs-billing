The blast-radius pass is done. I'm waiting on the four reviewers (Opus, the session model standing in for Fable, Sonnet, Haiku) before I put together the findings.

Reviewer C is back. Old Lua that gets a 484 from the new worker fails closed with a 503, so C's finding 8 is only a nit. Still waiting on A, B and D.

B and D are back. D refused a stray plan-file instruction it picked up from a tool result, which was the right call for a read-only reviewer. Waiting on Reviewer A (Opus).

# Review of `dial-number-format` against `main` (commit 18e95fa)

I didn't edit any repo files; the only file I wrote is the review summary in the plan file. I ran pstack interrogate with four reviewers and a blast-radius pass. The reviewers were A (Opus), B, C (Sonnet) and D (Haiku). B was meant to run on Fable, but the account has no usage credits for that model, so it ran on the session model instead. Blast-radius edge cases were checked by running the real `packages/rating/src/dialed.ts` under node.

**Verdict: nothing is BLOCKING; six findings are SHOULD FIX.** The core spec holds:

- **Bridge:** it uses the original number (`${billing_destination}` is the unmodified `destination_number`).
- **Billing number:** it is separate, and the 15-digit limit applies only to it.
- **484:** used for routes that aren't safe to bridge.
- **One function:** `resolveBillingNumber` serves both `/authorize` and CDR ingest.
- **Phase-2 rules:** ingest still runs `lockTenants` first, adds no partition creation, keeps retries at the outer layer, and uses decimal.js.
- **Lua checks:** `'86' .. gsub(...)` correctly keeps only the first return value, and `(?![\s\S])` is a strict end anchor in PCRE.

## SHOULD FIX

1. **The migration scans every `cdrs` partition while holding an exclusive lock.** Location: `packages/db/migrations/0003_billing_number.sql:2-6`. Raised by A, B and D; I confirmed it only by reading the code (no test run).
   - `ADD COLUMN … CHECK (…)` makes Postgres check every existing row, even though they are all NULL. `cdrs` is partitioned by `started_at`.
   - Step 1 of the rollout runs this while workers are live, so CDR ingest and `chargeCdr` wait behind it.
   - Migration `0002` already uses `NOT VALID` to avoid exactly this.
   - **Fix:** add the column with no constraint. Then `ADD CONSTRAINT … CHECK (…) NOT VALID` and `VALIDATE CONSTRAINT` as separate statements, with `SET lock_timeout`. Check that your Postgres version allows `NOT VALID` on a partitioned parent; if not, add it per partition.

2. **New Lua with an old worker silently mis-rates domestic calls.** Location: `freeswitch/scripts/billing_authorize.lua:100`. Raised by all four reviewers.
   - New Lua sends the raw `callee=13800138000`. The old worker accepts it and authorizes it against the NANP `1` rate. Its reply has no `billingNumber`, so the mismatch check is skipped and the call goes through.
   - The deploy order is enforced only by wording in the docs.
   - **Fix:** in the allow branch, treat a missing `billingNumber` like a mismatch (respond 503). Any worker that understands `dialedNumber` always sends it back (`app.ts:87`), so a wrong deploy order fails closed.
   - Optionally, also have Lua send `callee = billing_number` and `dialedNumber = destination`, so an old worker rates correctly during a rollback.

3. **A CDR with no marker is read as legacy, so CDRs from new Lua can get a fake `billing_number`.** Locations: `billing_authorize.lua:38,51-58` and `packages/rating/src/dialed.ts:35-41`. Raised by A and C; I proved it by running the code.
   - New Lua returns before it sets `billing_dialed_number` in three cases: the session isn't ready, the number gets a 484, or the script fails to load.
   - Those CDRs carry the raw `destination_number` and are parsed as already-international. `resolveBillingNumber({callee:'12345678901234'})` returned `12345678901234`, a 14-digit domestic number that Lua rejected because `86` + 14 digits is over 15. The row lands in `cdrs` with a NANP-looking `billing_number`.
   - The calls are unanswered, so nothing is charged, but the stored value is wrong.
   - **Fix:** set `billing_dialed_number` (or a `billing_protocol=2` variable) right after line 40, before any validation. Such CDRs then take the new path and are parked. Add a test for a marker-less CDR from new Lua.

4. **The legacy path accepts less than `main` did, and old Lua turns 484 into 503.** Locations: `dialed.ts:9` and `apps/worker/src/app.ts:19,73`. Raised by A, B and C; I checked the old fallback code on `main`.
   - Old Lua sends landline numbers like `075586001234` unchanged. `main` answered 404 (no rate). The new worker's legacy parse needs a first digit of 1–9, so it answers 400 with `sipCode:484`.
   - Old Lua's `sip_codes` table has no 484. It falls to the `status == 400` branch, logs a config error, and responds 503 on every landline call during the rollout window.
   - This contradicts the docs' claim that the new worker accepts old requests unchanged.
   - **Fix:** when `dialedNumber` is absent, return `sipCode: 400`. Also document that leading-`0` legacy numbers are now a format error rather than "no rate".

5. **Rate prefixes that start with `0`, or domestic prefixes without `86`, will never match after cutover.** Locations: `packages/db/migrations/0000_init.sql:97` and `packages/rating/src/csv.ts:82`. Raised by A.
   - Billing numbers can no longer start with `0`, and domestic numbers now carry `86`. Any tenant pricing domestic calls under `0755…` or `138…` gets "no rate" (SIP 404) on every domestic call.
   - **Fix:** before rolling out FreeSWITCH, list every effective `rate_entries.prefix` that matches `^0` or looks domestic without `86`. Tighten the CSV import and the DB CHECK to `^[1-9][0-9]*$` for new versions.

6. **A projection mismatch parks an answered call as a format error and throws away the computed number.** Locations: `dialed.ts:32-45` and `apps/worker/src/ingest.ts:137`. Raised by B and C.
   - `resolveBillingNumber` returns `undefined` in three cases: a bad number, `callee ≠ dialedNumber`, or a Lua projection that doesn't match.
   - All three are parked as `号码格式错误` (number format error) with `billing_number = NULL`. A Lua/worker version skew therefore looks exactly like a customer typo, and the correct billing number is lost.
   - **Fix:** return a tagged result: `{ok, billing} | {error: 'format' | 'mismatch'}`. Park mismatches under their own reason, store the number the worker computed, and alert.

## MINOR

- **`authorizeRaw` is dead code.** Location: `packages/rating/src/authorize.ts:66-73` (all four reviewers). It has no production caller and is a second parse entry point. Delete it and move its tests onto `resolveBillingNumber`.
- **The billing-number regex is duplicated.** Location: `packages/shared/src/worker.ts:5`. It repeats `parseDialedNumber`'s regex; use `z.string().refine(s => parseDialedNumber(s) !== undefined)`. Plain `$` is already strict in JS, so the `(?![\s\S])` lookahead is redundant there.
- **There is no minimum number length.** Location: `dialed.ts:15-22` and `billing_authorize.lua:48`. I ran the code: dialing `0` gives `86`, and `1` gives `861`. Both are authorized at the China rate and the carrier receives `0`. `+1` and `0044` work the same way, per D. **Fix:** require at least N subscriber digits after the country code, in TS and Lua, with tests.
- **Some doc wording is wrong or ambiguous.**
  - `docs/design.md:165` says old-protocol `callee` "已是国际号码" (is already an international number). That's false for domestic traffic from old Lua, which arrives as `13800138000` and still rates as NANP `1` during the rollout window. Say so.
  - `design.md:175`: "清空" (clear) can be read as "delete". Use "回放并确认处理完成" (replay and confirm processed).
- **The Lua reassignment on line 106 is redundant.** Location: `billing_authorize.lua:106`. After the mismatch check it can only produce `billing_number`, so drop it. Document the 503-on-mismatch in `freeswitch/README.md`.
- **Seeded CDRs leave `billing_number` NULL.** Location: `packages/db/src/seed.ts:592-597`. They are rated, so set `billingNumber: dialed`.
- **Two smaller cleanups in `ingest.ts`.** The `...cdr` spread carries the unverified `billingNumber`, which is overwritten only because of property order; build the insert explicitly. Separately, `apps/worker/src/app.db.test.ts` has grown from 947 to 1102 lines, so move the new cases to `app.dialed.db.test.ts`.
- **Run logs are committed.** `docs/evidence/dial-number-format/new-tests-on-main.txt` is a 446-line log; keep a summary. The untracked `claude-review-1.md` is empty, so don't commit it by accident.
- **Tests are missing for:**
  - a marker-less CDR from new Lua
  - an old-form domestic or leading-`0` CDR
  - edge numbers such as `0`, `+1` and `0044`
  - a mixed-rollout matrix of old and new forms against one handler

**Dismissed:**

- Rewriting `destination_number` back to the billing value (D): this breaks the spec's rule that the bridge uses the original number.
- "Rollout wording is inconsistent" (D): "作为一组逐台" means "as a set, one machine at a time", which is consistent.
- Manual claim SQL that omits `billing_number` (D): that file is phase-2 acceptance evidence, not a procedure. Any future claim path must still copy `billing_number`.
- PII in ledger notes (C): the spec asks for the normalized number in the ledger.

## Data migration concerns for existing CDRs

- **`callee` changes meaning at cutover.** Old rows hold the stripped number (`447700900123`); new rows hold the raw dial (`+447700900123`, `0755…`). Reports and groupings on `callee` will split. Readers must use `COALESCE(billing_number, callee)`, and even that compares different number spaces for mis-rated old rows.
- **Historical domestic calls were mis-rated.** On `main`, a bare `13800138000` was rated on prefix `1` (NANP), and those charges are already in the ledger. The design says "不重算" (no re-rating), but nothing marks those rows.
  - B says `raw_cdrs.payload->callflow->caller_profile` might help identify them; that isn't verified.
  - Old-Lua traffic during the rollout window and old retry files replayed later are mis-rated the same way. **Fix:** keep the window short and drain retry files before cutover.
- **There's no backfill.** `billing_number` stays NULL on history. A safe optional backfill is `billing_number = callee WHERE callee ~ '^[1-9][0-9]{0,14}$'` for rows received before cutover. It copies the old meaning, including the mis-rating, so tag those rows.
- **NULL means two things in `unassigned_cdrs.billing_number`.** On old rows it means "callee is already normalized"; on new rows it means "invalid or mismatched, and callee is raw".
  - Old-form rows with a leading `0` would now fail if reprocessed.
  - **Fix:** add a form marker column (legacy or v2), or a `dialed_number` column, before any phase-8 claim or re-rate code exists.
- **Ledger notes change format mid-history.** `通话扣费 <uuid>` becomes `通话扣费 <uuid> <number>` (call charge, then UUID, then number). The idempotency check ignores the note, so this is safe, but anything that parses notes will see two formats.
- **Rollback.** Per A, new-protocol CDRs that reach an old worker carry `destination_number = 'billing-bridge'`. The old worker would park every answered call as unbilled. The documented order is "FreeSWITCH first, then drain retry files, then worker". Finding 2's fail-closed check helps only on the authorize side, so draining is required, not optional.
