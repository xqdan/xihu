# Q1 Manifest / Operator Specification

## Decision question
模型描述是否足够生成逐层 operator DAG，并且每个算子都能被后续资源模型消费？

## Inputs

- 模型配置和版本证据；
- candidate binding；
- workload phase、context、batch、TP/CP/EP；
- dtype、layout、KV/state、MoE/index/MTP 配置。

## Outputs

- layer manifest；
- operator DAG；
- tensor/shape/dtype/layout ledger；
- manifest hash；
- 缺失字段和 `BLOCKED_CONFIG` 清单。

## Constraints

- 不得用 residual 参数或全局 scaling 静默补齐正式 manifest；
- K3、GLM-5.2、DeepSeek-V4-Pro 必须有独立 model profile；
- 每个 operator 必须有唯一 `operator_id`、source、unit 和 status；
- Q2-Q8 必须引用同一 manifest hash。

## Exit criteria

DAG 无环、无孤立节点，所有输入/输出 buffer 有唯一 ID；未知配置被显式阻塞。

## Handoff

```text
manifest_hash
operator_dag
operator_inventory
model_blockers
```
