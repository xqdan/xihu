# ADR-0003: Planning estimates are not event replay acceptance

Date: 2026-09-22
Status: accepted for repository modeling governance

Supersedes ADR-0002's claim of completed event evidence. No supplier-unconfirmed
configuration may be marked FROZEN. The three manifests are unverified planning assumptions.
D-Gate PASS currently permits planning comparison only, not architecture freeze.
Q-Gate must remain blocked while Q3-Q8 events are synthetic and TPS does not consume
an independently validated schedule. Counts, hashes and COMPLETE strings do not prove timing.

## Contracts
- Keep the calibrated K3 directional baseline unchanged; never mix its bytes/FLOPs
  with the much larger uncalibrated planning operator templates.
- Store the planning operator workload once; both Stage A and B consume it.
- Planning scorecard SI fields identify the dominant compute and bandwidth operators,
  not total model demand. Tests independently recompute each latency from its source.
- PLANNING_ESTIMATE is neither MODEL_OBSERVED nor SILICON_OBSERVED.
- Current TPS is an optimistic bottleneck bound, not fine end-to-end TPS.
- P0/P1 labels are covered but currently share core-class capacity assumptions;
  separate coverage is not physical resource validation.
- Generated dashboard comes from machine artifacts; no manually assigned maturity percentages.

## Exit criteria
Q1/Q2: verified shape-derived per-operator FLOP and byte ledger with source and units.
Q3/Q4/Q5: resource-conserving tile, packet and cycle traces with time units and calibration.
Q6/Q8: dependency/resource-aware schedule consumed by token latency calculation.
Q7: distinct P0/P1 per-core resources and activity/area/power reconciliation.
Q9: mutation tests reject missing/duplicate slots, mismatched hashes and synthetic evidence.

Reproduce: node models/resolve_architecture_blockers.js; node models/formal_detailed_run.js;
node scripts/generate_global_dashboard.js; npm test.
