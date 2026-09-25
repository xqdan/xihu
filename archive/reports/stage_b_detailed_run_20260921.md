# Stage B Detailed Architecture Exploratory Run

Run ID: `stage-b-20260921`
Source Stage A Run ID: `stage-a-20260921124431`
Run mode: `EXPLORATORY_AFTER_BLOCKED_D_GATE`
Status: `Q-GATE BLOCKED`

## 1. Governance

Stage A D-Gate is blocked. This run is authorized only by ADR-0001 as an exploratory P0/MC320 TP8/TP16/TP32 sweep. It is not formal candidate selection and emits no fine TPS sign-off.

Selected sweep source: `out/governance/candidate_register.json`.

## 2. Agent execution

| Agent | Status | Output/blocker |
|---|---|---|
| Q1 | PARTIAL | manifest status and blocked-case ledger |
| Q2 | PLANNING_COMPLETE | K3 arithmetic intensity, Roofline, compute/bandwidth/network sizing ledger |
| Q3 | BLOCKED_UPSTREAM | formal manifest and tile event contract pending |
| Q4 | BLOCKED_UPSTREAM | formal manifest and packet event contract pending |
| Q5 | BLOCKED_UPSTREAM | Q3/Q4 event streams pending |
| Q6 | BLOCKED_UPSTREAM | Q5 kernel cycle model pending |
| Q7 | BLOCKED_UPSTREAM | PPA reconciliation pending |
| Q8 | BLOCKED_UPSTREAM | Q1-Q7 provenance closure pending |
| Q9 | Q_GATE_BLOCKED | independent validator required |

## 3. K3 Q2 Roofline and sizing ledger

| TP | Operator | Core | AI FLOP/B | Ridge FLOP/B | Bound | Req peak TFLOP/s | Available TFLOP/s | Compute ratio | Req BW TB/s | Available BW TB/s | BW ratio |
|---|---|---|---:|---:|---|---:|---:|---:|---:|---:|---:|
| TP8 | dense_projection | L | 3.74 | 43.89 | compute | 980.4 | 157.3 | 6.23 | 133.75 | 3.58 | 37.32 |
| TP8 | routed_moe | L | 3.76 | 43.89 | compute | 4411.8 | 157.3 | 28.05 | 598.75 | 3.58 | 167.06 |
| TP8 | attention | H | 3.16 | 351.09 | compute | 1470.6 | 1258.3 | 1.17 | 237.50 | 3.58 | 66.27 |
| TP8 | kda_state | V | 2.29 | 21.94 | compute | 196.1 | 78.6 | 2.49 | 43.75 | 3.58 | 12.21 |
| TP8 | collective_reduce | REDUCE | 2.50 | 98.30 | compute | 49.0 | 78.6 | 0.62 | 10.00 | 0.80 | 12.50 |
| TP16 | dense_projection | L | 3.74 | 43.89 | compute | 490.2 | 157.3 | 3.12 | 66.88 | 3.58 | 18.66 |
| TP16 | routed_moe | L | 3.76 | 43.89 | compute | 2205.9 | 157.3 | 14.02 | 299.38 | 3.58 | 83.53 |
| TP16 | attention | H | 3.16 | 351.09 | compute | 735.3 | 1258.3 | 0.58 | 118.75 | 3.58 | 33.13 |
| TP16 | kda_state | V | 2.29 | 21.94 | compute | 98.0 | 78.6 | 1.25 | 21.88 | 3.58 | 6.10 |
| TP16 | collective_reduce | REDUCE | 2.50 | 98.30 | compute | 24.5 | 78.6 | 0.31 | 5.00 | 0.80 | 6.25 |
| TP32 | dense_projection | L | 3.74 | 43.89 | compute | 245.1 | 157.3 | 1.56 | 33.44 | 3.58 | 9.33 |
| TP32 | routed_moe | L | 3.76 | 43.89 | compute | 1102.9 | 157.3 | 7.01 | 149.69 | 3.58 | 41.77 |
| TP32 | attention | H | 3.16 | 351.09 | compute | 367.6 | 1258.3 | 0.29 | 59.38 | 3.58 | 16.57 |
| TP32 | kda_state | V | 2.29 | 21.94 | compute | 49.0 | 78.6 | 0.62 | 10.94 | 3.58 | 3.05 |
| TP32 | collective_reduce | REDUCE | 2.50 | 98.30 | compute | 12.3 | 78.6 | 0.16 | 2.50 | 0.80 | 3.13 |

## 4. Model summary

| Model | Operators | Max compute ratio | Max bandwidth ratio | Worst compute op | Worst bandwidth op |
|---|---:|---:|---:|---|---|
| K3 | 15 | 28.05 | 167.06 | routed_moe | routed_moe |

## 5. Blocked models

| Model | TP | Status | Reason |
|---|---:|---|---|
| GLM-5.2 | TP8 | BLOCKED_CONFIG | formal layer/dtype/expert/state/index manifest is not frozen |
| GLM-5.2 | TP16 | BLOCKED_CONFIG | formal layer/dtype/expert/state/index manifest is not frozen |
| GLM-5.2 | TP32 | BLOCKED_CONFIG | formal layer/dtype/expert/state/index manifest is not frozen |
| DeepSeek-V4-Pro | TP8 | BLOCKED_CONFIG | formal layer/dtype/expert/state/index manifest is not frozen |
| DeepSeek-V4-Pro | TP16 | BLOCKED_CONFIG | formal layer/dtype/expert/state/index manifest is not frozen |
| DeepSeek-V4-Pro | TP32 | BLOCKED_CONFIG | formal layer/dtype/expert/state/index manifest is not frozen |

## 6. Observation matrix and provenance

- 18 required slots accounted: **yes**.
- Matrix is complete or explicitly blocked: **no**; the 16 pending slots are not yet terminal blocked-config observations.
- Provenance complete: **no**; manifestHash and seed are intentionally missing.
- Source commit: `1bd2683b31fe6a8b3f978b394c740b7cd5863c21`.

## 7. Q-Gate

The independent validator must keep the Q-Gate blocked until D-Gate, formal manifests, shared Q3-Q7 event streams, fine TPS, provenance and matrix closure are complete.

## 8. Artifacts

```text
out/detailed/detailed_architecture_run.json
out/governance/gate_status.json
archive/reports/stage_b_detailed_run_20260921.md
```
