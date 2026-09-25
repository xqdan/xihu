# Stage B Planning Quantification Run

Run ID: `stage-b-20260925-planning`
Manifest hash: `491512cae387601c4b4ac8e3f53b69856e557098240c5bd5634995fad3d7e121`
Run mode: `PLANNING_QUANTIFICATION`
Source commit: `6ab70da6cb7b58276db4066d13a68bed35a2ae9b`

## Gate result

- D-Gate: `PASS`
- Q-Gate: `BLOCKED_BY_D_GATE_MANIFEST_EVENT_MODEL_AND_PROVENANCE`
- Planning artifacts only. Q-Gate blocked: planning token time and synthetic events do not establish fine TPS or PPA closure.

## Planning token time

- `raw = max(memory x 1.1553, compute x 1.4139 + collectives x max(1.15 us, bytes/network))`, `e2e = raw x 1.17`.
- Calibrated on the K3 detailed point (P1/MC640/TP32): planning 1102.41 vs detailed 1101.77; MC320 out-of-fit 551.21 vs 586.46.

## Performance acceptance (planning estimates, not validated)

- Target: 1000 TPS/usr; architecture gate: 1050 TPS/usr
- All 18 slots meet target: **no**
- All 18 slots meet architecture gate: **no**
- Comparable slots meet target: **no**; coverage: `COMPLETE`
- Selected candidate slots meet target: **no**
- Studied candidate slots meet target: **no**
- Status: `PERFORMANCE_MISS_REQUIRES_DIRECTION_BACKFLOW`
- Feedback: Slots below target need byte reduction, more TP ranks or an implementable bandwidth route before architecture freeze.

## Planning slots

| Model | TP | MC | Profile | TPS/usr | bounding operator | resource |
|---|---:|---|---|---:|---|---|
| K3 | 8 | MC320 | P0 | 137.80 | dense_projection | memory_bandwidth |
| K3 | 8 | MC640 | P0 | 275.60 | dense_projection | memory_bandwidth |
| K3 | 16 | MC320 | P0 | 275.60 | dense_projection | memory_bandwidth |
| K3 | 16 | MC640 | P0 | 551.21 | dense_projection | memory_bandwidth |
| K3 | 32 | MC320 | P0 | 551.21 | dense_projection | memory_bandwidth |
| K3 | 32 | MC640 | P0 | 1102.41 | dense_projection | memory_bandwidth |
| GLM-5.2 | 8 | MC320 | P0 | 477.98 | routed_moe | memory_bandwidth |
| GLM-5.2 | 8 | MC640 | P0 | 955.95 | routed_moe | memory_bandwidth |
| GLM-5.2 | 16 | MC320 | P0 | 955.95 | routed_moe | memory_bandwidth |
| GLM-5.2 | 16 | MC640 | P0 | 1911.91 | routed_moe | memory_bandwidth |
| GLM-5.2 | 32 | MC320 | P0 | 1911.91 | routed_moe | memory_bandwidth |
| GLM-5.2 | 32 | MC640 | P0 | 2603.23 | collective_reduce | collective_latency |
| DeepSeek-V4-Pro | 8 | MC320 | P0 | 491.87 | dense_projection | memory_bandwidth |
| DeepSeek-V4-Pro | 8 | MC640 | P0 | 983.74 | dense_projection | memory_bandwidth |
| DeepSeek-V4-Pro | 16 | MC320 | P0 | 983.74 | dense_projection | memory_bandwidth |
| DeepSeek-V4-Pro | 16 | MC640 | P0 | 1967.48 | dense_projection | memory_bandwidth |
| DeepSeek-V4-Pro | 32 | MC320 | P0 | 1967.48 | dense_projection | memory_bandwidth |
| DeepSeek-V4-Pro | 32 | MC640 | P0 | 2392.91 | collective_reduce | collective_latency |

## Planning slots on P1 (token-time lanes, us)

| Model | TP | MC | memory lane | compute x k | collectives | bound | TPS/usr |
|---|---:|---|---:|---:|---:|---|---:|
| K3 | 8 | MC320 | 6202.4 | 1205.8 | 451.9 (393 x 1.15) | memory | 137.80 |
| GLM-5.2 | 8 | MC320 | 1788.2 | 142.6 | 293.3 (255 x 1.15) | memory | 477.98 |
| DeepSeek-V4-Pro | 8 | MC320 | 1737.7 | 318.3 | 280.6 (244 x 1.15) | memory | 491.87 |
| K3 | 16 | MC320 | 3101.2 | 602.9 | 451.9 (393 x 1.15) | memory | 275.60 |
| GLM-5.2 | 16 | MC320 | 894.1 | 71.3 | 293.3 (255 x 1.15) | memory | 955.95 |
| DeepSeek-V4-Pro | 16 | MC320 | 868.8 | 159.2 | 280.6 (244 x 1.15) | memory | 983.74 |
| K3 | 32 | MC320 | 1550.6 | 301.4 | 451.9 (393 x 1.15) | memory | 551.21 |
| GLM-5.2 | 32 | MC320 | 447.0 | 35.7 | 293.3 (255 x 1.15) | memory | 1911.91 |
| DeepSeek-V4-Pro | 32 | MC320 | 434.4 | 79.6 | 280.6 (244 x 1.15) | memory | 1967.48 |
| K3 | 8 | MC640 | 3101.2 | 1205.8 | 451.9 (393 x 1.15) | memory | 275.60 |
| GLM-5.2 | 8 | MC640 | 894.1 | 142.6 | 293.3 (255 x 1.15) | memory | 955.95 |
| DeepSeek-V4-Pro | 8 | MC640 | 868.8 | 318.3 | 280.6 (244 x 1.15) | memory | 983.74 |
| K3 | 16 | MC640 | 1550.6 | 602.9 | 451.9 (393 x 1.15) | memory | 551.21 |
| GLM-5.2 | 16 | MC640 | 447.0 | 71.3 | 293.3 (255 x 1.15) | memory | 1911.91 |
| DeepSeek-V4-Pro | 16 | MC640 | 434.4 | 159.2 | 280.6 (244 x 1.15) | collective | 1943.50 |
| K3 | 32 | MC640 | 775.3 | 301.4 | 451.9 (393 x 1.15) | memory | 1102.41 |
| GLM-5.2 | 32 | MC640 | 223.5 | 35.7 | 293.3 (255 x 1.15) | collective | 2598.63 |
| DeepSeek-V4-Pro | 32 | MC640 | 217.2 | 79.6 | 280.6 (244 x 1.15) | collective | 2372.93 |

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

- `data/workload/formal_model_manifests.json`
- `data/workload/planning_operator_workload.json`
- `data/detailed/formal_event_replay.json`
- `data/workload/tps_observation_matrix.json`
- `data/detailed/detailed_architecture_run.json`
