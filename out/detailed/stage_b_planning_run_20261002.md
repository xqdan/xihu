# Stage B Planning Quantification Run

Run ID: `stage-b-20261002-planning`
Manifest hash: `a140afe4612d0bc8fc226c89d80f7ee4735da3784a75256d14f0da8b2e696083`
Run mode: `PLANNING_QUANTIFICATION`
Source commit: `8a348fdfd8df65275aef9b954d9b450566b78ea4`

## Gate result

- D-Gate: `PASS`
- Q-Gate: `BLOCKED_BY_D_GATE_MANIFEST_EVENT_MODEL_AND_PROVENANCE`
- Planning artifacts only. Q-Gate blocked: planning token time and synthetic events do not establish fine TPS or PPA closure.

## Planning token time

- `memory lane = 1.4537 x (memory + 0.200 x routed-expert memory)`; `serial lane = 1.1845 x compute + 0.2247 us x layers + 9.484 us/GB x memory GB + collectives x max(1.15 us, bytes/network)`; `raw = max(lanes)`, `e2e = raw x 1.17` (ADR-0008).
- Calibrated on the K3 detailed point (P1/MC640/TP32): planning 1157.69 vs detailed 1138.48; MC320 out-of-fit 423.84 vs 579.53.

## Performance acceptance (planning estimates, not validated)

- Target: 1000 TPS/usr; architecture gate: 1050 TPS/usr
- All 18 slots meet target: **no**
- All 18 slots meet architecture gate: **no**
- Comparable slots meet target: **no**; coverage: `COMPLETE`
- Comparable slots below target: **9 of 18**
- Selected candidate slots meet target: **yes** (required by the selection rule, not a performance result)
- `P1-compact-MC640-TP32`: every model reaches the target while tau <= 1.446 us (tau-conditional)
- Studied candidate slots meet target: **yes**
- Corroboration: 1 fitted point, 1 held out against the K3 detailed simulator (max |residual| 26.9%), **16 uncorroborated** (extrapolated from the K3 factors)
- Status: `PERFORMANCE_MISS_OUTSIDE_SELECTED_CANDIDATES_NOT_VALIDATED`
- Feedback: Slots below target need byte reduction, more TP ranks or an implementable bandwidth route before architecture freeze.

## Planning slots

| Model | TP | MC | Profile | TPS/usr | bounding operator | resource |
|---|---:|---|---|---:|---|---|
| K3 | 8 | MC320 | P1 | 105.96 | dense_projection | memory_bandwidth |
| K3 | 8 | MC640 | P1 | 381.46 | dense_projection | memory_bandwidth |
| K3 | 16 | MC320 | P1 | 211.92 | dense_projection | memory_bandwidth |
| K3 | 16 | MC640 | P1 | 762.91 | dense_projection | memory_bandwidth |
| K3 | 32 | MC320 | P1 | 423.84 | dense_projection | memory_bandwidth |
| K3 | 32 | MC640 | P1 | 1157.69 | collective_reduce | collective_latency |
| GLM-5.2 | 8 | MC320 | P1 | 344.65 | routed_moe | memory_bandwidth |
| GLM-5.2 | 8 | MC640 | P1 | 1240.76 | routed_moe | memory_bandwidth |
| GLM-5.2 | 16 | MC320 | P1 | 689.31 | routed_moe | memory_bandwidth |
| GLM-5.2 | 16 | MC640 | P1 | 1765.68 | collective_reduce | collective_latency |
| GLM-5.2 | 32 | MC320 | P1 | 1378.62 | routed_moe | memory_bandwidth |
| GLM-5.2 | 32 | MC640 | P1 | 1932.53 | collective_reduce | collective_latency |
| DeepSeek-V4-Pro | 8 | MC320 | P1 | 356.67 | dense_projection | memory_bandwidth |
| DeepSeek-V4-Pro | 8 | MC640 | P1 | 1284.00 | dense_projection | memory_bandwidth |
| DeepSeek-V4-Pro | 16 | MC320 | P1 | 713.33 | dense_projection | memory_bandwidth |
| DeepSeek-V4-Pro | 16 | MC640 | P1 | 1673.83 | collective_reduce | collective_latency |
| DeepSeek-V4-Pro | 32 | MC320 | P1 | 1426.66 | dense_projection | memory_bandwidth |
| DeepSeek-V4-Pro | 32 | MC640 | P1 | 1953.42 | collective_reduce | collective_latency |

## Planning slots (token-time lanes, us)

| Model | TP | MC | memory lane | FLOP / fixed / TMA | collectives | bound | TPS/usr | tau 1.15 / 1.5 / 2.0 | shape range |
|---|---:|---|---:|---:|---:|---|---:|---|---|
| K3 | 8 | MC320 | 8066.3 | 879.2 / 20.9 / 182.5 | 451.9 (393 x 1.15) | memory | 105.96 | 106.0 / 106.0 / 106.0 | - |
| GLM-5.2 | 8 | MC320 | 2479.9 | 114.6 / 17.5 / 52.6 | 382.9 (333 x 1.15) | memory | 344.65 | 344.7 / 344.7 / 344.7 | - |
| DeepSeek-V4-Pro | 8 | MC320 | 2396.4 | 239.9 / 13.7 / 52.4 | 350.8 (305 x 1.15) | memory | 356.67 | 356.7 / 356.7 / 356.7 | 356.7 - 383.1 |
| K3 | 16 | MC320 | 4033.1 | 439.6 / 20.9 / 91.2 | 451.9 (393 x 1.15) | memory | 211.92 | 211.9 / 211.9 / 211.9 | - |
| GLM-5.2 | 16 | MC320 | 1239.9 | 57.3 / 17.5 / 26.3 | 382.9 (333 x 1.15) | memory | 689.31 | 689.3 / 689.3 / 689.3 | - |
| DeepSeek-V4-Pro | 16 | MC320 | 1198.2 | 120.0 / 13.7 / 26.2 | 350.8 (305 x 1.15) | memory | 713.33 | 713.3 / 713.3 / 713.3 | 713.3 - 766.1 |
| K3 | 32 | MC320 | 2016.6 | 219.8 / 20.9 / 45.6 | 451.9 (393 x 1.15) | memory | 423.84 | 423.8 / 423.8 / 423.8 | - |
| GLM-5.2 | 32 | MC320 | 620.0 | 28.6 / 17.5 / 13.2 | 382.9 (333 x 1.15) | memory | 1378.62 | 1378.6 / 1378.6 / 1178.4 | - |
| DeepSeek-V4-Pro | 32 | MC320 | 599.1 | 60.0 / 13.7 / 13.1 | 350.8 (305 x 1.15) | memory | 1426.66 | 1426.7 / 1426.7 / 1226.6 | 1426.7 - 1532.2 |
| K3 | 8 | MC640 | 2240.6 | 879.2 / 20.9 / 182.5 | 451.9 (393 x 1.15) | memory | 381.46 | 381.5 / 381.5 / 381.5 | - |
| GLM-5.2 | 8 | MC640 | 688.9 | 114.6 / 17.5 / 52.6 | 382.9 (333 x 1.15) | memory | 1240.76 | 1240.8 / 1240.8 / 1004.7 | - |
| DeepSeek-V4-Pro | 8 | MC640 | 665.7 | 239.9 / 13.7 / 52.4 | 350.8 (305 x 1.15) | memory | 1284.00 | 1284.0 / 1119.4 / 933.0 | 1284.0 - 1329.3 |
| K3 | 16 | MC640 | 1120.3 | 439.6 / 20.9 / 91.2 | 451.9 (393 x 1.15) | memory | 762.91 | 762.9 / 748.9 / 638.9 | - |
| GLM-5.2 | 16 | MC640 | 344.4 | 57.3 / 17.5 / 26.3 | 382.9 (333 x 1.15) | collective | 1765.68 | 1765.7 / 1423.0 / 1114.2 | - |
| DeepSeek-V4-Pro | 16 | MC640 | 332.8 | 120.0 / 13.7 / 26.2 | 350.8 (305 x 1.15) | collective | 1673.83 | 1673.8 / 1384.4 / 1110.2 | 1673.8 - 1696.8 |
| K3 | 32 | MC640 | 560.2 | 219.8 / 20.9 / 45.6 | 451.9 (393 x 1.15) | collective | 1157.69 | 1157.7 / 975.9 / 797.1 | - |
| GLM-5.2 | 32 | MC640 | 172.2 | 28.6 / 17.5 / 13.2 | 382.9 (333 x 1.15) | collective | 1932.53 | 1932.5 / 1529.5 / 1178.4 | - |
| DeepSeek-V4-Pro | 32 | MC640 | 166.4 | 60.0 / 13.7 / 13.1 | 350.8 (305 x 1.15) | collective | 1953.42 | 1953.4 / 1570.3 / 1226.6 | 1953.4 - 1969.0 |

## Assumption sensitivity (TP32, one input changed per column; not a prediction)

| Model | MC | Profile | TPS/usr | +1 collective / layer | -1 collective / layer | 10% of attention weights replicated per rank | attention weights fully replicated per rank | expert prediction accuracy 0.5 | expert prediction accuracy 0.3 | kMemory = 1.0 | kMemory = 1.3 |
|---|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| K3 | MC320 | P1 | 424 | 424 (miss) | 424 (miss) | 174 (miss) | 28 (miss) | 404 (miss) | 392 (miss) | 616 (miss) | 474 (miss) |
| GLM-5.2 | MC320 | P1 | 1379 | 1379 | 1379 | 754 (miss) | 148 (miss) | 1210 | 1119 | 1933 | 1542 |
| DeepSeek-V4-Pro | MC320 | P1 | 1427 | 1427 | 1427 | 791 (miss) | 158 (miss) | 1301 | 1228 | 1953 | 1595 |
| K3 | MC640 | P1 | 1158 | 1011 | 1354 | 626 (miss) | 99 (miss) | 1158 | 1158 | 1158 | 1158 |
| GLM-5.2 | MC640 | P1 | 1933 | 1607 | 2424 | 1881 | 535 (miss) | 1933 | 1933 | 1933 | 1933 |
| DeepSeek-V4-Pro | MC640 | P1 | 1953 | 1684 | 2326 | 1904 | 568 (miss) | 1953 | 1953 | 1953 | 1953 |

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
