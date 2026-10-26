# Stage A blocker resolution run

Run ID: `stage-a-20261002-token-time`
Manifest hash: `a140afe4612d0bc8fc226c89d80f7ee4735da3784a75256d14f0da8b2e696083`
Source commit: `5dcb47f0e319f8be17e7321d1e3dd4b5d2407b16`

## Planning token time (integration/planning/token_time.js)

`memory lane = kMemory x (bytes + expertReread x routed bytes) / TP / BW`; `serial lane = kFlop x FLOP time + fixedPerLayerUs x layers + kTmaExposedUsPerGB x GB/rank + collectives x max(tau, bytes/network)`; `raw = max(memory lane, serial lane)`, `e2e = raw x 1.17`, `TPS/usr = 1e6 / e2e` (ADR-0008).

- Calibration on the K3 detailed timing breakdown (P1/MC640/TP32): expertReread 0.200, kMemory 1.2182, kFlop 1.6667, fixedPerLayerUs 0.3087, kTmaExposedUsPerGB 6.018; planning 1059.44 vs detailed 1043.96 TPS/usr (raw residual -11.96 us). The ADR-0006 single factor kCompute 1.9901 is kept for comparison only.
- Out-of-fit check at MC320: planning 505.75 vs detailed 585.94 TPS/usr (ratio 0.863).
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

- Planning sweep: 243 samples around K3/P1/MC640/TP32; 147 reach 1000 TPS/usr. This does not cover all D2-D6 physical axes.
- Blocked models: none. A BLOCKED_CONFIG model keeps the three-model comparison open, blocks the D-Gate and sends Stage B to EXPLORATORY_AFTER_BLOCKED_D_GATE (ADR-0006).
- Candidate register state: `D_GATE_PASSED` (derived from the validator, not written by this runner).

## Remaining qualification

- External model/license confirmation remains a qualification risk, not an implicit configuration.
- Event-level Q3-Q8 replay and fine TPS remain required before silicon sign-off.
- Planning TPS values are calibrated to the K3 detailed point but are not event-timed; they do not replace the detailed model.

## Planning TPS/usr per slot

| Candidate | Model | dtype | memory lane us | FLOP / fixed / TMA us | collective us | bound | TPS/usr | tau 1.15 / 1.5 / 2.0 | shape range |
|---|---|---|---:|---:|---:|---|---:|---|---|
| P1-compact-MC320-TP8 | K3 | dense BF16, router/LM head BF16, routed MXFP4 | 6759.8 | 1188.6 / 28.7 / 115.8 | 451.9 | memory | 126.44 | 126.4 / 126.4 / 126.4 | - |
| P1-compact-MC320-TP8 | GLM-5.2 | dense FP8, router/LM head BF16, routed FP8 | 2078.2 | 102.8 / 24.1 / 33.4 | 382.9 | memory | 411.26 | 411.3 / 411.3 / 411.3 | - |
| P1-compact-MC320-TP8 | DeepSeek-V4-Pro | dense FP8, router/LM head BF16, routed FP4 | 2008.2 | 286.1 / 18.8 / 33.3 | 350.8 | memory | 425.60 | 425.6 / 425.6 / 425.6 | 425.6 - 457.1 |
| P1-compact-MC320-TP16 | K3 | dense BF16, router/LM head BF16, routed MXFP4 | 3379.9 | 594.3 / 28.7 / 57.9 | 451.9 | memory | 252.88 | 252.9 / 252.9 / 252.9 | - |
| P1-compact-MC320-TP16 | GLM-5.2 | dense FP8, router/LM head BF16, routed FP8 | 1039.1 | 51.4 / 24.1 / 16.7 | 382.9 | memory | 822.53 | 822.5 / 822.5 / 822.5 | - |
| P1-compact-MC320-TP16 | DeepSeek-V4-Pro | dense FP8, router/LM head BF16, routed FP4 | 1004.1 | 143.1 / 18.8 / 16.6 | 350.8 | memory | 851.19 | 851.2 / 851.2 / 851.2 | 851.2 - 914.2 |
| P1-compact-MC320-TP32 | K3 | dense BF16, router/LM head BF16, routed MXFP4 | 1690.0 | 297.1 / 28.7 / 29.0 | 451.9 | memory | 505.75 | 505.8 / 505.8 / 505.8 | - |
| P1-compact-MC320-TP32 | GLM-5.2 | dense FP8, router/LM head BF16, routed FP8 | 519.6 | 25.7 / 24.1 / 8.3 | 382.9 | memory | 1645.06 | 1645.1 / 1532.7 / 1180.3 | - |
| P1-compact-MC320-TP32 | DeepSeek-V4-Pro | dense FP8, router/LM head BF16, routed FP4 | 502.1 | 71.5 / 18.8 / 8.3 | 350.8 | memory | 1702.39 | 1702.4 / 1536.7 / 1206.1 | 1702.4 - 1828.3 |
| P1-compact-MC640-TP8 | K3 | dense BF16, router/LM head BF16, routed MXFP4 | 1877.7 | 1188.6 / 28.7 / 115.8 | 451.9 | memory | 455.18 | 455.2 / 444.6 / 403.3 | - |
| P1-compact-MC640-TP8 | GLM-5.2 | dense FP8, router/LM head BF16, routed FP8 | 577.3 | 102.8 / 24.1 / 33.4 | 382.9 | memory | 1480.55 | 1480.6 / 1295.4 / 1034.4 | - |
| P1-compact-MC640-TP8 | DeepSeek-V4-Pro | dense FP8, router/LM head BF16, routed FP4 | 557.8 | 286.1 / 18.8 / 33.3 | 350.8 | collective | 1240.57 | 1240.6 / 1074.1 / 901.4 | 1240.6 - 1257.9 |
| P1-compact-MC640-TP16 | K3 | dense BF16, router/LM head BF16, routed MXFP4 | 938.9 | 594.3 / 28.7 / 57.9 | 451.9 | compute | 754.47 | 754.5 / 672.8 / 582.7 | - |
| P1-compact-MC640-TP16 | GLM-5.2 | dense FP8, router/LM head BF16, routed FP8 | 288.6 | 51.4 / 24.1 / 16.7 | 382.9 | collective | 1798.88 | 1798.9 / 1444.5 / 1127.3 | - |
| P1-compact-MC640-TP16 | DeepSeek-V4-Pro | dense FP8, router/LM head BF16, routed FP4 | 278.9 | 143.1 / 18.8 / 16.6 | 350.8 | collective | 1614.87 | 1614.9 / 1343.8 / 1083.9 | 1614.9 - 1629.5 |
| P1-compact-MC640-TP32 | K3 | dense BF16, router/LM head BF16, routed MXFP4 | 469.4 | 297.1 / 28.7 / 29.0 | 451.9 | collective | 1059.44 | 1059.4 / 905.1 / 749.2 | - |
| P1-compact-MC640-TP32 | GLM-5.2 | dense FP8, router/LM head BF16, routed FP8 | 144.3 | 25.7 / 24.1 / 8.3 | 382.9 | collective | 1937.75 | 1937.8 / 1532.7 / 1180.3 | - |
| P1-compact-MC640-TP32 | DeepSeek-V4-Pro | dense FP8, router/LM head BF16, routed FP4 | 139.5 | 71.5 / 18.8 / 8.3 | 350.8 | collective | 1901.77 | 1901.8 / 1536.7 / 1206.1 | 1901.8 - 1911.9 |

- tau columns: the point estimate uses tau 1.15 us and alone decides selection; 1.5 and 2.0 us are risk columns until B-008 derives tau physically.
- shape range: DeepSeek-V4-Pro expert hidden solved from 49B active (point) and from 1.6T total (variant `expertHiddenFromTotal`).

## Comparison rows (not ranked, not selectable)

| Comparison | Candidate | TPS/usr | bound | base model TPS/usr |
|---|---|---:|---|---:|
| K3-FP8-dense | P1-compact-MC320-TP8 | 191.07 | memory | 126.44 |
| K3-FP8-dense | P1-compact-MC320-TP16 | 382.13 | memory | 252.88 |
| K3-FP8-dense | P1-compact-MC320-TP32 | 764.27 | memory | 505.75 |
| K3-FP8-dense | P1-compact-MC640-TP8 | 489.93 | compute | 455.18 |
| K3-FP8-dense | P1-compact-MC640-TP16 | 768.20 | compute | 754.47 |
| K3-FP8-dense | P1-compact-MC640-TP32 | 1072.89 | collective | 1059.44 |

## Candidate ranking (worst comparable-model planning TPS)

Policy: rank by worst comparable-model planning TPS; formally eligible only if every comparable model reaches the 1000 TPS/usr target (not the 1050 architecture gate) at the tau point estimate 1.15 us; at most three eligible candidates; the tau range is a risk annotation, not a selection criterion: each candidate records the largest tau at which every model still reaches the target and is tau-conditional below 2 us; the best MC320 candidate is a non-formal reference.

| Candidate | worst model | min TPS | min TPS at tau 2 | max tau for target (us) | planning TPS >= 1050 (not the gate: see baselineStatus) | formally eligible |
|---|---|---:|---:|---:|---|---|
| P1-compact-MC640-TP32 | K3 | 1059.44 | 749.21 | 1.272 | yes | yes (tau-conditional) |
| P1-compact-MC640-TP16 | K3 | 754.47 | 582.66 | misses at any tau | no | no |
| P1-compact-MC320-TP32 | K3 | 505.75 | 505.75 | misses at any tau | no | no |
| P1-compact-MC640-TP8 | K3 | 455.18 | 403.34 | misses at any tau | no | no |
| P1-compact-MC320-TP16 | K3 | 252.88 | 252.88 | misses at any tau | no | no |
| P1-compact-MC320-TP8 | K3 | 126.44 | 126.44 | misses at any tau | no | no |

## Selected candidates

- `P1-compact-MC640-TP32`: worst K3 1059.44 TPS/usr; tau-conditional, reaches the target only while tau <= 1.272 us
- Reference (not formal): `P1-compact-MC320-TP32`, worst K3 505.75 TPS/usr; misses: K3 505.8 (51%).

## L2 morphology space (25 shapes, scored against S-CMP)

Axes: L/H ratio 8+4 / 4+4 / 12+4 / 16+4 / 8+8 / 8+12 / 8+16; local SRAM 1/4 MiB / 2/4 MiB / 4/4 MiB / 1/2 MiB / 1/8 MiB per L/H core; shared 8 / 12 / 16 / 20 / 24 / 32 MiB per die; MC MC320 / MC640; dies 4 / 6 / 8; TP 8 / 16 / 32. Everything else is the published point out/rdma/k3_rdma_final_tuning_results.json#/search/best/x.

Area and power from `A.physical(x, dies)` rescaled by `k3_physical_basis.resize`; TPS/usr from token time with the shape's peaks and MC bandwidth carried on the slot. Both are the SAME authorities the published grid uses, so a row here is comparable with a row above.

| Morphology | L/H | local/shared MiB per die | MC | dies | TP | die mm2 (max 400) | die W (max 300) | card W (max 3200) | package mm2 (max 5248) | worst min TPS | worst model | contract |
|---|---|---|---|---:|---:|---:|---:|---:|---:|---:|---|---|
| `P1-compact-L1H2S16-MC640-TP32` | 8+4 | 16/16 | MC640 | 8 | 32 | 364.6 | 294.4 | 3063 | 4517 | 1059.4 | K3 | all entries satisfied |
| `P1-compact-L1H4S20-MC640-TP32` | 8+4 | 24/20 | MC640 | 8 | 32 | 376.5 | 295.4 | 3072 | 4612 | 1059.4 | K3 | all entries satisfied |
| `P1-compact-L1H4S24-MC640-TP32` | 8+4 | 24/24 | MC640 | 8 | 32 | 380.5 | 295.8 | 3075 | 4644 | 1059.4 | K3 | all entries satisfied |
| `P1-compact-L1H4S32-MC640-TP32` | 8+4 | 24/32 | MC640 | 8 | 32 | 388.4 | 296.5 | 3080 | 4707 | 1059.4 | K3 | all entries satisfied |
| `P1-compact-L1H8S16-MC640-TP32` | 8+4 | 40/16 | MC640 | 8 | 32 | 388.4 | 296.5 | 3080 | 4707 | 1059.4 | K3 | all entries satisfied |
| `P1-compact-L2H4S16-MC640-TP32` | 8+4 | 32/16 | MC640 | 8 | 32 | 380.5 | 295.8 | 3075 | 4644 | 1059.4 | K3 | all entries satisfied |
| `P1-compact-L4H4S16-MC640-TP32` | 8+4 | 48/16 | MC640 | 8 | 32 | 396.3 | 297.2 | 3086 | 4770 | 1059.4 | K3 | all entries satisfied |
| `P1-compact-MC640-TP32` | 8+4 | 24/16 | MC640 | 8 | 32 | 372.5 | 295.1 | 3069 | 4580 | 1059.4 | K3 | all entries satisfied |
| `P1-compact-MC640-TP16` | 8+4 | 24/16 | MC640 | 8 | 16 | 372.5 | 295.1 | 3069 | 4580 | 754.5 | K3 | all entries satisfied |
| `P1-compact-MC640-TP8` | 8+4 | 24/16 | MC640 | 8 | 8 | 372.5 | 295.1 | 3069 | 4580 | 455.2 | K3 | all entries satisfied |
| `P1-compact-N8x16-MC640-TP32` | 8+16 | 72/16 | MC640 | 8 | 32 | 811.3 **OVER** | 712.4 **OVER** | 6408 **OVER** | 8090 **OVER** | 1390.9 | K3 | misses B-AREA by 411.3 |
| `P1-compact-N8x12-MC640-TP32` | 8+12 | 56/16 | MC640 | 8 | 32 | 668.4 **OVER** | 574.0 **OVER** | 5300 **OVER** | 6947 **OVER** | 1344.2 | K3 | misses B-AREA by 268.4 |
| `P1-compact-N8x8-MC640-TP32` | 8+8 | 40/16 | MC640 | 8 | 32 | 515.4 **OVER** | 433.5 **OVER** | 4176 **OVER** | 5723 **OVER** | 1259.5 | K3 | misses B-AREA by 115.4 |
| `P1-compact-N16x4-MC640-TP32` | 16+4 | 32/16 | MC640 | 8 | 32 | 468.1 **OVER** | 358.4 **OVER** | 3575 **OVER** | 5345 **OVER** | 1087.1 | K3 | misses B-AREA by 68.1 |
| `P1-compact-N12x4-MC640-TP32` | 12+4 | 28/16 | MC640 | 8 | 32 | 415.2 **OVER** | 325.7 **OVER** | 3314 **OVER** | 4922 | 1077.7 | K3 | misses B-AREA by 15.2 |
| `P1-compact-L1H4S12-MC640-TP32` | 8+4 | 24/12 | MC640 | 8 | 32 | 368.6 | 294.7 | 3066 | 4549 | 1059.4 | K3 | misses B-SRAM-CAP by 2.000 |
| `P1-compact-L1H4S8-MC640-TP32` | 8+4 | 24/8 | MC640 | 8 | 32 | 364.6 | 294.4 | 3063 | 4517 | 1059.4 | K3 | misses B-SRAM-CAP by 6.000 |
| `P1-compact-N4x4-MC640-TP32` | 4+4 | 20/16 | MC640 | 8 | 32 | 329.9 | 264.4 | 2824 | 4239 | 1008.4 | K3 | misses B-SERIAL-CMP by 0.262 |
| `P1-compact-L1H4S24-MC320-TP32` | 8+4 | 24/24 | MC320 | 8 | 32 | 380.5 | 295.8 | 2702 | 4644 | 505.8 | K3 | misses B-MEM-BW by 832.000 |
| `P1-compact-MC320-TP32` | 8+4 | 24/16 | MC320 | 8 | 32 | 372.5 | 295.1 | 2696 | 4580 | 505.8 | K3 | misses B-MEM-BW by 832.000 |
| `P1-compact-MC320-TP16` | 8+4 | 24/16 | MC320 | 8 | 16 | 372.5 | 295.1 | 2696 | 4580 | 252.9 | K3 | misses B-MEM-BW by 832.000 |
| `P1-compact-MC320-TP8` | 8+4 | 24/16 | MC320 | 8 | 8 | 372.5 | 295.1 | 2696 | 4580 | 126.4 | K3 | misses B-MEM-BW by 832.000 |
| `P1-compact-L1H4S8-MC320-TP32` | 8+4 | 24/8 | MC320 | 8 | 32 | 364.6 | 294.4 | 2690 | 4517 | 505.8 | K3 | misses B-MEM-BW by 832.000, B-SRAM-CAP by 6.000 |

- 10 of 25 shapes satisfy every L1 contract entry; 16 reach 1000 TPS/usr for every model. Best by contract: `P1-compact-L1H2S16-MC640-TP32`.
- A row that misses B-AREA is NOT dropped: the package area it would need is the number "差多少" is asking for, and a silently absent shape reads as an option nobody considered.
- The D-Gate above is computed over the published grid only. This table informs the L2 decision (out/direction/direction_selected.json) and refines the contract into out/budget/L2_budget.json; it does not select candidates.

