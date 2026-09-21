# 当前设计状态与已知结论

版本：2026-09-20。

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

## 2. 当前最佳 Compute Die 候选

当前 Final Tuning 搜索候选：

| 项目 | 值 | 状态 |
| --- | ---: | --- |
| 工艺/频率 | 工艺未锁；1.2 GHz | `MODEL` |
| L Core | 4 个 | `BASELINE` |
| H Core | 4 个 | `BASELINE` |
| BF16 Dense peak | 176.95 TFLOPS/Die | 推导值 |
| Vector peak | 9.83 TOPS/Die | 推导值 |
| Local SRAM | 20 MiB/Die | `BASELINE` |
| Shared SRAM | 24 MiB/Die，8 slices | `BASELINE` |
| 总数据 SRAM | 44 MiB/Die，352 MiB/卡 | 推导值 |
| NoC | 抽象 5×5 mesh，512 B/cycle/方向 | `MODEL` |
| TMA | 每 Core 4×512 B/cycle | `MODEL` |
| Reduce | 4096 lanes/Die | `MODEL` |
| 面积 | 259.57 mm²/Die | `MODEL` |
| 功耗 | 237.46 W/Die | `MODEL` |
| 卡功耗 | 2378.36 W | `MODEL` |

这些值来自
[`data/rdma/k3_rdma_final_tuning_results.json`](../../data/rdma/k3_rdma_final_tuning_results.json)。
其中利用率、面积和功耗系数尚未由 memory compiler、标准单元、PHY 宏和
综合/布线结果回标。

## 3. 当前性能结论

| MC 带宽假设 | TPS/usr | raw | e2e | 结论 |
| --- | ---: | ---: | ---: | --- |
| 320 GB/s/MC | 546.63 | 1563.58 μs | 1829.39 μs | 参考规格兼容点，明显不达标 |
| 640 GB/s/MC | 998.81 | 855.72 μs | 1001.19 μs | Stretch 点，仍未严格达到 1000 |

640 GB/s 点的时间账：

- compute/comm 串行时间：651.91 + 131.69 μs；
- DMA 等待：72.12 μs；
- raw：855.72 μs；
- 工程裕量后：1001.19 μs；
- 每 token 每卡外部读取约 5.36 GB；
- 有效 DMA 约 6.49 TB/s/卡。

320 GB/s 点的计算与通信时间基本不变，但 DMA 等待增加到约
779.97 μs。因此当前首要矛盾是**实现可行的 MC 聚合带宽**，而不是继续增加
Tensor peak。

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
| 旧概念为 8 L + 8 H Core；最新搜索为 4 L + 4 H | 以 4+4 为当前候选，旧文档仅作参考 |
| 旧 Compute Die 为 400 mm²；最新估算 259.57 mm² | 重新做 floorplan，400 mm² 仅是上限 |
| 卡内互联有“4×2 mesh”“双向 ring”“4+4 hierarchy”三种描述 | `BLOCKER`，统一拓扑后才可冻结 |
| 参考 MC 最大 320 GB/s；最佳搜索使用 640 GB/s | `BLOCKER`，必须关闭 |
| NoC 的 512 B/cycle 是分析参数，尚无可布线证明 | `OPEN`，需物理和拥塞模型 |
| Final Tuning 中大量优化使用经验缩放因子 | `BLOCKER`，需逐项替换为事件和资源模型 |
| Attention 投影参数由 residual 拟合，不是精确 Q/K/V 图 | `BLOCKER`，需模型清单和编译 trace |

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

