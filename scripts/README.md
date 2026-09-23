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

- `generate_planning_operator_workload.js`: K3 operator FLOP/byte rows derived from `src/core/design_engine.js` (single K3 shape source) and reconciled with the calibrated RDMA baseline; GLM-5.2 / DeepSeek-V4-Pro rows are unverified ratio-scaled placeholders.
- `sync_baseline_spec.js`: rewrites only the model-derived fields of the machine-readable P1 baseline so numbers are never hand-copied.
- `generate_team_contracts.js`, `generate_global_dashboard.js`: contract hashes and dashboard freshness consumed by tests.
