# Stage A blocker resolution run

Run ID: `stage-a-20260925-token-time`
Manifest hash: `491512cae387601c4b4ac8e3f53b69856e557098240c5bd5634995fad3d7e121`
Source commit: `6ab70da6cb7b58276db4066d13a68bed35a2ae9b`

## Planning token time (models/planning/token_time.js)

`raw = max(memory lane x kMemory, compute x kCompute + collectives x max(tau, bytes/network))`, `e2e = raw x 1.17`, `TPS/usr = 1e6 / e2e`.

- Calibration on the K3 detailed point (P1/MC640/TP32): kMemory 1.1553, kCompute 1.4139; planning 1102.41 vs detailed 1101.77 TPS/usr (raw residual -0.45 us).
- Out-of-fit check at MC320: planning 551.21 vs detailed 586.46 TPS/usr (ratio 0.940).
- K3 rows are derived from `src/core/design_engine.js` (kimiK3 preset) with absorbed MLA and FP8 KV; FLOP ratio vs detailed plan 0.996, byte ratio 0.969.
- DeepSeek-V4-Pro rows are derived from the manifest shape block (reported fields + ASSUMPTIONs); expert hidden solved from 49B active = 3840.8, implied total / reported 1600B = 1.162; MTP excluded.
- GLM-5.2 rows are derived from the public config.json (78 layers, 21 full-indexer layers, 256 experts top-8); parameters with MTP / reported 753B = 1.0004, active 41.25B; MTP excluded. Applying the K3 factors to GLM-5.2 and DeepSeek-V4-Pro is a planning ASSUMPTION.

## D-Gate (independent validator)

```json
{
  "scope": "PLANNING_COMPARISON_ONLY_NOT_ARCHITECTURE_FREEZE",
  "areaConservation": true,
  "threeModelRowsAccounted": true,
  "threeModelComparable": true,
  "blockedModels": [],
  "bottleneckClassification": true,
  "sensitivitySweep": true,
  "candidateCountLe3": true,
  "formalSelectionRecorded": true,
  "selectionResolvable": true,
  "registerConsistent": true,
  "failedChecks": [],
  "decision": "PASS"
}
```

- Planning sweep: 243 samples around K3/P1/MC640/TP32; 132 reach 1000 TPS/usr. This does not cover all D2-D6 physical axes.
- Blocked models: none. A BLOCKED_CONFIG model keeps the three-model comparison open, blocks the D-Gate and sends Stage B to EXPLORATORY_AFTER_BLOCKED_D_GATE (ADR-0006).
- Candidate register state: `D_GATE_PASSED` (derived from the validator, not written by this runner).

## Remaining qualification

- External model/license confirmation remains a qualification risk, not an implicit configuration.
- Event-level Q3-Q8 replay and fine TPS remain required before silicon sign-off.
- Planning TPS values are calibrated to the K3 detailed point but are not event-timed; they do not replace the detailed model.

## Planning TPS/usr per slot

| Candidate | Model | memory lane us | compute us | collective us | bound | TPS/usr |
|---|---|---:|---:|---:|---|---:|
| P0-7R-balanced-MC320-TP8 | K3 | 6202.4 | 1147.0 | 451.9 | memory | 137.80 |
| P0-7R-balanced-MC320-TP8 | GLM-5.2 | 1788.2 | 140.3 | 293.3 | memory | 477.98 |
| P0-7R-balanced-MC320-TP8 | DeepSeek-V4-Pro | 1737.7 | 306.3 | 280.6 | memory | 491.87 |
| P0-7R-balanced-MC320-TP16 | K3 | 3101.2 | 573.5 | 451.9 | memory | 275.60 |
| P0-7R-balanced-MC320-TP16 | GLM-5.2 | 894.1 | 70.1 | 293.3 | memory | 955.95 |
| P0-7R-balanced-MC320-TP16 | DeepSeek-V4-Pro | 868.8 | 153.2 | 280.6 | memory | 983.74 |
| P0-7R-balanced-MC320-TP32 | K3 | 1550.6 | 286.7 | 451.9 | memory | 551.21 |
| P0-7R-balanced-MC320-TP32 | GLM-5.2 | 447.0 | 35.1 | 293.3 | memory | 1911.91 |
| P0-7R-balanced-MC320-TP32 | DeepSeek-V4-Pro | 434.4 | 76.6 | 280.6 | memory | 1967.48 |
| P0-7R-balanced-MC640-TP8 | K3 | 3101.2 | 1147.0 | 451.9 | memory | 275.60 |
| P0-7R-balanced-MC640-TP8 | GLM-5.2 | 894.1 | 140.3 | 293.3 | memory | 955.95 |
| P0-7R-balanced-MC640-TP8 | DeepSeek-V4-Pro | 868.8 | 306.3 | 280.6 | memory | 983.74 |
| P0-7R-balanced-MC640-TP16 | K3 | 1550.6 | 573.5 | 451.9 | memory | 551.21 |
| P0-7R-balanced-MC640-TP16 | GLM-5.2 | 447.0 | 70.1 | 293.3 | memory | 1911.91 |
| P0-7R-balanced-MC640-TP16 | DeepSeek-V4-Pro | 434.4 | 153.2 | 280.6 | memory | 1967.48 |
| P0-7R-balanced-MC640-TP32 | K3 | 775.3 | 286.7 | 451.9 | memory | 1102.41 |
| P0-7R-balanced-MC640-TP32 | GLM-5.2 | 223.5 | 35.1 | 293.3 | collective | 2603.23 |
| P0-7R-balanced-MC640-TP32 | DeepSeek-V4-Pro | 217.2 | 76.6 | 280.6 | collective | 2392.91 |
| P1-compact-MC320-TP8 | K3 | 6202.4 | 1205.8 | 451.9 | memory | 137.80 |
| P1-compact-MC320-TP8 | GLM-5.2 | 1788.2 | 142.6 | 293.3 | memory | 477.98 |
| P1-compact-MC320-TP8 | DeepSeek-V4-Pro | 1737.7 | 318.3 | 280.6 | memory | 491.87 |
| P1-compact-MC320-TP16 | K3 | 3101.2 | 602.9 | 451.9 | memory | 275.60 |
| P1-compact-MC320-TP16 | GLM-5.2 | 894.1 | 71.3 | 293.3 | memory | 955.95 |
| P1-compact-MC320-TP16 | DeepSeek-V4-Pro | 868.8 | 159.2 | 280.6 | memory | 983.74 |
| P1-compact-MC320-TP32 | K3 | 1550.6 | 301.4 | 451.9 | memory | 551.21 |
| P1-compact-MC320-TP32 | GLM-5.2 | 447.0 | 35.7 | 293.3 | memory | 1911.91 |
| P1-compact-MC320-TP32 | DeepSeek-V4-Pro | 434.4 | 79.6 | 280.6 | memory | 1967.48 |
| P1-compact-MC640-TP8 | K3 | 3101.2 | 1205.8 | 451.9 | memory | 275.60 |
| P1-compact-MC640-TP8 | GLM-5.2 | 894.1 | 142.6 | 293.3 | memory | 955.95 |
| P1-compact-MC640-TP8 | DeepSeek-V4-Pro | 868.8 | 318.3 | 280.6 | memory | 983.74 |
| P1-compact-MC640-TP16 | K3 | 1550.6 | 602.9 | 451.9 | memory | 551.21 |
| P1-compact-MC640-TP16 | GLM-5.2 | 447.0 | 71.3 | 293.3 | memory | 1911.91 |
| P1-compact-MC640-TP16 | DeepSeek-V4-Pro | 434.4 | 159.2 | 280.6 | collective | 1943.50 |
| P1-compact-MC640-TP32 | K3 | 775.3 | 301.4 | 451.9 | memory | 1102.41 |
| P1-compact-MC640-TP32 | GLM-5.2 | 223.5 | 35.7 | 293.3 | collective | 2598.63 |
| P1-compact-MC640-TP32 | DeepSeek-V4-Pro | 217.2 | 79.6 | 280.6 | collective | 2372.93 |

## Candidate ranking (worst comparable-model planning TPS)

| Candidate | worst model | min TPS |
|---|---|---:|
| P0-7R-balanced-MC640-TP32 | K3 | 1102.41 |
| P1-compact-MC640-TP32 | K3 | 1102.41 |
| P0-7R-balanced-MC320-TP32 | K3 | 551.21 |
| P0-7R-balanced-MC640-TP16 | K3 | 551.21 |
| P1-compact-MC320-TP32 | K3 | 551.21 |
| P1-compact-MC640-TP16 | K3 | 551.21 |
| P0-7R-balanced-MC320-TP16 | K3 | 275.60 |
| P0-7R-balanced-MC640-TP8 | K3 | 275.60 |
| P1-compact-MC320-TP16 | K3 | 275.60 |
| P1-compact-MC640-TP8 | K3 | 275.60 |
| P0-7R-balanced-MC320-TP8 | K3 | 137.80 |
| P1-compact-MC320-TP8 | K3 | 137.80 |

## Selected candidates

- `P0-7R-balanced-MC640-TP32`
- `P1-compact-MC640-TP32`
- `P0-7R-balanced-MC320-TP32`

