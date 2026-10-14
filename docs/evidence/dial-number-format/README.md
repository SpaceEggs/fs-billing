# dial-number-format evidence: drop legacy number format (2026-10-13 PT)

Branch `drop-legacy-number-format`. Earlier #13 evidence in this folder was replaced by these runs.

- partA-counts-before.txt / partA-counts-after.txt: local dev DB `fs_billing` row counts before and after the reset (DROP/CREATE + `pnpm db:migrate`, no seed: the seed reinserts ABC001 CDRs/ledger/unassigned rows)
- pnpm-check.txt: `pnpm check` (lint, format, typecheck, unit tests) passes
- test-db-run{1,2,3}.txt: `pnpm test:db` on a fresh `fs_billing_test`, 161/161 each
- lua-harness.txt: `lua5.3 freeswitch/tests/billing_authorize_test.lua` passes
- fs-image-build.log: FS image built with the SignalWire token passed only as a BuildKit secret; token grep over evidence and build logs: no match
- integration-run{1,2}.txt: `freeswitch/test/run-integration.sh`, 14/14 PASS twice
- old-format-rejected.txt: authorize without `dialedNumber` -> HTTP 400 `sipCode:484`; CDR without `billing_dialed_number` is rejected by schema / parked as `话单校验失败` and never billed
- claude-review-1.md: Claude Code read-only review (1 blocking, 5 should fix, 7 minor), all addressed in the fix commit
- `git diff --check`: clean
