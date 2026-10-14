# FreeSWITCH / SIPp e2e (separate surface)

The telephony surface has no UI. A softswitch user places a call through FreeSWITCH. The billing Lua asks the Worker to authorize it (`maxSeconds`), FreeSWITCH bridges or rejects the call (402/403/484), and on hangup posts the CDR through the nginx relay to the Worker, which inserts `raw_cdrs`/`cdrs` and debits the ledger. `freeswitch/test/run-integration.sh` drives this end to end with real FreeSWITCH, SIPp, nginx, and Worker processes and an observer that captures INVITEs. The browser harness (`drive.mjs`) does not drive it, and `launch.sh` does not start it.

## Sub-features

- `number-cases`: six dialing formats (`+44`, `0044`, domestic mobile, domestic landline, `+1305`, bare `1305`). In each, the upstream INVITE keeps the original number. The authorize request has `callee == billingNumber` normalized and `dialedNumber` raw. The CDR `billing_number` is normalized.
- `rejects`: a disabled tenant gets SIP 403, insufficient balance gets 402, and an invalid number gets 484 before any authorize request. None is bridged upstream.
- `degrade`: when the Worker refuses or stalls, the call degrades per the Lua rules, and the observer records no authorize request.
- `time-limit`: a real 60 s allotted call lasts 59–60 s. It is billed 1 minute, CDR amount `0.01`, ledger `-0.01`, balance `0.01 → 0`.
- `cdr-replay`: with nginx down, the CDR lands in the retry dir. `replay-cdr.sh` re-posts it after nginx returns, and exactly one charge results.
- `lua-unit`: `lua5.3 freeswitch/tests/billing_authorize_test.lua` (also run by `pnpm check`).

## How to get to it (user POV)

- CI: `.github/workflows/freeswitch.yml` job `e2e`, on push or PR touching `freeswitch/**`, `apps/worker/**`, or `packages/**`, nightly, or `workflow_dispatch`. It needs the private GHCR image built by the `image` job (`SIGNALWIRE_TOKEN`).
- Locally: `bash freeswitch/test/run-integration.sh [log-dir]`, with the images `fs-billing-freeswitch:local` and the SIPp image built from `freeswitch/test/sipp.Dockerfile`. `--build` rebuilds FreeSWITCH and needs `SIGNALWIRE_TOKEN`.
- A real test-bench call (phase 10) is a different acceptance, outside this skill.

## Driving it with run-integration.sh

Preconditions:

- Linux with Docker host networking, Node, pnpm, Python 3, curl, and `docker images` showing `fs-billing-freeswitch:local` (or set `FS_IMAGE`).
- Host ports `3001` (Worker), `3002` (nginx relay), `3003` (stall), `3004` (authorize observer), and `5060`/`5062` (SIP) are free. They are fixed and host-networked, so only one SIPp run per machine, and never alongside a dev Worker on 3001.
- **Isolation.** By default the script runs `docker compose -f compose.yaml` against the user's compose project, which is `fs-billing-postgres-1` on `:5432`, migrates it, inserts `FSI…` test tenants, and stops it afterwards if it started it. Never run it bare here. Point it at a throwaway compose project instead:

  ```sh
  SIPP_RUN=fsb-sipp-$(date -u +%Y%m%dT%H%M%SZ)
  SIPP_PORT=$(python3 -c 'import socket; s=socket.socket(); s.bind(("127.0.0.1",0)); print(s.getsockname()[1])')
  SIPP_PW=$(python3 -c 'import secrets; print(secrets.token_hex(16))')
  SIPP_LOG=docs/evidence/verify-fs-billing/$SIPP_RUN/freeswitch-sipp
  COMPOSE_PROJECT_NAME=$SIPP_RUN POSTGRES_PORT=$SIPP_PORT POSTGRES_PASSWORD=$SIPP_PW \
  DATABASE_URL=postgresql://fs_billing:$SIPP_PW@127.0.0.1:$SIPP_PORT/fs_billing \
  APP_DATABASE_URL=postgresql://fs_billing_app:$SIPP_PW-app@127.0.0.1:$SIPP_PORT/fs_billing \
    bash freeswitch/test/run-integration.sh "$PWD/$SIPP_LOG"
  docker compose -p "$SIPP_RUN" -f compose.yaml down -v   # remove ONLY the throwaway project + volume
  ```

  `docker compose config` confirms that these variables give project `fsb-sipp-…`, `127.0.0.1:$SIPP_PORT`, and volume `fsb-sipp-…_postgres_data`. That substitution was checked. The full SIPp run was **not** executed when this skill was generated.

- **Run.** Execute the block above. The script prints a `用例	结果` table, and every row must read `PASS`. Exit code `0` means all cases passed. Any failure appends a `FAIL` row for the current case and exits non-zero.
- **Read the proof.** In `$SIPP_LOG/`: `results.tsv` (PASS/FAIL per case), the observer's INVITE and authorize captures, `containers.log`, `cdr/`, `replay.retry.json` / `replay.archive.json`, and the SQL waits on `raw_cdrs`/`cdrs` keyed by controlled `sip_call_id`. For extra DB proof, query the throwaway DB with `docker compose -p "$SIPP_RUN" -f compose.yaml exec -T postgres psql -U fs_billing -d fs_billing -c "<sql>"` before running `down -v`.
- **Lua unit only.** Run `lua5.3 freeswitch/tests/billing_authorize_test.lua`. Exit `0`.
- **CI evidence.** A PR's `FreeSWITCH integration` workflow uploads the `freeswitch-integration` artifact (the same log dir). `docs/evidence/phase-4-api/ci.txt` records the last all-PASS run.

## Gotchas

- Running `run-integration.sh` with no overrides writes FSI tenants into the user's dev DB and may stop their Postgres container. Always use the throwaway compose project above, and remove it with `down -v` for that project name only.
- `WORKER_SHARED_KEY` is generated per run when unset. Do not export a real key into the logs.
- The time-limit case really waits about 60 s per call, so the whole run takes several minutes. Do not shorten it: billing at 61 s counts as 2 minutes and the assertions are exact.
- If the image for the current `freeswitch/install/**` and `freeswitch/docker/**` hash is not built, CI skips the e2e with a notice. A skipped workflow is not a PASS.
- `launch.sh`'s API and web stack is independent of this. It does not start the Worker, so `/authorize` and CDR ingest cannot be shown through the browser harness.
