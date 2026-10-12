---
name: verify
description: Launch and drive the FS-Billing stage-0 Web page and real API and Worker HTTP endpoints. Use to verify local runtime behavior, capture evidence, and check cleanup after changes to these surfaces.
---

# Verify FS-Billing

Use this skill from the repository root. Read the [feature index](features/README.md), then the feature being verified. The primary surface is the Web page. The secondary surfaces are the API and Worker HTTP endpoints.

The current scaffold has no authentication, seed data, billing operations, or database-backed routes. PostgreSQL readiness is a separate infrastructure check. A healthy Web page or health endpoint does not prove database readiness.

## Launch

1. Run `pnpm install --frozen-lockfile` if dependencies are absent. Run `pnpm check && pnpm build` before driving a changed checkout.
2. Create a fresh evidence directory from the repository root, then start the launcher in the same terminal command.

   ```sh
   verify_artifacts="${VERIFY_EVIDENCE_ROOT:-$(pwd)/artifacts/verify}"
   mkdir -p "$verify_artifacts"
   verify_run=$(mktemp -d "$verify_artifacts/run-XXXXXX")
   apps/web/.agents/skills/verify/scripts/launch.sh "$verify_run"
   ```

3. Use `exec_command` with `tty: true` and `workdir` set to the repository root for step 2. Save the printed evidence path and returned terminal session ID. Keep that terminal running while driving the browser. In later shell calls, set `verify_run` to that printed path.

   The launcher records its PID, checkout, revision, and starting worktree status. It runs the repository's `pnpm dev` command and saves output to `dev.log`.

   If the browser tool cannot write inside the checkout, set `VERIFY_EVIDENCE_ROOT` to a directory writable by both the browser and terminal tools before running step 2. Keep that directory after cleanup. Do not discover the permission mismatch after capturing the proof.

4. Read `dev.log`. Readiness requires Vite at port 5173, `API listening at http://127.0.0.1:3000`, and `Worker listening at http://127.0.0.1:3001`. Run Doctor after those lines appear. Bound readiness to 60 seconds. On failure, capture the log and run Cleanup before retrying.

The launcher pins the API and Worker environment variables to the existing Web proxy's ports. It does not edit `.env` or start Docker. It refuses occupied ports 3000, 3001, or 5173. This scaffold cannot run two complete Web instances side by side without changing its proxy configuration. Never attach to an existing instance to bypass the refusal.

## Doctor

Run this read-only instance check before the first browser action, and whenever ownership or readiness looks wrong.

```sh
apps/web/.agents/skills/verify/scripts/doctor.py "$verify_run"
```

Exit 0 and `result: ready` mean that the recorded launcher remains alive in the recorded checkout, the revision matches, all three listening ports belong to its descendants, and Web, direct API, proxied API, and Worker responses match their real contracts. The command writes `doctor.json` and `web.html` to the evidence directory. It does not inspect database health or prove browser rendering.

If Doctor fails, inspect `dev.log` and port ownership. Do not kill the process that occupies a port unless this run owns it. A matching health response alone cannot establish ownership.

## Drive

Use the session's browser-control tool. On Codex, use `mcp__cua_repl`; follow its first-call bootstrap and returned documentation. Open `http://127.0.0.1:5173` in a temporary background tab. If a browser session is already initialized, reuse its binding and create a fresh tab.

```js
let verifyTab = await cua.createBrowserTab('iab', 'http://127.0.0.1:5173', {
  visible: false,
});
```

Read a fresh accessibility or DOM snapshot. Require the heading `电话计费系统` and the `status` element containing `服务状态：连接正常`. The browser's status is the Web feature's proof. Doctor's HTTP responses are supporting evidence.

For terminal entry points, use the literal URLs in the feature files. Preserve the command, HTTP status, body, and exit code. Assert the whole JSON body rather than checking that one substring exists.

## Evidence

Keep proof under the generated run directory. The default `artifacts/verify/run-*` directory is ignored by Git. `VERIFY_EVIDENCE_ROOT` can select a shared writable location outside the checkout. Both locations remain after Cleanup.

Capture the user action and the resulting state. For the Web feature, save the navigation URL, heading, status text, accessibility snapshot, and screenshot as `web-action.json`, `web.aria.txt`, and `web.png`. Use a documented screenshot API and write its returned bytes to the run directory. Do not use internal state setters, synthetic health handlers, or mocks.

`doctor.json` contains the real requests, responses, listening PIDs, checkout, and revision. `dev.log` records startup. Save terminal commands and exit codes for any additional drive. Record skipped feature IDs with their reason. A connected Web screenshot does not verify the unavailable state, Worker independence, or PostgreSQL.

There are no business writes in the current mapped endpoints. When later features add mutations, verify their persistent side effects through an independent read alongside the UI result. Do not infer persistence from a success label.

## Cleanup

1. Close the temporary browser tab created by this run.
2. Send Ctrl+C with `write_stdin` to the recorded launcher terminal session. Wait for the terminal to finish. Do this after a successful drive and after every failed drive.
3. Use `lsof -nP -iTCP:3000 -iTCP:3001 -iTCP:5173 -sTCP:LISTEN` to confirm that the run's recorded listeners have gone. If another process has since claimed a port, compare its PID with `doctor.json` and leave it alone.
4. Confirm that `doctor.json`, `dev.log`, and the requested browser artifacts still exist. Save the cleanup result as `cleanup.json`. Never remove the evidence directory.

If the terminal is lost, inspect the recorded launcher PID's current command, working directory, and descendants before sending SIGTERM to that PID. Do not run `pkill`, `killall`, or a process-name match. If ownership cannot be established, stop and report the unresolved process.

This run creates no Compose project or volume. Leave all existing PostgreSQL resources untouched. To inspect a developer-owned database, use `docker compose ps` and the read-only SQL command in the root README. Label that evidence as an existing instance.

## Helpers

- [scripts/launch.sh](scripts/launch.sh) starts an owned `pnpm dev` session after port checks. Invoke it with a fresh absolute evidence directory in a PTY.
- [scripts/doctor.py](scripts/doctor.py) checks process ownership and real HTTP contracts. Invoke it with the same directory.

Both helpers require the installed project dependencies, `git`, Python 3, and `lsof`. The ownership check supports macOS and Linux process tables. It does not support Windows.
