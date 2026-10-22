# Stage A blocker resolution run

Run ID: `stage-a-20261002-token-time`
Manifest hash: `a140afe4612d0bc8fc226c89d80f7ee4735da3784a75256d14f0da8b2e696083`
Source commit: `4fa22b29ed3469e44b1c594a17c355e5a2ef52c0`

## Planning token time (integration/planning/token_time.js)

`memory lane = kMemory x (bytes + expertReread x routed bytes) / TP / BW`; `serial lane = kFlop x FLOP time + fixedPerLayerUs x layers + kTmaExposedUsPerGB x GB/rank + collectives x max(tau, bytes/network)`; `raw = max(memory lane, serial lane)`, `e2e = raw x 1.17`, `TPS/usr = 1e6 / e2e` (ADR-0008).

- Calibration on the K3 detailed timing breakdown (P1/MC640/TP32): expertReread 0.200, kMemory 1.2316, kFlop 1.2972, fixedPerLayerUs 0.2962, kTmaExposedUsPerGB 5.691; planning 1142.61 vs detailed 1124.70 TPS/usr (raw residual -11.92 us). The ADR-0006 single factor kCompute 1.5927 is kept for comparison only.
- Out-of-fit check at MC320: planning 500.28 vs detailed 585.93 TPS/usr (ratio 0.854).
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

- Planning sweep: 243 samples around K3/P1/MC640/TP32; 198 reach 1000 TPS/usr. This does not cover all D2-D6 physical axes.
- Blocked models: none. A BLOCKED_CONFIG model keeps the three-model comparison open, blocks the D-Gate and sends Stage B to EXPLORATORY_AFTER_BLOCKED_D_GATE (ADR-0006).
- Candidate register state: `D_GATE_PASSED` (derived from the validator, not written by this runner).

## Remaining qualification

- External model/license confirmation remains a qualification risk, not an implicit configuration.
- Event-level Q3-Q8 replay and fine TPS remain required before silicon sign-off.
- Planning TPS values are calibrated to the K3 detailed point but are not event-timed; they do not replace the detailed model.

## Planning TPS/usr per slot

| Candidate | Model | dtype | memory lane us | FLOP / fixed / TMA us | collective us | bound | TPS/usr | tau 1.15 / 1.5 / 2.0 | shape range |
|---|---|---|---:|---:|---:|---|---:|---|---|
| P1-compact-MC320-TP8 | K3 | dense BF16, router/LM head BF16, routed MXFP4 | 6833.8 | 964.6 / 27.5 / 109.5 | 451.9 | memory | 125.07 | 125.1 / 125.1 / 125.1 | - |
| P1-compact-MC320-TP8 | GLM-5.2 | dense FP8, router/LM head BF16, routed FP8 | 2101.0 | 125.7 / 23.1 / 31.6 | 382.9 | memory | 406.81 | 406.8 / 406.8 / 406.8 | - |
| P1-compact-MC320-TP8 | DeepSeek-V4-Pro | dense FP8, router/LM head BF16, routed FP4 | 2030.2 | 263.0 / 18.1 / 31.4 | 350.8 | memory | 420.99 | 421.0 / 421.0 / 421.0 | 421.0 - 452.1 |
| P1-compact-MC320-TP16 | K3 | dense BF16, router/LM head BF16, routed MXFP4 | 3416.9 | 482.3 / 27.5 / 54.7 | 451.9 | memory | 250.14 | 250.1 / 250.1 / 250.1 | - |
| P1-compact-MC320-TP16 | GLM-5.2 | dense FP8, router/LM head BF16, routed FP8 | 1050.5 | 62.8 / 23.1 / 15.8 | 382.9 | memory | 813.62 | 813.6 / 813.6 / 813.6 | - |
| P1-compact-MC320-TP16 | DeepSeek-V4-Pro | dense FP8, router/LM head BF16, routed FP4 | 1015.1 | 131.5 / 18.1 / 15.7 | 350.8 | memory | 841.98 | 842.0 / 842.0 / 842.0 | 842.0 - 904.3 |
| P1-compact-MC320-TP32 | K3 | dense BF16, router/LM head BF16, routed MXFP4 | 1708.4 | 241.2 / 27.5 / 27.4 | 451.9 | memory | 500.28 | 500.3 / 500.3 / 500.3 | - |
| P1-compact-MC320-TP32 | GLM-5.2 | dense FP8, router/LM head BF16, routed FP8 | 525.2 | 31.4 / 23.1 / 7.9 | 382.9 | memory | 1627.25 | 1627.2 / 1521.0 / 1173.4 | - |
| P1-compact-MC320-TP32 | DeepSeek-V4-Pro | dense FP8, router/LM head BF16, routed FP4 | 507.6 | 65.7 / 18.1 / 7.9 | 350.8 | memory | 1683.96 | 1684.0 / 1556.3 / 1218.1 | 1684.0 - 1808.5 |
| P1-compact-MC640-TP8 | K3 | dense BF16, router/LM head BF16, routed MXFP4 | 1898.3 | 964.6 / 27.5 / 109.5 | 451.9 | memory | 450.25 | 450.3 / 450.3 / 450.3 | - |
| P1-compact-MC640-TP8 | GLM-5.2 | dense FP8, router/LM head BF16, routed FP8 | 583.6 | 125.7 / 23.1 / 31.6 | 382.9 | memory | 1464.52 | 1464.5 / 1257.2 / 1009.9 | - |
| P1-compact-MC640-TP8 | DeepSeek-V4-Pro | dense FP8, router/LM head BF16, routed FP4 | 563.9 | 263.0 / 18.1 / 31.4 | 350.8 | collective | 1288.65 | 1288.6 / 1110.0 / 926.5 | 1288.6 - 1315.4 |
| P1-compact-MC640-TP16 | K3 | dense BF16, router/LM head BF16, routed MXFP4 | 949.1 | 482.3 / 27.5 / 54.7 | 451.9 | compute | 840.79 | 840.8 / 740.6 / 632.8 | - |
| P1-compact-MC640-TP16 | GLM-5.2 | dense FP8, router/LM head BF16, routed FP8 | 291.8 | 62.8 / 23.1 / 15.8 | 382.9 | collective | 1763.44 | 1763.4 / 1421.6 / 1113.3 | - |
| P1-compact-MC640-TP16 | DeepSeek-V4-Pro | dense FP8, router/LM head BF16, routed FP4 | 282.0 | 131.5 / 18.1 / 15.7 | 350.8 | collective | 1656.28 | 1656.3 / 1372.4 / 1102.4 | 1656.3 - 1678.2 |
| P1-compact-MC640-TP32 | K3 | dense BF16, router/LM head BF16, routed MXFP4 | 474.6 | 241.2 / 27.5 / 27.4 | 451.9 | collective | 1142.61 | 1142.6 / 965.1 / 789.9 | - |
| P1-compact-MC640-TP32 | GLM-5.2 | dense FP8, router/LM head BF16, routed FP8 | 145.9 | 31.4 / 23.1 / 7.9 | 382.9 | collective | 1919.10 | 1919.1 / 1521.0 / 1173.4 | - |
| P1-compact-MC640-TP32 | DeepSeek-V4-Pro | dense FP8, router/LM head BF16, routed FP4 | 141.0 | 65.7 / 18.1 / 7.9 | 350.8 | collective | 1931.84 | 1931.8 / 1556.3 / 1218.1 | 1931.8 - 1946.7 |

- tau columns: the point estimate uses tau 1.15 us and alone decides selection; 1.5 and 2.0 us are risk columns until B-008 derives tau physically.
- shape range: DeepSeek-V4-Pro expert hidden solved from 49B active (point) and from 1.6T total (variant `expertHiddenFromTotal`).

## Comparison rows (not ranked, not selectable)

| Comparison | Candidate | TPS/usr | bound | base model TPS/usr |
|---|---|---:|---|---:|
| K3-FP8-dense | P1-compact-MC320-TP8 | 189.00 | memory | 125.07 |
| K3-FP8-dense | P1-compact-MC320-TP16 | 378.00 | memory | 250.14 |
| K3-FP8-dense | P1-compact-MC320-TP32 | 755.99 | memory | 500.28 |
| K3-FP8-dense | P1-compact-MC640-TP8 | 564.04 | compute | 450.25 |
| K3-FP8-dense | P1-compact-MC640-TP16 | 856.92 | compute | 840.79 |
| K3-FP8-dense | P1-compact-MC640-TP32 | 1157.42 | collective | 1142.61 |

## Candidate ranking (worst comparable-model planning TPS)

Policy: rank by worst comparable-model planning TPS; formally eligible only if every comparable model reaches the 1000 TPS/usr target (not the 1050 architecture gate) at the tau point estimate 1.15 us; at most three eligible candidates; the tau range is a risk annotation, not a selection criterion: each candidate records the largest tau at which every model still reaches the target and is tau-conditional below 2 us; the best MC320 candidate is a non-formal reference.

| Candidate | worst model | min TPS | min TPS at tau 2 | max tau for target (us) | planning TPS >= 1050 (not the gate: see baselineStatus) | formally eligible |
|---|---|---:|---:|---:|---|---|
| P1-compact-MC640-TP32 | K3 | 1142.61 | 789.87 | 1.421 | yes | yes (tau-conditional) |
| P1-compact-MC640-TP16 | K3 | 840.79 | 632.83 | misses at any tau | no | no |
| P1-compact-MC320-TP32 | K3 | 500.28 | 500.28 | misses at any tau | no | no |
| P1-compact-MC640-TP8 | K3 | 450.25 | 450.25 | misses at any tau | no | no |
| P1-compact-MC320-TP16 | K3 | 250.14 | 250.14 | misses at any tau | no | no |
| P1-compact-MC320-TP8 | K3 | 125.07 | 125.07 | misses at any tau | no | no |

## Selected candidates

- `P1-compact-MC640-TP32`: worst K3 1142.61 TPS/usr; tau-conditional, reaches the target only while tau <= 1.421 us
- Reference (not formal): `P1-compact-MC320-TP32`, worst K3 500.28 TPS/usr; misses: K3 500.3 (50%).

## L2 morphology space (25 shapes, scored against S-CMP)

Axes: L/H ratio 8+4 / 4+4 / 12+4 / 16+4 / 8+8 / 8+12 / 8+16; local SRAM 1/4 MiB / 2/4 MiB / 4/4 MiB / 1/2 MiB / 1/8 MiB per L/H core; shared 8 / 12 / 16 / 20 / 24 / 32 MiB per die; MC MC320 / MC640; dies 4 / 6 / 8; TP 8 / 16 / 32. Everything else is the published point out/rdma/k3_rdma_final_tuning_results.json#/search/best/x.

Area and power from `A.physical(x, dies)` rescaled by `k3_physical_basis.resize`; TPS/usr from token time with the shape's peaks and MC bandwidth carried on the slot. Both are the SAME authorities the published grid uses, so a row here is comparable with a row above.

| Morphology | L/H | local/shared MiB per die | MC | dies | TP | die mm2 (max 400) | die W (max 300) | card W (max 3200) | package mm2 (max 5248) | worst min TPS | worst model | contract |
|---|---|---|---|---:|---:|---:|---:|---:|---:|---:|---|---|
| `P1-compact-N12x4-MC640-TP32` | 12+4 | 28/16 | MC640 | 8 | 32 | 396.2 | 310.6 **OVER** | 3193 | 4770 | 1176.1 | K3 | all entries satisfied |
| `P1-compact-L1H2S16-MC640-TP32` | 8+4 | 16/16 | MC640 | 8 | 32 | 356.1 | 289.8 | 3026 | 4449 | 1142.6 | K3 | all entries satisfied |
| `P1-compact-L1H4S12-MC640-TP32` | 8+4 | 24/12 | MC640 | 8 | 32 | 360.1 | 290.1 | 3029 | 4481 | 1142.6 | K3 | all entries satisfied |
| `P1-compact-L1H4S20-MC640-TP32` | 8+4 | 24/20 | MC640 | 8 | 32 | 368.0 | 290.8 | 3035 | 4544 | 1142.6 | K3 | all entries satisfied |
| `P1-compact-L1H4S24-MC640-TP32` | 8+4 | 24/24 | MC640 | 8 | 32 | 372.0 | 291.2 | 3038 | 4576 | 1142.6 | K3 | all entries satisfied |
| `P1-compact-L1H4S32-MC640-TP32` | 8+4 | 24/32 | MC640 | 8 | 32 | 379.9 | 291.9 | 3043 | 4639 | 1142.6 | K3 | all entries satisfied |
| `P1-compact-L1H8S16-MC640-TP32` | 8+4 | 40/16 | MC640 | 8 | 32 | 379.9 | 291.9 | 3043 | 4639 | 1142.6 | K3 | all entries satisfied |
| `P1-compact-L2H4S16-MC640-TP32` | 8+4 | 32/16 | MC640 | 8 | 32 | 372.0 | 291.2 | 3038 | 4576 | 1142.6 | K3 | all entries satisfied |
| `P1-compact-L4H4S16-MC640-TP32` | 8+4 | 48/16 | MC640 | 8 | 32 | 387.8 | 292.6 | 3049 | 4702 | 1142.6 | K3 | all entries satisfied |
| `P1-compact-MC640-TP32` | 8+4 | 24/16 | MC640 | 8 | 32 | 364.0 | 290.5 | 3032 | 4512 | 1142.6 | K3 | all entries satisfied |
| `P1-compact-D6-MC640-TP32` | 8+4 | 24/16 | MC640 | 6 | 32 | 364.0 | 290.5 | 2294 | 3384 | 1031.7 | K3 | all entries satisfied |
| `P1-compact-MC640-TP16` | 8+4 | 24/16 | MC640 | 8 | 16 | 364.0 | 290.5 | 3032 | 4512 | 840.8 | K3 | all entries satisfied |
| `P1-compact-MC640-TP8` | 8+4 | 24/16 | MC640 | 8 | 8 | 364.0 | 290.5 | 3032 | 4512 | 450.3 | K3 | all entries satisfied |
| `P1-compact-N8x16-MC640-TP32` | 8+16 | 72/16 | MC640 | 8 | 32 | 840.0 **OVER** | 757.2 **OVER** | 6765 **OVER** | 8320 **OVER** | 1390.3 | K3 | misses B-AREA by 440.0 |
| `P1-compact-N8x12-MC640-TP32` | 8+12 | 56/16 | MC640 | 8 | 32 | 684.8 **OVER** | 602.3 **OVER** | 5526 **OVER** | 7078 **OVER** | 1357.5 | K3 | misses B-AREA by 284.8 |
| `P1-compact-N8x8-MC640-TP32` | 8+8 | 40/16 | MC640 | 8 | 32 | 519.3 **OVER** | 445.4 **OVER** | 4271 **OVER** | 5754 **OVER** | 1296.5 | K3 | misses B-AREA by 119.3 |
| `P1-compact-N16x4-MC640-TP32` | 16+4 | 32/16 | MC640 | 8 | 32 | 438.6 **OVER** | 332.7 **OVER** | 3370 **OVER** | 5109 | 1193.6 | K3 | misses B-AREA by 38.6 |
| `P1-compact-L1H4S8-MC640-TP32` | 8+4 | 24/8 | MC640 | 8 | 32 | 356.1 | 289.8 | 3026 | 4449 | 1142.6 | K3 | misses B-SRAM-CAP by 4.000 |
| `P1-compact-N4x4-MC640-TP32` | 4+4 | 20/16 | MC640 | 8 | 32 | 331.8 | 270.4 | 2871 | 4255 | 1053.1 | K3 | misses B-SERIAL-CMP by 0.143 |
| `P1-compact-D4-MC640-TP32` | 8+4 | 24/16 | MC640 | 4 | 32 | 364.0 | 290.5 | 1556 | 2256 | 864.1 | K3 | misses B-SERIAL-CMP by 0.205 |
| `P1-compact-L1H4S24-MC320-TP32` | 8+4 | 24/24 | MC320 | 8 | 32 | 372.0 | 291.2 | 2665 | 4576 | 500.3 | K3 | misses B-MEM-BW by 832.000 |
| `P1-compact-MC320-TP32` | 8+4 | 24/16 | MC320 | 8 | 32 | 364.0 | 290.5 | 2659 | 4512 | 500.3 | K3 | misses B-MEM-BW by 832.000 |
| `P1-compact-MC320-TP16` | 8+4 | 24/16 | MC320 | 8 | 16 | 364.0 | 290.5 | 2659 | 4512 | 250.1 | K3 | misses B-MEM-BW by 832.000 |
| `P1-compact-MC320-TP8` | 8+4 | 24/16 | MC320 | 8 | 8 | 364.0 | 290.5 | 2659 | 4512 | 125.1 | K3 | misses B-MEM-BW by 832.000 |
| `P1-compact-L1H4S8-MC320-TP32` | 8+4 | 24/8 | MC320 | 8 | 32 | 356.1 | 289.8 | 2653 | 4449 | 500.3 | K3 | misses B-MEM-BW by 832.000, B-SRAM-CAP by 4.000 |

- 13 of 25 shapes satisfy every L1 contract entry; 17 reach 1000 TPS/usr for every model. Best by contract: `P1-compact-N12x4-MC640-TP32`.
- A row that misses B-AREA is NOT dropped: the package area it would need is the number "差多少" is asking for, and a silently absent shape reads as an option nobody considered.
- The D-Gate above is computed over the published grid only. This table informs the L2 decision (out/direction/direction_selected.json) and refines the contract into out/budget/L2_budget.json; it does not select candidates.

