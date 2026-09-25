# Scripts

Scripts are reproducible entry points for searches, analysis and report generation. Generated outputs go to `data/` or `reports/`.

Planning pipeline (run from the repository root, in this order after a model change):

```sh
npm run search:final        # P1 Final Tuning search -> data/rdma/k3_rdma_final_tuning_results.json
npm run baseline:sync       # scripts/sync_baseline_spec.js -> docs/design/spec/k3_mc_baseline.json, directional_workload_baseline.json
npm run model:planning      # generate_planning_operator_workload -> resolve_architecture_blockers -> formal_detailed_run -> contracts -> dashboard
npm run report:latest
npm test
```

- `generate_planning_operator_workload.js`: K3 operator FLOP/byte rows derived from `src/core/design_engine.js` (single K3 shape source, FP8 KV 656 B/token/layer) and reconciled with the detailed plan; DeepSeek-V4-Pro rows derived from the manifest `shape` (reported fields plus explicit ASSUMPTION fields, MTP excluded); GLM-5.2 rows derived from the manifest `shape` (public HF config.json fields plus explicit ASSUMPTION fields for the deployment layout; 21 full-indexer layers, MTP excluded, ADR-0007). It also fits the planning token-time calibration (kMemory/kCompute) on the K3 detailed published point and checks it at MC320 (ADR-0006).
- `models/planning/token_time.js` (used by Stage A and B): `raw = max(memory × kMemory, compute × kCompute + collectives × τ)`, `e2e = raw × 1.17`.
- `models/detailed_run.js` and `models/direction/run_directional_tps.js` were retired and deleted (ADR-0006); use `npm run model:planning`.
- `sync_baseline_spec.js`: rewrites only the model-derived fields of the machine-readable P1 baseline so numbers are never hand-copied.
- `generate_team_contracts.js`, `generate_global_dashboard.js`: contract hashes and dashboard freshness consumed by tests.
