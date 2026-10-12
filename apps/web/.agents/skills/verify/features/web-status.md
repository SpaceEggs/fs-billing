# Web service status

The landing page shows whether its request to the API succeeds.

## Sub-features

- `web-connected` shows `服务状态：连接正常` after a real API request.
- `web-unavailable` shows `服务状态：暂时无法连接` when the API is unreachable.
- `web-recovered` shows `连接正常` after the API returns and the user opens the page again.

## How to get to it (user POV)

- Open `http://127.0.0.1:5173/` in the browser.
- Reload the same page to make a fresh connection attempt.

## Driving it with Codex browser control

Preconditions:

- Launch the skill's owned session and pass Doctor for the connected baseline.
- Use a temporary tab controlled by `mcp__cua_repl`.

- Open the Web URL. Read a fresh snapshot. Require the heading `电话计费系统` and a `status` element containing `服务状态：连接正常`.
- Save the navigation, status text, snapshot, and screenshot. Use `web-action.json`, `web.aria.txt`, and `web.png` in the run directory.
- To check the unavailable state, read the API listener PID from `doctor.json`. Confirm that it still belongs to the recorded launcher, then send SIGTERM to that PID. Keep Web running. Confirm that a real request to port 3000 fails, reload the page, and require `服务状态：暂时无法连接`. Save separate unavailable-state evidence.
- To check recovery, clean up the entire session, start a fresh owned session, pass Doctor, and open the Web URL in a fresh tab. Require `连接正常`. Preserve the earlier run's evidence.

## Gotchas

- The page requests health only when it mounts. Stopping the API does not change the already rendered connected state until a reload.
- The initial `正在连接` state may disappear before the browser snapshot. Do not depend on observing that transient state.
- The Web proxy points to port 3000. An API on another port does not satisfy this path.
- API health does not check PostgreSQL. The page cannot prove database readiness.
- Report only the sub-features actually driven.
