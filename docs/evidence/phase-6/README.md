# Phase 6 PR 3 acceptance evidence

This record covers the PR 3 backend only. It does not mark Phase 6 complete, and it does not include the later portal/admin CDR pages or portal ledger/settings work planned for PRs 4–6. The final full repository checks are still pending for the current tree.

## Dataset and provenance

The formal measurements use the isolated `fs_billing_perf_pr3_uuid_v4` database, generated with `asOf=2026-10-17T04:00Z`. It contains seven tenants and 3.44 million rows; `PORTALBIG` has three million CDRs. The creation record and source profile are in [`isolated-db-provenance.json`](isolated-db-provenance.json) and [`isolated-db-finish-20261019T085417Z.log`](isolated-db-finish-20261019T085417Z.log).

An earlier in-place repair attempt against the legacy performance database performed writes inside a transaction that was later rolled back. A subsequent logical-content check found no change. The isolated setup left no permanent write in the legacy database. The old and new CDR business fields match except for `call_uuid` and `received_at`. The new ledger seed uses actor `li`, while the old data used `wang`; the setup selects the first admin by ID, so actor equality is not claimed.

## HTTP list latency

[`list-latency.txt`](list-latency.txt) contains the complete real-server HTTP measurement on the three-million-row profile. The 112 measured requests had a maximum end-to-end response time of **227.6 ms**. There were 11 initial warmups and five deep-page warmups; including those, all 128 responses were below **352.9 ms**, under the 500 ms page target. The 14-row summary is seven rounds of the first and last pages, not the full measured sample set. The run reports the exact source profile, 234,277 answered calls and 246,574 total calls for September, three index families and 45 CDR indexes, zero failures, zero cleanup errors, and zero graceful API shutdown errors.

The SQL prototype is a separate diagnostic: seven rounds across 18 prototype variants, zero errors, and a maximum of 104.8 ms. It is not an HTTP service measurement and must not be compared as if it were one.

## HTTP export and lifecycle

[`export-formal-pr3-20261019T1051Z-stream-hold-r2.jsonl`](export-formal-pr3-20261019T1051Z-stream-hold-r2.jsonl) records the formal streamed-export run. It reports no failures or cleanup errors. The two 100,000-row scenarios each include two warmups and seven measured requests; the 14 measured exports met the 30-second budget. The default five-minute deadline closed the server response at 300,006 ms and the client at 300,503.4 ms. After deadline cleanup, the same tenant completed a 200,000-row retry with every row received. The global admission test accepted four exports and rejected the fifth with 429; the per-tenant test accepted one export and rejected the second with 429.

On 2026-10-19 this tree collected 42 fresh API-process RSS samples, one export per process, so a 200,000-row run cannot warm the process for a later 50,000-row run. The files are under [`rss-isolated/`](rss-isolated/). Seven rounds alternate the size order. Each round covers portal and admin for `EXPORT50K`, `EXPORT100K`, and `EXPORT200K`. All 42 processes exited 0, returned the declared row count, and recorded no cleanup error. Host load was 7.0 on 10 cores when the run started, because `pnpm check` was still finishing. The per-cell elapsed ranges are in [`rss-isolated/summary.jsonl`](rss-isolated/summary.jsonl).

Peak RSS medians were 191.2 MB, 222.5 MB, and 266.2 MB for portal at 50,000, 100,000, and 200,000 rows. Admin medians were 195.5 MB, 227.6 MB, and 264.0 MB. Quadrupling the rows raised the peak 1.39 times for portal and 1.35 times for admin. The sample taken before the request stayed near 160 MB.

The increase above that baseline did grow with the row count. Portal medians were 31.2 MB, 61.9 MB, and 107.0 MB. Admin medians were 35.5 MB, 67.3 MB, and 104.8 MB. From 50,000 to 200,000 rows that increase was 3.43 times for portal and 2.96 times for admin. In `portal-EXPORT200K-r3.json` RSS moved from 158.2 MB at 0 rows to 264.0 MB at 200,000 rows and did not fall at the end. A later same-process check separates that RSS high-water mark from retained memory. After `global.gc()`, heap used was 38.5 MB for a 50,000-row export and 38.5 MB for a 200,000-row export. RSS stayed near the high-water mark, 188.3 MB and 265.8 MB, because the process did not return those pages. A second 200,000-row export in the process that had already reached 260.6 MB peaked at 264.0 MB, a 6.7 MB increase. The retained heap does not grow with the row count. The fresh-process RSS curve records the first export's high-water mark.

[`ledger-financial-only-2026-10-19T11-54-03-013Z-2d1dd222.json`](ledger-financial-only-2026-10-19T11-54-03-013Z-2d1dd222.json) is the read-only ledger comparison. Both `fs_billing_perf` and `fs_billing_perf_pr3_uuid_v4` had 2,935,921 ledger rows and the same financial-field SHA-256 `6c0794a94ddc8e248ae59f4b17fcd8c28deee307c592fea9b939b8b46d39deb5`. The actor differs, `seed:admin:wang` in the old database and `seed:admin:li` in the new one. The script treats that as the allowed seed difference. The command exited 0.

The earlier formal run records request IDs and server completion outcomes for lifecycle correlation. Its deadline case ended with no active query, idle transaction, or cancellation query; one normal idle pool socket may remain until API shutdown closes the pool. The HTTP run observed zero cancellation control connections because its abort occurred while waiting for response `drain`, with no query in flight. PostgreSQL cancellation of an active lock-wait query is covered separately by the DB integration test.

## Other PR 3 evidence

- [`freeswitch-hangup-cause-audit.md`](freeswitch-hangup-cause-audit.md): 46 project cause names match the FreeSWITCH 1.11.3 enum and mapping sources. The additional upstream names retain the existing unknown-cause fallback.
- On 2026-10-19, after the RSS files and the financial-only file were formatted, `pnpm check` exited 0. It reported 35 unit-test files, 687 passed and 1 skipped, then 31 web files and 390 passed, then a web build. `pnpm test:db` exited 0 with 32 files and 456 tests. `pnpm test:idor` exited 0 with 1 file and 27 tests. Logs from this run are outside the repo, in `/tmp/pr3-check3.log`, `/tmp/pr3-test-db.log`, and `/tmp/pr3-test-idor.log`.
- The initial list-preflight files were removed. They used legacy synthetic UUIDs and produced no valid latency or RSS sample.
