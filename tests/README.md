# Tests

`npm test` runs every `test_*.js` in the groups below (`node tests/run_all.js [group ...]` runs a subset; `npm run test:<group>` for one group).

| Group | Checks |
|---|---|
| `unit/` | Unit-level invariants: directional units, operator/SRAM simulator physics, LSE merge semantics, mailbox lifecycle. |
| `regression/` | Search reproducibility (stored `inputHash` against the current sources), design and TPS baselines, 7R package baseline, K3 manifest consistency, multi-model profiles and TP matrix, TPS observation matrix, detailed sizing conservation. |
| `governance/` | Gates, candidate selection, cross-team contracts and their hashes, integration freshness, dashboard, Stage A/B runs, agent organization documents. |
| `structure/` | Repository layout: required directories, local `require` targets and links resolve, and team directories do not depend on other teams, `integration/` or `out/`. |

Tests read committed artifacts in `out/`; when a source changes, regenerate the affected artifacts (see `integration/pipelines/README.md`) instead of editing the test or the artifact.
