# Integration

Cross-team code, owned by the Architecture Council. Anything that combines the work of two or more teams lives here; team directories (`teams/<team>/`) depend only on themselves.

| Directory | Content |
|---|---|
| `detailed/` | K3 detailed models and searches: operator/SRAM simulator, architecture and B=1 searches, RDMA-to-SRAM and Final Tuning models. They combine the Model shape (`teams/model/src/design_engine.js`) with hardware and software assumptions. |
| `planning/` | Planning token time (`token_time.js`), Stage A resource envelope (`directional_envelope.js`), run ids. |
| `governance/` | D-Gate / Q-Gate evaluation (`evaluate_gates.js`). |
| `pipelines/` | Runnable entry points; every generated file in `out/` is written by a script here. See [`pipelines/README.md`](pipelines/README.md). |
| `templates/` | HTML report templates rendered into `out/`. |

Rules:

- Code here may read `teams/*/` inputs and `out/` artifacts; `teams/*/` must not require anything here (enforced by `tests/structure/test_project_structure.js`).
- Do not write generated data outside `out/`. The single exception is `pipelines/sync_baseline_spec.js` (model-derived fields of the hardware baseline).
- A change to the detailed models or searches changes the stored `inputHash` of the search results; rerun the affected searches (`npm run search:*`) and `npm run model:planning`.
