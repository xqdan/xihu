# Integration

Cross-team code, owned by the Architecture Council. Anything that combines the work of two or more teams lives here; team directories (`teams/<team>/`) depend only on themselves.

| Directory | Content |
|---|---|
| `detailed/` | K3 detailed models: operator/SRAM simulator, die physical model and design space (`k3_architecture_search.js`, `k3_physical_basis.js`), RDMA-to-SRAM memory model, Final Tuning model and its search (the only search that produces the published point), and the design-baseline replay. They combine the Model shape (`teams/model/src/design_engine.js`) with hardware and software assumptions. |
| `planning/` | Planning token time (`token_time.js`), Stage A resource envelope (`directional_envelope.js`), run ids. |
| `governance/` | D-Gate / Q-Gate evaluation (`evaluate_gates.js`). |
| `orchestration/` | Multi-agent cross-team review workflows (Claude Code Workflow scripts, read-only, not Node entry points). See [`orchestration/README.md`](orchestration/README.md). |
| `pipelines/` | Runnable entry points; every generated file in `out/` is written by a script here. See [`pipelines/README.md`](pipelines/README.md). |

Rules:

- Code here may read `teams/*/` inputs and `out/` artifacts; `teams/*/` must not require anything here (enforced by `tests/structure/test_project_structure.js`).
- Do not write generated data outside `out/`. The single exception is `pipelines/sync_baseline_spec.js` (model-derived fields of the hardware baseline).
- A change to the detailed models or searches changes the stored `inputHash` of the search results; rerun `npm run search:final`, `npm run baseline:sync` and `npm run model:planning`.
