# Stage A blocker resolution run

Run ID: `stage-a-20261002-token-time`
Manifest hash: `a140afe4612d0bc8fc226c89d80f7ee4735da3784a75256d14f0da8b2e696083`
Source commit: `ddf8599e978b6fac5aaeb79659a51e749aa9ac0c`

## Planning token time (integration/planning/token_time.js)

`memory lane = kMemory x (bytes + expertReread x routed bytes) / TP / BW`; `serial lane = kFlop x FLOP time + fixedPerLayerUs x layers + kTmaExposedUsPerGB x GB/rank + collectives x max(tau, bytes/network)`; `raw = max(memory lane, serial lane)`, `e2e = raw x 1.17`, `TPS/usr = 1e6 / e2e` (ADR-0008).

- Calibration on the K3 detailed timing breakdown (P1/MC640/TP32): expertReread 0.200, kMemory 1.4537, kFlop 1.1845, fixedPerLayerUs 0.2247, kTmaExposedUsPerGB 9.484; planning 1157.69 vs detailed 1138.48 TPS/usr (raw residual -12.46 us). The ADR-0006 single factor kCompute 1.5430 is kept for comparison only.
- Out-of-fit check at MC320: planning 423.84 vs detailed 579.53 TPS/usr (ratio 0.731).
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
  "expectedRegisterState": "D_GATE_PASSED",
  "registerConsistent": true,
  "failedChecks": [],
  "decision": "PASS"
}
```

- Planning sweep: 243 samples around K3/P1/MC640/TP32; 207 reach 1000 TPS/usr. This does not cover all D2-D6 physical axes.
- Blocked models: none. A BLOCKED_CONFIG model keeps the three-model comparison open, blocks the D-Gate and sends Stage B to EXPLORATORY_AFTER_BLOCKED_D_GATE (ADR-0006).
- Candidate register state: `D_GATE_PASSED` (derived from the validator, not written by this runner).

## Remaining qualification

- External model/license confirmation remains a qualification risk, not an implicit configuration.
- Event-level Q3-Q8 replay and fine TPS remain required before silicon sign-off.
- Planning TPS values are calibrated to the K3 detailed point but are not event-timed; they do not replace the detailed model.

## Planning TPS/usr per slot

| Candidate | Model | dtype | memory lane us | FLOP / fixed / TMA us | collective us | bound | TPS/usr | tau 1.15 / 1.5 / 2.0 | shape range |
|---|---|---|---:|---:|---:|---|---:|---|---|
| P1-compact-MC320-TP8 | K3 | dense BF16, router/LM head BF16, routed MXFP4 | 8066.3 | 879.2 / 20.9 / 182.5 | 451.9 | memory | 105.96 | 106.0 / 106.0 / 106.0 | - |
| P1-compact-MC320-TP8 | GLM-5.2 | dense FP8, router/LM head BF16, routed FP8 | 2479.9 | 114.6 / 17.5 / 52.6 | 382.9 | memory | 344.65 | 344.7 / 344.7 / 344.7 | - |
| P1-compact-MC320-TP8 | DeepSeek-V4-Pro | dense FP8, router/LM head BF16, routed FP4 | 2396.4 | 239.9 / 13.7 / 52.4 | 350.8 | memory | 356.67 | 356.7 / 356.7 / 356.7 | 356.7 - 383.1 |
| P1-compact-MC320-TP16 | K3 | dense BF16, router/LM head BF16, routed MXFP4 | 4033.1 | 439.6 / 20.9 / 91.2 | 451.9 | memory | 211.92 | 211.9 / 211.9 / 211.9 | - |
| P1-compact-MC320-TP16 | GLM-5.2 | dense FP8, router/LM head BF16, routed FP8 | 1239.9 | 57.3 / 17.5 / 26.3 | 382.9 | memory | 689.31 | 689.3 / 689.3 / 689.3 | - |
| P1-compact-MC320-TP16 | DeepSeek-V4-Pro | dense FP8, router/LM head BF16, routed FP4 | 1198.2 | 120.0 / 13.7 / 26.2 | 350.8 | memory | 713.33 | 713.3 / 713.3 / 713.3 | 713.3 - 766.1 |
| P1-compact-MC320-TP32 | K3 | dense BF16, router/LM head BF16, routed MXFP4 | 2016.6 | 219.8 / 20.9 / 45.6 | 451.9 | memory | 423.84 | 423.8 / 423.8 / 423.8 | - |
| P1-compact-MC320-TP32 | GLM-5.2 | dense FP8, router/LM head BF16, routed FP8 | 620.0 | 28.6 / 17.5 / 13.2 | 382.9 | memory | 1378.62 | 1378.6 / 1378.6 / 1178.4 | - |
| P1-compact-MC320-TP32 | DeepSeek-V4-Pro | dense FP8, router/LM head BF16, routed FP4 | 599.1 | 60.0 / 13.7 / 13.1 | 350.8 | memory | 1426.66 | 1426.7 / 1426.7 / 1226.6 | 1426.7 - 1532.2 |
| P1-compact-MC640-TP8 | K3 | dense BF16, router/LM head BF16, routed MXFP4 | 2240.6 | 879.2 / 20.9 / 182.5 | 451.9 | memory | 381.46 | 381.5 / 381.5 / 381.5 | - |
| P1-compact-MC640-TP8 | GLM-5.2 | dense FP8, router/LM head BF16, routed FP8 | 688.9 | 114.6 / 17.5 / 52.6 | 382.9 | memory | 1240.76 | 1240.8 / 1240.8 / 1004.7 | - |
| P1-compact-MC640-TP8 | DeepSeek-V4-Pro | dense FP8, router/LM head BF16, routed FP4 | 665.7 | 239.9 / 13.7 / 52.4 | 350.8 | memory | 1284.00 | 1284.0 / 1119.4 / 933.0 | 1284.0 - 1329.3 |
| P1-compact-MC640-TP16 | K3 | dense BF16, router/LM head BF16, routed MXFP4 | 1120.3 | 439.6 / 20.9 / 91.2 | 451.9 | memory | 762.91 | 762.9 / 748.9 / 638.9 | - |
| P1-compact-MC640-TP16 | GLM-5.2 | dense FP8, router/LM head BF16, routed FP8 | 344.4 | 57.3 / 17.5 / 26.3 | 382.9 | collective | 1765.68 | 1765.7 / 1423.0 / 1114.2 | - |
| P1-compact-MC640-TP16 | DeepSeek-V4-Pro | dense FP8, router/LM head BF16, routed FP4 | 332.8 | 120.0 / 13.7 / 26.2 | 350.8 | collective | 1673.83 | 1673.8 / 1384.4 / 1110.2 | 1673.8 - 1696.8 |
| P1-compact-MC640-TP32 | K3 | dense BF16, router/LM head BF16, routed MXFP4 | 560.2 | 219.8 / 20.9 / 45.6 | 451.9 | collective | 1157.69 | 1157.7 / 975.9 / 797.1 | - |
| P1-compact-MC640-TP32 | GLM-5.2 | dense FP8, router/LM head BF16, routed FP8 | 172.2 | 28.6 / 17.5 / 13.2 | 382.9 | collective | 1932.53 | 1932.5 / 1529.5 / 1178.4 | - |
| P1-compact-MC640-TP32 | DeepSeek-V4-Pro | dense FP8, router/LM head BF16, routed FP4 | 166.4 | 60.0 / 13.7 / 13.1 | 350.8 | collective | 1953.42 | 1953.4 / 1570.3 / 1226.6 | 1953.4 - 1969.0 |

- tau columns: the point estimate uses tau 1.15 us and alone decides selection; 1.5 and 2.0 us are risk columns until B-008 derives tau physically.
- shape range: DeepSeek-V4-Pro expert hidden solved from 49B active (point) and from 1.6T total (variant `expertHiddenFromTotal`).

## Comparison rows (not ranked, not selectable)

| Comparison | Candidate | TPS/usr | bound | base model TPS/usr |
|---|---|---:|---|---:|
| K3-FP8-dense | P1-compact-MC320-TP8 | 160.12 | memory | 105.96 |
| K3-FP8-dense | P1-compact-MC320-TP16 | 320.24 | memory | 211.92 |
| K3-FP8-dense | P1-compact-MC320-TP32 | 640.48 | memory | 423.84 |
| K3-FP8-dense | P1-compact-MC640-TP8 | 576.43 | memory | 381.46 |
| K3-FP8-dense | P1-compact-MC640-TP16 | 879.49 | compute | 762.91 |
| K3-FP8-dense | P1-compact-MC640-TP32 | 1183.25 | collective | 1157.69 |

## Candidate ranking (worst comparable-model planning TPS)

Policy: rank by worst comparable-model planning TPS; formally eligible only if every comparable model reaches the 1000 TPS/usr target (not the 1050 architecture gate) at the tau point estimate 1.15 us; at most three eligible candidates; the tau range is a risk annotation, not a selection criterion: each candidate records the largest tau at which every model still reaches the target and is tau-conditional below 2 us; the best MC320 candidate is a non-formal reference.

| Candidate | worst model | min TPS | min TPS at tau 2 | max tau for target (us) | planning TPS >= 1050 (not the gate: see baselineStatus) | formally eligible |
|---|---|---:|---:|---:|---|---|
| P1-compact-MC640-TP32 | K3 | 1157.69 | 797.05 | 1.446 | yes | yes (tau-conditional) |
| P1-compact-MC640-TP16 | K3 | 762.91 | 638.90 | misses at any tau | no | no |
| P1-compact-MC320-TP32 | K3 | 423.84 | 423.84 | misses at any tau | no | no |
| P1-compact-MC640-TP8 | K3 | 381.46 | 381.46 | misses at any tau | no | no |
| P1-compact-MC320-TP16 | K3 | 211.92 | 211.92 | misses at any tau | no | no |
| P1-compact-MC320-TP8 | K3 | 105.96 | 105.96 | misses at any tau | no | no |

## Selected candidates

- `P1-compact-MC640-TP32`: worst K3 1157.69 TPS/usr; tau-conditional, reaches the target only while tau <= 1.446 us
- Reference (not formal): `P1-compact-MC320-TP32`, worst K3 423.84 TPS/usr; misses: K3 423.8 (42%).

## L2 morphology space (25 shapes, scored against S-CMP)

Axes: L/H ratio 8+4 / 4+4 / 12+4 / 16+4 / 8+8 / 8+12 / 8+16; local SRAM 1/4 MiB / 2/4 MiB / 4/4 MiB / 1/2 MiB / 1/8 MiB per L/H core; shared 8 / 12 / 16 / 20 / 24 / 32 MiB per die; MC MC320 / MC640; dies 4 / 6 / 8; TP 8 / 16 / 32. Everything else is the published point out/rdma/k3_rdma_final_tuning_results.json#/search/best/x.

Area and power from `A.physical(x, dies)` rescaled by `k3_physical_basis.resize`; TPS/usr from token time with the shape's peaks and MC bandwidth carried on the slot. Both are the SAME authorities the published grid uses, so a row here is comparable with a row above.

| Morphology | L/H | local/shared MiB per die | MC | dies | TP | die mm2 (max 400) | die W (max 300) | card W (max 3200) | package mm2 (max 5248) | worst min TPS | worst model | contract |
|---|---|---|---|---:|---:|---:|---:|---:|---:|---:|---|---|
| `P1-compact-N12x4-MC640-TP32` | 12+4 | 28/16 | MC640 | 8 | 32 | 397.8 | 315.3 **OVER** | 3230 **OVER** | 4782 | 1188.8 | K3 | all entries satisfied |
| `P1-compact-L1H2S16-MC640-TP32` | 8+4 | 16/16 | MC640 | 8 | 32 | 353.8 | 291.8 | 3042 | 4430 | 1157.7 | K3 | all entries satisfied |
| `P1-compact-L1H4S20-MC640-TP32` | 8+4 | 24/20 | MC640 | 8 | 32 | 365.6 | 292.8 | 3051 | 4525 | 1157.7 | K3 | all entries satisfied |
| `P1-compact-L1H4S24-MC640-TP32` | 8+4 | 24/24 | MC640 | 8 | 32 | 369.6 | 293.2 | 3054 | 4557 | 1157.7 | K3 | all entries satisfied |
| `P1-compact-L1H4S32-MC640-TP32` | 8+4 | 24/32 | MC640 | 8 | 32 | 377.5 | 293.9 | 3059 | 4620 | 1157.7 | K3 | all entries satisfied |
| `P1-compact-L1H8S16-MC640-TP32` | 8+4 | 40/16 | MC640 | 8 | 32 | 377.5 | 293.9 | 3059 | 4620 | 1157.7 | K3 | all entries satisfied |
| `P1-compact-L2H4S16-MC640-TP32` | 8+4 | 32/16 | MC640 | 8 | 32 | 369.6 | 293.2 | 3054 | 4557 | 1157.7 | K3 | all entries satisfied |
| `P1-compact-L4H4S16-MC640-TP32` | 8+4 | 48/16 | MC640 | 8 | 32 | 385.4 | 294.6 | 3065 | 4684 | 1157.7 | K3 | all entries satisfied |
| `P1-compact-MC640-TP32` | 8+4 | 24/16 | MC640 | 8 | 32 | 361.7 | 292.5 | 3048 | 4493 | 1157.7 | K3 | all entries satisfied |
| `P1-compact-D6-MC640-TP32` | 8+4 | 24/16 | MC640 | 6 | 32 | 361.7 | 292.5 | 2306 | 3370 | 1053.2 | K3 | all entries satisfied |
| `P1-compact-MC640-TP16` | 8+4 | 24/16 | MC640 | 8 | 16 | 361.7 | 292.5 | 3048 | 4493 | 762.9 | K3 | all entries satisfied |
| `P1-compact-MC640-TP8` | 8+4 | 24/16 | MC640 | 8 | 8 | 361.7 | 292.5 | 3048 | 4493 | 381.5 | K3 | all entries satisfied |
| `P1-compact-N8x16-MC640-TP32` | 8+16 | 72/16 | MC640 | 8 | 32 | 844.3 **OVER** | 766.2 **OVER** | 6837 **OVER** | 8355 **OVER** | 1385.7 | K3 | misses B-AREA by 444.3 |
| `P1-compact-N8x12-MC640-TP32` | 8+12 | 56/16 | MC640 | 8 | 32 | 685.2 **OVER** | 608.6 **OVER** | 5577 **OVER** | 7081 **OVER** | 1356.0 | K3 | misses B-AREA by 285.2 |
| `P1-compact-N8x8-MC640-TP32` | 8+8 | 40/16 | MC640 | 8 | 32 | 520.9 **OVER** | 450.0 **OVER** | 4308 **OVER** | 5767 **OVER** | 1300.3 | K3 | misses B-AREA by 120.9 |
| `P1-compact-N16x4-MC640-TP32` | 16+4 | 32/16 | MC640 | 8 | 32 | 439.0 **OVER** | 339.0 **OVER** | 3420 **OVER** | 5112 | 1205.0 | K3 | misses B-AREA by 39.0 |
| `P1-compact-L1H4S12-MC640-TP32` | 8+4 | 24/12 | MC640 | 8 | 32 | 357.7 | 292.1 | 3045 | 4462 | 1157.7 | K3 | misses B-SRAM-CAP by 4.000 |
| `P1-compact-L1H4S8-MC640-TP32` | 8+4 | 24/8 | MC640 | 8 | 32 | 353.8 | 291.8 | 3042 | 4430 | 1157.7 | K3 | misses B-SRAM-CAP by 8.000 |
| `P1-compact-N4x4-MC640-TP32` | 4+4 | 20/16 | MC640 | 8 | 32 | 325.6 | 269.7 | 2866 | 4204 | 1073.5 | K3 | misses B-SERIAL-CMP by 0.099 |
| `P1-compact-D4-MC640-TP32` | 8+4 | 24/16 | MC640 | 4 | 32 | 361.7 | 292.5 | 1564 | 2247 | 762.9 | K3 | misses B-SERIAL-CMP by 0.161 |
| `P1-compact-L1H4S24-MC320-TP32` | 8+4 | 24/24 | MC320 | 8 | 32 | 369.6 | 293.2 | 2681 | 4557 | 423.8 | K3 | misses B-MEM-BW by 832.000 |
| `P1-compact-MC320-TP32` | 8+4 | 24/16 | MC320 | 8 | 32 | 361.7 | 292.5 | 2675 | 4493 | 423.8 | K3 | misses B-MEM-BW by 832.000 |
| `P1-compact-MC320-TP16` | 8+4 | 24/16 | MC320 | 8 | 16 | 361.7 | 292.5 | 2675 | 4493 | 211.9 | K3 | misses B-MEM-BW by 832.000 |
| `P1-compact-MC320-TP8` | 8+4 | 24/16 | MC320 | 8 | 8 | 361.7 | 292.5 | 2675 | 4493 | 106.0 | K3 | misses B-MEM-BW by 832.000 |
| `P1-compact-L1H4S8-MC320-TP32` | 8+4 | 24/8 | MC320 | 8 | 32 | 353.8 | 291.8 | 2669 | 4430 | 423.8 | K3 | misses B-MEM-BW by 832.000, B-SRAM-CAP by 8.000 |

- 12 of 25 shapes satisfy every L1 contract entry; 17 reach 1000 TPS/usr for every model. Best by contract: `P1-compact-N12x4-MC640-TP32`.
- A row that misses B-AREA is NOT dropped: the package area it would need is the number "差多少" is asking for, and a silently absent shape reads as an option nobody considered.
- The D-Gate above is computed over the published grid only. This table informs the L2 decision (out/direction/direction_selected.json) and refines the contract into out/budget/L2_budget.json; it does not select candidates.

