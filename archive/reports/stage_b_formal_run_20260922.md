# Stage B Formal Detailed Architecture Run

Run ID: `stage-b-20260922-formal`
Manifest hash: `92cea05d01eb96af4b5ef61796e9dae82768ba4e60749f2afc2d9ab95286ea94`
Run mode: `PLANNING_QUANTIFICATION`

## Gate result

- D-Gate: `PASS`
- Q-Gate: `BLOCKED_BY_D_GATE_MANIFEST_EVENT_MODEL_AND_PROVENANCE`
- Planning artifacts only. Q-Gate blocked: synthetic events do not establish fine TPS or PPA closure.

## Performance acceptance

- Target: 1000 TPS/usr
- All 18 slots meet target: **no**
- Feedback: Reduce external-memory bytes or add an implementable bandwidth/reuse route before architecture freeze.

## Agent outputs

- **Q1**: COMPLETE - formal model manifest, operator inventory and shared hash
- **Q2**: COMPLETE - three-model arithmetic intensity, Roofline, compute/bandwidth/network sizing ledger
- **Q3**: PLANNING_ONLY - tile and memory event replay
- **Q4**: PLANNING_ONLY - collective packet and NoC event replay
- **Q5**: PLANNING_ONLY - kernel cycle replay
- **Q6**: PLANNING_ONLY - scheduler overlap and stall replay
- **Q7**: PLANNING_ONLY - planning PPA and thermal envelope reconciliation
- **Q8**: PLANNING_ONLY - optimistic bottleneck bounds; no dependency-aware timing replay
- **Q9**: COMPLETE - independent gate validator executed after artifact generation

## Artifacts

- `teams/model/inputs/formal_model_manifests.json`
- `out/detailed/formal_event_replay.json`
- `out/workload/tps_observation_matrix.json`
- `out/detailed/detailed_architecture_run.json`
