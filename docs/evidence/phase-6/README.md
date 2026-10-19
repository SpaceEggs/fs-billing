# Phase 6 PR 3 acceptance evidence

This record covers the PR 3 backend only. It does not mark Phase 6 complete, and it does not include the later portal/admin CDR pages or portal ledger/settings work planned for PRs 4–6. The review fixes passed the final repository, database, and IDOR checks recorded below.

## Dataset and provenance

The formal measurements use the isolated `fs_billing_perf_pr3_uuid_v4` database, generated with `asOf=2026-10-17T04:00Z`. It contains seven tenants and 3.44 million rows; `PORTALBIG` has three million CDRs. The creation record and source profile are in [`isolated-db-provenance.json`](isolated-db-provenance.json) and [`isolated-db-finish-20261019T085417Z.log`](isolated-db-finish-20261019T085417Z.log).

An earlier in-place repair attempt against the legacy performance database performed writes inside a transaction that was later rolled back. A subsequent logical-content check found no change. The isolated setup left no permanent write in the legacy database. The old and new CDR business fields match except for `call_uuid` and `received_at`. The new ledger seed uses actor `li`, while the old data used `wang`; the setup selects the first admin by ID, so actor equality is not claimed.

## HTTP list latency

[`list-latency.txt`](list-latency.txt) contains the complete real-server HTTP measurement on the three-million-row profile. The 112 measured requests had a maximum end-to-end response time of **227.6 ms**. There were 11 initial warmups and five deep-page warmups; including those, all 128 responses were below **352.9 ms**, under the 500 ms page target. The 14-row summary is seven rounds of the first and last pages, not the full measured sample set. The run reports the exact source profile, 234,277 answered calls and 246,574 total calls for September, three index families and 45 CDR indexes, zero failures, zero cleanup errors, and zero graceful API shutdown errors.

The SQL prototype is a separate diagnostic: seven rounds across 18 prototype variants, zero errors, and a maximum of 104.8 ms. It is not an HTTP service measurement and must not be compared as if it were one.

## HTTP export and lifecycle

[`export-formal-pr3-20261019T1051Z-stream-hold-r2.exit.json`](export-formal-pr3-20261019T1051Z-stream-hold-r2.exit.json) records the formal streamed-export run. The per-second database log and the earlier 10:48 capture were removed. The exit file reports no failures or cleanup errors. The two 100,000-row scenarios each include two warmups and seven measured requests; the 14 measured exports met the 30-second budget. The default five-minute deadline closed the server response at 300,006 ms and the client at 300,503.4 ms. After deadline cleanup, the same tenant completed a 200,000-row retry with every row received. The global admission test accepted four exports and rejected the fifth with 429; the per-tenant test accepted one export and rejected the second with 429.

On 2026-10-19 this tree collected 42 fresh API-process RSS samples, one export per process, so a 200,000-row run cannot warm the process for a later 50,000-row run. The per-sample totals are in [`rss-isolated/summary.jsonl`](rss-isolated/summary.jsonl). The per-tick traces were removed. Seven rounds alternate the size order. Each round covers portal and admin for `EXPORT50K`, `EXPORT100K`, and `EXPORT200K`. All 42 processes exited 0, returned the declared row count, and recorded no cleanup error. Host load was 7.0 on 10 cores when the run started, because `pnpm check` was still finishing.

Peak RSS medians were 191.2 MB, 222.5 MB, and 266.2 MB for portal at 50,000, 100,000, and 200,000 rows. Admin medians were 195.5 MB, 227.6 MB, and 264.0 MB. Quadrupling the rows raised the peak 1.39 times for portal and 1.35 times for admin. The sample taken before the request stayed near 160 MB.

The increase above that baseline did grow with the row count. Portal medians were 31.2 MB, 61.9 MB, and 107.0 MB. Admin medians were 35.5 MB, 67.3 MB, and 104.8 MB. From 50,000 to 200,000 rows that increase was 3.43 times for portal and 2.96 times for admin. One 200,000-row portal sample moved from 158.2 MB at 0 rows to 264.0 MB at 200,000 rows and did not fall at the end. The earlier forced-GC and repeated-export plateau claims had no retained observations or checked-in GC hook. They are superseded by the retained same-process measurement below.

## Same-process memory reproduction

[`export-memory-20261019.json`](export-memory-20261019.json) retains the memory run on the corrected source. Five rounds alternate all six portal and admin 50k, 100k, and 200k scenarios forward and backward, then repeat both 200k scenarios each round. One API process completed all 40 exports and 5.5 million CSV data rows. Every response returned HTTP 200 and matched its server completion event and expected row count. The API exited 0, with no failure or cleanup error. Cleanup removed 20 run-specific audit rows and all five run-specific identities and sessions. CDR and financial rows were read only.

The artifact records the actual Node arguments, Git HEAD, runtime and harness SHA-256 values before and after the run, PostgreSQL version, migration/index profile hashes, per-request baseline/peak RSS, 50 ms RSS traces, completed rows, and all 80 forced-GC observations. The source hashes remained unchanged. The recorded Git HEAD is the regression-test commit before the uncommitted fix. The per-file hashes identify the measured implementation and match the final checked-in sources. The hook is checked in at `apps/api/scripts/portal-memory-gc.mjs`. It requires explicit opt-in, `--expose-gc`, `NODE_ENV=test`, and a loopback API. Each observation follows three collections on separate event-loop turns in the API process. The client retains bounded CSV prefixes and counts rows incrementally.

Values below are decimal MB. Each cell gives the median and range of five samples. Extra 200k repeats are reported separately.

| Scenario          | Post-GC heap used MB      | Peak RSS MB                  |
| ----------------- | ------------------------- | ---------------------------- |
| admin-EXPORT50K   | 39.015 (38.750 to 40.732) | 263.832 (202.981 to 287.261) |
| portal-EXPORT50K  | 39.015 (38.745 to 40.886) | 262.291 (201.900 to 275.792) |
| admin-EXPORT100K  | 39.035 (38.764 to 40.967) | 262.291 (234.865 to 277.561) |
| portal-EXPORT100K | 39.021 (38.711 to 40.999) | 262.799 (235.422 to 279.282) |
| admin-EXPORT200K  | 39.052 (38.745 to 40.090) | 271.254 (240.828 to 284.279) |
| portal-EXPORT200K | 39.052 (38.713 to 40.178) | 268.976 (248.873 to 285.966) |

The five extra 200k repeats per audience had peak RSS increases above their immediate pre-request baselines of **3.932 MB** median for admin, range 3.506 to 11.125 MB, and **5.177 MB** for portal, range 3.457 to 19.448 MB. Their post-GC heap medians were 39.058 MB and 39.030 MB. All 200k exports peaked between 240.828 MB and 287.130 MB across the five rounds.

This finite run shows no retained-heap growth proportional to row count at 50k through 200k, and no file-sized retained growth across these repeated exports. The earlier fresh-process RSS growth remains visible in the separate evidence. Forced collection changes production GC behavior, and 50 ms polling can miss short peaks. This run does not prove constant fresh-process peak RSS or behavior for larger exports, sustained concurrency, or a buffering reverse proxy. No numeric memory pass threshold was invented.

The actual run used the existing isolated database on port 5432. Port 55432 belongs to a different `fs_overview_perf` database. [`export-memory-preflight-wrong-port-20261019.json`](export-memory-preflight-wrong-port-20261019.json) records that initial authentication failure before API startup, identity creation, or requests. Its sample list is empty.

Run from the repository root with a readable local environment template containing the existing owner, app, auth, and authentication-secret values. The retained command used the template path below. Substitute an equivalent local template when reproducing elsewhere.

```sh
cd apps/api
PERF_TARGET_DATABASE=fs_billing_perf_pr3_uuid_v4 \
  PERF_DATABASE_PORT=5432 PERF_MEMORY=1 PERF_GC_ON_SIGUSR2=1 PERF_ROUNDS=5 \
  node --env-file=/Users/lqzone/.codex/worktrees/phase-6-cdr-backend/FS-Billing/.env \
  --import tsx scripts/portal-export-perf.ts \
  > ../../docs/evidence/phase-6/export-memory-reproduction.json
```

The command reuses the existing synthetic database and cleans only its own identity, session, and audit records. It does not seed or recreate the database. This is a memory diagnostic. Request timings are retained as context, with no throughput or speedup claim.

[`ledger-financial-only-2026-10-19T11-54-03-013Z-2d1dd222.json`](ledger-financial-only-2026-10-19T11-54-03-013Z-2d1dd222.json) is the read-only ledger comparison. Both `fs_billing_perf` and `fs_billing_perf_pr3_uuid_v4` had 2,935,921 ledger rows and the same financial-field SHA-256 `6c0794a94ddc8e248ae59f4b17fcd8c28deee307c592fea9b939b8b46d39deb5`. The actor differs, `seed:admin:wang` in the old database and `seed:admin:li` in the new one. The script treats that as the allowed seed difference. The command exited 0.

The earlier formal run records request IDs and server completion outcomes for lifecycle correlation. Its deadline case ended with no active query, idle transaction, or cancellation query; one normal idle pool socket may remain until API shutdown closes the pool. The HTTP run observed zero cancellation control connections because its abort occurred while waiting for response `drain`, with no query in flight. PostgreSQL cancellation of an active lock-wait query is covered separately by the DB integration test.

## Other PR 3 evidence

- [`freeswitch-hangup-cause-audit.md`](freeswitch-hangup-cause-audit.md): 46 project cause names match the FreeSWITCH 1.11.3 enum and mapping sources. The additional upstream names retain the existing unknown-cause fallback.
- On 2026-10-19, after the RSS files and the financial-only file were formatted, `pnpm check` exited 0. It reported 35 unit-test files, 687 passed and 1 skipped, then 31 web files and 390 passed, then a web build. `pnpm test:db` exited 0 with 32 files and 456 tests. `pnpm test:idor` exited 0 with 1 file and 27 tests. Logs from this run are outside the repo, in `/tmp/pr3-check3.log`, `/tmp/pr3-test-db.log`, and `/tmp/pr3-test-idor.log`.
- The initial list-preflight files were removed. They used legacy synthetic UUIDs and produced no valid latency or RSS sample.

## PR 3 review fixes

[`cancel-recovery-20261019.json`](cancel-recovery-20261019.json) records the failing and passing real-PostgreSQL proxy observations and the regression commands. Successful backend cancellation no longer leaves a silent data connection holding admission indefinitely. The shared lease owner bounds original-query settlement and rollback at two seconds, and control completion at eight seconds. It also covers Drizzle rollback and BEGIN acknowledgment races. A started CSV response ends immediately at the export deadline, while admission remains held until database cleanup finishes.

Final review-fix validation on 2026-10-19 passed `pnpm check` with 706 root tests and one existing skip, 390 web tests, typechecks, lint, formatting, and the web build. `pnpm test:db` passed all 456 tests against a separate temporary PostgreSQL instance. `pnpm test:idor` passed all 27 tests. Independent runtime and memory-evidence reviews found no remaining blocker in these two fixes. Phase 6 overall remains incomplete.
