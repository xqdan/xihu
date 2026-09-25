# ADR-0004: Collective-count basis and the per-collective cost basis (τ)

Date: 2026-09-25
Status: accepted for repository modeling governance

Two numbers on the K3 collective path were previously unregistered and
mutually inconsistent: how many reductions the design issues, and what one
reduction costs. Both are now named, single-sourced and asserted.

## Context

`teams/software/docs/SW-05_COLLECTIVE_STRATEGY_REVISION.md` reconciled the
repository P1 count (510) against the reference page
(`references/k3_1000tps_chip_designs.html:1720`, 393 reductions). Three groups
accounted for the 117 difference:

| Delta | Operator | Nature |
|---:|---|---|
| 92 | `Shared output all-reduce` | The reference page folds the shared expert output into its expert-output merge; the repository issued a separate reduction. |
| 24 | `Q / new-KV all-gather` | The reference page's attention sublayer counts only its reduction pair. |
| 1 | `Distributed sampling candidates` | Not counted by the reference page. |

Separately, SW-05 §2 found four different per-collective latency defaults on
the same path, none of them declared as the authoritative basis.

This matters because `mappedPlan()` (integration/detailed/k3_architecture_search.js)
rewrites the duration of every COMM op through `R.collective()`
(integration/detailed/k3_sram_memory_rdma_model.js). The simulator's own `tauUs` (1.15 μs)
is therefore never on the critical path for a mapped design. A reader
comparing the spec's τ to the published point would find a ~4.37× discrepancy (`spec.tauBasis.ratioToSpec`)
with no entry explaining it.

## Decision

**1. The counting basis is a switch, and the published point uses the
reference basis.** `OPT.countBasis` (integration/detailed/k3_rdma_final_tuning_model.js) is
forwarded through `mappedPlan()` to the simulator, which validates it against
`['reference-393','repo-510']`. The default is `'reference-393'`.

**2. Withheld groups stay in the DAG as local ops.** Under `'reference-393'`
the `Q / new-KV all-gather` and `Distributed sampling candidates` ops keep the
same bytes, arena and dependency edges but are emitted with `unit!=='COMM'`.
They do not vanish from the op list. This is asserted: switching basis must not
change `plan.ops.length`.

**3. The fold is a counting-basis alignment, not a proven legal fusion.**
`Wup all-reduce` becomes `Wup + Shared output all-reduce` with an unchanged
payload of `B*H*2`, and the tail add drops from three-way to two-way. Routed
experts are latent-width (`expertInput: "latent"`, teams/model/src/design_engine.js:43)
while shared experts are full-hidden FFNs, so the two operands are not
demonstrably compatible. The precondition is registered as B-007
(docs/architecture/OPEN_ISSUES.md). If B-007 fails, the 92 delta loses its
justification and the basis reverts to `repo-510`.

**4. The published point does not change its τ.** `OPT.oneWayUs = 0.05` stays as
it is; changing it alongside the counting basis would move two things at once
and make the result unattributable. The τ basis is instead recorded as a
first-class observable: `spec.tauBasis` in teams/hardware/inputs/k3_mc_baseline.json,
with the spec value (`1.15 μs`), the four in-repo sources, the observed
ns/collective at the published point, and an analytic ceiling table.

**5. Amendment 2026-09-25 (supersedes decision 4 and the "not proven" part of
decision 3).**
- The reference-393 basis is accepted (B-007). The folded
  `Wup + Shared output all-reduce` is now issued after the shared-expert compute:
  each rank adds its Latent Wup and Shared down partial sums locally, then reduces
  once. Before this change the fold was issued before the shared experts, so their
  partial sums were never reduced.
- The published point now uses the spec τ: every collective costs at least
  `OPT.tauUs = 1.15 µs`, booked as `services.tauFloor`. The RDMA protocol model
  (with `OPT.oneWayUs`) still sets the duration of any collective above τ.
- All `GAIN` factors are 1 (B-003).
- Published point after these three changes: 681.06 TPS/usr (raw 1254.96 µs =
  compute 734.82 + comm 451.95 + wait 68.20), candidate 8 L + 4 H/Die.
- Same day, compute/collective overlap (`OPT.commOverlap`): collectives run on
  their own lane, and only the data-independent shared experts are issued under
  the Wdown + Router all-gather. raw = compute + comm + wait − overlap.
  Published point: 729.14 TPS/usr (raw 1172.20 µs = compute 692.98 + comm
  451.95 + wait 78.20 − overlap 50.92), still 8 L + 4 H/Die. Of the +48.08 TPS,
  overlap accounts for about +30 and a better candidate for about +18 (it scores
  699.07 serial); the earlier search had missed it, and the 681.06 candidate is
  now a fixed search seed. The 393-count ceiling at τ is 781.26 TPS.
- Same day, separate TMA lanes (`OPT.tmaLane`): the shared→local fill of each
  op's DMA-sourced inputs is split out of the op (`services.tmaFill`) and issued
  ahead of it on a per-domain lane into the free local double-buffer half.
  raw = compute − tmaHidden + comm + wait − overlap. Published point: 774.77
  TPS/usr (raw 1103.16 µs = compute 712.04 − tmaHidden 122.73 + comm 451.95 +
  wait 92.55 − overlap 30.64), 8 L + 4 H/Die with 4 MiB local SRAM per L core
  and 24 MiB shared per die. Of the +45.63 TPS, the lanes on the previous
  candidate account for about +20.76 (749.90) and the candidate move for about
  +24.87; the same candidate without lanes scores 666.01. Part of the hidden
  fill reappears as DMA wait on routed experts and in-layer-only KV tiles. The
  393-count ceiling is 845.72 TPS.
- Same day, cross-layer KV prefetch (`OPT.kvPrefetch='window'`, review item 8)
  and DMA preemption (`OPT.dmaPreempt`): KV context tiles of the next
  `x.depth` layers are prefetched like weights, and the routed-expert
  demand fetch released by Top-k parks an in-flight prefetch instead of queueing
  behind it. Prediction prefetch timing and accuracy (0.8) are unchanged; the
  predicted tiles already landed about 20 µs before Top-k. Published point:
  860.03 TPS/usr (raw 993.81 µs = compute 675.27 − tmaHidden 120.86 + comm
  451.95 + wait 16.36 − overlap 28.91), 8 L + 4 H/Die with 2 MiB local SRAM
  per L core and 16 MiB shared per die. On this candidate: both off 707.00,
  preemption off 767.85, cross-layer KV off 802.94. The previous candidate
  scores 843.72 with both on. The 393-count ceiling is 874.42 TPS.
- Same day, attention and small-op mapping (`OPT.pvMerge='layer'`,
  `softmaxFusion`, `epilogueFusion`), the prefetch depth searched as `x.depth`
  (1..4) instead of a fixed 4, a finer H-core grid and a pairwise polish so
  card power can move between blocks. Published point: 1007.27 TPS/usr (raw
  848.53 µs = compute 550.64 − tmaHidden 142.57 + comm 451.95 + wait 21.29 −
  overlap 32.78), 8 L + 4 H/Die with 5×(48×128) H engines, 0.8 GHz, 2048
  reduce lanes. On this candidate: pvMerge=tile 919.97, softmax fusion off
  975.19, epilogue fusion off 979.98, all three off 870.60. The 393-count
  ceiling is 1033.19 TPS. The raw margin to the 854.70 µs budget is 6.2 µs,
  so τ is now the sensitivity: 393 × 0.016 µs consumes it.
- Same day, FP8 KV cache (`OPT.kvCache='fp8'`, FlashMLA layout, 656 B per
  token per layer, BF16 compute with in-kernel dequant). Published point:
  1031.52 TPS/usr (raw 828.59 µs = compute 519.81 − tmaHidden 132.39 + comm
  451.95 + wait 21.82 − overlap 32.61), KV tile 32768 and 4096 reduce lanes.
  The 393-count ceiling is 1059.42 TPS; the raw margin is 26.1 µs, i.e. τ may
  rise by about 0.066 µs before the point misses 1000. That point ran at
  0.8 GHz and was withdrawn the same day (next item).
- Same day, frequency fixed at 1.0 GHz: compute may be sized only by core and
  engine counts and shapes, not by lowering the clock (`EXT.ghz = [1]`).
  Published point: 1015.08 TPS/usr (raw 842.01 µs = compute 502.36 −
  tmaHidden 110.34 + comm 453.44 + wait 23.70 − overlap 27.16), 4 L + 5 H/Die
  with 5×(32×128) H engines, 2 MiB H local SRAM, KV tile 16384, 64 UCIe lanes.
  The LSE merge now exceeds τ (1.21 µs protocol time) because the halved UCIe
  lengthens its card-local phase. The 393-count ceiling is 1046.39 TPS; the
  raw margin is 12.70 µs, i.e. τ may rise by about 0.032 µs before the point
  misses 1000.
- Same day, physical basis (ADR-0005 decision 6: Samsung SF4 area, matrix
  density 3.2 TF/mm², liquid cooling at die 300 W / card 2800 W). Published
  point: 1101.77 TPS/usr (raw 775.75 µs = compute 434.62 − tmaHidden 106.91 +
  comm 451.95 + wait 22.35 − overlap 26.27), 8 L + 4 H/Die with 5×(48×128) H
  engines, 4 MiB H local SRAM, KV tile 32768, 128 UCIe lanes. All five
  collective groups are below τ again, so comm = 393 × 1.15 µs. The 393-count
  ceiling is 1134.46 TPS; the raw margin is 78.95 µs, i.e. τ may rise to about
  1.35 µs (0.201 µs per collective) before the point misses 1000.

## Consequences

- **The count change is not a gain.** `SW-05` §4.2 is explicit that the C1
  fusion yields nothing billable to `software_gain_budget`. Any TPS movement
  caused by this change must be attributed to the two mechanisms that actually
  affect the schedule (the folded reduction no longer costs a separate
  collective; the tail add reads two operands instead of three) and the
  remainder labelled `UNEXPLAINED` per
  teams/14_TPS_OBSERVATION_METRICS.md §7.1.
- **The count axis is not the lever.** At the spec τ the analytic ceiling is
  1046.39 TPS at 393 reductions (874.42 before the attention/small-op mapping) (`spec.tauBasis.ceilingTpsByCount["393"]`,
  with GAIN = 1, shared-expert overlap and TMA lanes, DMA wait taken as 0),
  against the 854.70 μs raw budget. The fully-replicated structural floor of
  209 reductions evaluates to 1412.24 TPS, but only as an optimistic bound: it
  holds the hidden TMA at today's value although fewer collectives leave less
  time to hide fills under, and it ignores DMA wait. The `tauBasis` block carries this
  table so the ordering of the two workstreams is visible: τ first, then count.
- **Regression is possible in both directions.** `tests/regression/test_k3_rdma_final_tuning.js`
  asserts `collectiveCount === 393` on the reference basis and `=== 510` on the
  repo basis, so neither can be changed silently.
- **This registration is separate from B-003/MR-007** (SW-05 §2.3): the τ basis
  is a counting/latency-basis question, not one of the 24 named GAIN factors.

## Reproduce

```
npm run search:final
node integration/pipelines/sync_baseline_spec.js
npm run report:rdma
npm test
```
