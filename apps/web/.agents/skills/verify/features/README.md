# FS-Billing verification map

Read this index before a run. Map only behavior implemented by the current scaffold.

## Baseline preconditions

- Start the owned session with the skill's launcher at ports 3000, 3001, and 5173.
- Require Doctor to pass before driving the connected baseline.
- Use a fresh evidence directory and browser tab for each run.
- No login, seed data, or database process is required for the mapped HTTP and Web paths.

## Proof and skip reporting

- Save each action and its observable result under the run directory.
- Capture browser snapshots and screenshots for Web states.
- Capture status and exact response JSON for HTTP paths.
- Report skipped sub-feature IDs. Do not treat one entry point as proof of another.
- Stop only processes started by this run. Keep evidence after teardown.

## Features

- [Web service status](web-status.md) covers the connected state, unavailable state, and reopening after recovery.
- [API health](api-health.md) covers direct API access and access through the Web proxy.
- [Worker health](worker-health.md) covers direct access and independence from the API process.

PostgreSQL, monetary lint, and build checks remain supporting developer checks in the root README and phase plan. The three mapped features perform no business writes. Add business features when their real user paths exist.
