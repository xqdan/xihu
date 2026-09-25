# Pipelines

Reproducible entry points for the final tuning search, the planning pipeline and report generation. Every script resolves paths from the repository root (it `chdir`s there or joins onto it), so it can be run from any directory. Generated outputs go to `out/`; the only exception is `sync_baseline_spec.js`, which rewrites the model-derived fields of `teams/hardware/inputs/k3_mc_baseline.json` (see `teams/hardware/README.md`).

Planning pipeline (in this order after a model change):

```sh
npm run search:final        # run_search.js final -> out/rdma/k3_rdma_final_tuning_results.json
npm run baseline:sync       # sync_baseline_spec.js -> teams/hardware/inputs/k3_mc_baseline.json, out/direction/directional_workload_baseline.json
npm run model:planning      # generate_planning_operator_workload -> stage_a -> stage_b -> generate_team_contracts -> generate_direction_feedback -> generate_global_dashboard
npm test
```

- `generate_planning_operator_workload.js`: K3 operator FLOP/byte rows derived from `teams/model/src/design_engine.js` (single K3 shape source, FP8 KV 656 B/token/layer) and reconciled with the detailed plan; GLM-5.2 and DeepSeek-V4-Pro rows come from the Model team derivation `teams/model/src/workload_derivation.js` (manifest `shape` plus explicit ASSUMPTION fields, MTP excluded, ADR-0007). It also fits the planning token-time calibration on the K3 detailed published point and checks it at MC320 (ADR-0008).
- `stage_a.js`: Stage A direction comparison. The resource envelope comes from `integration/planning/directional_envelope.js`; the D-Gate is computed by `integration/governance/evaluate_gates.js`.
- `stage_b.js`: Stage B planning quantification of the selected candidates.
- `integration/planning/token_time.js` (used by Stage A and B): `raw = max(kMemory × (memory + expertReread × routed-expert memory), kFlop × compute + fixed per layer + exposed TMA + collectives × τ)`, `e2e = raw × 1.17`; every slot also reports τ = 1.15 / 1.5 / 2.0 µs (ADR-0008).
- `generate_team_contracts.js`: merges `teams/<team>/contract.json` with the current artifacts into `out/contracts/`, and writes the integration manifest with contract hashes.
- `generate_direction_feedback.js`: Stage B -> Stage A backflow (`out/governance/direction_feedback.json`, open blockers and best planning estimate per model).
- `generate_global_dashboard.js`: `out/dashboard/architecture_global_dashboard.html`; reads the blockers from the feedback file, so run it after `generate_direction_feedback.js` (`npm run dashboard` runs both).
- `run_search.js final`: runs the final tuning search (`integration/detailed/k3_rdma_final_tuning_search.js`), the source of the published point; it also writes `out/rdma/k3_rdma_final_tuning_report.html`.
- `sync_baseline_spec.js`: rewrites only the model-derived fields of the machine-readable P1 baseline so numbers are never hand-copied.
- `models/detailed_run.js` and `models/direction/run_directional_tps.js` were retired and deleted (ADR-0006); use `npm run model:planning`.
