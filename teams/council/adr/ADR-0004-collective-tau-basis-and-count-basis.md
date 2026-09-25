# ADR-0004: Collective-count basis and the per-collective cost basis (τ)

Date: 2026-09-25
Status: accepted for repository modeling governance

Two numbers on the K3 collective path were previously unregistered and
mutually inconsistent: how many reductions the design issues, and what one
reduction costs. Both are now named, single-sourced and asserted.

## Context

The SW-05 collective review (reconciliation now kept in
`teams/software/docs/COLLECTIVE_SCHEDULE.md` section 1.1) reconciled the
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
rewrote the duration of every COMM op through `R.collective()`
(integration/detailed/k3_sram_memory_rdma_model.js). The simulator's own `tauUs` (1.15 μs)
was therefore never on the critical path for a mapped design, and the spec's τ
differed from the published point's per-collective time by about 4.37× with no
entry explaining it. Decision 4 closes this: `spec.tauBasis.ratioToSpec` is now 1.

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

**4. Every collective is charged at least the spec τ (amended 2026-09-25).**
Every collective costs at least `OPT.tauUs = 1.15 µs`, booked as
`services.tauFloor`; the RDMA protocol model (with `OPT.oneWayUs = 0.05`) sets
the duration only of a collective above τ. The τ basis is recorded as a
first-class observable: `spec.tauBasis` in
teams/hardware/inputs/k3_mc_baseline.json, with the spec value, the in-repo
sources, the observed ns/collective at the published point and an analytic
ceiling table.

**5. The reference-393 basis is accepted (B-007, amended 2026-09-25).** This
amendment supersedes the "not proven" part of decision 3. The folded
`Wup + Shared output all-reduce` is issued after the shared-expert compute:
each rank adds its Latent Wup and Shared down partial sums locally, then reduces
once. The fold's legality conditions are in
`teams/software/docs/COLLECTIVE_SCHEDULE.md` section 2.3.

**6. Current published point.** All `GAIN` factors are 1 (B-003). The point is
1101.77 TPS/usr (raw 775.75 µs = compute 434.62 − tmaHidden 106.91 + comm
451.95 + wait 22.35 − overlap 26.27). All five collective groups are below τ,
so comm = 393 × 1.15 µs. The raw margin to the 854.70 µs budget is 78.95 µs:
τ may rise to about 1.35 µs (0.201 µs per collective) before the point misses
1000. Falling back to `repo-510` gives 941.74. The mechanisms behind the point
and their single ablations are in `docs/architecture/21_TPS_DESIGN_BASELINE.md`
(ADR-0005).

## Consequences

- **The count change is not a gain.** `SW-05` §4.2 is explicit that the C1
  fusion yields nothing billable to `software_gain_budget`. Any TPS movement
  caused by this change must be attributed to the two mechanisms that actually
  affect the schedule (the folded reduction no longer costs a separate
  collective; the tail add reads two operands instead of three) and the
  remainder labelled `UNEXPLAINED` per
  teams/14_TPS_OBSERVATION_METRICS.md §7.1.
- **The count axis is not the lever.** At the spec τ the analytic ceiling is
  1134.46 TPS at 393 reductions (`spec.tauBasis.ceilingTpsByCount["393"]`,
  with GAIN = 1, shared-expert overlap and TMA lanes, DMA wait taken as 0),
  against the 854.70 μs raw budget. The fully-replicated structural floor of
  209 reductions evaluates to 1577.52 TPS, but only as an optimistic bound: it
  holds the hidden TMA at today's value although fewer collectives leave less
  time to hide fills under, and it ignores DMA wait. Replication costs more DMA
  bandwidth than the published point has (COLLECTIVE_SCHEDULE section 5). τ is
  the first workstream; the count is second.
- **Regression is possible in both directions.** `tests/regression/test_k3_rdma_final_tuning.js`
  asserts `collectiveCount === 393` on the reference basis and `=== 510` on the
  repo basis, so neither can be changed silently.
- **This registration is separate from B-003/MR-007** (SW-05 §2.3): the τ basis
  is a counting/latency-basis question, not one of the 24 named GAIN factors.

## Reproduce

```
npm run search:final
npm run baseline:sync
npm test
```
