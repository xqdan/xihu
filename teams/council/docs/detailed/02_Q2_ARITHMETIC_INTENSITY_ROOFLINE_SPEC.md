# Q2 Arithmetic Intensity / Roofline / Sizing Specification

## Decision question
在具体模型、TP 和资源 profile 下，瓶颈是计算、内存、网络还是配置缺失？当前架构方向是否值得继续细化？

## Inputs

- Q1 manifest/DAG；
- D2 memory、D3 compute、D4 communication envelope；
- 唯一硬件规格 P1 与 MC320/MC640 profile。

## Outputs

- operator FLOP/byte ledger；
- `I_MC`、`I_network`、ridge、Roofline bound；
- required/available compute、memory、network ratios；
- per-model/per-TP sizing summary；
- `LOCAL_DETAIL_FIX`、`DIRECTION_BACKFLOW` 或 `BLOCKED_CONFIG`。

## Constraints

- L/H/Vector/Indexer/Reduce 分开；
- raw bandwidth 不能当 sustained/effective bandwidth；
- attention、MoE、KV/state、indexer、collective 单独记账；
- required bandwidth 超标不能靠增加 peak FLOPS 掩盖。

## Exit criteria

FLOP、byte、TP shard、network byte 和单位守恒；每条结果可追溯到 manifest hash。

## Feedback

如果 sizing 改变了主导架构墙或候选排序，必须通过 A0/ADR 回到 D2/D3/D4/D7。
