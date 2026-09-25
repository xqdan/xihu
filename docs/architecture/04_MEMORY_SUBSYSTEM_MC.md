# Memory Cube 存储子系统设计

## 0. 7-reticle 集成存储基线

单芯片采用一个 7-reticle package，集成 16 个 MC，每个 Compute Die 本地绑定 2 个 MC。容量优先档为 16×16 GB = 256 GB/package，早期原型可采用 16×8 GB = 128 GB/package。片上数据 SRAM 采用 96 MiB/Die、768 MiB/package 的 7R 候选，分为 64 MiB L-Core Local SRAM、16 MiB H-Core Local SRAM 和 16 MiB Shared SRAM。

7R 面积预算为 8×400 mm² Compute Die + 16×100 mm² MC = 4,800 mm²，工程 placement window 约 5,248 mm²。320 GB/s/MC 时 package raw MC payload 为 5.12 TB/s；640 GB/s/MC 为 Stretch 10.24 TB/s。7R 面积本身不能替代 MC 带宽闭合。
## 1. 路线选择

本轮主线是**外置 Memory Cube**：

- MC 内不假设 Tensor/GEMM 单元；
- 权重、KV 和线性 Attention state 存放在 MC；
- 计算发生在 Compute Die；
- MC 通过 UCIe 类链路向 Shared SRAM/TMA 提供 tile。

近存计算 MC 单独作为后备路线，不参与当前性能签核。

## 2. 参考器件

参考：
[MemoryCube reference provenance](../../references/README.md)。

KGD 规格摘录：

| 项目 | 参考值 |
| --- | --- |
| Logic node | SMIC 28 HKE+ |
| Die size | 12.6×8.1 mm，约 102 mm² |
| Capacity | 8 GB(4Hi) / 16 GB(8Hi) |
| Interface | UCIe 1.1 |
| 单 UCIe | 20 Gbps×16，40 GB/s 单向 |
| 最大单向带宽 | 8 个 UCIe，320 GB/s |
| D2D distance | ≤50 mm |

## 3. 7-Reticle Package 基线

| 项目 | 基线 |
| --- | --- |
| MC 数量 | 16/package |
| 本地关系 | 2 MC/Compute Die |
| 容量档位 | 16 GB/MC 优先，8 GB 作为降本档 |
| Package 容量 | 256 GB（16 GB 档）或 128 GB（8 GB 档） |
| 原始聚合带宽 | 5.12 TB/s/package @320 GB/s |
| 当前模型有效系数 | 0.70 |
| 模型有效聚合带宽 | 3.584 TB/s/package |

### 3.1 MC 带宽档位（ADR-0019）

| 档位 GB/s/颗 | 分类 | 用途 |
| ---: | --- | --- |
| 320 | `REFERENCE` | 参考器件 KGD 规格，P1 回归的参考兼容点 |
| 400 | `GRID` | 规格网格候选 |
| 480 | `DEFAULT_SEARCH_CAP` | 1.5× 参考值，默认搜索上限；路线 A 观测点 |
| 560 | `AGGRESSIVE` | 超过默认上限，报告必须标记 |
| 640 | `STRETCH/AGGRESSIVE` | P1 Final Tuning 的 Stretch 点，不是制造默认值 |

机器可读定义见 `teams/hardware/inputs/k3_mc_baseline.json#bandwidthTiers`。MC 数量档位为 8、16、24、32 颗/卡；16 颗是 7R 主候选。

8 GB 档已能覆盖当前 TP32 下约 49.6 GB/package的模型+状态 backing，但没有充分
覆盖多请求、Prefill、冗余和故障降容。产品容量建议先按 16 GB 档规划，
性能分析仍按带宽而不是容量决定。

## 4. 关键阻塞：带宽差一倍

当前 Final Tuning（P1）要接近 1000 TPS，需要每 MC 搜索参数 640 GB/s；参考 MC 的
320 GB/s 点明显不达标。两点的有效 DMA 带宽和 TPS 以
`teams/hardware/inputs/k3_mc_baseline.json#modelResults` 为准。

因此必须在以下方案中做出工程选择：

1. **MC-X：单颗 MC 提升到约 640 GB/s。**
   需要新的 PHY/base die，不能直接引用当前参考规格。
2. **增加 MC 数量。**
   32 MC/卡可以接近带宽需求，但当前封装边长、岸线和功耗尚不支持。
3. **每个逻辑 MC 使用两个独立 320 GB/s 数据面。**
   本质仍要求翻倍 UCIe PHY、bump、控制器和 MC 内部通道。
4. **减少每 token MC 字节。**
   通过 FP8 dense、压缩 attention/shared 权重、更多可复用 SRAM、
   算子融合或算法变更。
5. **转向近存计算 MC。**
   权重不离开 MC，但这是另一条架构路线。

在该问题关闭前，不能冻结 MC PHY、Compute Die 岸线或宣称 1000 TPS 达成。

## 5. MC 控制器功能

每 Compute Die 的 MC 子系统至少包含：

- 2 个本地 MC 端口；
- 地址 interleave 和 page-home；
- read/write/atomic/flush；
- 多队列 QoS；
- TMA 大块读与 KV/state 小写合并；
- ECC/CRC、重试、lane repair；
- link training、降速和热插拔隔离；
- telemetry：带宽、队列、重试、温度、坏页；
- NUMA miss 的远端转发接口。

## 6. 地址映射建议

建议层级：

```text
model object
 -> TP card shard
 -> local Compute Die home
 -> MC0/MC1 stripe
 -> channel
 -> bank/row
```

- 权重 tile 按连续 8 MiB 对象布局；
- KV 以 sequence/page/context-tile 为单位；
- 线性 Attention state 按 layer/head 分片；
- expert 权重按实际 Tensor tile 连续布局，避免跨 row 小步长访问；
- mailbox 不放在 MC，放在 Shared SRAM。

## 7. 带宽与延迟签核

每个 MC 必须分别给出：

- 大顺序读、随机读、读写混合；
- 8 MiB weight tile；
- 16K-token KV tile；
- 小尺寸 state read-modify-write；
- UCIe replay/ECC 开启后的 payload；
- 8/16 个 MC 同时工作时的供电/热降额；
- P50/P95/P99 first-byte latency。

不能只用峰值 320 GB/s 乘 MC 数。目标是以真实 command mix 得到可持续带宽。

## 8. 冻结条件

- MC 厂商确认容量、payload 带宽、功耗和 PHY 宏；
- 卡级并发实测或高可信协议模型；
- Compute Die 岸线、bump 和封装走线通过；
- 参考 MC 点的 tile 仿真可重现；
- 1000 TPS 路线明确是 MC-X、更多 MC、压缩字节还是近存计算；
- 故障降容和数据重映射策略完成。
