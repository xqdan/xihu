# ADR-0006: Planning token time, derived DeepSeek-V4-Pro workload, and GLM-5.2 BLOCKED_CONFIG

Date: 2026-09-25
Status: accepted for repository modeling governance; decision 5 (GLM-5.2
`BLOCKED_CONFIG`) superseded by ADR-0007 on 2026-09-25, when the public
config was integrated; the decision 2 calibration (kMemory 1.1553,
kCompute 1.4139) superseded by ADR-0008 (split serial lane and expert re-read)

## Context

The 2026-09-25 review of the GLM-5.2 and DeepSeek-V4-Pro TPS/usr numbers found
problems in the planning path (Stage A / Stage B, `npm run model:planning`):

1. **TPS/usr came from a single operator.** The planning "TPS" was
   `1e6 / max over operators of max(compute, memory)`. It did not sum the
   operators of a token and did not charge collectives or the 1.17 margin. The
   result was an optimistic bound, not a token time. At K3 P1/MC640/TP32 it
   differed from the detailed model's 1101.77 by a large factor.
2. **GLM-5.2 and DeepSeek-V4-Pro rows were ratio-scaled from K3.** The GLM rows
   implied about 808B active parameters, above the 753B total.
3. **K3 planning KV bytes used the BF16 preset (1152 B/token/layer).** The
   detailed model uses the FP8 FlashMLA layout (656 B).
4. **The DeepSeek rows carried an EP dispatch operator.** That is inconsistent
   with the TP-only slot, and MTP was not stated either way.
5. **Two deprecated runners could still overwrite the current gate evidence:**
   `models/detailed_run.js` and `models/direction/run_directional_tps.js`.

## Decision

1. **Planning token time** (`integration/planning/token_time.js`). It keeps the
   two-lane structure of the detailed simulator, where DMA runs under a single
   compute/collective slot:

   ```text
   memory lane = Σ non-collective bytes / TP / effective MC bandwidth
   serial lane = Σ FLOP / TP / (core peak × 0.6 × 0.85) + collectives × max(τ, bytes / network)
   raw         = max(memory lane × kMemory, compute × kCompute + collectives)
   e2e         = raw × 1.17;   TPS/usr = 1e6 / e2e
   ```

   Collectives are charged at τ = 1.15 µs (ADR-0004), the same as in the
   detailed model, and are not scaled.

2. **Calibration.** kMemory and kCompute are fitted once on the K3 detailed
   published point (P1 / MC640 / TP32,
   `out/rdma/k3_rdma_final_tuning_results.json#/search/best`). The fit is stored
   in `out/workload/planning_operator_workload.json#/calibration`.

   | Quantity | Value |
   |---|---:|
   | kMemory = detailed DMA busy / planning memory lane | 775.30 / 671.09 = 1.1553 |
   | kCompute = (compute − hidden TMA − overlap) / planning compute | 301.45 / 213.20 = 1.4139 |
   | Planning TPS/usr at the calibration slot | 1102.41 (detailed model 1101.77; raw residual −0.45 µs) |
   | Out-of-fit check, MC320 (not fitted) | planning 551.21 vs detailed 586.46 (0.940) |

   Applying the K3 factors to other models is a planning ASSUMPTION.

3. **K3 rows** are derived from `MODEL_PRESETS.kimiK3` with absorbed MLA
   attention FLOPs and FP8 KV at 656 B/token/layer, taken from the detailed
   plan. They reconcile with the detailed plan to FLOP 0.996 and bytes 0.969.

4. **DeepSeek-V4-Pro rows** are derived from
   `formal_model_manifests.json#/models/2/shape`.
   - `shape.reported` holds the published fields: 1.6T / 49B, 61 layers,
     hidden 7168, 128 heads, 384 + 1 experts, top-6, indexer top-k 2048, and
     FP8 weights with FP4 experts.
   - Every other field is in `shape.assumptions` with a `basis` string (mostly
     DeepSeek-V3/V3.2 dimensions). These fields are marked ASSUMPTION.
   - The expert hidden size is solved from the 49B active parameters, giving
     3840.8. The implied total is 1.16 × the reported 1.6T; that residual is
     visible and not hidden.
   - Collectives are 4 per layer: 244 per token.
   - There is no EP dispatch row, because the slots are TP-only. MTP is
     excluded from TPS/usr (`mtpApplied: false`).

5. **GLM-5.2 is `BLOCKED_CONFIG`.**
   - It has no operator rows, no TPS and no bound.
   - Its 6 observation slots stay accounted but carry `tpsPerUser: null` and
     list the missing config (`missingConfig`).
   - It is excluded from candidate ranking and is never assumed.

6. **Gates.**
   - The D-Gate check `threeModelComparable` is false while any model is
     `BLOCKED_CONFIG`. The decision is taken from the first failed check; here
     it is `BLOCKED_MODEL_CONFIG_INCOMPLETE`.
   - With the D-Gate blocked, Stage B runs as
     `EXPLORATORY_AFTER_BLOCKED_D_GATE`, as in ADR-0001. It studies the three
     policy-ranked candidates of the active `exploratorySweeps` entry and has
     no formal selection.
   - The Q-Gate stays blocked.

7. **Retired runners.** The deprecated runners were first guarded to throw on
   load, then deleted on 2026-09-25. They can no longer overwrite the gate
   artifacts.

## Consequences

- K3 planning at P1/MC640/TP32 is 1102.4 TPS/usr and is memory-bound. At
  MC320 it is 551.2, below the target.
- DeepSeek-V4-Pro at TP32 / MC640:
  - 2372.9 TPS/usr at P1 and 2392.9 at P0;
  - bound by collective latency (244 × 1.15 µs), not memory;
  - the indexer reads 8.4 GB/token at 1M context (132 B × 61 layers), about
    4× the sparse-attention KV;
  - TP8 at MC640 is 983.7.

  These numbers rest on the ASSUMPTION fields and on the K3 calibration.
- Performance acceptance is `PERFORMANCE_MISS_REQUIRES_DIRECTION_BACKFLOW` with
  coverage `BLOCKED_CONFIG_PARTIAL_COVERAGE`:
  - 12 slots have planning estimates;
  - 6 are BLOCKED_CONFIG.
- The D-Gate cannot pass until GLM-5.2's config is supplied. That config
  covers active parameters, the expert count and shape, attention and indexer
  dimensions, layers, and collectives per layer.
- kMemory and kCompute are fitted on K3 only. A second detailed point would be
  needed before the factors can be treated as model-independent.
- `tests/unit/test_directional_units.js` and
  `tests/governance/test_planning_evidence_dashboard.js` recompute every comparable slot
  from the workload and the stored calibration.
  `tests/regression/test_k3_manifest_consistency.js` replays the calibration and the MC320
  check against the detailed model.
