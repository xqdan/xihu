# Stage B Detailed Architecture Dry Run Report

Run date: 2026-09-21  \
Run ID: `stage-b-20260921113859`  \
Source Stage A Run ID: `stage-a-20260921105239`  \
Status: `QUANTIFICATION_DRY_RUN / Q-GATE BLOCKED`

## 1. Flow executed in this run

```text
Q1 manifest status check
  -> Q2 operator arithmetic ledger / Roofline / sizing
  -> Q3 tile + memory event model placeholder check
  -> Q4 packet + collective event model placeholder check
  -> Q5 kernel cycle model placeholder check
  -> Q6 schedule and overlap placeholder check
  -> Q7 PPA placeholder check
  -> Q8 fine TPS gate check
  -> Q9 Q-Gate review
```

This run completes only the executable Q1/Q2 dry-run path. Q3-Q7 event-level models are not implemented yet, so Q8 does not emit a signed-off fine TPS result.

## 2. Inputs and candidate scope

Machine-readable inputs:

```text
data/direction/directional_tps_scorecard.json
data/workload/model_profiles.json
```

Selected Stage A candidates for P0 + MC320 TP sweep:

```text
P0-7R-balanced-MC320-TP8
P0-7R-balanced-MC320-TP16
P0-7R-balanced-MC320-TP32
```

Scope constraints:

| Dimension | Setting | Meaning |
|---|---|---|
| Physical profile | P0 | 7-reticle balanced baseline; do not extrapolate from P1 compact |
| Memory profile | MC320 | Manufacturing baseline; do not use MC640 stretch as default |
| TP | 8 / 16 / 32 | Compare TP scaling under the same P0/MC320 envelope |
| Target TPS/usr | 1000 | Q2 required peak sizing target |
| Utilization | 0.6 | Planning assumption |
| Duty cycle | 0.85 | Planning assumption |

## 3. Manifest status

| Model | Current status | Handling in this run |
|---|---|---|
| K3 | PLANNING_MANIFEST | Generate a planning operator ledger; do not treat it as a frozen manifest |
| GLM-5.2 | BLOCKED_CONFIG | Keep blocked; do not emit fake operator-level conclusions |
| DeepSeek-V4-Pro | BLOCKED_CONFIG | Keep blocked; do not emit fake operator-level conclusions |

## 4. K3 Q2 arithmetic intensity, Roofline and compute sizing

| TP | Operator | Core | AI FLOP/B | Ridge FLOP/B | Roofline bound | Required peak TFLOP/s | Available peak TFLOP/s | Req/Avail | Status |
|---|---|---|---:|---:|---|---:|---:|---:|---|
| TP8 | dense_projection | L | 3.74 | 49.37 | bandwidth | 980.4 | 176.9 | 5.54 | PLANNING_ESTIMATE |
| TP8 | routed_moe | L | 3.76 | 49.37 | bandwidth | 4411.8 | 176.9 | 24.93 | PLANNING_ESTIMATE |
| TP8 | attention | H | 3.16 | 49.37 | bandwidth | 1470.6 | 176.9 | 8.31 | PLANNING_ESTIMATE |
| TP8 | kda_state | V | 2.29 | 2.74 | bandwidth | 196.1 | 9.8 | 19.95 | PLANNING_ESTIMATE |
| TP8 | collective_reduce | REDUCE | 2.50 | 12.29 | bandwidth | 49.0 | 9.8 | 4.99 | PLANNING_ESTIMATE |
| TP16 | dense_projection | L | 3.74 | 49.37 | bandwidth | 490.2 | 176.9 | 2.77 | PLANNING_ESTIMATE |
| TP16 | routed_moe | L | 3.76 | 49.37 | bandwidth | 2205.9 | 176.9 | 12.47 | PLANNING_ESTIMATE |
| TP16 | attention | H | 3.16 | 49.37 | bandwidth | 735.3 | 176.9 | 4.16 | PLANNING_ESTIMATE |
| TP16 | kda_state | V | 2.29 | 2.74 | bandwidth | 98.0 | 9.8 | 9.97 | PLANNING_ESTIMATE |
| TP16 | collective_reduce | REDUCE | 2.50 | 12.29 | bandwidth | 24.5 | 9.8 | 2.49 | PLANNING_ESTIMATE |
| TP32 | dense_projection | L | 3.74 | 49.37 | bandwidth | 245.1 | 176.9 | 1.39 | PLANNING_ESTIMATE |
| TP32 | routed_moe | L | 3.76 | 49.37 | bandwidth | 1102.9 | 176.9 | 6.23 | PLANNING_ESTIMATE |
| TP32 | attention | H | 3.16 | 49.37 | bandwidth | 367.6 | 176.9 | 2.08 | PLANNING_ESTIMATE |
| TP32 | kda_state | V | 2.29 | 2.74 | bandwidth | 49.0 | 9.8 | 4.99 | PLANNING_ESTIMATE |
| TP32 | collective_reduce | REDUCE | 2.50 | 12.29 | bandwidth | 12.3 | 9.8 | 1.25 | PLANNING_ESTIMATE |

### Key observation

| Model | Operator count | Max Req/Avail | Worst operator | Worst core | Status | Confidence |
|---|---:|---:|---|---|---|---|
| K3 | 15 | 24.93 | routed_moe | L | PLANNING_ESTIMATE | E1 |

The current K3 planning ledger has max required-to-available ratio `24.93`. The worst operator is `routed_moe` on core class `L`. This indicates a sizing risk between the directional K3 routed-MoE workload constants and the P0 L-Core envelope. It is a planning risk signal, not a final silicon sign-off conclusion.

## 5. GLM-5.2 / DeepSeek-V4-Pro blocked cases

| Model | TP | Physical | MC | Status | Confidence | Reason |
|---|---|---|---|---|---|---|
| GLM-5.2 | TP8 | P0 | MC320 | BLOCKED_CONFIG | E0 | formal layer/dtype/expert manifest is not frozen |
| GLM-5.2 | TP16 | P0 | MC320 | BLOCKED_CONFIG | E0 | formal layer/dtype/expert manifest is not frozen |
| GLM-5.2 | TP32 | P0 | MC320 | BLOCKED_CONFIG | E0 | formal layer/dtype/expert manifest is not frozen |
| DeepSeek-V4-Pro | TP8 | P0 | MC320 | BLOCKED_CONFIG | E0 | formal layer/dtype/expert manifest is not frozen |
| DeepSeek-V4-Pro | TP16 | P0 | MC320 | BLOCKED_CONFIG | E0 | formal layer/dtype/expert manifest is not frozen |
| DeepSeek-V4-Pro | TP32 | P0 | MC320 | BLOCKED_CONFIG | E0 | formal layer/dtype/expert manifest is not frozen |

Blocking rule: without a formal layer/dtype/expert manifest, the flow does not invent an operator ledger and does not emit fine-grained TPS.

## 6. P0/P1 and MC320/MC640 isolation status

| Check | Status | Note |
|---|---|---|
| P0/P1 separated | PASS | This run uses P0 only and does not extrapolate P1 compact results to P0 |
| MC320/MC640 separated | PASS | This run uses MC320 baseline only and does not treat MC640 stretch as default |
| TP8/TP16/TP32 executable | PASS | K3 emits Q2 ledgers for TP8, TP16 and TP32 |
| Shared manifest for Roofline/replay | BLOCKED | Q3-Q7 do not yet share one event manifest |

## 7. Q-Gate conclusion

Current Q-Gate decision:

```text
BLOCKED_BY_MANIFEST_AND_EVENT_MODEL
```

Passed checks:

- P0/P1 and MC320/MC640 dimensions are explicitly isolated.
- K3 TP8/TP16/TP32 Q2 planning ledgers are executable.
- GLM-5.2 and DeepSeek-V4-Pro unfrozen configs are explicitly blocked.

Blocking checks:

- K3 formal manifest is still not frozen.
- GLM-5.2 and DeepSeek-V4-Pro lack formal layer/dtype/expert manifests.
- Q3 tile/memory events, Q4 collective packet events, Q5 kernel cycles, Q6 scheduler/overlap and Q7 PPA are not implemented.
- Q8 fine TPS must not be emitted yet.

## 8. Next detailed-design agent work

| Agent | Next output | Unlocks |
|---|---|---|
| Q1 Manifest Agent | Three-model formal manifest | Full three-model Q2 ledger |
| Q3 Memory/Event Agent | Tile, SRAM and HBM/MC event stream | Memory replay and SRAM-hit analysis |
| Q4 Network Agent | Packet, VC, credit and collective event stream | TP/EP communication latency and overlap |
| Q5 Kernel Agent | Per-kernel cycle model | Operator latency |
| Q6 Scheduler Agent | Stream schedule, fusion and overlap policy | End-to-end token latency |
| Q7 PPA Agent | Area/power/timing budget reconciliation | Implementability check |
| Q8 TPS Agent | Fine TPS/usr scorecard | Only after Q1-Q7 provenance closure |
| Q9 Review Agent | Q-Gate decision | Detailed sign-off or blocked state |

## 9. Run artifacts

```text
models/detailed_run.js
data/detailed/detailed_architecture_run.json
reports/detailed/stage_b_detailed_run_20260921.md
```
