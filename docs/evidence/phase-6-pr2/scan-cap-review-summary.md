# Cross-window adjustment scan cap review

This is a review-process summary based on the Web implementation agent's reported terminal output. It is not a preserved raw terminal log.

Independent review found a boundary case after the first source commit. If newer date windows supplied 950 adjustments and the oldest window returned a final page of 100, the scanner kept only 50 of that page but reported `truncated=false`. The former `rangeDone` condition described how much the server returned, not how much the scanner retained.

The fix records `pageTruncated = rows.length > remaining` and includes that condition in the returned truncation flag. It retains the existing conditions for unread pages and older date windows. Regression cases check both 950 plus 100, which is truncated, and 950 plus 50, which is complete. Both cases retain exactly 1,000 items.

The Web agent ran the new oldest-window case against the old implementation at 15:38:31 JST on 2026-10-18. `pnpm --filter @fs-billing/web exec vitest run src/lib/receivables.test.ts -t 'oldest window'` exited 1. The reported assertion was `expected false to be true` at `receivables.test.ts:374`.

After the fix, the agent ran `vitest run src/lib/receivables.test.ts src/pages/admin/tenant-tabs/ledger-tab.test.tsx` at 15:40:02 JST. Its reported output was `Test Files 2 passed (2)`, `Tests 34 passed (34)` and `Duration 1.20s`. Web typecheck, lint and the relevant Prettier checks also exited 0. Those commands printed directly in the agent's terminal and were not redirected to files.

The final full repository check is captured separately in [check.txt](check.txt). That output is a raw command capture and includes the new regression cases in the complete Web suite. The DB query and performance code did not change for this fix, so the accepted DB and performance measurements remain applicable.
