# Phase 6 PR1 independent review

**Verdict: PASS+NOTES.** I found no migration-scope, tenant-visibility, or policy-metadata defect in the reviewed code. One low-priority benchmark timeout gap remains. The report-only comment check also flags one fixture comment for deletion or a clearer helper name.

## Intent

Change only the `tenant_read` `USING` expressions on the 13 approved tenant tables to scalar subqueries, so PostgreSQL can evaluate the scope helpers as InitPlans. Preserve row visibility, all other policy attributes and policies, app code, and CDR leaf permissions. Prove those properties with DB/IDOR tests, catalog snapshots, actual plans, and safely isolated performance evidence.

## Scope and review limits

I reviewed the frozen migration, journal, migration-count test, catalog/RLS test, both new performance scripts, and the final design/evidence README. The four source hashes match the values supplied for the freeze. The README hash is `ab73da3ad934d271844303617f0b0f7554f9c5f94e4b54bb7ea2b036ba03a114`.

The Run 1 recovered excerpt and its provenance are excluded from independent verification because I authored that recovery in an earlier task. The separate recon reviewer owns that check. I did not run tests, benchmarks, or database commands. README evidence records `pnpm check`, `pnpm test:db`, and `pnpm test:idor` as passing; I read those claims but did not rerun them.

The no-comments and interrogate reviews used the current skill files and their stated rubric. The skills normally use separate reviewers, but the parent explicitly prohibited agents and other models for this review. This is one reviewer’s result, with reduced model diversity.

## Finding

### 1. [warning] A hung Worker sample prevents benchmark cleanup

**Location:** [rls-initplan-worker-perf.ts](/Users/lqzone/.codex/worktrees/phase-6-rls-initplan/FS-Billing/packages/db/scripts/rls-initplan-worker-perf.ts:200)

**Evidence:** `runWorker` calls synchronous `spawnSync` without a timeout. The unchanged child script sends each of its 1,000 requests with `fetch` and no abort signal. The Worker handler awaits the database read in `loadRatingTenant`. If a request stalls, `spawnSync` blocks the parent before it reaches the database-drop and prefix-verification `finally` at lines 484–509. That can leave generated benchmark databases behind until someone intervenes.

**Suggestion:** Bound each request or the child-run lifetime, and have timeout failure return control to the parent cleanup path. This is a benchmark reliability issue, not an app authorization defect.

## No-comments report-only check

- Comment deletions: 0. This was report-only, so I made no edits.
- Restored comments: 0.
- `MUST KILL`: the comment at `packages/db/src/rls-initplan.db.test.ts:188`, inside `insertSupplementalFixtures`, narrates the fixture’s unset-scope behavior. The helper name or a narrowly named lock helper should make that behavior clear without prose.
- Protected exceptions: all 12 `--> statement-breakpoint` markers in migration 0015 remain. Drizzle uses these as migration protocol markers.
- Lint/type suppressions: none found in changed code.
- Reruns, architect sketches, fixes, and encodings: none. The explicit report-only and no-write constraints prohibit applying flags.
- Open constraint: no separate comment-sicko agent ran because the parent prohibited subagent use. I applied its checked-in rules directly and do not claim an agent verdict.

## Review disposition

There are no security or row-visibility blockers. The migration changes only the 13 intended `tenant_read` quals. The test checks catalog-discovered relations, same-backend scope transitions, the legacy predicate oracle, and CDR leaves. The worker harness verifies policy and index snapshots and removes generated databases on ordinary completion and error paths. The timeout gap above is the only code finding. The comment flag is maintainability feedback from the requested no-comments pass.

I did not independently validate the recovered Run 1 artifact or benchmark result calculations. The only unresolved code recommendation is bounding the Worker sample lifetime so cleanup also runs after a stalled request.
