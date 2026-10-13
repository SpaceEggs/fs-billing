# Beijing time attribution

Rating callers parse Beijing local times as fixed UTC+8 and derive the call's answer day/month. Source: `packages/rating/src/time.ts` and `time.test.ts`.

## Sub-features

- `time-parse` accepts `YYYY-MM-DD HH:mm[:ss]` with space or `T` separator.
- `time-attribution` derives Beijing day/month from the supplied answer instant.

## How to get to it (user POV)

- Drive package acceptance from the repository root; callers use `beijingTime`, `beijingDay`, and `beijingMonth`.

## Driving it with package commands

Preconditions: installed dependencies.

```sh
pnpm test packages/rating/src/time.test.ts
```

- Require exit 0. Beijing `2026-10-01 00:00` becomes `2026-09-30T16:00:00.000Z`.
- A call answered before Beijing midnight remains attributed to its answer day/month even when it ends later. Invalid calendar dates and malformed text throw.
- Preserve command, test summary, and exit code.

## Gotchas

- These helpers use fixed UTC+8, independent of the machine timezone; they do not implement daylight saving.
- The caller must supply answer time rather than end/write time. Database CDR partitions instead use start time; raw partitions use receipt time.
- Invalid Date inputs to formatting throw through `toISOString`.
