# Stage B Planning Quantification Run

Run ID: `stage-b-20260925-planning`
Manifest hash: `dbbdcad65e2f895f0b28380c3422f6900ead9050398dbbdaabe8e7a0dfd3d18f`
Run mode: `PLANNING_QUANTIFICATION`
Source commit: `e95418359cb22dd2a24318d9d9e13477baa2f3d5`

## Gate result

- D-Gate: `PASS`
- Q-Gate: `BLOCKED_BY_D_GATE_MANIFEST_EVENT_MODEL_AND_PROVENANCE`
- Planning artifacts only. Q-Gate blocked: planning token time and synthetic events do not establish fine TPS or PPA closure.

## Planning token time

- `memory lane = 1.1178 x (memory + 0.200 x routed-expert memory)`; `serial lane = 1.1529 x compute + 0.2987 us x layers + 5.793 us/GB x memory GB + collectives x max(1.15 us, bytes/network)`; `raw = max(lanes)`, `e2e = raw x 1.17` (ADR-0008).
- Calibrated on the K3 detailed point (P1/MC640/TP32): planning 1102.41 vs detailed 1101.77; MC320 out-of-fit 551.21 vs 586.46.

## Performance acceptance (planning estimates, not validated)

- Target: 1000 TPS/usr; architecture gate: 1050 TPS/usr
- All 18 slots meet target: **no**
- All 18 slots meet architecture gate: **no**
- Comparable slots meet target: **no**; coverage: `COMPLETE`
- Comparable slots below target: **11 of 18**
- Selected candidate slots meet target: **yes** (required by the selection rule, not a performance result)
- `P1-compact-MC640-TP32`: every model reaches the target while tau <= 1.408 us (tau-conditional)
- Studied candidate slots meet target: **yes**
- Status: `PERFORMANCE_MISS_OUTSIDE_SELECTED_CANDIDATES_NOT_VALIDATED`
- Feedback: Slots below target need byte reduction, more TP ranks or an implementable bandwidth route before architecture freeze.

## Planning slots

| Model | TP | MC | Profile | TPS/usr | bounding operator | resource |
|---|---:|---|---|---:|---|---|
| K3 | 8 | MC320 | P1 | 137.80 | dense_projection | memory_bandwidth |
| K3 | 8 | MC640 | P1 | 275.60 | dense_projection | memory_bandwidth |
| K3 | 16 | MC320 | P1 | 275.60 | dense_projection | memory_bandwidth |
| K3 | 16 | MC640 | P1 | 551.21 | dense_projection | memory_bandwidth |
| K3 | 32 | MC320 | P1 | 551.21 | dense_projection | memory_bandwidth |
| K3 | 32 | MC640 | P1 | 1102.41 | dense_projection | memory_bandwidth |
| GLM-5.2 | 8 | MC320 | P1 | 448.26 | routed_moe | memory_bandwidth |
| GLM-5.2 | 8 | MC640 | P1 | 896.53 | routed_moe | memory_bandwidth |
| GLM-5.2 | 16 | MC320 | P1 | 896.53 | routed_moe | memory_bandwidth |
| GLM-5.2 | 16 | MC640 | P1 | 1793.05 | routed_moe | memory_bandwidth |
| GLM-5.2 | 32 | MC320 | P1 | 1793.05 | routed_moe | memory_bandwidth |
| GLM-5.2 | 32 | MC640 | P1 | 2416.78 | collective_reduce | collective_latency |
| DeepSeek-V4-Pro | 8 | MC320 | P1 | 463.85 | dense_projection | memory_bandwidth |
| DeepSeek-V4-Pro | 8 | MC640 | P1 | 927.69 | dense_projection | memory_bandwidth |
| DeepSeek-V4-Pro | 16 | MC320 | P1 | 927.69 | dense_projection | memory_bandwidth |
| DeepSeek-V4-Pro | 16 | MC640 | P1 | 1855.38 | dense_projection | memory_bandwidth |
| DeepSeek-V4-Pro | 32 | MC320 | P1 | 1855.38 | dense_projection | memory_bandwidth |
| DeepSeek-V4-Pro | 32 | MC640 | P1 | 2299.32 | collective_reduce | collective_latency |

## Planning slots (token-time lanes, us)

| Model | TP | MC | memory lane | FLOP / fixed / TMA | collectives | bound | TPS/usr | tau 1.15 / 1.5 / 2.0 | shape range |
|---|---:|---|---:|---:|---:|---|---:|---|---|
| K3 | 8 | MC320 | 6202.4 | 983.2 / 27.8 / 111.5 | 451.9 (393 x 1.15) | memory | 137.80 | 137.8 / 137.8 / 137.8 | - |
| GLM-5.2 | 8 | MC320 | 1906.7 | 116.3 / 23.3 / 32.1 | 293.3 (255 x 1.15) | memory | 448.26 | 448.3 / 448.3 / 448.3 | - |
| DeepSeek-V4-Pro | 8 | MC320 | 1842.6 | 259.6 / 18.2 / 32.0 | 280.6 (244 x 1.15) | memory | 463.85 | 463.8 / 463.8 / 463.8 | 463.8 - 498.2 |
| K3 | 16 | MC320 | 3101.2 | 491.6 / 27.8 / 55.7 | 451.9 (393 x 1.15) | memory | 275.60 | 275.6 / 275.6 / 275.6 | - |
| GLM-5.2 | 16 | MC320 | 953.3 | 58.1 / 23.3 / 16.1 | 293.3 (255 x 1.15) | memory | 896.53 | 896.5 / 896.5 / 896.5 | - |
| DeepSeek-V4-Pro | 16 | MC320 | 921.3 | 129.8 / 18.2 / 16.0 | 280.6 (244 x 1.15) | memory | 927.69 | 927.7 / 927.7 / 927.7 | 927.7 - 996.3 |
| K3 | 32 | MC320 | 1550.6 | 245.8 / 27.8 / 27.9 | 451.9 (393 x 1.15) | memory | 551.21 | 551.2 / 551.2 / 551.2 | - |
| GLM-5.2 | 32 | MC320 | 476.7 | 29.1 / 23.3 / 8.0 | 293.3 (255 x 1.15) | memory | 1793.05 | 1793.1 / 1793.1 / 1498.4 | - |
| DeepSeek-V4-Pro | 32 | MC320 | 460.7 | 64.9 / 18.2 / 8.0 | 280.6 (244 x 1.15) | memory | 1855.38 | 1855.4 / 1855.4 / 1475.9 | 1855.4 - 1992.6 |
| K3 | 8 | MC640 | 3101.2 | 983.2 / 27.8 / 111.5 | 451.9 (393 x 1.15) | memory | 275.60 | 275.6 / 275.6 / 275.6 | - |
| GLM-5.2 | 8 | MC640 | 953.3 | 116.3 / 23.3 / 32.1 | 293.3 (255 x 1.15) | memory | 896.53 | 896.5 / 896.5 / 896.5 | - |
| DeepSeek-V4-Pro | 8 | MC640 | 921.3 | 259.6 / 18.2 / 32.0 | 280.6 (244 x 1.15) | memory | 927.69 | 927.7 / 927.7 / 927.7 | 927.7 - 996.3 |
| K3 | 16 | MC640 | 1550.6 | 491.6 / 27.8 / 55.7 | 451.9 (393 x 1.15) | memory | 551.21 | 551.2 / 551.2 / 551.2 | - |
| GLM-5.2 | 16 | MC640 | 476.7 | 58.1 / 23.3 / 16.1 | 293.3 (255 x 1.15) | memory | 1793.05 | 1793.1 / 1780.6 / 1406.9 | - |
| DeepSeek-V4-Pro | 16 | MC640 | 460.7 | 129.8 / 18.2 / 16.0 | 280.6 (244 x 1.15) | memory | 1855.38 | 1855.4 / 1612.6 / 1310.9 | 1855.4 - 1949.1 |
| K3 | 32 | MC640 | 775.3 | 245.8 / 27.8 / 27.9 | 451.9 (393 x 1.15) | memory | 1102.41 | 1102.4 / 959.3 / 786.0 | - |
| GLM-5.2 | 32 | MC640 | 238.3 | 29.1 / 23.3 / 8.0 | 293.3 (255 x 1.15) | collective | 2416.78 | 2416.8 / 1929.8 / 1498.4 | - |
| DeepSeek-V4-Pro | 32 | MC640 | 230.3 | 64.9 / 18.2 / 8.0 | 280.6 (244 x 1.15) | collective | 2299.32 | 2299.3 / 1869.8 / 1475.9 | 2299.3 - 2318.4 |

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
