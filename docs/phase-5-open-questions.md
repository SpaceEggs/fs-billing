# Phase 5 open questions

## Legacy tenants without balance alert settings — RESOLVED 2026-10-14

**Decision (user):** follow recommendation option 1, deferred — do **not** backfill or synthesize settings.

- Detail and list projections return service unavailable when a tenant has no `balance_alert_settings` row.
- Balance, ledger, tenant edit, disable, and enable still use core tenant data.
- Creating a tenant always writes explicit settings in the creation transaction.
- Updating settings on an unconfigured legacy tenant stays deferred until a before-state / backfill policy is chosen (product owners pick legacy threshold + recipients then).
- Option 3 (silently project zero / empty) is rejected: invents saved settings and can misstate health.

No remaining open questions in this file.
