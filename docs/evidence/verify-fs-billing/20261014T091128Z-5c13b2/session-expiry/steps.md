# session-expiry — PASS

run 20261014T091128Z-5c13b2, 2026-10-14T09:15:55.359Z, web http://127.0.0.1:53769

| step | action | result | detail |
|---|---|---|---|
| expired-redirect | expired session + deep link with query -> login -> back to the same URL | PASS |  |
| revoked-dialog | session deleted while on /admin?view=verify -> dialog -> re-login returns | PASS |  |
| cross-zone-fallback | remembered /admin path + customer login falls back to / | PASS |  |
