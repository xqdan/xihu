# Stage A blocker resolution run

Run ID: `stage-a-20261002-token-time`
Manifest hash: `d888e569c08aa6bfa421e630cb08b9b972cb767980a4b585b8e7cd2e24dea9a0`
Source commit: `f9e05202394a7038cd52f692d45aaba4b62bb300`

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
  "expectedRegisterState": "D_GATE_PASSED",
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
| P1-compact-MC320-TP8 | GLM-5.2 | dense FP8, router/LM head BF16, routed FP8 | 1906.7 | 116.4 / 23.3 / 32.1 | 382.9 | memory | 448.26 | 448.3 / 448.3 / 448.3 | - |
| P1-compact-MC320-TP8 | DeepSeek-V4-Pro | dense FP8, router/LM head BF16, routed FP4 | 1842.6 | 259.7 / 18.2 / 32.0 | 350.8 | memory | 463.85 | 463.8 / 463.8 / 463.8 | 463.8 - 498.2 |
| P1-compact-MC320-TP16 | K3 | dense BF16, router/LM head BF16, routed MXFP4 | 3101.2 | 491.6 / 27.8 / 55.7 | 451.9 | memory | 275.60 | 275.6 / 275.6 / 275.6 | - |
| P1-compact-MC320-TP16 | GLM-5.2 | dense FP8, router/LM head BF16, routed FP8 | 953.3 | 58.2 / 23.3 / 16.1 | 382.9 | memory | 896.53 | 896.5 / 896.5 / 896.5 | - |
| P1-compact-MC320-TP16 | DeepSeek-V4-Pro | dense FP8, router/LM head BF16, routed FP4 | 921.3 | 129.8 / 18.2 / 16.0 | 350.8 | memory | 927.69 | 927.7 / 927.7 / 927.7 | 927.7 - 996.3 |
| P1-compact-MC320-TP32 | K3 | dense BF16, router/LM head BF16, routed MXFP4 | 1550.6 | 245.8 / 27.8 / 27.9 | 451.9 | memory | 551.21 | 551.2 / 551.2 / 551.2 | - |
| P1-compact-MC320-TP32 | GLM-5.2 | dense FP8, router/LM head BF16, routed FP8 | 476.7 | 29.1 / 23.3 / 8.0 | 382.9 | memory | 1793.05 | 1793.1 / 1526.5 / 1176.6 | - |
| P1-compact-MC320-TP32 | DeepSeek-V4-Pro | dense FP8, router/LM head BF16, routed FP4 | 460.7 | 64.9 / 18.2 / 8.0 | 350.8 | memory | 1855.38 | 1855.4 / 1557.9 / 1219.0 | 1855.4 - 1947.7 |
| P1-compact-MC640-TP8 | K3 | dense BF16, router/LM head BF16, routed MXFP4 | 3101.2 | 983.2 / 27.8 / 111.5 | 451.9 | memory | 275.60 | 275.6 / 275.6 / 275.6 | - |
| P1-compact-MC640-TP8 | GLM-5.2 | dense FP8, router/LM head BF16, routed FP8 | 953.3 | 116.4 / 23.3 / 32.1 | 382.9 | memory | 896.53 | 896.5 / 896.5 / 896.5 | - |
| P1-compact-MC640-TP8 | DeepSeek-V4-Pro | dense FP8, router/LM head BF16, routed FP4 | 921.3 | 259.7 / 18.2 / 32.0 | 350.8 | memory | 927.69 | 927.7 / 927.7 / 927.7 | 927.7 - 996.3 |
| P1-compact-MC640-TP16 | K3 | dense BF16, router/LM head BF16, routed MXFP4 | 1550.6 | 491.6 / 27.8 / 55.7 | 451.9 | memory | 551.21 | 551.2 / 551.2 / 551.2 | - |
| P1-compact-MC640-TP16 | GLM-5.2 | dense FP8, router/LM head BF16, routed FP8 | 476.7 | 58.2 / 23.3 / 16.1 | 382.9 | collective | 1778.76 | 1778.8 / 1431.5 / 1119.4 | - |
| P1-compact-MC640-TP16 | DeepSeek-V4-Pro | dense FP8, router/LM head BF16, routed FP4 | 460.7 | 129.8 / 18.2 / 16.0 | 350.8 | collective | 1660.23 | 1660.2 / 1375.1 / 1104.2 | 1660.2 - 1680.2 |
| P1-compact-MC640-TP32 | K3 | dense BF16, router/LM head BF16, routed MXFP4 | 775.3 | 245.8 / 27.8 / 27.9 | 451.9 | memory | 1102.41 | 1102.4 / 959.3 / 786.0 | - |
| P1-compact-MC640-TP32 | GLM-5.2 | dense FP8, router/LM head BF16, routed FP8 | 238.3 | 29.1 / 23.3 / 8.0 | 382.9 | collective | 1927.72 | 1927.7 / 1526.5 / 1176.6 | - |
| P1-compact-MC640-TP32 | DeepSeek-V4-Pro | dense FP8, router/LM head BF16, routed FP4 | 230.3 | 64.9 / 18.2 / 8.0 | 350.8 | collective | 1934.20 | 1934.2 / 1557.9 / 1219.0 | 1934.2 - 1947.7 |

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

| Candidate | worst model | min TPS | min TPS at tau 2 | max tau for target (us) | planning TPS >= 1050 (not the gate: see baselineStatus) | formally eligible |
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

## L2 morphology space (25 shapes, scored against S-CMP)

Axes: L/H ratio 8+4 / 4+4 / 12+4 / 16+4 / 8+8 / 8+12 / 8+16; local SRAM 1/4 MiB / 2/4 MiB / 4/4 MiB / 1/2 MiB / 1/8 MiB per L/H core; shared 8 / 12 / 16 / 20 / 24 / 32 MiB per die; MC MC320 / MC640; dies 4 / 6 / 8; TP 8 / 16 / 32. Everything else is the published point out/rdma/k3_rdma_final_tuning_results.json#/search/best/x.

Area and power from `A.physical(x, dies)` rescaled by `k3_physical_basis.resize`; TPS/usr from token time with the shape's peaks and MC bandwidth carried on the slot. Both are the SAME authorities the published grid uses, so a row here is comparable with a row above.

| Morphology | L/H | local/shared MiB per die | MC | dies | TP | die mm2 (max 400) | die W (max 300) | card W (max 2800) | package mm2 (max 5248) | worst min TPS | worst model | contract |
|---|---|---|---|---:|---:|---:|---:|---:|---:|---:|---|---|
| `P1-compact-L1H2S16-MC640-TP32` | 8+4 | 16/16 | MC640 | 8 | 32 | 357.4 | 282.5 | 2739 | 4459 | 1102.4 | K3 | all entries satisfied |
| `P1-compact-L1H4S20-MC640-TP32` | 8+4 | 24/20 | MC640 | 8 | 32 | 369.3 | 283.6 | 2748 | 4554 | 1102.4 | K3 | all entries satisfied |
| `P1-compact-L1H4S24-MC640-TP32` | 8+4 | 24/24 | MC640 | 8 | 32 | 373.3 | 284.0 | 2751 | 4586 | 1102.4 | K3 | all entries satisfied |
| `P1-compact-L1H4S32-MC640-TP32` | 8+4 | 24/32 | MC640 | 8 | 32 | 381.2 | 284.7 | 2756 | 4649 | 1102.4 | K3 | all entries satisfied |
| `P1-compact-L1H8S16-MC640-TP32` | 8+4 | 40/16 | MC640 | 8 | 32 | 381.2 | 284.7 | 2756 | 4649 | 1102.4 | K3 | all entries satisfied |
| `P1-compact-L2H4S16-MC640-TP32` | 8+4 | 32/16 | MC640 | 8 | 32 | 373.3 | 284.0 | 2751 | 4586 | 1102.4 | K3 | all entries satisfied |
| `P1-compact-L4H4S16-MC640-TP32` | 8+4 | 48/16 | MC640 | 8 | 32 | 389.1 | 285.4 | 2762 | 4713 | 1102.4 | K3 | all entries satisfied |
| `P1-compact-MC640-TP32` | 8+4 | 24/16 | MC640 | 8 | 32 | 365.3 | 283.3 | 2745 | 4523 | 1102.4 | K3 | all entries satisfied |
| `P1-compact-N12x4-MC640-TP32` | 12+4 | 28/16 | MC640 | 8 | 32 | 397.5 | 303.4 **OVER** | 2906 **OVER** | 4780 | 1102.4 | K3 | all entries satisfied |
| `P1-compact-D6-MC640-TP32` | 8+4 | 24/16 | MC640 | 6 | 32 | 365.3 | 283.3 | 2079 | 3392 | 826.8 | K3 | all entries satisfied |
| `P1-compact-MC640-TP16` | 8+4 | 24/16 | MC640 | 8 | 16 | 365.3 | 283.3 | 2745 | 4523 | 551.2 | K3 | all entries satisfied |
| `P1-compact-MC640-TP8` | 8+4 | 24/16 | MC640 | 8 | 8 | 365.3 | 283.3 | 2745 | 4523 | 275.6 | K3 | all entries satisfied |
| `P1-compact-L1H4S12-MC640-TP32` | 8+4 | 24/12 | MC640 | 8 | 32 | 361.4 | 282.9 | 2742 | 4491 | 1102.4 | K3 | misses B-SRAM-CAP by 4.000 |
| `P1-compact-L1H4S8-MC640-TP32` | 8+4 | 24/8 | MC640 | 8 | 32 | 357.4 | 282.5 | 2739 | 4459 | 1102.4 | K3 | misses B-SRAM-CAP by 8.000 |
| `P1-compact-N16x4-MC640-TP32` | 16+4 | 32/16 | MC640 | 8 | 32 | 440.0 **OVER** | 325.5 **OVER** | 3083 **OVER** | 5120 | 1102.4 | K3 | misses B-AREA by 40.0 |
| `P1-compact-N8x12-MC640-TP32` | 8+12 | 56/16 | MC640 | 8 | 32 | 646.8 **OVER** | 547.9 **OVER** | 4862 **OVER** | 6775 **OVER** | 1102.4 | K3 | misses B-AREA by 246.8 |
| `P1-compact-N8x16-MC640-TP32` | 8+16 | 72/16 | MC640 | 8 | 32 | 782.5 **OVER** | 679.2 **OVER** | 5912 **OVER** | 7860 **OVER** | 1102.4 | K3 | misses B-AREA by 382.5 |
| `P1-compact-N8x8-MC640-TP32` | 8+8 | 40/16 | MC640 | 8 | 32 | 501.0 **OVER** | 414.6 **OVER** | 3795 **OVER** | 5608 **OVER** | 1102.4 | K3 | misses B-AREA by 101.0 |
| `P1-compact-N4x4-MC640-TP32` | 4+4 | 20/16 | MC640 | 8 | 32 | 333.1 | 263.1 | 2584 | 4265 | 1055.3 | K3 | misses B-SERIAL-CMP by 0.172 |
| `P1-compact-D4-MC640-TP32` | 8+4 | 24/16 | MC640 | 4 | 32 | 365.3 | 283.3 | 1412 | 2261 | 551.2 | K3 | misses B-SERIAL-CMP by 0.244 |
| `P1-compact-L1H4S24-MC320-TP32` | 8+4 | 24/24 | MC320 | 8 | 32 | 373.3 | 284.0 | 2607 | 4586 | 551.2 | K3 | misses B-MEM-BW by 320.000 |
| `P1-compact-MC320-TP32` | 8+4 | 24/16 | MC320 | 8 | 32 | 365.3 | 283.3 | 2602 | 4523 | 551.2 | K3 | misses B-MEM-BW by 320.000 |
| `P1-compact-MC320-TP16` | 8+4 | 24/16 | MC320 | 8 | 16 | 365.3 | 283.3 | 2602 | 4523 | 275.6 | K3 | misses B-MEM-BW by 320.000 |
| `P1-compact-MC320-TP8` | 8+4 | 24/16 | MC320 | 8 | 8 | 365.3 | 283.3 | 2602 | 4523 | 137.8 | K3 | misses B-MEM-BW by 320.000 |
| `P1-compact-L1H4S8-MC320-TP32` | 8+4 | 24/8 | MC320 | 8 | 32 | 357.4 | 282.5 | 2596 | 4459 | 551.2 | K3 | misses B-MEM-BW by 320.000, B-SRAM-CAP by 8.000 |

- 12 of 25 shapes satisfy every L1 contract entry; 16 reach 1000 TPS/usr for every model. Best by contract: `P1-compact-L1H2S16-MC640-TP32`.
- A row that misses B-AREA is NOT dropped: the package area it would need is the number "差多少" is asking for, and a silently absent shape reads as an option nobody considered.
- The D-Gate above is computed over the published grid only. This table informs the L2 decision (out/direction/direction_selected.json) and refines the contract into out/budget/L2_budget.json; it does not select candidates.

