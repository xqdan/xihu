# Stage B Planning Quantification Run

Run ID: `stage-b-20261002-planning`
Manifest hash: `a140afe4612d0bc8fc226c89d80f7ee4735da3784a75256d14f0da8b2e696083`
Run mode: `PLANNING_QUANTIFICATION`
Source commit: `5dcb47f0e319f8be17e7321d1e3dd4b5d2407b16`

## Gate result

- D-Gate: `PASS`
- Q-Gate: `BLOCKED_BY_D_GATE_MANIFEST_EVENT_MODEL_AND_PROVENANCE`
- Planning artifacts only. Q-Gate blocked: planning token time and synthetic events do not establish fine TPS or PPA closure.

## Planning token time

- `memory lane = 1.2182 x (memory + 0.200 x routed-expert memory)`; `serial lane = 1.6667 x compute + 0.3087 us x layers + 6.018 us/GB x memory GB + collectives x max(1.15 us, bytes/network)`; `raw = max(lanes)`, `e2e = raw x 1.17` (ADR-0008).
- Calibrated on the K3 detailed point (P1/MC640/TP32): planning 1059.44 vs detailed 1043.96; MC320 out-of-fit 505.75 vs 585.94.

## Performance acceptance (planning estimates, not validated)

- Target: 1000 TPS/usr; architecture gate: 1050 TPS/usr
- All 18 slots meet target: **no**
- All 18 slots meet architecture gate: **no**
- Comparable slots meet target: **no**; coverage: `COMPLETE`
- Comparable slots below target: **9 of 18**
- Selected candidate slots meet target: **yes** (required by the selection rule, not a performance result)
- `P1-compact-MC640-TP32`: every model reaches the target while tau <= 1.272 us (tau-conditional)
- Studied candidate slots meet target: **yes**
- Corroboration: 1 fitted point, 1 held out against the K3 detailed simulator (max |residual| 13.7%), **16 uncorroborated** (extrapolated from the K3 factors)
- Status: `PERFORMANCE_MISS_OUTSIDE_SELECTED_CANDIDATES_NOT_VALIDATED`
- Feedback: Slots below target need byte reduction, more TP ranks or an implementable bandwidth route before architecture freeze.

## Planning slots

| Model | TP | MC | Profile | TPS/usr | bounding operator | resource |
|---|---:|---|---|---:|---|---|
| K3 | 8 | MC320 | P1 | 126.44 | dense_projection | memory_bandwidth |
| K3 | 8 | MC640 | P1 | 455.18 | dense_projection | memory_bandwidth |
| K3 | 16 | MC320 | P1 | 252.88 | dense_projection | memory_bandwidth |
| K3 | 16 | MC640 | P1 | 754.47 | attention | compute |
| K3 | 32 | MC320 | P1 | 505.75 | dense_projection | memory_bandwidth |
| K3 | 32 | MC640 | P1 | 1059.44 | collective_reduce | collective_latency |
| GLM-5.2 | 8 | MC320 | P1 | 411.26 | routed_moe | memory_bandwidth |
| GLM-5.2 | 8 | MC640 | P1 | 1480.55 | routed_moe | memory_bandwidth |
| GLM-5.2 | 16 | MC320 | P1 | 822.53 | routed_moe | memory_bandwidth |
| GLM-5.2 | 16 | MC640 | P1 | 1798.88 | collective_reduce | collective_latency |
| GLM-5.2 | 32 | MC320 | P1 | 1645.06 | routed_moe | memory_bandwidth |
| GLM-5.2 | 32 | MC640 | P1 | 1937.75 | collective_reduce | collective_latency |
| DeepSeek-V4-Pro | 8 | MC320 | P1 | 425.60 | dense_projection | memory_bandwidth |
| DeepSeek-V4-Pro | 8 | MC640 | P1 | 1240.57 | collective_reduce | collective_latency |
| DeepSeek-V4-Pro | 16 | MC320 | P1 | 851.19 | dense_projection | memory_bandwidth |
| DeepSeek-V4-Pro | 16 | MC640 | P1 | 1614.87 | collective_reduce | collective_latency |
| DeepSeek-V4-Pro | 32 | MC320 | P1 | 1702.39 | dense_projection | memory_bandwidth |
| DeepSeek-V4-Pro | 32 | MC640 | P1 | 1901.77 | collective_reduce | collective_latency |

## Planning slots (token-time lanes, us)

| Model | TP | MC | memory lane | FLOP / fixed / TMA | collectives | bound | TPS/usr | tau 1.15 / 1.5 / 2.0 | shape range |
|---|---:|---|---:|---:|---:|---|---:|---|---|
| K3 | 8 | MC320 | 6759.8 | 1188.6 / 28.7 / 115.8 | 451.9 (393 x 1.15) | memory | 126.44 | 126.4 / 126.4 / 126.4 | - |
| GLM-5.2 | 8 | MC320 | 2078.2 | 102.8 / 24.1 / 33.4 | 382.9 (333 x 1.15) | memory | 411.26 | 411.3 / 411.3 / 411.3 | - |
| DeepSeek-V4-Pro | 8 | MC320 | 2008.2 | 286.1 / 18.8 / 33.3 | 350.8 (305 x 1.15) | memory | 425.60 | 425.6 / 425.6 / 425.6 | 425.6 - 457.1 |
| K3 | 16 | MC320 | 3379.9 | 594.3 / 28.7 / 57.9 | 451.9 (393 x 1.15) | memory | 252.88 | 252.9 / 252.9 / 252.9 | - |
| GLM-5.2 | 16 | MC320 | 1039.1 | 51.4 / 24.1 / 16.7 | 382.9 (333 x 1.15) | memory | 822.53 | 822.5 / 822.5 / 822.5 | - |
| DeepSeek-V4-Pro | 16 | MC320 | 1004.1 | 143.1 / 18.8 / 16.6 | 350.8 (305 x 1.15) | memory | 851.19 | 851.2 / 851.2 / 851.2 | 851.2 - 914.2 |
| K3 | 32 | MC320 | 1690.0 | 297.1 / 28.7 / 29.0 | 451.9 (393 x 1.15) | memory | 505.75 | 505.8 / 505.8 / 505.8 | - |
| GLM-5.2 | 32 | MC320 | 519.6 | 25.7 / 24.1 / 8.3 | 382.9 (333 x 1.15) | memory | 1645.06 | 1645.1 / 1532.7 / 1180.3 | - |
| DeepSeek-V4-Pro | 32 | MC320 | 502.1 | 71.5 / 18.8 / 8.3 | 350.8 (305 x 1.15) | memory | 1702.39 | 1702.4 / 1536.7 / 1206.1 | 1702.4 - 1828.3 |
| K3 | 8 | MC640 | 1877.7 | 1188.6 / 28.7 / 115.8 | 451.9 (393 x 1.15) | memory | 455.18 | 455.2 / 444.6 / 403.3 | - |
| GLM-5.2 | 8 | MC640 | 577.3 | 102.8 / 24.1 / 33.4 | 382.9 (333 x 1.15) | memory | 1480.55 | 1480.6 / 1295.4 / 1034.4 | - |
| DeepSeek-V4-Pro | 8 | MC640 | 557.8 | 286.1 / 18.8 / 33.3 | 350.8 (305 x 1.15) | collective | 1240.57 | 1240.6 / 1074.1 / 901.4 | 1240.6 - 1257.9 |
| K3 | 16 | MC640 | 938.9 | 594.3 / 28.7 / 57.9 | 451.9 (393 x 1.15) | compute | 754.47 | 754.5 / 672.8 / 582.7 | - |
| GLM-5.2 | 16 | MC640 | 288.6 | 51.4 / 24.1 / 16.7 | 382.9 (333 x 1.15) | collective | 1798.88 | 1798.9 / 1444.5 / 1127.3 | - |
| DeepSeek-V4-Pro | 16 | MC640 | 278.9 | 143.1 / 18.8 / 16.6 | 350.8 (305 x 1.15) | collective | 1614.87 | 1614.9 / 1343.8 / 1083.9 | 1614.9 - 1629.5 |
| K3 | 32 | MC640 | 469.4 | 297.1 / 28.7 / 29.0 | 451.9 (393 x 1.15) | collective | 1059.44 | 1059.4 / 905.1 / 749.2 | - |
| GLM-5.2 | 32 | MC640 | 144.3 | 25.7 / 24.1 / 8.3 | 382.9 (333 x 1.15) | collective | 1937.75 | 1937.8 / 1532.7 / 1180.3 | - |
| DeepSeek-V4-Pro | 32 | MC640 | 139.5 | 71.5 / 18.8 / 8.3 | 350.8 (305 x 1.15) | collective | 1901.77 | 1901.8 / 1536.7 / 1206.1 | 1901.8 - 1911.9 |

## Assumption sensitivity (TP32, one input changed per column; not a prediction)

| Model | MC | Profile | TPS/usr | +1 collective / layer | -1 collective / layer | 10% of attention weights replicated per rank | attention weights fully replicated per rank | expert prediction accuracy 0.5 | expert prediction accuracy 0.3 | kMemory = 1.0 | kMemory = 1.3 |
|---|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| K3 | MC320 | P1 | 506 | 506 (miss) | 506 (miss) | 207 (miss) | 33 (miss) | 482 (miss) | 468 (miss) | 616 (miss) | 474 (miss) |
| GLM-5.2 | MC320 | P1 | 1645 | 1610 | 1645 | 900 (miss) | 177 (miss) | 1444 | 1336 | 1938 | 1542 |
| DeepSeek-V4-Pro | MC320 | P1 | 1702 | 1645 | 1702 | 943 (miss) | 188 (miss) | 1552 | 1466 | 1902 | 1595 |
| K3 | MC640 | P1 | 1059 | 935 (miss) | 1221 | 746 (miss) | 118 (miss) | 1059 | 1059 | 1059 | 1059 |
| GLM-5.2 | MC640 | P1 | 1938 | 1610 | 2432 | 1905 | 638 (miss) | 1938 | 1938 | 1938 | 1938 |
| DeepSeek-V4-Pro | MC640 | P1 | 1902 | 1645 | 2254 | 1872 | 678 (miss) | 1902 | 1902 | 1902 | 1902 |

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
