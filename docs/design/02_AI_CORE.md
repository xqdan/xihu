# AI Core 子系统设计

> 本文的单元级数字基于 2026-09-20 的 P1 候选（4 L + 4 H、1.2 GHz）。2026-09-23 修正
> Final Tuning 模型后，P1 最佳候选移动到 24 L + 8 H、1.0 GHz（`spec/k3_mc_baseline.json`），
> 本文在 P1 候选稳定前只作对照。

## 1. 目标与边界

AI Core 负责 Tensor、Vector 和局部数据编排。本文冻结到单元级，不展开
Tensor PE 内部、乘法器实现、寄存器文件 bitcell 或具体流水级。

当前采用异构 Core：

- L Core：面向 GEMV、Skinny GEMM、Decode FFN 和低复用投影；
- H Core：面向 Attention QK/PV、较高复用 GEMM 和 Prefill；
- Vector：RMSNorm、RoPE、Softmax、SiLU、量化、路由和归约尾部；
- TMA：MC/Shared/Local 之间的 tile 搬运。

## 2. 单 Die 基线

| 单元 | 数量 | 频率 | 主要规格 | 状态 |
| --- | ---: | ---: | --- | --- |
| L Core | 4 | 1.2 GHz | 每 Core 8×(1×256) Tensor engine | `BASELINE` |
| H Core | 4 | 1.2 GHz | 每 Core 8×(16×128) Tensor engine | `BASELINE` |
| Vector | 8 | 1.2 GHz | 每 Core 512 lanes | `MODEL` |
| TMA | 8 组 | 1.2 GHz | 每 Core 4 engines×512 B/cycle | `MODEL` |

### 2.1 L Core

每 Core：

- 8 个逻辑 Tensor engine；
- 每 engine 每周期完成 1×256 个 BF16 MAC；
- 每 Core 共 2048 MAC/cycle；
- BF16 计算按 2 FLOP/MAC；
- 1 MiB Local SRAM；
- 64 banks，逻辑 bank 数据宽度 32 B/cycle；
- 512-lane Vector；
- 4 个 TMA engine。

4 个 L Core 的 BF16 Dense peak：

```text
4 × 8 × 1 × 256 × 2 × 1.2 GHz = 19.6608 TFLOPS/Die
```

### 2.2 H Core

每 Core：

- 8 个逻辑 Tensor engine；
- 每 engine 每周期完成 16×128 个 BF16 MAC；
- 每 Core 共 16384 MAC/cycle；
- 4 MiB Local SRAM；
- 64 banks，逻辑 bank 数据宽度 32 B/cycle；
- 512-lane Vector；
- 4 个 TMA engine。

4 个 H Core 的 BF16 Dense peak：

```text
4 × 8 × 16 × 128 × 2 × 1.2 GHz = 157.2864 TFLOPS/Die
```

单 Die 合计 BF16 Dense peak 为 176.9472 TFLOPS。该值是数学 peak，
不是可持续性能。

## 3. 单元级接口

每个 Core 至少具有：

| 接口 | 方向 | 最低语义 |
| --- | --- | --- |
| Command queue | 入 | tile opcode、shape、dtype、地址、依赖 token |
| TMA descriptor | 双向 | 2D/3D stride、gather/scatter、padding、convert |
| Local SRAM ports | 双向 | Tensor、Vector、TMA 分配独立仲裁类 |
| Data NoC endpoint | 双向 | Shared SRAM/其他 Core tile 传输 |
| Control NoC endpoint | 双向 | command、completion、fault、barrier |
| Collective endpoint | 双向 | partial/result、epoch、ready/ACK |
| PMU/debug | 出 | cycle、stall、bank conflict、utilization、ECC |

Tensor、Vector、TMA 可并行，但必须由 scoreboarding 保证：

- producer tile 写完后 consumer 才能读；
- TMA 不覆盖仍被 Tensor/Vector 使用的 buffer；
- collective 未 release 的 mailbox 不得复用；
- fault/poison 必须沿 tile dependency 传播。

## 4. 支持的数据类型

架构规划至少覆盖：

- BF16 Tensor 和 Vector；
- FP16 可选兼容；
- FP32 accumulation；
- FP8/INT8 Tensor；
- MXFP4/NVFP4 权重解包和缩放；
- INT32/INT16 地址、计数和路由元数据。

当前性能模型把 routed expert 权重按 17/32 byte/parameter 计，其他权重按
BF16 计。该精度组合是最大的性能敏感项之一，必须在模型清单冻结时确认。

## 5. 算子映射

| 算子/tile | 首选单元 | 关键限制 |
| --- | --- | --- |
| Attention projection | L Core | 低 batch、权重流式 |
| QK/PV | H Core | KV tile、head tile、局部累加 |
| Online softmax | Vector | m/l/O 生命周期与 FP32 精度 |
| Linear Attention state | H + Vector | 状态 read-modify-write |
| Wdown/Router/Wup | L Core | 小矩阵与 collective 边界 |
| Expert gate/up/down | L Core | token packing、低 M 利用率 |
| Shared experts | L Core | 两个 shared 分支与 routed 合并 |
| RMSNorm/RoPE/SiLU | Vector | Local SRAM 端口和 launch |
| LM head | L Core | 最后一层大权重流 |

## 6. 当前模型风险

1. 88% matrix utilization 是 Final Tuning 假设，不是由阵列波形推导。
2. “attention fusion”“token packing”“Wup/router fusion”目前以缩放因子
   表示，需要替换成具体融合 kernel。
3. 1×256 和 16×128 是逻辑阵列形状，物理子阵列划分尚未定义。
4. Vector lane 的操作集合、SFU 数量、跨 lane reduction 和寄存器容量未定。
5. 1.2 GHz 尚无 PVT、线长和 SRAM macro 时序证明。

## 7. AI Core 冻结交付物

- Core 单元框图和端口表；
- Tensor/Vector ISA 与 tile descriptor；
- 支持 shape/dtype 列表；
- Tensor/Vector/TMA 并发状态机；
- 每类 kernel 的 cycle 模型和 golden trace；
- Local SRAM bank 映射；
- 面积/功耗初算与时钟约束；
- 关键算子仿真：MLA、Linear Attention、MoE、LM Head。
