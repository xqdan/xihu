# Stage A blocker resolution run

Run ID: `stage-a-20260925-token-time`
Manifest hash: `dbbdcad65e2f895f0b28380c3422f6900ead9050398dbbdaabe8e7a0dfd3d18f`
Source commit: `e95418359cb22dd2a24318d9d9e13477baa2f3d5`

## Planning token time (integration/planning/token_time.js)

`memory lane = kMemory x (bytes + expertReread x routed bytes) / TP / BW`; `serial lane = kFlop x FLOP time + fixedPerLayerUs x layers + kTmaExposedUsPerGB x GB/rank + collectives x max(tau, bytes/network)`; `raw = max(memory lane, serial lane)`, `e2e = raw x 1.17`, `TPS/usr = 1e6 / e2e` (ADR-0008).

- Calibration on the K3 detailed timing breakdown (P1/MC640/TP32): expertReread 0.200, kMemory 1.1178, kFlop 1.1529, fixedPerLayerUs 0.2987, kTmaExposedUsPerGB 5.793; planning 1102.41 vs detailed 1101.77 TPS/usr (raw residual -0.45 us). The ADR-0006 single factor kCompute 1.4139 is kept for comparison only.
- Out-of-fit check at MC320: planning 551.21 vs detailed 586.46 TPS/usr (ratio 0.940).
- K3 rows are derived from `teams/model/src/design_engine.js` (kimiK3 preset) with absorbed MLA and FP8 KV; FLOP ratio vs detailed plan 0.996, byte ratio 0.969.
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
  "selectionMeetsTarget": true,
  "registerConsistent": true,
  "failedChecks": [],
  "decision": "PASS"
}
```

- Planning sweep: 243 samples around K3/P1/MC640/TP32; 131 reach 1000 TPS/usr. This does not cover all D2-D6 physical axes.
- Blocked models: none. A BLOCKED_CONFIG model keeps the three-model comparison open, blocks the D-Gate and sends Stage B to EXPLORATORY_AFTER_BLOCKED_D_GATE (ADR-0006).
- Candidate register state: `D_GATE_PASSED` (derived from the validator, not written by this runner).

## Remaining qualification

- External model/license confirmation remains a qualification risk, not an implicit configuration.
- Event-level Q3-Q8 replay and fine TPS remain required before silicon sign-off.
- Planning TPS values are calibrated to the K3 detailed point but are not event-timed; they do not replace the detailed model.

## Planning TPS/usr per slot

| Candidate | Model | dtype | memory lane us | FLOP / fixed / TMA us | collective us | bound | TPS/usr | tau 1.15 / 1.5 / 2.0 | shape range |
|---|---|---|---:|---:|---:|---|---:|---|---|
| P1-compact-MC320-TP8 | K3 | dense BF16, router/LM head BF16, routed MXFP4 | 6202.4 | 983.2 / 27.8 / 111.5 | 451.9 | memory | 137.80 | 137.8 / 137.8 / 137.8 | - |
| P1-compact-MC320-TP8 | GLM-5.2 | dense FP8, router/LM head BF16, routed FP8 | 1906.7 | 116.3 / 23.3 / 32.1 | 293.3 | memory | 448.26 | 448.3 / 448.3 / 448.3 | - |
| P1-compact-MC320-TP8 | DeepSeek-V4-Pro | dense FP8, router/LM head BF16, routed FP4 | 1842.6 | 259.6 / 18.2 / 32.0 | 280.6 | memory | 463.85 | 463.8 / 463.8 / 463.8 | 463.8 - 498.2 |
| P1-compact-MC320-TP16 | K3 | dense BF16, router/LM head BF16, routed MXFP4 | 3101.2 | 491.6 / 27.8 / 55.7 | 451.9 | memory | 275.60 | 275.6 / 275.6 / 275.6 | - |
| P1-compact-MC320-TP16 | GLM-5.2 | dense FP8, router/LM head BF16, routed FP8 | 953.3 | 58.1 / 23.3 / 16.1 | 293.3 | memory | 896.53 | 896.5 / 896.5 / 896.5 | - |
| P1-compact-MC320-TP16 | DeepSeek-V4-Pro | dense FP8, router/LM head BF16, routed FP4 | 921.3 | 129.8 / 18.2 / 16.0 | 280.6 | memory | 927.69 | 927.7 / 927.7 / 927.7 | 927.7 - 996.3 |
| P1-compact-MC320-TP32 | K3 | dense BF16, router/LM head BF16, routed MXFP4 | 1550.6 | 245.8 / 27.8 / 27.9 | 451.9 | memory | 551.21 | 551.2 / 551.2 / 551.2 | - |
| P1-compact-MC320-TP32 | GLM-5.2 | dense FP8, router/LM head BF16, routed FP8 | 476.7 | 29.1 / 23.3 / 8.0 | 293.3 | memory | 1793.05 | 1793.1 / 1793.1 / 1498.4 | - |
| P1-compact-MC320-TP32 | DeepSeek-V4-Pro | dense FP8, router/LM head BF16, routed FP4 | 460.7 | 64.9 / 18.2 / 8.0 | 280.6 | memory | 1855.38 | 1855.4 / 1855.4 / 1475.9 | 1855.4 - 1992.6 |
| P1-compact-MC640-TP8 | K3 | dense BF16, router/LM head BF16, routed MXFP4 | 3101.2 | 983.2 / 27.8 / 111.5 | 451.9 | memory | 275.60 | 275.6 / 275.6 / 275.6 | - |
| P1-compact-MC640-TP8 | GLM-5.2 | dense FP8, router/LM head BF16, routed FP8 | 953.3 | 116.3 / 23.3 / 32.1 | 293.3 | memory | 896.53 | 896.5 / 896.5 / 896.5 | - |
| P1-compact-MC640-TP8 | DeepSeek-V4-Pro | dense FP8, router/LM head BF16, routed FP4 | 921.3 | 259.6 / 18.2 / 32.0 | 280.6 | memory | 927.69 | 927.7 / 927.7 / 927.7 | 927.7 - 996.3 |
| P1-compact-MC640-TP16 | K3 | dense BF16, router/LM head BF16, routed MXFP4 | 1550.6 | 491.6 / 27.8 / 55.7 | 451.9 | memory | 551.21 | 551.2 / 551.2 / 551.2 | - |
| P1-compact-MC640-TP16 | GLM-5.2 | dense FP8, router/LM head BF16, routed FP8 | 476.7 | 58.1 / 23.3 / 16.1 | 293.3 | memory | 1793.05 | 1793.1 / 1780.6 / 1406.9 | - |
| P1-compact-MC640-TP16 | DeepSeek-V4-Pro | dense FP8, router/LM head BF16, routed FP4 | 460.7 | 129.8 / 18.2 / 16.0 | 280.6 | memory | 1855.38 | 1855.4 / 1612.6 / 1310.9 | 1855.4 - 1949.1 |
| P1-compact-MC640-TP32 | K3 | dense BF16, router/LM head BF16, routed MXFP4 | 775.3 | 245.8 / 27.8 / 27.9 | 451.9 | memory | 1102.41 | 1102.4 / 959.3 / 786.0 | - |
| P1-compact-MC640-TP32 | GLM-5.2 | dense FP8, router/LM head BF16, routed FP8 | 238.3 | 29.1 / 23.3 / 8.0 | 293.3 | collective | 2416.78 | 2416.8 / 1929.8 / 1498.4 | - |
| P1-compact-MC640-TP32 | DeepSeek-V4-Pro | dense FP8, router/LM head BF16, routed FP4 | 230.3 | 64.9 / 18.2 / 8.0 | 280.6 | collective | 2299.32 | 2299.3 / 1869.8 / 1475.9 | 2299.3 - 2318.4 |

- tau columns: the point estimate uses tau 1.15 us and alone decides selection; 1.5 and 2.0 us are risk columns until B-008 derives tau physically.
- shape range: DeepSeek-V4-Pro expert hidden solved from 49B active (point) and from 1.6T total (variant `expertHiddenFromTotal`).

## Comparison rows (not ranked, not selectable)

| Comparison | Candidate | TPS/usr | bound | base model TPS/usr |
|---|---|---:|---|---:|
| K3-FP8-dense | P1-compact-MC320-TP8 | 208.24 | memory | 137.80 |
| K3-FP8-dense | P1-compact-MC320-TP16 | 416.47 | memory | 275.60 |
| K3-FP8-dense | P1-compact-MC320-TP32 | 832.95 | memory | 551.21 |
| K3-FP8-dense | P1-compact-MC640-TP8 | 416.47 | memory | 275.60 |
| K3-FP8-dense | P1-compact-MC640-TP16 | 832.95 | memory | 551.21 |
| K3-FP8-dense | P1-compact-MC640-TP32 | 1149.32 | collective | 1102.41 |

## Candidate ranking (worst comparable-model planning TPS)

Policy: rank by worst comparable-model planning TPS; formally eligible only if every comparable model reaches the 1000 TPS/usr target (not the 1050 architecture gate) at the tau point estimate 1.15 us; at most three eligible candidates; the tau range is a risk annotation, not a selection criterion: each candidate records the largest tau at which every model still reaches the target and is tau-conditional below 2 us; the best MC320 candidate is a non-formal reference.

| Candidate | worst model | min TPS | min TPS at tau 2 | max tau for target (us) | >= 1050 gate | formally eligible |
|---|---|---:|---:|---:|---|---|
| P1-compact-MC640-TP32 | K3 | 1102.41 | 785.97 | 1.408 | yes | yes (tau-conditional) |
| P1-compact-MC320-TP32 | K3 | 551.21 | 551.21 | misses at any tau | no | no |
| P1-compact-MC640-TP16 | K3 | 551.21 | 551.21 | misses at any tau | no | no |
| P1-compact-MC320-TP16 | K3 | 275.60 | 275.60 | misses at any tau | no | no |
| P1-compact-MC640-TP8 | K3 | 275.60 | 275.60 | misses at any tau | no | no |
| P1-compact-MC320-TP8 | K3 | 137.80 | 137.80 | misses at any tau | no | no |

## Selected candidates

- `P1-compact-MC640-TP32`: worst K3 1102.41 TPS/usr; tau-conditional, reaches the target only while tau <= 1.408 us
- Reference (not formal): `P1-compact-MC320-TP32`, worst K3 551.21 TPS/usr; misses: K3 551.2 (55%).

