# Phase 6 PR 1 acceptance

PR 1 changes only the `tenant_read` `USING` predicates on the 13 tenant-scoped tables. Migration `0015_rls_initplan.sql` contains 13 explicit `ALTER POLICY` statements; `tenants` uses `id`, and the other tables use `tenant_id`. The test derives its RLS inventory from PostgreSQL catalogs, compares the migrated policy set with the intended targets, and checks real app-role row visibility against the legacy `app_can_see` behavior for populated tenant fixtures and the requested session-scope cases. No app source changed.

The implementation is in the isolated `phase-6-rls-initplan` worktree. Independent Luna review found no blocking issue. Its initial cleanup concern was resolved in the final Worker harness, and the final review found no blocking finding. The review used one Luna model, with no second-model agreement signal. CI and merge status are tracked in [PR #40](https://github.com/SpaceEggs/fs-billing/pull/40). Phase 6 remains in progress. Review reports and the independent focused RLS test output are included below.

## Independent review

- [`independent-review-initial.md`](independent-review-initial.md) records the initial PASS+NOTES review and the cleanup finding that prompted the final repair.
- [`independent-review-security-and-comments.md`](independent-review-security-and-comments.md) records the security and comment review.
- [`independent-review-final.md`](independent-review-final.md) records the final PASS+NOTES disposition. The cleanup finding is resolved, with no blocking finding. It also records the single-model review limit.
- [`independent-rls-focused-test.txt`](independent-rls-focused-test.txt) records the independent focused RLS DB test, which passed.

## Verification

| Command                   | Result                                                                                                        | Output                                           |
| ------------------------- | ------------------------------------------------------------------------------------------------------------- | ------------------------------------------------ |
| `pnpm check`              | Passed, exit code 0: lint, format, typecheck, 660 root tests (1 skipped), 380 Web tests, and production build | [`pnpm-check.txt`](pnpm-check.txt)               |
| Final `pnpm format:check` | Passed after the acceptance-doc updates                                                                       | [`pnpm-format-final.txt`](pnpm-format-final.txt) |
| `pnpm test:db`            | Passed, exit code 0: 26 files, 415 tests                                                                      | [`pnpm-test-db.txt`](pnpm-test-db.txt)           |
| `pnpm test:idor`          | Passed, exit code 0: 1 file, 17 tests                                                                         | [`pnpm-test-idor.txt`](pnpm-test-idor.txt)       |

The DB suites recreated and removed only the local `fs_billing_test` fixture. The SQL A/B probe connected to local `fs_billing_perf` and rolled back all policy changes. The Worker harness used local `fs_billing` only as an owner connection to create and drop uniquely named disposable databases; it did not alter development business data. Worker samples ran only against those temporary clones, and both run prefixes were checked for cleanup. No production endpoint was accessed.

## PostgreSQL query execution comparison

The SQL probe ran six alternating legacy/InitPlan pairs on the existing local PostgreSQL 17.9 `fs_billing_perf` fixture. It used the actual `0015` migration for each candidate side, restored the legacy policy before the paired baseline, and rolled back the transaction. The fixture contained 3,000,000 PORTALBIG CDR rows, 234,277 answered September rows, 11,821 matching search rows, and 75 CDR indexes. `pg_policies` had 55 rows before and after; exactly 13 `tenant_read.qual` values changed. Result digests and row counts matched between sides.

These figures are PostgreSQL `EXPLAIN ANALYZE` execution times in milliseconds. They are database query timings, not HTTP request or page latency.

| Query     |     Legacy median (range) | InitPlan median (range) |
| --------- | ------------------------: | ----------------------: |
| Summary   | 108.473 (104.805–117.250) |  35.920 (35.103–39.580) |
| Deep page |    50.593 (48.022–61.303) |  15.792 (15.398–16.630) |
| Search    |  109.534 (99.983–117.086) |  34.554 (33.467–37.669) |

For representative plans, legacy and candidate reads used the same shared buffers and no shared reads: summary 7,365 hits, deep page 5,989 hits, and search 7,366 hits. The selected plan operators and result rows also matched. The legacy `Filter` contains the inlined `current_setting`/UUID work at scanned rows; the candidate plan has three InitPlans, each with one loop for tenant scope. The raw paired plans and policy snapshots are in [`rls-initplan-perf.json`](rls-initplan-perf.json); the rerunnable SQL probe is [`rls-initplan-perf.ts`](../../../../packages/db/scripts/rls-initplan-perf.ts).

This supports the diagnosis that repeated RLS helper evaluation is expensive for large tenant-scoped scans. The timings are query-level evidence from one local fixture, not a claim about whole-page latency.

To reproduce the SQL probe, set `PERF_DATABASE_URL` to a loopback URL whose database is exactly `fs_billing_perf`; the script rejects other hosts or database names. The URL must use a local read/write owner credential because the probe applies the migration only inside a transaction. Use a new capture path with shell no-clobber enabled:

```sh
set -o noclobber
capture="docs/evidence/phase-6-pr1/rls-initplan-perf-$(date -u +%Y%m%dT%H%M%SZ)-${RANDOM}.json"
PERF_DATABASE_URL="<local fs_billing_perf URL>" pnpm --filter @fs-billing/db exec tsx --env-file=../../.env scripts/rls-initplan-perf.ts > "$capture" 2> "${capture%.json}.stderr.txt"
```

## Worker authorization p95

On 2026-10-18 JST, the user set the acceptance rule: “按现有 50 ms 上限验收，并完整披露两轮差异。” The source is chat call `call_0917756c257f4e0d8926c10d864f3ea7`. Accordingly, the existing per-sample p95 limit is the acceptance criterion. Passing it does not mean there was no regression or that the change sped up HTTP requests.

Both fixed Worker runs used the unchanged `apps/worker/scripts/perf-authorize.ts`, the same local host, fresh database clones from the same migrations and seed, 500 rate entries, 1,000 serial loopback HTTP requests per sample, and alternating `AB`/`BA` order. Each child exits nonzero if any response is not HTTP 200 or its JSON body differs from the expected authorization response. Across both runs, all 24,000 requests completed successfully, and all 24 sample p95 values (12 per run; 6 per variant per run) were below 50 ms.

| Run              | Legacy p95 median (range) | InitPlan p95 median (range) | Paired direction                                         |
| ---------------- | ------------------------: | --------------------------: | -------------------------------------------------------- |
| Run 1            |  11.483 ms (9.312–12.401) |   12.069 ms (10.106–12.297) | InitPlan higher in 5/6 pairs                             |
| Run 2            | 13.328 ms (12.281–14.268) |   13.791 ms (12.017–14.320) | InitPlan higher in 2/6 pairs                             |
| Combined samples |  12.341 ms (9.312–14.268) |   12.271 ms (10.106–14.320) | Paired median delta +0.353 ms; range −0.456 to +2.524 ms |

The combined exact two-sided sign test on the 12 paired p95 differences is `p = 0.774`. Pair directions differed between runs, and the run-level medians shifted upward together in run 2. The data pass the selected 50 ms p95 budget but do not establish an HTTP speedup or exclude a small latency regression. The largest single-request `maxMs` observed was 89.426 ms; the agreed acceptance metric is p95, not maximum latency. The earlier Phase 3 result of 5.5–6.3 ms is historical and is not used as this run’s baseline.

The unchanged Worker path sets `app.scope = 'system'`. A non-counted `EXPLAIN ANALYZE` diagnostic used the same `loadRatingTenant` query shapes with 500 visible rates. Under system scope the legacy scan filter contains the inlined `current_setting` checks; the candidate evaluates `app_is_operator()` in an InitPlan once, while the `app.scope` and tenant-id InitPlans have zero loops because the operator branch is true. This explains why the Worker HTTP measurement may show little RLS effect; the one-shot diagnostic is mechanism evidence only and its timings are not a latency result. Full plans are in [`rls-initplan-worker-system-profile-500-rates.json`](rls-initplan-worker-system-profile-500-rates.json), with cleanup confirmation in [`rls-initplan-worker-system-profile-cleanup.txt`](rls-initplan-worker-system-profile-cleanup.txt).

Run 2's complete JSON, including all 53 index definitions and all 55 policy rows, is [`rls-initplan-worker-perf-run2.json`](rls-initplan-worker-perf-run2.json). The canonical [`rls-initplan-worker-perf.json`](rls-initplan-worker-perf.json) is byte-identical to that file. Run 1's original full JSON was overwritten when the second capture reused its path. The parent recovered a parsed results excerpt from the original tool output; it preserves all 12 raw sample records and the relevant setup fields, but not the 53 index definitions or 55 policy records. Its source and limits are documented in [`run1 provenance`](rls-initplan-worker-perf-run1-provenance.md). The [`combined analysis`](rls-initplan-worker-perf-combined-analysis.json) is calculated from that excerpt and the complete run 2 JSON.

Both Worker run prefixes were checked against `pg_database` after the runs and had no remaining databases: [`run 1 cleanup`](rls-initplan-worker-perf-run1-cleanup.txt), [`run 2 cleanup`](rls-initplan-worker-perf-run2-cleanup.txt). The capture safeguard uses `set -o noclobber` with a unique run-specific filename; the overwrite rejection check exited nonzero and left the original file hash unchanged ([`capture guard check`](capture-guard-check.txt)).

## Evidence files

- [`rls-initplan-perf.json`](rls-initplan-perf.json): full SQL A/B samples, plans, fixture identity, indexes, and complete policy snapshots.
- [`rls-initplan-worker-perf-run1-results-excerpt.json`](rls-initplan-worker-perf-run1-results-excerpt.json) and [`provenance`](rls-initplan-worker-perf-run1-provenance.md): recovered Run 1 samples and source limits.
- [`rls-initplan-worker-perf-run2.json`](rls-initplan-worker-perf-run2.json): complete Run 2 output.
- [`rls-initplan-worker-perf-combined-analysis.json`](rls-initplan-worker-perf-combined-analysis.json): paired deltas, ranges, sign test, and the user-selected p95 acceptance decision.
- [`rls-initplan-worker-system-profile-500-rates.json`](rls-initplan-worker-system-profile-500-rates.json): one non-counted Worker system-scope plan profile.

When reproducing the Worker benchmark, load local credentials from the repository `.env`, choose a new output filename, and enable shell no-clobber before starting the command:

```sh
set -o noclobber
capture="docs/evidence/phase-6-pr1/rls-initplan-worker-perf-run-$(date -u +%Y%m%dT%H%M%SZ)-${RANDOM}.json"
pnpm --filter @fs-billing/db exec tsx --env-file=../../.env scripts/rls-initplan-worker-perf.ts > "$capture" 2> "${capture%.json}.stderr.txt"
```

The runner refuses non-loopback endpoints or a source database other than local `fs_billing`; it provisions only generated `fsb_rls_w_*` databases, asserts the 13-qual-only policy diff and identical indexes, and checks `pg_database` after cleanup. Each Worker child has a 120-second timeout. Timeout, SIGINT, or SIGTERM terminates the child process group and returns control to database cleanup. If both benchmark work and cleanup fail, the runner reports both errors. A final signal check prevents a complete result after SIGINT or SIGTERM during cleanup. Set `RLS_INITPLAN_WORKER_TIMEOUT_MS` to an integer from 1 to 120,000 to shorten the limit for local failure-path checks. Do not reuse an existing capture path.

After collecting the accepted samples, failure-path checks used a local `pnpm` stub to hold a child process open. Timeout, SIGTERM, and SIGKILL escalation each terminated the stub process group, ran database cleanup, and left no database with the invocation's generated prefix. The checks did not send Worker HTTP requests or add performance samples. Results are in [worker cleanup failure paths](worker-cleanup-failure-paths.txt).
