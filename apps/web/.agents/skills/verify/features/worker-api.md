# Worker authorization and CDR ingestion

The FreeSWITCH caller authorizes calls and pushes raw mod_json_cdr text directly to Worker. Sources: `docs/worker-api.md`, `packages/shared/src/worker.ts`, `apps/worker/src/app.ts`, `ingest.ts`, `charge.ts`, `queue.ts`, and `app.db.test.ts`.

## Sub-features

- `worker-authorize` loads real tenant status, balance and rates; returns allow/maxSeconds or reject/reason/sipCode.
- `worker-authorize-number` returns HTTP 400 and `号码格式错误` for invalid callee syntax.
- `worker-cdr-raw` commits exact received text before parsing, including malformed and duplicate pushes.
- `worker-cdr-gate` deduplicates via call_uuids, including concurrent pushes and changed tags on unassigned calls.
- `worker-cdr-unassigned` parks unknown/missing tenant tags and malformed numbers as pending with cdr_failed alerts and no charge.
- `worker-cdr-charge` enqueues atomically with the CDR and calculates through rating from the saved answer-time rate and supports idempotent ledger writes with occurred_at = answered_at.
- `worker-cdr-partition` returns 503, logs and alerts on missing partitions without write-path DDL.
- `worker-crash` proves rollback after a simulated failure following ledger insertion and pg-boss redelivery after commit without acknowledgement.
- `worker-partition-maintenance` runs once at startup and daily at Beijing midnight, alerts on failure and supports re-push after missing partitions recover.
- `worker-access` rejects missing/wrong shared keys and IPs outside the allowlist.
- `worker-authorize-perf` checks 500 entries and 1,000 sequential real HTTP requests against p95 < 50 ms.

## Driving it

```sh
pnpm test:db apps/worker/src/app.db.test.ts
pnpm perf:authorize
```

The DB suite uses the shared fresh `fs_billing_test` database, app-role writes and independent owner reads. It installs a real pg-boss schema with owner, then uses app-role queue operations. Require one CDR, two exact raw bodies, one queued job, one ledger charge and one balance decrement after duplicate posting and repeated handler execution. Unknown tags and invalid callees must give HTTP 200 with pending records, alerts and no jobs/charges. Capture command output and exit code.

The performance script needs the `.env` app connection, `WORKER_SHARED_KEY` (at least 16 characters) and `WORKER_ALLOWED_IPS` configured. It owns an ephemeral loopback HTTP listener and stops it at teardown. Require the JSON result to show 500 entries, 1000 requests, p95Ms < 50 and passed=true. It leaves its dedicated tenant disabled with rates intact; record that persistent effect.

For a direct Worker process, migrate DB and install the queue before starting. Both POST routes require `X-Billing-Key`. Contracts and request examples are in `docs/worker-api.md`; sample body is `freeswitch/examples/sample-cdr.json`. Do not post the sample into customer data merely to verify health.

## Gotchas

- Bad JSON/invalid shapes are raw-only with alerts and HTTP 200; unassigned rows require a valid UUID and call timeline.
- Raw CDR UUID/tenant columns remain NULL because original rows are inserted before parsing and are append-only. Inspect body/payload or returned rawId.
- Formal CDRs preserve billing_unverified; unanswered and zero-price calls produce no ledger entry.
- Job crash recovery, queue supervision and daily partition scheduling are covered by the DB suite. FreeSWITCH dialplan integration remains a later phase 3 unit. Simulated transaction failure and queue restart do not prove an actual FreeSWITCH call.
