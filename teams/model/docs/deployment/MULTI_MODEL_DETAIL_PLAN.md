# GLM-5.2 / DeepSeek-V4-Pro 细化计划

这两条模型线现在已经有 planning workload，但还没有达到“单 Die / AI Core / SRAM / 互联 / 软件重叠可回放”的深度。细化工作的机器可读入口是 [`multimodel_detail_plan.json`](../../inputs/multimodel_detail_plan.json)。本文件解释如何使用它，以及当前为什么仍然是 `BLOCKED_CONFIG`。

## 当前边界

两条模型线必须独立保留，不能用 K3 的系数或彼此的数字互相替代：

| 模型 | 当前依据 | 首要阻塞 |
| --- | --- | --- |
| GLM-5.2 | public config + 已有 GLM operator trace | FP8 KV/index 格式、TP/EP/CP/PP 部署布局、逐 collective payload、MTP 路径 |
| DeepSeek-V4-Pro | reported fields + DeepSeek-V3/V3.2 assumptions | 官方 config、FP4 编码、49B active/1.6T total 矛盾、indexer/MLA 维度、逐 collective payload |

当前已有的 `deriveGlm` / `deriveDeepSeek` 和 planning operator ledger 只回答“粗略需要多少 FLOP/byte”。它们不能直接回答单 Die 上每种 core 的 cycle、SRAM 改变对瓶颈的影响，或 TP16/TP32 每条链路的排队尾延迟。

## 需要完成的工作包

1. **模型资格与形状冻结**：为每个模型登记 config、checkpoint、建模代码和量化格式的版本/hash。DeepSeek 的 active-parameter 与 total-parameter 解必须是两个 variant；在矛盾解决前不能合成一个数字。
2. **逐算子账本**：按 layer type 展开 dense、router、shared/routed expert、indexer、sparse attention、KV/index state、MTP draft/verify/rollback。每行必须同时有 shape、dtype、FLOP、weight/activation/expert/KV/index bytes。
3. **逐 collective 消息账本**：不能只写“每 token 333/305 次”。每个 collective 需要 count、payload/rank、peer scaling、algorithm、phase、workspace、ACK/control bytes，并分别生成 TP16、TP32 投影。
4. **单 Die / AI Core 回放**：分开 L、H、INDEXER、REDUCE、V 类资源；把 FP8/FP4 dequant、scale load、accumulation、router 和 indexer top-k 的成本显式计入。输出 per-die service/cycle 和瓶颈，不把 K3 的 token-time 拟合系数伪装成验证结果。
5. **SRAM / MC 敏感性**：独立计算 `KV_STATE`、`SPARSE_INDEX_CACHE`、`EXPERT_STAGING`、`MTP_BRANCH_STATE` 的容量、生命周期、带宽和 eviction。至少扫描 SRAM 容量、有效带宽、expert staging、index-cache hit/miss，并记录每次 sweep 的输入 hash、seed、单位和 evidence level。
6. **NoC / Die-to-Die / RDMA 回放**：将 indexer、attention、MoE output、router/control、MTP control 分流；把 logical payload、wire bytes、routed bytes、workspace、credit 和 queue wait 守恒起来。没有 queueing trace 时只能输出 `BLOCKED_CONFIG`，不能写 P95/P99。
7. **软件部署与重叠**：冻结 TP/EP/CP/PP、expert placement、Tile IR lowering、prefetch、fusion、collective/compute/KV overlap，以及 MTP accept/reject 的 commit/rollback。任何软件收益必须绑定可执行前提和 trace。
8. **V&V 与集成 Gate**：独立检查 shape/precision hash、FLOP/byte/payload conservation、trace provenance 和 variant 隔离。只有通过后才能从 `BLOCKED_CONFIG` 提升到 `MODEL_WITH_ASSUMPTIONS` 或 `VALIDATED_REPLAY`。

## 依赖顺序

```text
资格冻结
   -> 逐算子账本
      -> 逐 collective 消息账本
         -> 单 Die / SRAM / 网络回放
            -> 软件部署与重叠 trace
               -> V&V conservation + provenance
                  -> Architecture integration / Gate input
```

`MODEL-COLLECTIVE-LEDGER-01` 已落地为两份模型专属输入和 `teams/model/src/collective_ledger.js`，因此 1M decode 的 GLM/DeepSeek TP16/TP32 网络 planning projection 可以进入 `MODEL_WITH_ASSUMPTIONS`。

以下 planning 交付物也已落地，并由独立回归和 regeneration gate 固定：

- `MODEL-OP-LEDGER-01`：`out/workload/model_operator_ledgers.json`，GLM full/shared layer 与 DeepSeek active/total variant 分开记账；
- `HW-MULTIMODEL-REPLAY-01`：`out/workload/model_core_replay.json`，输出 L/H/INDEXER/REDUCE/V 的单 Die 资源服务账，并显式计入 FP8/FP4 dequant、scale load、accumulation；
- `HW-MULTIMODEL-SRAM-01`：`out/workload/model_sram_sensitivity.json`，区分 KV_STATE、SPARSE_INDEX_CACHE、EXPERT_STAGING、MTP_BRANCH_STATE，并扫描 shared SRAM 容量和 MC 有效带宽。

这些产物仍是 `PLANNING_DERIVED` / `UNVERIFIED_PLANNING_MANIFEST`。`MODEL-GLM-QUAL-01`、`MODEL-DS-QUAL-01`、queueing/runtime trace、软件 overlap trace 和独立 V&V replay 尚未完成；短上下文批量场景及任何 validated TPS、P95/P99 结论继续保持 `BLOCKED_CONFIG` 或未验证状态。

## 完成定义

一个模型可以进入 `MODEL_WITH_ASSUMPTIONS`，必须同时满足：

- 形状、精度、并行方式、state layout 都有 provenance；
- operator ledger 和 collective ledger 的 FLOP/byte/payload 守恒测试通过；
- TP16/TP32、MC320/MC640、single-die 资源约束分别落盘；
- SRAM 容量/带宽敏感性能够回放，且明确指出是 capacity-bound、bandwidth-bound、compute-bound 还是 network-bound；
- 所有未知量仍在 `assumptions` / `blockedFields` 中，没有静默补值。

只有具备模型专属 trace、队列/重叠输入和独立 V&V 报告，才可进入 `VALIDATED_REPLAY`。这一步之前的 TPS 只能是 planning estimate，不能作为芯片保证。
