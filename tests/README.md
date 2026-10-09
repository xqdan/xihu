# Tests

`npm test` runs every `test_*.js` in the groups below (`node tests/run_all.js [group ...]` runs a subset; `npm run test:<group>` for one group). Test files run as separate processes, up to `min(8, cores - 1)` at a time; `--jobs=N` or `TEST_JOBS=N` changes that and `--jobs=1` restores the serial order. A file's output is printed when it finishes, and the first failure stops the run with that file's exit code. Tests must therefore write only to per-process temp paths (the one exception, the working-tree probe in `test_workflow_driver.js`, is ignored by the copy in `test_regeneration_reproducible.js`).

| Group | Checks |
|---|---|
| `unit/` | Unit-level invariants: directional units, operator/SRAM simulator physics, LSE merge semantics, mailbox lifecycle, the workflow host runtime (schema validation, retry/abort policy, landing gates, read-only guard, Claude/Cursor backends via fakes). |
| `regression/` | Search reproducibility (stored `inputHash` against the current sources), design and TPS baselines, K3 manifest consistency, multi-model profiles and TP matrix, TPS observation matrix, detailed sizing conservation, behavior of the C-group workflows under a mock runtime, and the workflow driver (`run_workflow.js`) end to end in dry-run mode. |
| `governance/` | Gates, candidate selection, cross-team contracts and their hashes, integration freshness, dashboard, Stage A/B runs, agent organization documents, agent strategy boundary and roster `consumers` reconciliation, byte-for-byte regeneration of `out/` (`test_regeneration_reproducible.js`). |
| `structure/` | Repository layout: required directories, local `require` targets and links resolve, and team directories do not depend on other teams, `integration/` or `out/`; structural checks of the `design.*.workflow.js` scripts (S3–S7 skeletons). |

Tests read committed artifacts in `out/`; when a source changes, regenerate the affected artifacts (see `integration/pipelines/README.md`) instead of editing the test or the artifact.
