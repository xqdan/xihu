# TMA 与 SRAM 子系统设计

## 1. 物理容量基线

每 Compute Die：

| 区域 | 配置 | 物理容量 |
| --- | --- | ---: |
| L Local SRAM | 4 Core×1 MiB | 4 MiB |
| H Local SRAM | 4 Core×4 MiB | 16 MiB |
| Shared SRAM | 8 slices×3 MiB | 24 MiB |
| 合计 |  | 44 MiB/Die |

整卡 8 Die 合计 352 MiB 数据 SRAM，其中 Shared SRAM 是 192 MiB。

当前模拟器使用 Shared SRAM 的 85% 可用比例和 75% working-window：

```text
8 × 24 MiB × 0.85 × 0.75 = 122.4 MiB/card
```

模拟峰值 122.20 MiB/card，说明**当前选择的工作窗口**接近满载；这不等于
每 Die 需要 122 MiB，也不等于全部 352 MiB 物理 SRAM 已满。

## 2. Local SRAM

### 2.1 L Core Local SRAM

- 1 MiB/Core；
- 64 banks；
- 32 B/cycle/bank 逻辑读宽；
- 面向权重 tile、激活、量化参数和 Tensor 输出；
- 当前最大映射需求约 0.651 MiB/Core。

### 2.2 H Core Local SRAM

- 4 MiB/Core；
- 64 banks；
- 32 B/cycle/bank 逻辑读宽；
- 面向 KV、score/probability、m/l/O partial 和 state tile；
- 当前最大映射需求约 2.134 MiB/Core。

物理实现不得把 64 banks 合成一条超宽全局总线。建议按 Tensor engine
邻近分组，每组独立 bank crossbar，再通过窄化交换网络连接 TMA/Vector。

## 3. Shared SRAM

- 8 slices/Die；
- 每 slice 3 MiB usable-data target；
- 地址按 cache-line/stripe 在 slice 间交织；
- 同时承担 MC refill、跨 Core tile、collective mailbox 和 writeback；
- Weight、Activation、KV/Partial、RDMA mailbox 采用 bank color 隔离；
- 数据 ECC、metadata parity、scrub 和 spare 开销不包含在 24 MiB 数据容量内。

建议初始 bank class：

| bank class | 目标份额 | 主要用户 |
| --- | ---: | --- |
| Weight/refill | 40% | MC DMA、专家预取 |
| Activation | 20% | Core 间交换、residual |
| KV/state | 20% | Attention、Linear state |
| Collective mailbox | 15% | RDMA receive、partial、result |
| Control/spare | 5% | descriptor、ECC、坏 bank 迁移 |

比例必须由真实 trace 回标，不能作为硬分区永久锁死。

## 4. TMA 基线

每 Core 4 个 TMA engine，每 engine 512 B/cycle，1.2 GHz。逻辑峰值：

```text
4 × 512 B/cycle × 1.2 GHz = 2.4576 TB/s/Core
```

当前模型按 80% 效率得到约 1.966 TB/s/Core。最终实现必须限制于 Local SRAM
写端口、Shared SRAM slice、NoC 和 MC 中最慢的一项，不能把 TMA engine 数量
直接视为可叠加带宽。

TMA descriptor 最少支持：

- contiguous、2D/3D strided；
- gather/scatter；
- multicast 到多个 Local SRAM；
- dtype convert/dequant；
- zero/padding；
- source/destination bounds；
- completion event；
- dependency token；
- poison/ECC error；
- partial-ready watermark。

## 5. Buffer 生命周期

推荐每类 tile 使用 generation-tagged slot：

```text
FREE
 -> FILLING
 -> VISIBLE
 -> READY
 -> CONSUMING
 -> DRAINING/ACK
 -> FREE(next generation)
```

以下对象不能隐式 alias：

- 正在接收的 RDMA slot；
- 未完成 Tensor/Vector 消费的 Local tile；
- 未 ACK 的 writeback；
- online softmax 的 m/l/O；
- 预测专家命中尚未确认的有效部分。

## 6. 端口和冲突模型

需要独立量化：

- Tensor read/write；
- Vector read/write；
- TMA fill/drain；
- collective reduce read/write；
- ECC scrub；
- debug/repair。

当前 Final Tuning 假设：

- Local write/read ratio=1.70；
- TMA 有独立端口，写侧再乘 1.55；
- read scale=1.18；
- Weight/Activation/KV-Partial bank partition。

这些值必须替换成 bank-cycle 仿真结果。验收时报告平均值、P95、P99 和最坏
bank conflict，而不是只给总 TB/s。

## 7. 冻结交付物

- SRAM macro 组合、bank/slice/row 地址图；
- 所有端口和仲裁优先级；
- ECC、scrub、repair 和容量折损；
- TMA descriptor 格式和队列深度；
- 每个算子 tile 的 buffer 表与生命周期；
- bank-cycle 模型；
- 面积、动态功耗、泄漏和时序报告。
