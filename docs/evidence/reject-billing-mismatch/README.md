# reject-billing-mismatch evidence (2026-10-13 PT)

Branch `reject-billing-mismatch`, stacked on #14 (`drop-legacy-number-format`).

- pnpm-check.txt: `pnpm check` passes (252 tests)
- test-db-run{1,2,3}.txt: `pnpm test:db` on a fresh `fs_billing_test`, 161/161 each
- lua-harness.txt: `lua5.3 freeswitch/tests/billing_authorize_test.lua` passes
- fs-image-build.log: FS image built with `SIGNALWIRE_TOKEN` only as a BuildKit secret; token grep over evidence and run logs: no match
- integration-run{1,2}.txt: `freeswitch/test/run-integration.sh`, 15/15 PASS twice, including `计费号码不一致 HTTP 400 / SIP 503`
- mismatch.{raw,unassigned,alerts}.json: drift case output (raw CDR without `billing_unverified`, `hangup_cause=NORMAL_TEMPORARY_FAILURE`; unassigned row `计费号码不一致` / `867551234567`; one `cdr_failed` alert, no `auth_timeout`)
- fails-on-14-unit.txt / fails-on-14-integration.txt: with #14's `app.ts`, the new unit test fails and the SIPp drift case fails (call got `200 OK`, i.e. bridged via fallback)
- claude-review-1.md: Claude Code read-only review (0 blocking, 2 should fix, 4 minor), all addressed in the fix commit
- counts-before.txt / counts-after.txt: local dev DB `fs_billing` reset (DROP/CREATE + `pnpm db:migrate`, no seed)
- `git diff --check`: clean
