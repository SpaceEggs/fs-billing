# API health

The developer can confirm API availability directly and through the Web server's API proxy.

## Sub-features

- `api-direct` returns the API health body from port 3000.
- `api-proxy` returns the same body through port 5173.

## How to get to it (user POV)

- Open or request `http://127.0.0.1:3000/api/health`.
- Open or request `http://127.0.0.1:5173/api/health` through the Web server.

## Driving it with HTTP

Preconditions:

- Launch the skill's owned session and pass Doctor.

- Run `curl --noproxy '*' --fail --silent --show-error -w '\nHTTP %{http_code}\n' http://127.0.0.1:3000/api/health`. Require exit 0, HTTP 200, and the complete JSON body `{"status":"ok","service":"api"}`.
- Run `curl --noproxy '*' --fail --silent --show-error -w '\nHTTP %{http_code}\n' http://127.0.0.1:5173/api/health`. Require the same status and complete JSON body.
- Save both commands, outputs, and exit codes. Doctor also captures both entry points in `doctor.json`.

## Gotchas

- A passing direct request does not prove the Vite proxy works. Drive both entry points.
- This endpoint checks neither database connectivity nor login.
- The health body is identical across checkouts. Use Doctor's process ownership check before treating it as this run's evidence.
