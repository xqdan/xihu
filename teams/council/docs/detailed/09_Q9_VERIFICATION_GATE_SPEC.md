# Q9 Verification / Gate Specification

## Decision question
详细架构的模型、事件、结果和 provenance 是否足以支持 Q-Gate 或形成可执行反馈？

## Inputs

- Q1-Q8 machine-readable artifacts；
- schemas、golden traces、contract tests；
- Stage A result 和 ADR。

## Outputs

- independent Q-Gate report；
- regression/conservation report；
- blocker list；
- `PASS`、`BLOCKED_CONFIG`、`LOCAL_DETAIL_FIX`、`PPA_DIRECTION_BACKFLOW` 或 `PERFORMANCE_MISS` feedback packet。

## Constraints

- Q9 不修改模型语义；
- source commit、manifest hash、input hashes、run_id、profile、unit contract 缺失时不得签核；
- pending/blocked 不得有伪造 TPS；
- 必须同时验证 schema、物理守恒和时间守恒。

## Exit criteria

Q-Gate 决策由独立 validator 重新计算，且 A0 已明确下一步是冻结、局部回流、方向回流还是保持 blocker。
