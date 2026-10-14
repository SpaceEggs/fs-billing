# dial-number-format evidence (2026-10-13 PT)

- pnpm-check.txt: `pnpm check` (lint, format, typecheck, 263 tests) passes
- test-db-run{1,2,3}.txt: `pnpm test:db`, 3 runs, 150/150 each
- lua-harness.txt: `lua5.3 freeswitch/tests/billing_authorize_test.lua` passes
- fs-image-build.log: FS image built with the SignalWire token passed only as a BuildKit secret (`--secret id=signalwire_token,env=SIGNALWIRE_TOKEN`); token grep over evidence and logs: no match
- integration-run{1,2}.txt: run-integration.sh, 14/14 PASS twice (plus, 00, domestic mobile, domestic landline, +1305, bare 1305, 484, 403, 402, ALLOTTED_TIMEOUT, authorize fallback x2, CDR retry and dedup)
- new-tests-on-main.txt: new vitest tests on a6d1dbd: 44 failed; Lua harness on main: exit 1
- claude-review-1.md: Claude Code read-only review (0 blocking, 6 should fix, minors)
- `git diff --check`: clean
