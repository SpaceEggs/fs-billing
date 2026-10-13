# Worker endpoint security

Worker binds a private IPv4 address, checks the actual source IP, and requires a shared key on both POST routes. Sources: `apps/worker/src/config.ts`, `app.ts`, `config.test.ts`, and `app.db.test.ts`.

## Sub-features

- `security-bind` accepts loopback/RFC1918 IPv4 only and validates port, app database role, key length and IP list at startup.
- `security-key` returns 401 for missing or wrong `X-Billing-Key` before CDR storage.
- `security-ip` returns 403 outside the allowlist even with a valid key.
- `security-relay` restricts the header-injecting CDR relay to loopback on the FreeSWITCH machine.

## How to get to it (user POV)

Configure `WORKER_HOST`, `WORKER_PORT`, `WORKER_SHARED_KEY`, `WORKER_ALLOWED_IPS` and `APP_DATABASE_URL` using `docs/worker-api.md`. Start Worker independently of API. Do not expose its port through the public website proxy.

## Driving it with HTTP and configuration commands

```sh
pnpm test apps/worker/src/config.test.ts
pnpm test:db apps/worker/src/app.db.test.ts -t '缺密钥'
```

Require configuration rejection for public/wildcard binds, invalid ports/IPs, short keys and owner-role runtime URLs. The DB test requires 401 for missing/wrong keys and 403 for a non-allowlisted actual source IP. Save status, test output and exit codes.

With a running Worker, POST `/authorize` and `/cdr` without a key and require 401 from an allowed IP. Repeat with a valid key from a separate non-allowlisted host and require 403. Confirm no raw body or job appears for the rejected CDR. On the FreeSWITCH machine run `nginx -t` and inspect that the relay listens only on `127.0.0.1:3002`; requests from other hosts must fail to connect.

## Gotchas

- `/health` is public and does not prove authentication or DB readiness. The health-only factory used by tests is not the configured runtime.
- Worker does not trust `X-Forwarded-For`; the allowlist contains the real network peer. The loopback relay forwards from the FreeSWITCH host to Worker.
- Native `cred` is Basic authentication, not `X-Billing-Key`. Use the documented relay; protect its config and FreeSWITCH global key from other local accounts.
- Do not place the key in channel variables or query strings, which enter CDRs or logs.
