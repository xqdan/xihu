# Stage B Planning Quantification Run

Run ID: `stage-b-20261002-planning`
Manifest hash: `a140afe4612d0bc8fc226c89d80f7ee4735da3784a75256d14f0da8b2e696083`
Run mode: `PLANNING_QUANTIFICATION`
Source commit: `4fa22b29ed3469e44b1c594a17c355e5a2ef52c0`

## Gate result

- D-Gate: `PASS`
- Q-Gate: `BLOCKED_BY_D_GATE_MANIFEST_EVENT_MODEL_AND_PROVENANCE`
- Planning artifacts only. Q-Gate blocked: planning token time and synthetic events do not establish fine TPS or PPA closure.

## Planning token time

- `memory lane = 1.2316 x (memory + 0.200 x routed-expert memory)`; `serial lane = 1.2972 x compute + 0.2962 us x layers + 5.691 us/GB x memory GB + collectives x max(1.15 us, bytes/network)`; `raw = max(lanes)`, `e2e = raw x 1.17` (ADR-0008).
- Calibrated on the K3 detailed point (P1/MC640/TP32): planning 1142.61 vs detailed 1124.70; MC320 out-of-fit 500.28 vs 585.93.

## Performance acceptance (planning estimates, not validated)

- Target: 1000 TPS/usr; architecture gate: 1050 TPS/usr
- All 18 slots meet target: **no**
- All 18 slots meet architecture gate: **no**
- Comparable slots meet target: **no**; coverage: `COMPLETE`
- Comparable slots below target: **9 of 18**
- Selected candidate slots meet target: **yes** (required by the selection rule, not a performance result)
- `P1-compact-MC640-TP32`: every model reaches the target while tau <= 1.421 us (tau-conditional)
- Studied candidate slots meet target: **yes**
- Corroboration: 1 fitted point, 1 held out against the K3 detailed simulator (max |residual| 14.6%), **16 uncorroborated** (extrapolated from the K3 factors)
- Status: `PERFORMANCE_MISS_OUTSIDE_SELECTED_CANDIDATES_NOT_VALIDATED`
- Feedback: Slots below target need byte reduction, more TP ranks or an implementable bandwidth route before architecture freeze.

## Planning slots

| Model | TP | MC | Profile | TPS/usr | bounding operator | resource |
|---|---:|---|---|---:|---|---|
| K3 | 8 | MC320 | P1 | 125.07 | dense_projection | memory_bandwidth |
| K3 | 8 | MC640 | P1 | 450.25 | dense_projection | memory_bandwidth |
| K3 | 16 | MC320 | P1 | 250.14 | dense_projection | memory_bandwidth |
| K3 | 16 | MC640 | P1 | 840.79 | attention | compute |
| K3 | 32 | MC320 | P1 | 500.28 | dense_projection | memory_bandwidth |
| K3 | 32 | MC640 | P1 | 1142.61 | collective_reduce | collective_latency |
| GLM-5.2 | 8 | MC320 | P1 | 406.81 | routed_moe | memory_bandwidth |
| GLM-5.2 | 8 | MC640 | P1 | 1464.52 | routed_moe | memory_bandwidth |
| GLM-5.2 | 16 | MC320 | P1 | 813.62 | routed_moe | memory_bandwidth |
| GLM-5.2 | 16 | MC640 | P1 | 1763.44 | collective_reduce | collective_latency |
| GLM-5.2 | 32 | MC320 | P1 | 1627.25 | routed_moe | memory_bandwidth |
| GLM-5.2 | 32 | MC640 | P1 | 1919.10 | collective_reduce | collective_latency |
| DeepSeek-V4-Pro | 8 | MC320 | P1 | 420.99 | dense_projection | memory_bandwidth |
| DeepSeek-V4-Pro | 8 | MC640 | P1 | 1288.65 | collective_reduce | collective_latency |
| DeepSeek-V4-Pro | 16 | MC320 | P1 | 841.98 | dense_projection | memory_bandwidth |
| DeepSeek-V4-Pro | 16 | MC640 | P1 | 1656.28 | collective_reduce | collective_latency |
| DeepSeek-V4-Pro | 32 | MC320 | P1 | 1683.96 | dense_projection | memory_bandwidth |
| DeepSeek-V4-Pro | 32 | MC640 | P1 | 1931.84 | collective_reduce | collective_latency |

## Planning slots (token-time lanes, us)

| Model | TP | MC | memory lane | FLOP / fixed / TMA | collectives | bound | TPS/usr | tau 1.15 / 1.5 / 2.0 | shape range |
|---|---:|---|---:|---:|---:|---|---:|---|---|
| K3 | 8 | MC320 | 6833.8 | 964.6 / 27.5 / 109.5 | 451.9 (393 x 1.15) | memory | 125.07 | 125.1 / 125.1 / 125.1 | - |
| GLM-5.2 | 8 | MC320 | 2101.0 | 125.7 / 23.1 / 31.6 | 382.9 (333 x 1.15) | memory | 406.81 | 406.8 / 406.8 / 406.8 | - |
| DeepSeek-V4-Pro | 8 | MC320 | 2030.2 | 263.0 / 18.1 / 31.4 | 350.8 (305 x 1.15) | memory | 420.99 | 421.0 / 421.0 / 421.0 | 421.0 - 452.1 |
| K3 | 16 | MC320 | 3416.9 | 482.3 / 27.5 / 54.7 | 451.9 (393 x 1.15) | memory | 250.14 | 250.1 / 250.1 / 250.1 | - |
| GLM-5.2 | 16 | MC320 | 1050.5 | 62.8 / 23.1 / 15.8 | 382.9 (333 x 1.15) | memory | 813.62 | 813.6 / 813.6 / 813.6 | - |
| DeepSeek-V4-Pro | 16 | MC320 | 1015.1 | 131.5 / 18.1 / 15.7 | 350.8 (305 x 1.15) | memory | 841.98 | 842.0 / 842.0 / 842.0 | 842.0 - 904.3 |
| K3 | 32 | MC320 | 1708.4 | 241.2 / 27.5 / 27.4 | 451.9 (393 x 1.15) | memory | 500.28 | 500.3 / 500.3 / 500.3 | - |
| GLM-5.2 | 32 | MC320 | 525.2 | 31.4 / 23.1 / 7.9 | 382.9 (333 x 1.15) | memory | 1627.25 | 1627.2 / 1521.0 / 1173.4 | - |
| DeepSeek-V4-Pro | 32 | MC320 | 507.6 | 65.7 / 18.1 / 7.9 | 350.8 (305 x 1.15) | memory | 1683.96 | 1684.0 / 1556.3 / 1218.1 | 1684.0 - 1808.5 |
| K3 | 8 | MC640 | 1898.3 | 964.6 / 27.5 / 109.5 | 451.9 (393 x 1.15) | memory | 450.25 | 450.3 / 450.3 / 450.3 | - |
| GLM-5.2 | 8 | MC640 | 583.6 | 125.7 / 23.1 / 31.6 | 382.9 (333 x 1.15) | memory | 1464.52 | 1464.5 / 1257.2 / 1009.9 | - |
| DeepSeek-V4-Pro | 8 | MC640 | 563.9 | 263.0 / 18.1 / 31.4 | 350.8 (305 x 1.15) | collective | 1288.65 | 1288.6 / 1110.0 / 926.5 | 1288.6 - 1315.4 |
| K3 | 16 | MC640 | 949.1 | 482.3 / 27.5 / 54.7 | 451.9 (393 x 1.15) | compute | 840.79 | 840.8 / 740.6 / 632.8 | - |
| GLM-5.2 | 16 | MC640 | 291.8 | 62.8 / 23.1 / 15.8 | 382.9 (333 x 1.15) | collective | 1763.44 | 1763.4 / 1421.6 / 1113.3 | - |
| DeepSeek-V4-Pro | 16 | MC640 | 282.0 | 131.5 / 18.1 / 15.7 | 350.8 (305 x 1.15) | collective | 1656.28 | 1656.3 / 1372.4 / 1102.4 | 1656.3 - 1678.2 |
| K3 | 32 | MC640 | 474.6 | 241.2 / 27.5 / 27.4 | 451.9 (393 x 1.15) | collective | 1142.61 | 1142.6 / 965.1 / 789.9 | - |
| GLM-5.2 | 32 | MC640 | 145.9 | 31.4 / 23.1 / 7.9 | 382.9 (333 x 1.15) | collective | 1919.10 | 1919.1 / 1521.0 / 1173.4 | - |
| DeepSeek-V4-Pro | 32 | MC640 | 141.0 | 65.7 / 18.1 / 7.9 | 350.8 (305 x 1.15) | collective | 1931.84 | 1931.8 / 1556.3 / 1218.1 | 1931.8 - 1946.7 |

## Assumption sensitivity (TP32, one input changed per column; not a prediction)

| Model | MC | Profile | TPS/usr | +1 collective / layer | -1 collective / layer | 10% of attention weights replicated per rank | attention weights fully replicated per rank | expert prediction accuracy 0.5 | expert prediction accuracy 0.3 | kMemory = 1.0 | kMemory = 1.3 |
|---|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| K3 | MC320 | P1 | 500 | 500 (miss) | 500 (miss) | 205 (miss) | 33 (miss) | 477 (miss) | 463 (miss) | 616 (miss) | 474 (miss) |
| GLM-5.2 | MC320 | P1 | 1627 | 1597 | 1627 | 890 (miss) | 175 (miss) | 1429 | 1321 | 1919 | 1542 |
| DeepSeek-V4-Pro | MC320 | P1 | 1684 | 1667 | 1684 | 933 (miss) | 186 (miss) | 1535 | 1450 | 1932 | 1595 |
| K3 | MC640 | P1 | 1143 | 1000 (miss) | 1333 | 738 (miss) | 117 (miss) | 1143 | 1143 | 1143 | 1143 |
| GLM-5.2 | MC640 | P1 | 1919 | 1597 | 2403 | 1889 | 631 (miss) | 1919 | 1919 | 1919 | 1919 |
| DeepSeek-V4-Pro | MC640 | P1 | 1932 | 1667 | 2296 | 1903 | 670 (miss) | 1932 | 1932 | 1932 | 1932 |

## Agent outputs

- **Q1**: COMPLETE - formal model manifest, operator inventory and shared hash
- **Q2**: COMPLETE - arithmetic intensity, Roofline and sizing ledger for K3, GLM-5.2, DeepSeek-V4-Pro; no model BLOCKED_CONFIG
- **Q3**: PLANNING_ONLY - tile and memory event placeholders
- **Q4**: PLANNING_ONLY - collective packet and NoC event placeholders
- **Q5**: PLANNING_ONLY - kernel cycle placeholders
- **Q6**: PLANNING_ONLY - scheduler overlap and stall placeholders
- **Q7**: PLANNING_ONLY - planning PPA and thermal envelope reconciliation
- **Q8**: PLANNING_ONLY - K3-calibrated planning token time; no dependency-aware timing replay
- **Q9**: COMPLETE - independent gate validator executed after artifact generation

## Artifacts

- `teams/model/inputs/formal_model_manifests.json`
- `out/workload/planning_operator_workload.json`
- `out/detailed/formal_event_replay.json`
- `out/workload/tps_observation_matrix.json`
- `out/detailed/detailed_architecture_run.json`
