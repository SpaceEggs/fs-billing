Three reviewers (Opus, the Opus fallback for Fable, and Haiku) are still running. I'll merge their findings when they finish.

Still waiting on the Haiku reviewer. Everything else has been checked and merged into the draft.

I found one blocking problem, five should-fix items and seven minor ones, so the branch isn't ready to merge yet. No repo files were edited. The unit tests on HEAD pass (155/155); I didn't run the DB tests or the migrations, because those need docker. The Fable reviewer couldn't run (no usage credits), so a second Opus reviewer took its place alongside Opus, Sonnet and Haiku.

## BLOCKING

**B1. CDRs for calls the dialplan rejects now look like old-format CDRs.** Location: `freeswitch/dialplan/billing.xml:6-12`, `packages/shared/src/worker.ts:71,134`. Found by both Opus reviewers; I confirmed it in the code.
- **How it happens:** when the dialed number fails `^\+?[0-9]{1,17}$` (for example `138|evil`, an empty number, or 18+ digits), the `<anti-action>` responds 484 before `billing_authorize.lua` runs. So `billing_dialed_number` is never set.
- **On main:** a fallback to `destination_number` parked these as `号码格式错误` with the call UUID, so repeated pushes were caught as duplicates.
- **On HEAD:** they go down the validation-failure path as `话单校验失败: …` with no call UUID. Every replay of the retry or archive file adds another pending row and another alert.
- So the fallback that was removed was not only there for legacy CDRs. The integration test's `bad` case (`freeswitch/test/run-integration.sh:275`) hides this because it accepts either `call_uuid` or `raw_id`.
- **Fix:**
  1. In `billing.xml`, set `billing_dialed_number=${destination_number}` before the `lua` action and as the first `<anti-action>`.
  2. Make the `bad` case require `reason='号码格式错误' AND call_uuid IS NOT NULL AND billing_number IS NULL`.
  3. Add a DB test that posts a CDR with `billing_dialed_number: '138|evil'`.

## SHOULD FIX

**S1. The Drizzle `check()` SQL is broken.** Location: `packages/db/src/schema.ts:166-170, 212-221`.
- The quote is never closed. Rendering it through Drizzle gives `... ~ '^[1-9][0-9]{5,14}$` with no closing `'`.
- No other table in `schema.ts` uses `check()`; this repo keeps constraints in the SQL migrations only.
- **Fix:** delete the three `check()` blocks and the `check` import. If you'd rather keep them, add the closing quote.

**S2. Migration 0004 fails on a populated DB that is already at 0003, and nothing says so.**
- On a fresh DB it applies cleanly.
- At 0003 it aborts if there are NULL `cdrs.billing_number` values (error 23502), 1–5 digit numbers (0003 allowed those), or older `unassigned_cdrs` rows with NULL and a reason like `租户不存在`.
- Your evidence files show the DB was wiped first (50 cdrs → 0).
- **Fix:** add one line to `docs/design.md` §4.2 and `docs/worker-api.md` saying dev and integration DBs must be reset before 0004. Optionally start the migration with a `DO $$ … RAISE EXCEPTION 'reset DB' $$` guard.

**S3. The new mismatch row in the SIP table is wrong.** Location: `docs/freeswitch.md:52`.
- When the Worker detects a mismatch it returns HTTP 503 (`app.ts:73-78`).
- Lua treats a 503 as "no response" and lets the call through for 1800 seconds as unverified (`billing_authorize.lua:97,117`). The CDR is then parked and never billed.
- SIP 503 only happens when Lua itself finds a mismatch in a 200 response.
- **Fix:** correct the table row. Letting the call through on a Worker-detected mismatch already happens on main; making it reject the call is a separate follow-up.

**S4. Legacy wording is still in the docs.**
- `docs/design.md:128` (§4.2): "新协议以 `dialedNumber` 区分原始拨号和旧版已规范化号码". Delete the sentence.
- `docs/design.md:163`:
  - Change "优先使用 `billing_dialed_number`" to "使用".
  - Change "号码格式无效时该列为 NULL" to "号码格式错误或话单校验失败时为 NULL".
- `docs/worker-api.md:83`: "`destination_number` 只保留在原文中" is untrue for validation failures, because `invalid-cdr.ts:15` still falls back to it for display. Say so in that line.
- `docs/worker-api.md:88`: change "旧格式话单" to "缺少 `billing_dialed_number` 的话单".
- `docs/freeswitch.md` and `freeswitch/README.md` have no leftover rollout text. One caveat: README line 26 ("提前退出或校验失败的话单也保留原始拨号") is only true once B1 is fixed.

**S5. The verify-skill docs describe the old authorize request.** Location: `apps/web/.agents/skills/verify/features/worker-authorize.md:9-10,16` and `worker-api.md:8`.
- They tell you to POST `{tenant, callee, uuid}`, which now returns 400/484.
- They also say `+` and `00` numbers are rejected and that FreeSWITCH "normalizes the destination". Neither is true now.
- **Fix:** add `dialedNumber` to the request shape and correct those two lines.

## MINOR

- **M1. The 0004 CHECK depends on reason text written in several places** (`ingest.ts:95,137-145`, `0004:17-19`, `cdrs.db.test.ts`).
  - Every reason the code produces today satisfies the CHECK.
  - But renaming one of them in only one place makes inserts fail (23514). The Worker then returns 503 and FreeSWITCH retries forever.
  - **Fix:** export `号码格式错误` and the `话单校验失败: ` prefix as constants and use them in `ingest.ts` and the tests.
- **M2. The seed data still uses the legacy shape** (`packages/db/src/seed.ts:341-380,579-587`).
  - `callee` holds already-normalized numbers. Treated as a dialed number, `447700900123` would normalize to `86447700900123`.
  - It also uses the reason `找不到租户`, which no code produces.
  - **Fix:** store real dialed forms, derive the billing number with `normalizeDialedNumber`, and use `租户不存在`.
- **M3. Unused fields:** `destination_number` at `worker.ts:70,89` is parsed but never read. The fixture at `app.db.test.ts:200-215` still sets it up. Remove both.
- **M4. A deleted test wasn't legacy-only.** The "early return" test covered the domestic overflow `12345678901234`. Add that value to the list at `app.db.test.ts:298`.
- **M5. 0004 adds its CHECKs without `NOT VALID` + `VALIDATE`**, unlike 0003. That's harmless before production, but worth matching 0003.
- **M6. The test name `新协议 %s …`** at `app.db.test.ts:969` still says "新协议".
- **M7. No Lua test covers removing 400 from `sip_codes`** (`billing_authorize.lua:12`). Optionally add the case HTTP 400 with `sipCode:400` → respond 503.

## Answers to your specific questions
- **Authorize without `dialedNumber`:** there is a behaviour test (`apps/worker/src/app.test.ts:60,62-63`). It asserts HTTP 400 and `{allowed:false, reason:'号码格式错误', sipCode:484}` without touching the DB, and it passes.
- **Reason-coupled CHECK:** it matches every reason the code produces today, but it breaks easily (M1). On a DB at 0003 with existing rows it fails (S2).
- **Things you wanted kept:** all intact.
  - `resolveBillingNumber` is still the one function for both authorize (`app.ts:71`) and CDRs (`ingest.ts:106`).
  - Lua passes the dialed number through unchanged.
  - The 484 bridge check, the 6–15 digit rule and mismatch detection are still there and tested.
  - Ledger notes now have one format.
- **Project rules:** no new locks, `lock_tenants` still comes before writes, no partition creation on the write path, and money still goes through decimal.js. Nothing else in the api or web apps reads `callee` or `billing_number`.

**Verdict:** not ready to merge until B1 is fixed; everything else is small doc, schema and test cleanup.
