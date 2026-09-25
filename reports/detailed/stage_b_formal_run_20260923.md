# Stage B Formal Detailed Architecture Run

Run ID: `stage-b-20260923-formal`
Manifest hash: `68303686e210999ec31ea08df9310e76d36677f184422b0754fe87cae051c319`
Run mode: `PLANNING_QUANTIFICATION`
Source commit: `a452bde77da47539b4d699e16c36a84c8cdd9370`

## Gate result

- D-Gate: `PASS`
- Q-Gate: `BLOCKED_BY_D_GATE_MANIFEST_EVENT_MODEL_AND_PROVENANCE`
- Planning artifacts only. Q-Gate blocked: synthetic events do not establish fine TPS or PPA closure.

## Performance acceptance (planning bounds, not validated)

- Target: 1000 TPS/usr; architecture gate: 1050 TPS/usr
- All 18 slots meet target: **no**
- All 18 slots meet architecture gate: **no**
- Selected candidate slots meet target: **no**
- Status: `PERFORMANCE_MISS_REQUIRES_DIRECTION_BACKFLOW`
- Feedback: Slots below target need byte reduction, more TP ranks or an implementable bandwidth route before architecture freeze; planning bounds are optimistic.

## Planning slots

| Model | TP | MC | Profile | bound TPS | bounding operator | resource |
|---|---:|---|---|---:|---|---|
| K3 | 8 | MC320 | P0 | 257.94 | dense_projection | memory_bandwidth |
| K3 | 8 | MC640 | P0 | 515.87 | dense_projection | memory_bandwidth |
| K3 | 16 | MC320 | P0 | 515.87 | dense_projection | memory_bandwidth |
| K3 | 16 | MC640 | P0 | 1031.74 | dense_projection | memory_bandwidth |
| K3 | 32 | MC320 | P0 | 1031.74 | dense_projection | memory_bandwidth |
| K3 | 32 | MC640 | P0 | 2063.49 | dense_projection | memory_bandwidth |
| GLM-5.2 | 8 | MC320 | P0 | 238.45 | routed_moe | memory_bandwidth |
| GLM-5.2 | 8 | MC640 | P0 | 476.89 | routed_moe | memory_bandwidth |
| GLM-5.2 | 16 | MC320 | P0 | 476.89 | routed_moe | memory_bandwidth |
| GLM-5.2 | 16 | MC640 | P0 | 953.79 | routed_moe | memory_bandwidth |
| GLM-5.2 | 32 | MC320 | P0 | 953.79 | routed_moe | memory_bandwidth |
| GLM-5.2 | 32 | MC640 | P0 | 1907.57 | routed_moe | memory_bandwidth |
| DeepSeek-V4-Pro | 8 | MC320 | P0 | 204.58 | routed_moe | memory_bandwidth |
| DeepSeek-V4-Pro | 8 | MC640 | P0 | 409.16 | routed_moe | memory_bandwidth |
| DeepSeek-V4-Pro | 16 | MC320 | P0 | 409.16 | routed_moe | memory_bandwidth |
| DeepSeek-V4-Pro | 16 | MC640 | P0 | 818.33 | routed_moe | memory_bandwidth |
| DeepSeek-V4-Pro | 32 | MC320 | P0 | 818.33 | routed_moe | memory_bandwidth |
| DeepSeek-V4-Pro | 32 | MC640 | P0 | 1636.66 | routed_moe | memory_bandwidth |

## Agent outputs

- **Q1**: COMPLETE - formal model manifest, operator inventory and shared hash
- **Q2**: COMPLETE - three-model arithmetic intensity, Roofline, compute/bandwidth/network sizing ledger (K3 shape-derived; GLM/DeepSeek unverified)
- **Q3**: PLANNING_ONLY - tile and memory event placeholders
- **Q4**: PLANNING_ONLY - collective packet and NoC event placeholders
- **Q5**: PLANNING_ONLY - kernel cycle placeholders
- **Q6**: PLANNING_ONLY - scheduler overlap and stall placeholders
- **Q7**: PLANNING_ONLY - planning PPA and thermal envelope reconciliation
- **Q8**: PLANNING_ONLY - optimistic bottleneck bounds; no dependency-aware timing replay
- **Q9**: COMPLETE - independent gate validator executed after artifact generation

## Artifacts

- `data/workload/formal_model_manifests.json`
- `data/workload/planning_operator_workload.json`
- `data/detailed/formal_event_replay.json`
- `data/workload/tps_observation_matrix.json`
- `data/detailed/detailed_architecture_run.json`
