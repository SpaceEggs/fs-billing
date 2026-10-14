# cross-tenant — PASS

run 20261014T083714Z-b9fa00, 2026-10-14T08:37:58.473Z, web http://127.0.0.1:51139

| step | action | result | detail |
|---|---|---|---|
| own-tenant-only | A and B each read /api/portal/context and only see their own tenant | PASS | A sees ABC001 -35.20 CNY only; B sees GLB009 -15.02 USD only |
| customer-to-admin | customer cookie on admin API -> 403, no side effect | PASS | GET /api/admin/context 403; reset-password on B 403; B credential untouched; 0 audit rows |
| admin-to-portal | admin cookie on portal API -> 403 | PASS |  |
| anonymous | no cookie -> 401 UNAUTHENTICATED | PASS |  |
| idor-suite | pnpm test:idor (live OpenAPI enumeration, RLS) on a scratch fs_billing_test in our container | PASS | Tests  15 passed (15) |
