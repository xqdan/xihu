# Stage A blocker resolution run

Run ID: `stage-a-20260923-calibrated-workload`
Manifest hash: `68303686e210999ec31ea08df9310e76d36677f184422b0754fe87cae051c319`
Source commit: `bfc53ffe1bd23821069244c99447869bcfe604a4`

## Workload calibration

- K3 operator rows are derived from `src/core/design_engine.js` (kimiK3 preset), FLOP ratio vs calibrated baseline 1.000, byte ratio 0.979.
- GLM-5.2 and DeepSeek-V4-Pro rows are ratio-scaled planning placeholders, still UNVERIFIED.

## D-Gate (independent validator)

```json
{
  "scope": "PLANNING_COMPARISON_ONLY_NOT_ARCHITECTURE_FREEZE",
  "areaConservation": true,
  "threeModelRowsAccounted": true,
  "threeModelComparable": true,
  "bottleneckClassification": true,
  "sensitivitySweep": true,
  "candidateCountLe3": true,
  "formalSelectionRecorded": true,
  "selectionResolvable": true,
  "registerConsistent": true,
  "decision": "PASS"
}
```

- Planning sweep: 243 samples; K3/P0/MC320/TP32 only. This does not cover all D2-D6 physical axes.
- Candidate register state: `D_GATE_PASSED` (derived from the validator, not written by this runner).

## Remaining qualification

- External model/license confirmation remains a qualification risk, not an implicit configuration.
- Event-level Q3-Q8 replay and fine TPS remain required before silicon sign-off.
- Planning TPS values are single-operator bottleneck bounds and are not comparable with the RDMA tile simulator results.

## Candidate ranking (worst-model planning TPS bound)

| Candidate | worst model | min TPS bound |
|---|---|---:|
| P0-7R-balanced-MC640-TP32 | DeepSeek-V4-Pro | 1636.66 |
| P1-compact-MC640-TP32 | DeepSeek-V4-Pro | 1636.66 |
| P0-7R-balanced-MC320-TP32 | DeepSeek-V4-Pro | 818.33 |
| P0-7R-balanced-MC640-TP16 | DeepSeek-V4-Pro | 818.33 |
| P1-compact-MC320-TP32 | DeepSeek-V4-Pro | 818.33 |
| P1-compact-MC640-TP16 | DeepSeek-V4-Pro | 818.33 |
| P0-7R-balanced-MC320-TP16 | DeepSeek-V4-Pro | 409.16 |
| P0-7R-balanced-MC640-TP8 | DeepSeek-V4-Pro | 409.16 |
| P1-compact-MC320-TP16 | DeepSeek-V4-Pro | 409.16 |
| P1-compact-MC640-TP8 | DeepSeek-V4-Pro | 409.16 |
| P0-7R-balanced-MC320-TP8 | DeepSeek-V4-Pro | 204.58 |
| P1-compact-MC320-TP8 | DeepSeek-V4-Pro | 204.58 |

## Selected candidates

- `P0-7R-balanced-MC640-TP32`
- `P1-compact-MC640-TP32`
- `P0-7R-balanced-MC320-TP32`

