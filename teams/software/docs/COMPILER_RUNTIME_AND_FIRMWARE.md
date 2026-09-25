# 编译器、Runtime 与固件设计

> 当前发布点依赖的调度与映射机制（TMA 通道、KV 跨层预取、DMA 抢占、PV 按层合并、softmax/逐元素融合、
> FP8 KV、launch batching）及其逐项回退见 [`docs/architecture/21_TPS_DESIGN_BASELINE.md`](../../../docs/architecture/21_TPS_DESIGN_BASELINE.md) 第 4、5 节。

本文是原 `docs/architecture/08_SCHEDULER_AND_SOFTWARE.md` 的软件部分（2026-09-25 拆分）。四级调度中
Die Dispatcher、Core Tile Scheduler 和 PMU 属于硬件，见
[`teams/hardware/docs/08_ON_DIE_SCHEDULER_AND_PMU.md`](../../hardware/docs/08_ON_DIE_SCHEDULER_AND_PMU.md)；
两者之间的 Tile IR 是跨团队契约，见 [`docs/architecture/contracts/TILE_IR.md`](../../../docs/architecture/contracts/TILE_IR.md)。

## 1. 软件层级

```text
Model compiler
  -> graph lowering
  -> operator fusion
  -> tile planning
  -> static schedule template

Runtime
  -> TP group scheduler
  -> card scheduler
  -> die dispatcher        (硬件，见 teams/hardware/docs/08)
  -> core tile scheduler   (硬件，见 teams/hardware/docs/08)

Firmware
  -> link/MC bring-up
  -> queue and memory management
  -> fault handling/DVFS
  -> telemetry
```

编译器输出 Tile IR（[`TILE_IR.md`](../../../docs/architecture/contracts/TILE_IR.md)）。性能模型不得继续只靠
算子名称匹配优化。

## 2. Runtime 调度层级

### 2.1 TP Group Scheduler

- 32 卡 gang admission；
- 检查所有 rank 的 queue、MC、温度和 fabric credit；
- 分配 collective epoch；
- 以最慢 rank 完成一个 token step；
- 超时/故障触发 group abort 或降级。

### 2.2 Card Scheduler

- 8 Die 分工；
- 本地 MC home 与 NUMA；
- card-local collective；
- Decode/Prefill QoS；
- 每 Die 功率和温度均衡。

Card Scheduler 以 command batch 形式向 Die Dispatcher 下发 tile；Die 内的 Core 选择和 tile 级依赖由硬件完成。

## 3. 静态与动态划分

编译期静态确定：

- 93 层顺序；
- 每层算子图；
- Tensor shape 和基础 tile；
- 权重/KV shard；
- collective 类型；
- buffer 生命周期。

运行期动态决定（大部分由硬件调度器执行，编译器只给出约束）：

- TMA 发起时刻；
- ready tile 的 Core 选择；
- MC/NoC credit；
- expert token packing；
- partial-ready 启动；
- Decode/Prefill QoS；
- 故障绕行和降频。

## 4. 低开销要求

1000 TPS 下 host 不应逐 kernel 介入。建议 host 每个请求或多个 token 下发
高层命令，device 持久执行完整 decode-step schedule（persistent decode）。

当前 launch 时间模型约 8.89 μs/token。软件侧冻结目标：

- 常规 tile command 无 host doorbell；
- command batch；
- completion 合并；
- 可测量每类 launch stall。

硬件侧对应要求（descriptor 预取、控制 NoC 隔离、completion 合并的硬件支持）见
[`teams/hardware/docs/08_ON_DIE_SCHEDULER_AND_PMU.md`](../../hardware/docs/08_ON_DIE_SCHEDULER_AND_PMU.md) 第 3 节。

## 5. 冻结交付物

- TP Group / Card 两级调度状态机；
- 内存分配和 epoch 管理；
- 编译器 mapping 规则；
- 固件 bring-up、fault、DVFS；
- 软件 golden trace（供硬件回放测试使用）。

Tile IR 与 binary descriptor 的冻结见 [`TILE_IR.md`](../../../docs/architecture/contracts/TILE_IR.md)。
