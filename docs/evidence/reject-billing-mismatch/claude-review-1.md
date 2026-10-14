I found nothing blocking, two things worth fixing before merge, and four small issues. I didn't edit any repo files. I ran the Lua harness (passed) and `pnpm vitest run apps/worker/src/app.test.ts` (18/18 passed), and read the integration logs left in `/tmp/fsi-mm-1`.

All the review angles below were done by me in this session. I didn't launch separate reviewer agents or other models, so the "several reviewers" signal the method relies on isn't really there.

## Intent

When the Worker computes a different billing number from the one Lua sent, a call used to fall back to 1800 s of unbilled time. Now it's rejected: the Worker returns HTTP 400 and the existing Lua branch for 400 answers SIP 503 with no fallback. The A-leg CDR is parked as `计费号码不一致` with one `cdr_failed` alert and no `auth_timeout` alert. `/authorize` still doesn't read or write the database, and Lua is unchanged.

**Angles:** (A) Worker and wire format; (B) Lua and FreeSWITCH runtime; (C) ingest, DB and replays; (D) the test harness; (E) the docs.

## SHOULD FIX

1. **The docs say these calls hang up with `CALL_REJECTED`, but the CDR records `NORMAL_TEMPORARY_FAILURE`** (angles B and E). In `freeswitch/scripts/billing_authorize.lua:115`, `respond 503` already ends the call, so the `hangup('CALL_REJECTED')` after it does nothing. The real archived CDRs show:
   - the mismatch call (`a_61747efa…`): `NORMAL_TEMPORARY_FAILURE`, Q.850 41
   - the 403 case: `CALL_REJECTED`
   - the 484 case: `INVALID_NUMBER_FORMAT`

   Anyone searching CDRs for `CALL_REJECTED` to find mismatch rejections will find none. The Lua harness misses this because its mock records the cause from the `hangup()` call.
   - **Where:** `docs/freeswitch.md:56`, `docs/design.md:134`, `docs/worker-api.md:41`, `freeswitch/README.md:30`.
   - **Fix:** say "SIP 503 (CDR `hangup_cause=NORMAL_TEMPORARY_FAILURE`)", and add `payload->'variables'->>'hangup_cause'='NORMAL_TEMPORARY_FAILURE'` to the raw-CDR `wait_sql` at `freeswitch/test/run-integration.sh:304`.

2. **The SIPp case can't tell a mismatch 400 from an auth failure** (angle D). A 401 or 403 from `/authorize` would also give SIP 503, no bridge and no unverified flag. Ingest would then park the CDR as `计费号码不一致` anyway, because it re-checks the number itself. The agreed plan included "one authorize request", but that check didn't make it into the test.
   - It did work in this run: `worker.log` in `/tmp/fsi-mm-1` has `req-j` with `statusCode:400`, the mismatch log line, and all six fields.
   - **Fix:** at `freeswitch/test/run-integration.sh:302`, assert that `worker.log` contains exactly one `"msg":"授权计费号码不一致"` line with this call's uuid. The uuid is already available through `$uuids`.

## MINOR

3. **`freeswitch/README.md:34`:** the new parking sentence sits between the `billing_unverified` explanation and "正常授权设该标记为 false", so "该标记" now points at the wrong thing. Move the new sentence to the end of the paragraph.
4. **`docs/freeswitch.md:52`:** the row "Worker 返回 HTTP 400 或…" reads as if every 400 gives SIP 503, but a number-format 400 gives 484. Change it to "Worker 返回 HTTP 400 `授权计费号码不一致`".
5. **`freeswitch/test/run-integration.sh:293-301`:** the test overwrites the tracked `freeswitch/scripts/billing_authorize.lua` in place. Normal exits, Ctrl-C and SIGTERM restore it through the EXIT/INT/TERM traps. After a SIGKILL it stays drifted, but the next run's `cmp` guard fails and the Lua harness case `{'07551234567','867551234567'}` (`billing_authorize_test.lua:76`) also fails, so the drift can't go unnoticed. **Fix (optional):** after `restore_authorize`, add `git diff --quiet -- freeswitch/scripts/billing_authorize.lua || fail …`.
6. **Replays aren't tested for this reason code.** The docs promise one alert per UUID even when the CDR is re-sent. That's true by construction (see "Cleared" below), but no test sends a mismatch CDR twice. **Fix:** at the end of the test at `apps/worker/src/app.db.test.ts:~1137`, re-post the same body and expect `status: 'duplicate'` and still exactly one alert.

## Noted and dismissed

- **Noted:** the log at `apps/worker/src/app.ts:75-83` now includes phone numbers (`dialedNumber`, `callee`) at error level. It only fires on a rare event and the plan called for it. Worth a line in the logging policy if you have one.
- **Dismissed:** the new Lua harness case overlaps the existing "HTTP 400 unsupported SIP code" case at `:145`. It still pins the exact response body, and it costs nothing.
- **Dismissed:** I considered adding the mismatch to `authorizeResponseSchema`. It isn't a business rejection, and leaving it out is what keeps Lua unchanged.

**Agreement map:** #1 was found by angles B and E; #2 by A and D. The others came from one angle each.

## Blast radius

**The one fact this is safe because of:** the Lua script's existing 400 branch already rejects without a fallback, so the Worker's 400 can't cause a bridge, whatever order Lua and the Worker are deployed in. I proved this as far as level 5 (reproduced in the running app):

- **Level 2:** at `billing_authorize.lua:96-97`, `decision()` returns nil for `{error=…}`, and line 112 then goes to `respond 503` with no `allow()`.
- **Level 4:** the harness case at `billing_authorize_test.lua:148-156` passes now when I run it.
- **Level 5:** in `integration-run1/2`, the mismatch case passes with no carrier INVITE. With the #14 Worker, `fails-on-14-integration.txt` shows `200 OK` and a bridge.

**Risks outside the diff:** I found none with real cost. During a version skew between Lua and the Worker, calls for the affected number types are now rejected instead of let through unbilled. That's intended and was agreed in the plan.

## Cleared

- **`/authorize` stays read-only:** it returns at `app.ts:85` before `withSystem`, and the unit test checks that `transaction` is never called. I ran it: 18/18.
- **No `auth_timeout` alert:** `billing_unverified` is only set inside `allow()`, and ingest defaults the flag to false (`packages/shared/src/worker.ts:71`). The alert at `ingest.ts:131` is only written when that flag is true. The evidence CDR shows `billing_authorized=false` and no unverified flag.
- **One alert per UUID:** when `park()` inserts a row with `call_uuid`, `started_at` and `ended_at`, a trigger registers the UUID (`migrations/0002_worker_reliability.sql:22-31`). A replay then hits the `registered` check at `ingest.ts:127` and returns `duplicate` before any alert is written. The evidence row has all three fields. I checked this by reading the code, not by running a replay.
- **No new locks:** none were added. Ingest already calls `lockTenants` before writing.
- **Other callers of the old 503:** the only references are docs and verify notes about partition and CDR 503s, which are unaffected. The response schema is unchanged.
- **The test sees the swapped script:** `freeswitch/test/compose.yaml:10` mounts the whole scripts directory read-only, so FreeSWITCH reads the host copy on each call.
- **The schema accepts the parked row:** `billing_number='867551234567'` is stored, which is allowed under migration 0004 for this reason.

**Cheapest check before merging:** add the `worker.log` assertion from #2 and the `hangup_cause` assertion from #1, then rerun `freeswitch/test/run-integration.sh` once.
