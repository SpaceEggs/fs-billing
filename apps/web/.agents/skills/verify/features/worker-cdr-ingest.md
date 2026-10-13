# Worker CDR ingestion

FreeSWITCH posts A-leg mod_json_cdr text to `/cdr`. Worker commits each raw body before parsing and uses the global UUID registry to prevent duplicate calls. Sources: `apps/worker/src/ingest.ts`, `app.ts`, `packages/shared/src/worker.ts`, and `freeswitch/autoload_configs/json_cdr.conf.xml`.

## Sub-features

- `ingest-raw` preserves exact text for valid, malformed and duplicate pushes.
- `ingest-uuid` returns duplicate on repeated/concurrent UUIDs, including changed tags on an unassigned call.
- `ingest-pending` parks missing/unknown tenant tags, bad numbers and missing answer-time rates without charging.
- `ingest-unverified` retains the flag, charges normally and records one `auth_timeout` alert for the first valid CDR.
- `ingest-atomic-job` commits formal CDR and pg-boss job together; enqueue failure rolls both and registration back.
- `ingest-disk-replay` replays completed failed files through the local relay and removes them only after 2xx.

## How to get to it (user POV)

Use the Worker startup/configuration in `docs/worker-api.md`. Both direct and replay requests require the shared key at Worker. Native mod_json_cdr uses the loopback relay from `freeswitch/README.md` to add that header.

## Driving it with HTTP and database commands

```sh
pnpm test:db apps/worker/src/app.db.test.ts
```

The suite posts real sample text twice, drives a real pg-boss queue, and reads stored state independently with owner. Require two identical raw bodies, one formal CDR, one job, one charge and one balance decrement. Pending fixtures require HTTP 200, one pending row, a `cdr_failed` alert and no job/charge. Malformed JSON is raw-only with an alert and `invalid`. Record test output and exit code.

For the disk path, stop Worker before hanging up a test call. Confirm a complete archive and retry file, restore Worker, then run `replay-cdr.sh`. Files newer than one minute wait for a later run. Require retry removal after 2xx. POST the archived body again and require `duplicate` with unchanged ledger/balance. Preserve the UUID, file copies, HTTP responses and DB reads.

## Gotchas

- Keep `encode=false`, `encode-values=false` and `log-b-leg=false`. Form/base64 encoding does not match Worker's direct text contract; B-leg has a different UUID.
- Each accepted push adds a raw row. Its UUID/tenant columns stay NULL; use `rawId`, `body` or `payload` for lookup.
- Invalid UUID/time shapes cannot form pending rows. They remain raw-only and return HTTP 200, not 400.
- The module does not scan failed disk files itself. Schedule the replay script and monitor the retry directory. A Worker 503 must reach FreeSWITCH unchanged.
