# 当前设计状态与已知结论

版本：2026-09-23。

## 0. 7-reticle 单芯片前提

自 2026-09-21 起，单芯片的物理边界改为一个 7-reticle advanced package：8×400 mm² Compute Die + 16×100 mm² MC，工程 placement window 约 82×64 mm、5,248 mm²；一个 package 对软件表现为一个 TP rank，32 个 package 构成 TP32。

当前需要并行维护两个 profile：

| Profile | 用途 | 规格 |
|---|---|---|
| P0 7R physical primary | 封装、面积、集成存储和 PPA 主规划 | 8 L + 8 H/Die，1.0 GHz 候选，96 MiB data SRAM/Die，400 mm²/Die |
| P1 compact executable | 当前搜索/回归模型 | 由 Final Tuning 搜索决定，权威值在 `spec/k3_mc_baseline.json#computeDieCandidate`；2026-09-23 修正模型后为 24 L + 8 H/Die、1.0 GHz、88 MiB data SRAM/Die（2026-09-20 的候选是 4 L + 4 H、1.2 GHz、44 MiB） |

P1 的性能回归结果不能直接宣称为 P0 7R 物理主候选的最终性能；需要先完成
P0 的 tile、kernel、MC、NoC、floorplan 和 PPA 模型。本文第 2、3 节的数字全部是 **P1** 结果。

## 1. 已确定的工作负载口径

| 项目 | 当前值 | 状态 |
| --- | ---: | --- |
| 目标 | 1000 TPS/usr，单用户 Decode | `FROZEN` |
| Batch | 1 | `FROZEN` |
| Context | 1,048,576 token | `BASELINE` |
| 模型 | K3 工程 preset，93 层、92 个 MoE 层 | `MODEL` |
| Hidden / latent | 7168 / 3584 | `MODEL` |
| Experts | 896，总 Top-16，2 个 shared expert | `MODEL` |
| Attention | 24 层 Softmax MLA + 69 层线性 Attention | `MODEL` |
| 并行 | TP=32 张卡，PP=1 | `BASELINE` |
| 工程裕量 | 1.17 | `BASELINE` |
| raw 时延预算 | 854.70 μs/token | 由目标推导 |

K3 preset 来自
[`src/core/design_engine.js`](../../src/core/design_engine.js)，属于本地工程口径，
不是已经由模型提供方签核的正式规格。模型结构、精度和层顺序在架构冻结前必须
由独立的模型清单确认。

## 2. 当前最佳 Compute Die 候选（P1）

当前 Final Tuning 搜索候选的**权威数值**在
[`spec/k3_mc_baseline.json`](spec/k3_mc_baseline.json) 的 `computeDieCandidate` 中，
由 `npm run baseline:sync` 从
[`data/rdma/k3_rdma_final_tuning_results.json`](../../data/rdma/k3_rdma_final_tuning_results.json)
生成，`tests/test_design_baseline.js` 强制两者一致。本文不再手抄数字，避免多处漂移。

| 项目 | 值 | 状态 |
| --- | ---: | --- |
| 工艺/频率 | 工艺未锁；`computeDieCandidate.frequencyGHz`（当前 1.0 GHz） | `MODEL` |
| L Core | `computeDieCandidate.lCores`（当前 24，每 Core 2×(2×128) engine） | `MODEL` |
| H Core | `computeDieCandidate.hCores`（当前 8，每 Core 4×(32×64) engine） | `MODEL` |
| BF16 Dense peak | `computeDieCandidate.bf16DenseTflops` | 推导值 |
| Vector peak | `computeDieCandidate.vectorTops` | 推导值 |
| Local SRAM | `lCore/hCore.localSramMiB`（当前 2 MiB/Core，64 MiB/Die） | `MODEL` |
| Shared SRAM | `sharedSramMiB` / `sharedSramSlices`（当前 24 MiB，16 slices） | `MODEL` |
| 总数据 SRAM | `physicalDataSramMiB`（当前 88 MiB/Die） | 推导值 |
| NoC | 抽象 mesh，`dataNocBytesPerCyclePerDirection` | `MODEL` |
| TMA | `tmaEngines` × `tmaBytesPerCyclePerEngine` | `MODEL` |
| Reduce | `reduceLanes` | `MODEL` |
| 面积 | `computeDieCandidate.estimatedAreaMm2`（含共享 SRAM 端口放大成本） | `MODEL` |
| 功耗 | `computeDieCandidate.estimatedPowerW`（同上） | `MODEL` |
| 卡功耗 | `computeDieCandidate.estimatedCardPowerW` | `MODEL` |

2026-09-23 修正 Final Tuning 模型（端口放大计费、launch 只应用一次）后重新搜索，
最佳候选从 4 L + 4 H、1.2 GHz、44 MiB/Die 移动到 24 L + 8 H、1.0 GHz、88 MiB/Die。
02、03、05 号文档的单元级描述仍基于 2026-09-20 的候选，在 P1 候选稳定前只作对照，
不作为当前规格。

其中利用率、面积和功耗系数尚未由 memory compiler、标准单元、PHY 宏和
综合/布线结果回标。自 2026-09-23 起，Final Tuning 对共享 SRAM 读写端口的
放大（`localWriteRatio`、`tmaPortWriteScale`、`sharedReadScale`）按 bank 面积
和端口功耗计入 die/card 限制，不再是无成本的带宽放大。

## 3. 当前性能结论（P1）

| MC 带宽假设 | 权威数值 | 结论 |
| --- | --- | --- |
| 320 GB/s/MC | `modelResults.referenceMc320GBs` | 参考规格兼容点，明显不达标 |
| 640 GB/s/MC | `modelResults.stretchMc640GBs` | Stretch 点（ADR-011 归为 `STRETCH/AGGRESSIVE`）；是否达到 1000 以 `acceptance.currentStatus` 为准，且即使达到也只是模型结果 |

两点的 TPS、raw/e2e 时延、compute/comm/DMA 等待时间、每 token 每卡外部读取
字节和有效 DMA 带宽都记录在上述 JSON 字段中；`README.md`、各子系统文档和
看板引用同一来源。

320 GB/s 点的计算与通信时间与 640 GB/s 点基本相同，差别几乎全部来自 DMA
等待。因此当前首要矛盾是**实现可行的 MC 聚合带宽**，而不是继续增加
Tensor peak。

Final Tuning 的所有经验缩放因子在
[`src/rdma/k3_rdma_final_tuning_model.js`](../../src/rdma/k3_rdma_final_tuning_model.js)
的 `GAIN` 表中逐项命名，证据等级均为 ASSUMPTION（B-003）。

## 4. 必须纠正的口径

### 4.1 SRAM 峰值不是每 Die

模拟器中的 122.20 MiB 峰值和 122.40 MiB window 是**整卡 8 个 Die 的
Shared SRAM 聚合工作窗口**：

- Shared SRAM 物理容量：8×24=192 MiB/卡；
- usable 0.85，再乘 window fraction 0.75：122.4 MiB/卡；
- 模拟峰值：122.20 MiB/卡；
- Local SRAM 20 MiB/Die 由 tile-fit 约束单独检查。

因此旧报告中的“122.2 MiB/Die”是标签错误，不应据此把单 Die SRAM 扩到
122 MiB。

### 4.2 “MC”存在两条不同路线

1. **本轮主线：外置 Memory Cube。** MC 只负责存储和传输，计算在
   Compute Die；对应当前 Final Tuning 模型。
2. **备选：近存计算 MC。** MC base die 内有 GEMM/vector；对应
   近存计算 MC 备选路线（另行维护，不纳入本仓库基线）。

两条路线的 MC 数量、带宽定义、功耗和数据流不同，后续文档不得混用。

## 5. 当前资料中的主要冲突

| 冲突 | 当前处理 |
| --- | --- |
| P0 为 8 L + 8 H Core、1.0 GHz；P1 由搜索决定（当前 24 L + 8 H、1.0 GHz） | 不是冲突，是两个 profile（ADR-004）；P0 是物理主规划，P1 是当前可执行回归模型；报告必须注明 profile |
| P0 Compute Die 为 400 mm² 上限；P1 估算见第 2 节 | 400 mm² 是 P0 规划上限，P1 数字只用于回归对照 |
| 卡内互联有“4×2 mesh”“双向 ring”“4+4 hierarchy”三种描述 | `BLOCKER`，统一拓扑后才可冻结 |
| 参考 MC 320 GB/s；默认搜索上限 480 GB/s；P1 最佳搜索使用 640 GB/s | `BLOCKER`，档位定义见 ADR-011，必须选定可制造档 |
| NoC 的 512 B/cycle 是分析参数，尚无可布线证明 | `OPEN`，需物理和拥塞模型 |
| Final Tuning 中大量优化使用经验缩放因子 | `BLOCKER`；因子已在 `GAIN` 表中逐项命名，共享 SRAM 端口放大已计入面积/功耗，但仍需逐项替换为事件和资源模型 |
| Attention 投影参数由 residual 拟合，不是精确 Q/K/V 图 | `BLOCKER`，需模型清单和编译 trace |
| 正式 manifest 曾与 `design_engine` preset 描述不同的 K3 | 已修正：K3 唯一来源是 `src/core/design_engine.js#MODEL_PRESETS.kimiK3`，`tests/test_k3_manifest_consistency.js` 强制一致 |

## 6. 当前可以保留的设计方向

- 异构 L/H Core，分别覆盖低复用 GEMV/Skinny GEMM 和高复用
  Attention/GEMM；
- Local SRAM + Shared SRAM 分层，TMA 与计算流水重叠；
- 8 Die/卡，2 MC/Die，NUMA 本地优先；
- 远端 SRAM 可寻址、commit/ready/ACK/epoch 生命周期；
- LSE 使用 m/l/O 语义归约，不作为普通 FP32 sum；
- 以 tile 为抢占、同步和性能核算单位；
- Decode 小消息与 Prefill 大流量采用独立 QoS/VC。

这些是可继续深化的架构方向，但还不是已签核实现。
