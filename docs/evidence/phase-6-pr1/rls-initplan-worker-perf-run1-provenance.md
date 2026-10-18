# Run 1 recovery provenance

This file documents a results excerpt recovered from the root Codex chat record. I did not access a database, rerun a benchmark, or read another project.

- Root chat: `01a14ac7-feb3-7ff2-ab69-432a16ca1ac6`
- Source turn: `01a14ac8-00d9-75e0-90ee-2446ac96f50c`
- Source tool call: `exec-2e5ef92b-2953-47a1-b5fb-e3333235e507` (`commandExecution`, completed, exit code 0)
- Source command working directory: `/Users/lqzone/.codex/worktrees/phase-6-rls-initplan/FS-Billing`
- Source command: Python loaded `docs/evidence/phase-6-pr1/rls-initplan-worker-perf.json` and printed `status`, `environment`, `summary`, setup fields except `indexes` and `pgPolicies`, plus `rawSamples` under the output key `samples`.
- Run identity: disposable database prefix `fsb_rls_w_7da0cf33_`; `environment.capturedAt` is `2026-10-17T17:33:51.865Z`.
- Recovered sample count: 12. Each preserved sample contains round, order, variant, database, and worker fields `entries`, `requests`, `p95Ms`, `maxMs`, and `passed`.

`run1-results-excerpt.json` is a parsed excerpt of that printed tool output, with `samples` named `rawSamples`. It is not the complete benchmark JSON file. The original first-round JSON was overwritten by the second run. The source command explicitly omitted `setup.indexes` and `setup.pgPolicies`, so the 53 index definitions and 55 policy records were not captured here. They are lost with the overwritten artifact and cannot be reconstructed from this excerpt. No values for those fields have been inferred or fabricated.
