# Worker call charging

The app-role job handler charges an answered call from its saved answer-time rate snapshot. Sources: `apps/worker/src/charge.ts`, `queue.ts`, `main.ts`, and `app.db.test.ts`.

## Sub-features

- `charge-once` writes one `call:<UUID>` ledger event and updates balance once across repeated/concurrent execution.
- `charge-snapshot` uses the version at answer time and refuses missing rates during ingestion.
- `charge-month` stores `occurred_at = answered_at`, including calls processed in a later Beijing month.
- `charge-rollback` rolls back ledger and balance after failure following ledger insertion.
- `charge-redelivery` restarts pg-boss and reclaims an expired unacknowledged job without a second charge.

## How to get to it (user POV)

POST a valid CDR as described in `docs/worker-api.md`; Worker atomically enqueues `charge-cdr` and consumes it. Runtime connects as `fs_billing_app`; queue schema installation is an owner deployment operation.

## Driving it with job handlers and database commands

```sh
pnpm test:db apps/worker/src/app.db.test.ts
```

Require the 190-second sample at 0.0480/minute to store 4 billed minutes, 0.192 charge, one -0.192 ledger event and -0.192 balance. Repeated handler calls must preserve those values. Verify Beijing September/October fixtures use answer-time rates and months rather than creation time.

Require the injected failure after ledger insertion to leave no charge and unchanged balance; rerunning succeeds exactly once. The unacknowledged-job test stops the queue, advances expiry, restarts supervision and drives the redelivered job. Require one ledger event and unchanged already-charged balance. Save the test summary and exit code.

## Gotchas

- The queue-restart test does not kill a FreeSWITCH process. It proves stored job recovery and idempotent handling, not real SIP integration.
- Unanswered and zero-price calls produce no ledger event. Pending/invalid CDRs never enter the charge queue.
- Transaction retries apply only at the outermost transaction. Keep external side effects out of rerunnable callbacks.
- pg-boss is pinned and patched to avoid new advisory locks and premature Drizzle transaction commits. Revalidate these paths after upgrades.
