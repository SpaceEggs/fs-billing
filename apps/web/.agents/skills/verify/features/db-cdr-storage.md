# CDR storage

Database callers persist formal call detail, raw received text, and unassigned calls awaiting resolution. Source: CDR/raw/unassigned definitions and triggers in `packages/db/migrations/0000_init.sql`, `src/schema.ts`, and `src/cdrs.db.test.ts`.

## Sub-features

- `cdr-formal` constrains answer/time/rating fields and registers the UUID.
- `cdr-raw` retains exact text and derives a queryable JSONB payload when representable.
- `cdr-unassigned` stores a pending/ignored/assigned resolution state with required actor/reason fields.

## How to get to it (user POV)

- Drive PostgreSQL acceptance after the skill's database preconditions. Operator SQL uses parent tables with admin/system scope and pre-created month partitions. No CDR ingestion endpoint or resolution UI exists yet.

## Driving it with database commands

```sh
pnpm test:db packages/db/src/cdrs.db.test.ts
psql "$APP_DATABASE_URL" -X -v ON_ERROR_STOP=1 <<'SQL'
BEGIN;
SET LOCAL app.scope = 'system';
INSERT INTO raw_cdrs (body) VALUES ('this is not JSON');
SELECT body, payload FROM raw_cdrs WHERE body = 'this is not JSON';
SELECT tenant_tag, reason, status FROM unassigned_cdrs WHERE tenant_tag = 'ABC01';
ROLLBACK;
SQL
```

- Require exact raw text and NULL payload for the invalid JSON. Fresh seed has a pending `ABC01` call with reason `找不到租户`. Rollback removes the raw example.
- Acceptance reads raw whitespace/key order/duplicate keys unchanged while JSONB is canonicalized; malformed and numeric-overflow JSON still store raw text with NULL payload. Formal UUID duplication fails `23505` across months.
- ISO and Description are nullable, including on partitions. Old rows retain NULL; new answered calls snapshot nonempty ISO/Description from the matched rate, and blank strings become NULL. ISO must be two uppercase letters or NULL. Formal unanswered rows require duration/minutes/charge 0. Answered rows require answer within start/end and non-NULL matched prefix/country/rate. End must not precede start; duration and charges are nonnegative. Save summary and independent SQL output.

## Gotchas

- Answered shape does not itself prove charge arithmetic or a ledger append. Pricing and ledger acceptance are separate capabilities.
- JSONB conversion catches `22P02`, `22P05`, and `22003`; valid JSON that JSONB cannot represent can still retain body with NULL payload.
- Raw inserts require a receipt-month partition. Formal inserts require a start-month partition; missing months give `23514`.
- Pending unassigned rows have no resolution metadata; ignored rows need reason/actor/time, assigned rows need tenant/actor/time. Invalid state combinations fail `23514`.
- Tenant scope cannot read raw or unassigned records. Use parents as the app role; direct partition reads are denied.
