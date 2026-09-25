# ADR-0008: Split token-time calibration, τ sensitivity, dtype policy and target-gated selection

Date: 2026-09-25
Status: accepted for repository modeling governance; supersedes the
calibration of ADR-0006 decision 2 and ADR-0007 decision 5

## Context

A review of the three-model TPS/usr (after ADR-0007 and ADR-0020) raised six
issues with the planning path:

1. The single kCompute (1.4139) mixed a FLOP efficiency with per-layer fixed
   costs (local TMA, launch) and exposed TMA fill. Applied to models with fewer
   FLOP per rank, it overstated their serial lane.
2. At TP32 the collective lane binds for GLM-5.2 and DeepSeek-V4-Pro, and the
   collective floor τ = 1.15 µs has no physical derivation (B-008).
3. The three models used different dtype policies with no explicit statement:
   K3 has BF16 dense, while GLM-5.2 and DeepSeek-V4-Pro have FP8 dense.
4. kMemory (1.1553) absorbed the K3 expert re-read, even though the re-read
   scales with routed-expert bytes and not with total bytes.
5. DeepSeek-V4-Pro's expert hidden size was solved only from the 49B active
   count, which implies a total of 1.16 × 1.6T. Its router and LM head were in
   FP8, while GLM-5.2's are BF16.
6. The selection policy admitted a candidate that misses the target on one
   model (K3 at 551 TPS/usr for MC320/TP32) as a formal candidate.

## Decision

1. **Split serial lane.** `integration/planning/token_time.js`:

   ```text
   memory lane = kMemory × (memory + expertReread × routed-expert memory)
   serial lane = kFlop × compute + fixedPerLayerUs × layers
               + kTmaExposedUsPerGB × non-collective GB per rank
               + collectives × max(τ, bytes / network bandwidth)
   raw = max(memory lane, serial lane); e2e = raw × 1.17
   ```

   Each factor comes from the timing breakdown of the K3 detailed published
   point (P1 / MC640 / TP32; the non-COMM ops of
   `k3_rdma_final_tuning_model.js` `mapped(best.x).plan.ops`):

   | Factor | Definition | Value |
   |---|---|---:|
   | expertReread | wrongBytes / predBytes | 0.2000 |
   | kMemory | DMA busy / (memory + expertReread × expert memory) | 1.1178 |
   | kFlop | (kernel 224.84 + reduce 14.23 + dieLink 6.73) / planning compute | 1.1529 |
   | fixedPerLayerUs | (localTma 42.87 + launch 11.17 − comm overlap 26.27) / 93 | 0.2987 µs |
   | kTmaExposedUsPerGB | (tmaFill 134.77 − tmaHidden 106.91) / non-collective GB per rank | 5.793 µs/GB |

   The three serial terms sum to the detailed serial compute
   (245.81 + 27.78 + 27.87 = 301.45 µs). The replay gives 1102.41 against the
   detailed 1101.77 (raw residual −0.45 µs). The MC320 point is outside the fit:
   planning gives 551.21 and the detailed model 586.46 (ratio 0.940). The old
   single factor is kept as `legacyKCompute` for comparison. Applying the K3
   factors to other models remains a planning ASSUMPTION. The factors have
   these limits:

   - **expertReread is an input, not a measurement.** 0.20 is 1 − the
     prediction accuracy 0.8 that the detailed model takes as input
     (`integration/detailed/k3_operator_sram_sim.js` `DEFAULT.prediction`). Applying
     it to GLM-5.2 and DeepSeek-V4-Pro assumes the same 80% expert prediction.
     Every slot reports `rereadSensitivity` at accuracy 0.7 / 0.8 / 0.9 with
     kMemory held at the K3 fit. For memory-bound slots this moves GLM-5.2 by
     −4.4% / +4.9% and DeepSeek-V4-Pro by −3.1% / +3.3%. Collective-bound
     slots do not move.
   - **kFlop is extrapolated to the INDEXER core class.** K3 has L, H, V and
     REDUCE work only, so the fit never saw INDEXER work. At TP32,
     DeepSeek-V4-Pro's INDEXER compute (32.7 µs) is its largest compute term.
     No slot is bound by it today.
   - **fixedPerLayerUs nets out a K3 mechanism.** It subtracts the K3
     shared-expert compute/communication overlap (26.27 µs), and the other
     models inherit that. The effect is at most about 28 µs per token.
   - **Memory-bound values may be conservative.** At MC320, planning is 0.94 of
     the detailed model for K3. The same kMemory may make memory-bound
     GLM-5.2 and DeepSeek-V4-Pro slots about 6% conservative.

2. **τ sensitivity.** Every slot reports TPS/usr at τ = 1.15, 1.5 and 2.0 µs
   (`TAU_SENSITIVITY_US`). The scorecard, the Stage B run and the dashboard show
   these as a range. The point estimate stays at 1.15 µs until B-008 derives τ.
   Only the point estimate decides selection; the range is a risk annotation
   (decision 6).

3. **dtype policy.** `planning_operator_workload.json#/dtypePolicy` states
   each model's policy, and the scorecard and dashboard show it:

   | Model | Dense / attention | Shared expert | Router + LM head | Routed expert | KV |
   |---|---|---|---|---|---|
   | K3 | BF16 | BF16 | BF16 | MXFP4 | FP8 656 B |
   | GLM-5.2 | FP8 | FP8 | BF16 | FP8 | FP8 656 B (ASSUMPTION) |
   | DeepSeek-V4-Pro | FP8 | FP8 | BF16 | FP4 | FP8 656 B (ASSUMPTION) |

   A comparison row `K3-FP8-dense` (K3 with FP8 dense, attention and shared
   expert, BF16 router/LM head) is reported under `comparisons` and is not
   ranked.

4. **Expert re-read factor.** This is decision 1's `expertReread`. It
   multiplies only the routed-expert bytes, so kMemory drops from 1.1553 to
   1.1178.

5. **DeepSeek-V4-Pro range.**
   - The router and LM head are BF16 (`bytesPerParam.routerAndLmHead = 2`),
     aligned with GLM-5.2.
   - The expert hidden size is solved two ways:

     | Basis | Expert hidden | Other total |
     |---|---:|---|
     | 49B active (primary) | 3840.8 | implied total 1.162 × 1.6T |
     | 1.6T total (variant `expertHiddenFromTotal`) | 3299.8 | implied active 44.28B |

   - Each slot reports `tpsPerUserShapeRange`, which spans both solutions.

6. **Selection.**
   - Candidates are ranked by worst-model TPS/usr.
   - A candidate is formally eligible only if every comparable model reaches
     the 1000 target. At most three candidates are selected.
   - The best MC320 candidate is kept as `MC320_REFERENCE_NOT_FORMAL`, listing
     the models that miss.
   - `evaluate_gates.js` adds the check `selectionMeetsTarget` (block reason
     `BLOCKED_SELECTION_BELOW_TARGET`).
   - The floor is the 1000 target (`sharedDecodeTargetTpsPerUser`). The 1050
     architecture gate is not a floor; each ranking entry records
     `meetsArchitectureGate`.
   - Eligibility uses the τ point estimate (1.15 µs). Each candidate also
     records `maxTauUsForTarget`, the largest τ at which every model still
     reaches the target. It is flagged `tauConditional` when that τ is below
     2.0 µs, and the register lists these candidates under
     `tauConditionalCandidates`.
     - Ranking by the τ range would leave no eligible candidate.
     - The range is therefore shown as risk, not used to select.

7. **Stage B status.**
   - Formal candidates reach the target by construction, so "the selected
     slots meet the target" says nothing about performance.
   - With a formal selection and slots below the gate, the status is
     `PERFORMANCE_MISS_OUTSIDE_SELECTED_CANDIDATES_NOT_VALIDATED`.
     `performanceAcceptance` records the count of comparable slots below the
     target and the τ condition of each selected candidate.
   - `STUDIED_CANDIDATES_ABOVE_TARGET_OTHERS_MISS_NOT_VALIDATED` remains only
     for exploratory runs. Their candidate set is not target-gated.

## Consequences

- TPS/usr on the single hardware spec P1 (ADR-0021). `m` means memory-bound
  and `c` means collective-bound:

  | Slot | K3 | GLM-5.2 | DeepSeek-V4-Pro (range) | K3-FP8-dense |
  |---|---:|---:|---:|---:|
  | MC320 TP8 | 137.8 m | 448.3 m | 463.8 m (463.8–498.2) | 208.2 |
  | MC320 TP16 | 275.6 m | 896.5 m | 927.7 m (927.7–996.3) | 416.5 |
  | MC320 TP32 | 551.2 m | 1793.1 m | 1855.4 m (1855.4–1992.6) | 832.9 |
  | MC640 TP8 | 275.6 m | 896.5 m | 927.7 m (927.7–996.3) | 416.5 |
  | MC640 TP16 | 551.2 m | 1793.1 m | 1855.4 m (1855.4–1949.1) | 832.9 |
  | MC640 TP32 | 1102.4 m | 2416.8 c | 2299.3 c (2299.3–2318.4) | 1149.3 |

- Change against ADR-0007:
  - At the collective-bound TP32/MC640 slots, GLM-5.2 drops 7.0% and
    DeepSeek-V4-Pro 3.1–3.3%. The split serial lane is smaller than before,
    but the collective lane dominates.
  - At memory-bound slots, GLM-5.2 drops 6.2% and DeepSeek-V4-Pro 5.7%. Their
    routed-expert share of bytes is larger than K3's, so the re-read factor
    costs them more than the kMemory reduction saves. For DeepSeek-V4-Pro the
    BF16 router and LM head add to this.
  - K3 is unchanged by construction.

- τ sensitivity at 1.15 / 1.5 / 2.0 µs:

  | Slot | K3 | GLM-5.2 | DeepSeek-V4-Pro |
  |---|---|---|---|
  | TP32/MC640 | 1102 / 959 / 786 | 2417 / 1930 / 1498 | 2299 / 1870 / 1476 |
  | TP16/MC640 | 551 / 551 / 551 | 1793 / 1781 / 1407 | 1855 / 1613 / 1311 |
  | TP32/MC320 | 551 / 551 / 551 | 1793 / 1793 / 1498 | 1855 / 1855 / 1476 |

  - K3 at TP32/MC640 falls below the target at τ = 1.5 µs.
  - GLM-5.2 and DeepSeek-V4-Pro stay above it at every τ in the table.

- Selection and gates:
  - One formal candidate: `P1-compact-MC640-TP32` (ADR-0021 removed the
    second hardware spec and its candidates).
  - `P1-compact-MC320-TP32` is the non-formal MC320 reference, with K3 at
    551.2 (0.55 of target).
  - The D-Gate stays `PASS`.
  - The formal candidate is τ-conditional. In the planning model, K3 reaches
    the target only while τ ≤ 1.408 µs.
    - The detailed model gives about 1.35 µs for the same point (B-008).
    - The planning bound is looser because the planning serial lane is
      slightly shorter.
    - The detailed value governs.
    - GLM-5.2 and DeepSeek-V4-Pro reach the target up to τ ≈ 3.1 µs.
  - K3 at 1102.4 clears the 1050 architecture gate by 5%.
  - The Stage B performance status becomes
    `PERFORMANCE_MISS_OUTSIDE_SELECTED_CANDIDATES_NOT_VALIDATED`, with 11 of
    18 comparable slots below the target.
  - The sensitivity sweep has 131 of 243 samples feasible (previously 132).
- The Q-Gate stays blocked: there is no event-timed replay.
