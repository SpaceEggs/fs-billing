# session-expiry — PASS

run 20261014T085015Z-3b300e, 2026-10-14T08:54:43.592Z, web http://127.0.0.1:44029

| step | action | result | detail |
|---|---|---|---|
| expired-redirect | expired session + deep link with query -> login -> back to the same URL | PASS |  |
| revoked-dialog | session deleted while on /admin?view=verify -> dialog -> re-login returns | PASS |  |
| cross-zone-fallback | remembered /admin path + customer login falls back to / | PASS |  |
