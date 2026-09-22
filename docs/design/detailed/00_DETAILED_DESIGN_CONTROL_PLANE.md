# Q0 Detailed Design Control Plane

## Decision question
本次详细设计量化哪个 `candidate_id`、`model_id`、`physicalProfile`、`mcProfile` 和 `TP/CP/EP`？

## Inputs

- `data/governance/candidate_register.json`
- `data/governance/gate_status.json`
- `data/workload/model_profiles.json`
- `data/direction/directional_tps_scorecard.json`
- `data/analysis/detailed_architecture_operating_model.json`

## Outputs

- detail run manifest；
- candidate binding；
- source/input/manifest hash；
- formal 或 exploratory run mode；
- model blocker list。

## Constraints

- D-Gate 未通过只能使用 `EXPLORATORY_AFTER_BLOCKED_D_GATE`；
- formal candidate 不得从 runner 内硬编码；
- P0/P1、MC320/MC640 必须独立；
- blocked model 不生成伪造 operator/TPS 结论。

## Exit criteria

所有下游 Q Agent 使用同一 `run_id`、profile、input hash 和 manifest hash。

## Handoff

输出给 Q1/Q2 的 handoff 必须包括：`candidateBinding`、`runMode`、`provenanceBundle`、`blockedConfigurations`。
