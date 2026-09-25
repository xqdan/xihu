# Q6 Scheduler / Software Event Specification

## Decision question
硬件事件是否能被 scheduler 组织成可重放的 decode step，并获得声明过的软件优化收益？

## Inputs

- Q1 DAG；
- Q3/Q4/Q5 events；
- D6 software gain budget；
- deadline、QoS、reservation、firmware policy。

## Outputs

- schedule trace；
- launch、barrier、reservation、ready/deadline、backpressure；
- persistent decode、fusion、prefetch、MTP acceptance/rollback；
- critical path 和 software overhead。

## Constraints

- 软件收益必须体现为实际 event、bytes、launch count 或 critical path 变化；
- host 不逐 kernel/collective 介入；
- MTP 必须有 acceptance、rollback、commit bytes；
- overlap policy 必须明确 `serial`、`max_overlap` 或 `partial_overlap`。

## Exit criteria

同一输入可 deterministic replay，且每个 stall 都能归因到 resource、dependency、queue 或 software event。
