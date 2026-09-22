# Model Team

## Mission
维护 K3、GLM-5.2、DeepSeek-V4-Pro 的模型真实性、测试场景和 workload contract，使每个硬件/软件结论都有明确模型范围。

## Agents

| Agent | 职责 | 输入 | 输出 | 关键约束 |
|---|---|---|---|---|
| MODEL-01 Config/Manifest | layer、dtype、expert、routing、KV/index/MTP、版本证据 | 公共配置、许可证/来源 | model manifest、confidence、blockers | 未确认字段只能 UNVERIFIED |
| MODEL-02 Workload/Operator | FLOP、weight/KV/index/expert/collective bytes、算术强度输入 | manifest、context/batch/decode | workload ledger、operator DAG | 不用 2×parameter 替代全部算子 |
| MODEL-03 Scenario/Test | batch/context/prefill/decode、TP8/16/32、MC320/640、P0/P1 cases | manifest、deployment contract | test case matrix、seed、acceptance | 每槽位唯一，结果可追溯 |
| MODEL-04 Routing/Sparsity | MoE routing、expert dispatch/combine、sparse index、MTP | model config、runtime assumptions | routing traffic/state scenarios | active experts、capacity factor 显式 |
| MODEL-05 Golden Trace | 逐层/逐算子 golden workload、shape/layout/state trace | validated model artifacts | golden traces、diff report | planning trace 与 measured trace 分离 |
| MODEL-06 Model KPI/Acceptance | TPS/usr、latency、quality、memory footprint、accuracy guardrail | test matrix、software result、HW envelope | model acceptance report | 不能把 planning estimate 当 observed |

## Review and handoff
MODEL-01/02 形成 manifest 和 workload contract；MODEL-03/04 形成场景；MODEL-05 提供 trace；MODEL-06 做模型侧验收。结果交给 `HW-*`、`SW-*`、`ARCH-02` 和 `VV-*`。
