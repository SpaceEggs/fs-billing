I reviewed the Phase 3 diff (`d08f1be...HEAD`) without editing anything. I found **no BLOCKERs**. Five things are worth fixing, and the first one could turn into a blocker once it's checked on a real call.

## What holds up

- **No double charging:** duplicates are caught by checking the `call_uuids` table first, then by catching `23505 call_uuids_pkey`. The migration's new `app.cdr_ingest` check stops an HTTP re-push from claiming an unassigned UUID. Charges are keyed `call:<uuid>` with `ON CONFLICT DO NOTHING`, and a replay returns the existing entry. There are tests for a crash before commit and for a job redelivered after commit.
- **Charge date and money:** `occurred_at` is `answered_at` (September test included). Charges are computed from the rate saved at ingest, using decimal strings throughout.
- **Lock rules:** every write transaction calls `lockTenants` before writing. There is no partition creation on the write path: `23514` becomes a 503 plus a `partition_failed` alert. `ensureCdrPartitions` now only accepts a pool, and that is type-tested. Retries happen only in the outermost `withSystem`.
- **Endpoint security:** the key is compared with SHA-256 plus `timingSafeEqual`. The IP check uses the socket IP (no proxy trust). The bind address must be private or loopback IPv4. `/health` is the only route outside the check.
- **Lua script:** 1.5 s total and connect timeouts; `+` and then `00` are stripped and written back to `destination_number`. `sched_hangup` runs via `execute_on_answer`, so ringing time isn't counted. 401/403/400 responses reject the call instead of failing open. Timeouts and missing responses allow 1800 s and set `billing_unverified=true`.

## SHOULD-FIX

1. **`packages/shared/src/worker.ts:55`: `caller_id_number` is required in `variables`.** In real FreeSWITCH CDRs, `caller_id_number` (like `destination_number`) normally lives in `callflow[].caller_profile`, not in the variables hash. The Lua script sets `destination_number` explicitly but not this one. If real CDRs leave it out, every CDR becomes `invalid` (`ingest.ts:72-75`): only the raw text is saved, with no `cdrs` row and no charge, so revenue is lost. The sample CDR has the field, so the tests can't catch this. Check it on the criterion-8 live call. If it's missing, fall back to `callflow[0].caller_profile` or default to `''`. If it's confirmed missing, this becomes a **BLOCKER**.
2. **`queue.ts:73-74` with `main.ts:40-52`: three retries with `retryDelay: 0` and nothing to recover.** Once retries run out, the job is marked failed. The `cdrs` row still shows a charge but no ledger entry is ever written, and the only trace is a `cdr_failed` alert. Add backoff, plus a reconciliation check that finds answered CDRs with a charge but no `call:<uuid>` ledger entry.
3. **`ingest.ts:70-75`: CDRs that fail the schema stay only in `raw_cdrs`.** This covers time/duration mismatches, missing fields, and UUIDs that aren't valid RFC format. They never reach `unassigned_cdrs`, so the phase-8 manual workflow can't see them. Nothing is lost, but nobody can act on them.
4. **`queue.ts:42-46`: possible connection-pool starvation.** When pg-boss's queue cache is empty, `boss.send` runs `getQueue` on a second pool connection. Meanwhile the ingest transaction already holds one connection and the tenant lock. The pool uses the default `max` of 10 with no `connectionTimeoutMillis`. More than 10 concurrent CDR posts right after startup (for example the replay cron after an outage) can hang forever. Fix: load the cache once after `boss.start()` and set a connection timeout.
5. **Test gap for criterion 8:** there's no evidence of a real FreeSWITCH call. `docs/evidence/phase-3/live-e2e.txt` only covers HTTP calls, and `billing_authorize.lua` and `billing.xml` have no automated tests. Finding 1 is exactly the kind of bug this gap hides.

## NIT

- `app.ts:60` authorizes using the app's clock (`new Date()`). Phase 2 already showed that a gap between the app and database clocks changes whether a rate version counts as active.
- `main.ts:46` writes a `cdr_failed` alert on every retry, so up to 4 per job.
- `ingest.ts:56-59` never fills `raw_cdrs.tenant_id`/`call_uuid`, so raw rows can't be linked to their CDR.
- `app.db.test.ts:558` tests 401/403 only on `/cdr`, not on `/authorize`.
- `config.ts` accepts IPv6 entries in `WORKER_ALLOWED_IPS`, but they can never match because the listener is IPv4-only.
- The pg-boss patch (removing `BEGIN;`/`COMMIT;` by regex, plus `noAdvisoryLocks`) is load-bearing, since the app role can't call advisory lock functions. It also assumes only one worker instance runs. Write both down.
- `0000_init.sql` was edited after it was applied. The change is comment-only and drizzle doesn't recheck hashes, but it sets a bad precedent.
- `main.ts:39`: if partition maintenance fails at startup, the worker doesn't start. Authorization is then down and every call falls back to 1800 s.
- Billed seconds can exceed `maxSeconds` by 1 s because the epoch timestamps are truncated. That bills one extra minute beyond the overdraft limit.
