# Worker health

The developer can confirm that the Worker responds on its own port, including when the API is unavailable.

## Sub-features

- `worker-direct` returns the Worker health body from port 3001.
- `worker-independent` continues to return the same body after the owned API listener stops.

## How to get to it (user POV)

- Open or request `http://127.0.0.1:3001/health`.

## Driving it with HTTP

Preconditions:

- Launch the skill's owned session and pass Doctor.

- Run `curl --noproxy '*' --fail --silent --show-error -w '\nHTTP %{http_code}\n' http://127.0.0.1:3001/health`. Require exit 0, HTTP 200, and the complete JSON body `{"status":"ok","service":"worker"}`.
- For independence, confirm ownership of the API PID in `doctor.json`, then send SIGTERM to that PID. Confirm that the direct API request fails. Repeat the Worker request and require the same successful response. Save the failed API request and successful Worker request together.
- After the independence drive, clean up the full session. Start a fresh session before verifying the connected Web baseline again.

## Gotchas

- Use `/health` on port 3001. `/api/health` belongs to the API.
- Worker startup now requires `APP_DATABASE_URL`, `WORKER_SHARED_KEY`, `WORKER_ALLOWED_IPS`, DB migrations, and `pnpm --filter @fs-billing/worker queue:migrate`. See [Worker interfaces](worker-api.md). Health still reports process status without checking DB readiness.
- A Worker response without stopping the API does not prove independence.
- Doctor expects the healthy baseline and must fail after the API is intentionally stopped. That failure is expected during this sub-feature.
