# Phase 6 PR 1 independent final review

Verdict: **PASS+NOTES**. The timeout and SIGTERM worker lifecycle repair works in a live, isolated timeout injection. I found no new blocker in the migration, catalog test, fixture-helper rename, or Worker result path. One non-blocking cleanup-error reporting gap remains in the benchmark harness.

## Scope and intent

Intent: change only the `tenant_read` `USING` predicates on 13 tenant-scoped tables to InitPlan expressions, preserve existing tenant visibility and other policy attributes, and keep the worker benchmark's disposable database and child-process cleanup reliable on timeout or interruption.

Reviewed the uncommitted diff at `/Users/lqzone/.codex/worktrees/phase-6-rls-initplan/FS-Billing`, branch `phase-6-rls-initplan`, base/HEAD `5f78c4409a9f948add0b44165ba00409343e4aa6`. The worktree contained only the expected PR files. I made no source changes. The production migration has 64 SQL lines / 13 `ALTER POLICY` statements and touches only the approved `tenant_read` policies; it contains 12 Drizzle statement-breakpoint markers. The catalog test's renamed helper is `insertSupplementalFixturesWithAppScopeUnset`.

SHA-256:

- `packages/db/scripts/rls-initplan-worker-perf.ts`: `ae5aeb4abbd98b4478b15fa6bd059f23d2003a8a31ebb45a01f196c9ffdb2059`
- `packages/db/migrations/0015_rls_initplan.sql`: `6444d3f11720a9821ca4f69e5809c90abca9a1ccf545f63847c161fd27a0bbc8`
- `packages/db/src/rls-initplan.db.test.ts`: `b74844e5ea7c8e8dfd6bb0bf4156253b5515f5e3e26883748d15c1fe97599b55`

## Finding

### [warning] Cleanup failures are hidden when benchmark work already failed

**Location:** `packages/db/scripts/rls-initplan-worker-perf.ts:613`.

If a benchmark operation throws, JavaScript runs the `finally` cleanup and then propagates that original exception. If a `DROP DATABASE`, leftover query, or owner close also fails, the cleanup block stores that issue in `cleanupError`, but control never reaches the `if (cleanupError)` after the `finally`. The run still exits as failed, so this does not create a false success; however, the output omits that disposable databases may remain. Preserve both errors or include the cleanup failure in the existing failed-run output.

## Live timeout verification

I loaded `/Volumes/Dev/FS-Billing/.env` into the command environment without printing its contents. The runner itself verified that its owner endpoint was loopback `fs_billing`. A temporary local `pnpm` stub ignored SIGTERM and kept a child alive, so the runner exercised the 1,000 ms timeout and 1,000 ms SIGKILL escalation without starting Worker HTTP requests or collecting a performance sample.

Command: `pnpm --filter @fs-billing/db exec tsx scripts/rls-initplan-worker-perf.ts` with `RLS_INITPLAN_WORKER_TIMEOUT_MS=1000` and `PATH` pointing to the temporary stub first. The runner reported `Worker run timed out after 1000 ms for fsb_rls_w_ec9da35e_01_base`. Expected exit code was 1; recorded exit code was 1. Stub process group PIDs 78733 and 78735 were both gone after exit. A read-only `pg_database` query returned `[]` for every `fsb_rls_w_*` database. The run used only the disposable benchmark clones; it did not touch `fs_billing_perf` or send Worker HTTP traffic. No review process remains running.

The author also recorded final-source timeout escalation and SIGTERM checks in `docs/evidence/phase-6-pr1/worker-cleanup-failure-paths.txt`. My independent run confirms the timeout path against the current source. I did not repeat SIGTERM because it would exercise the same shared termination and cleanup flow.

## Limits and disposition

The earlier reports in `/tmp/fs-billing-phase6-pr1-review/security-and-comments.md` and `report.md` were PASS+NOTES; this review only assessed the final lifecycle repair and adjacent final-source state. I did not rerun the full DB/IDOR suites or performance measurements, per scope. No second model or agent was used, per instruction, so there is no multi-model agreement signal. The `no-comments` skill's separate-agent step was not run under that same restriction; its source guidance was read, and the old fixture narrative comment has been removed in the current test.

**Mergeability:** no migration or authorization blocker found. PASS+NOTES, with the cleanup-error reporting gap as non-blocking follow-up.

## Final cleanupError delta recheck (2026-10-18)

**Updated verdict: PASS+NOTES.** The previous cleanup-error finding is **resolved** in the final source. No blocking finding remains from this review.

The current worker script matches the supplied SHA-256 `1c8cf8913e288d1c154fb3767e4789503ae27f9f3f26c41aed6763bbaae140f9`. I read the source directly. The catch at line 589 stores the primary error; `finally` still attempts every tracked DROP, checks the generated prefix, and closes the owner. After cleanup, the script combines the primary and cleanup messages and preserves the original as `cause` when both fail (lines 618-626). When cleanup succeeds it rethrows the original error (line 630). It calls `assertNotInterrupted()` immediately before emitting a successful result (line 631), so SIGINT/SIGTERM received during cleanup cannot produce a `complete` JSON result.

The updated README and failure-path record match the supplied SHA-256 values `40e9ec46c697554590a8703372a418609713ced48698627032251eadcf958808` and `513a20600855608c6b64a05e464735871a15534d11a2cce234d53ff64544bb55`. The failure record describes the combined timeout-plus-cleanup failure, exit 1, absence of a `complete` result, the three exact generated databases intentionally left by the DROP-query injection, cleanup restricted to that prefix, and the final empty-prefix check. It also records no Worker HTTP requests and the stub child exit. This is sufficient evidence for the narrow reporting fix; the record is a concise execution summary rather than a raw captured terminal transcript.

I performed only a read-only owner query for `fsb_rls_w_2bb5a6d6_*`. It returned `[]` with exit 0. PID 79173 was absent. No benchmark, HTTP sample, intentional residue, or source change was made during this recheck.
