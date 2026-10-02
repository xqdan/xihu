# Stage B Planning Quantification Run

Run ID: `stage-b-20260925-planning`
Manifest hash: `fbfe2e2782e0798d8bb58b09f0bcaca4836d4088d1b538cd0f6490ed1409e652`
Run mode: `PLANNING_QUANTIFICATION`
Source commit: `913bf4704e14c3f248f3056c7cff68b6b59862f9`

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
- Corroboration: 1 fitted point, 1 held out against the K3 detailed simulator (max |residual| 6.0%), **16 uncorroborated** (extrapolated from the K3 factors)
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
| GLM-5.2 | 16 | MC640 | P1 | 1778.76 | collective_reduce | collective_latency |
| GLM-5.2 | 32 | MC320 | P1 | 1793.05 | routed_moe | memory_bandwidth |
| GLM-5.2 | 32 | MC640 | P1 | 1927.72 | collective_reduce | collective_latency |
| DeepSeek-V4-Pro | 8 | MC320 | P1 | 463.85 | dense_projection | memory_bandwidth |
| DeepSeek-V4-Pro | 8 | MC640 | P1 | 927.69 | dense_projection | memory_bandwidth |
| DeepSeek-V4-Pro | 16 | MC320 | P1 | 927.69 | dense_projection | memory_bandwidth |
| DeepSeek-V4-Pro | 16 | MC640 | P1 | 1660.23 | collective_reduce | collective_latency |
| DeepSeek-V4-Pro | 32 | MC320 | P1 | 1855.38 | dense_projection | memory_bandwidth |
| DeepSeek-V4-Pro | 32 | MC640 | P1 | 1934.20 | collective_reduce | collective_latency |

## Planning slots (token-time lanes, us)

| Model | TP | MC | memory lane | FLOP / fixed / TMA | collectives | bound | TPS/usr | tau 1.15 / 1.5 / 2.0 | shape range |
|---|---:|---|---:|---:|---:|---|---:|---|---|
| K3 | 8 | MC320 | 6202.4 | 983.2 / 27.8 / 111.5 | 451.9 (393 x 1.15) | memory | 137.80 | 137.8 / 137.8 / 137.8 | - |
| GLM-5.2 | 8 | MC320 | 1906.7 | 116.4 / 23.3 / 32.1 | 382.9 (333 x 1.15) | memory | 448.26 | 448.3 / 448.3 / 448.3 | - |
| DeepSeek-V4-Pro | 8 | MC320 | 1842.6 | 259.7 / 18.2 / 32.0 | 350.8 (305 x 1.15) | memory | 463.85 | 463.8 / 463.8 / 463.8 | 463.8 - 498.2 |
| K3 | 16 | MC320 | 3101.2 | 491.6 / 27.8 / 55.7 | 451.9 (393 x 1.15) | memory | 275.60 | 275.6 / 275.6 / 275.6 | - |
| GLM-5.2 | 16 | MC320 | 953.3 | 58.2 / 23.3 / 16.1 | 382.9 (333 x 1.15) | memory | 896.53 | 896.5 / 896.5 / 896.5 | - |
| DeepSeek-V4-Pro | 16 | MC320 | 921.3 | 129.8 / 18.2 / 16.0 | 350.8 (305 x 1.15) | memory | 927.69 | 927.7 / 927.7 / 927.7 | 927.7 - 996.3 |
| K3 | 32 | MC320 | 1550.6 | 245.8 / 27.8 / 27.9 | 451.9 (393 x 1.15) | memory | 551.21 | 551.2 / 551.2 / 551.2 | - |
| GLM-5.2 | 32 | MC320 | 476.7 | 29.1 / 23.3 / 8.0 | 382.9 (333 x 1.15) | memory | 1793.05 | 1793.1 / 1526.5 / 1176.6 | - |
| DeepSeek-V4-Pro | 32 | MC320 | 460.7 | 64.9 / 18.2 / 8.0 | 350.8 (305 x 1.15) | memory | 1855.38 | 1855.4 / 1557.9 / 1219.0 | 1855.4 - 1947.7 |
| K3 | 8 | MC640 | 3101.2 | 983.2 / 27.8 / 111.5 | 451.9 (393 x 1.15) | memory | 275.60 | 275.6 / 275.6 / 275.6 | - |
| GLM-5.2 | 8 | MC640 | 953.3 | 116.4 / 23.3 / 32.1 | 382.9 (333 x 1.15) | memory | 896.53 | 896.5 / 896.5 / 896.5 | - |
| DeepSeek-V4-Pro | 8 | MC640 | 921.3 | 259.7 / 18.2 / 32.0 | 350.8 (305 x 1.15) | memory | 927.69 | 927.7 / 927.7 / 927.7 | 927.7 - 996.3 |
| K3 | 16 | MC640 | 1550.6 | 491.6 / 27.8 / 55.7 | 451.9 (393 x 1.15) | memory | 551.21 | 551.2 / 551.2 / 551.2 | - |
| GLM-5.2 | 16 | MC640 | 476.7 | 58.2 / 23.3 / 16.1 | 382.9 (333 x 1.15) | collective | 1778.76 | 1778.8 / 1431.5 / 1119.4 | - |
| DeepSeek-V4-Pro | 16 | MC640 | 460.7 | 129.8 / 18.2 / 16.0 | 350.8 (305 x 1.15) | collective | 1660.23 | 1660.2 / 1375.1 / 1104.2 | 1660.2 - 1680.2 |
| K3 | 32 | MC640 | 775.3 | 245.8 / 27.8 / 27.9 | 451.9 (393 x 1.15) | memory | 1102.41 | 1102.4 / 959.3 / 786.0 | - |
| GLM-5.2 | 32 | MC640 | 238.3 | 29.1 / 23.3 / 8.0 | 382.9 (333 x 1.15) | collective | 1927.72 | 1927.7 / 1526.5 / 1176.6 | - |
| DeepSeek-V4-Pro | 32 | MC640 | 230.3 | 64.9 / 18.2 / 8.0 | 350.8 (305 x 1.15) | collective | 1934.20 | 1934.2 / 1557.9 / 1219.0 | 1934.2 - 1947.7 |

## Assumption sensitivity (TP32, one input changed per column; not a prediction)

| Model | MC | Profile | TPS/usr | +1 collective / layer | -1 collective / layer | 10% of attention weights replicated per rank | attention weights fully replicated per rank | expert prediction accuracy 0.5 | expert prediction accuracy 0.3 | kMemory = 1.0 | kMemory = 1.3 |
|---|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| K3 | MC320 | P1 | 551 | 551 (miss) | 551 (miss) | 226 (miss) | 36 (miss) | 526 (miss) | 510 (miss) | 616 (miss) | 474 (miss) |
| GLM-5.2 | MC320 | P1 | 1793 | 1603 | 1793 | 981 (miss) | 193 (miss) | 1574 | 1456 | 1928 | 1542 |
| DeepSeek-V4-Pro | MC320 | P1 | 1855 | 1669 | 1855 | 1028 | 205 (miss) | 1691 | 1597 | 1934 | 1595 |
| K3 | MC640 | P1 | 1102 | 993 (miss) | 1102 | 452 (miss) | 72 (miss) | 1051 | 1020 | 1134 | 948 (miss) |
| GLM-5.2 | MC640 | P1 | 1928 | 1603 | 2417 | 1896 | 386 (miss) | 1928 | 1928 | 1928 | 1928 |
| DeepSeek-V4-Pro | MC640 | P1 | 1934 | 1669 | 2299 | 1905 | 410 (miss) | 1934 | 1934 | 1934 | 1934 |

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
