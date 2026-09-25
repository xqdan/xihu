# 调度器、编译器与固件设计

> 当前发布点依赖的调度与映射机制（TMA 通道、KV 跨层预取、DMA 抢占、PV 按层合并、softmax/逐元素融合、
> FP8 KV、launch batching）及其逐项回退见 [`21_TPS_DESIGN_BASELINE.md`](21_TPS_DESIGN_BASELINE.md) 第 4、5 节。

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
  -> die dispatcher
  -> core tile scheduler

Firmware
  -> link/MC bring-up
  -> queue and memory management
  -> fault handling/DVFS
  -> telemetry
```

## 2. Tile IR

每个 tile descriptor 至少包含：

- opcode、dtype、accumulation dtype；
- M/N/K 或 attention/state shape；
- source/destination address；
- strides、layout、quant scale；
- Core class：L/H/Vector/Collective；
- TMA program；
- dependency token；
- output event；
- collective epoch；
- partial-ready threshold；
- priority/QoS；
- timeout 和 fault policy。

Tile IR 是编译器、模拟器和 RTL 之间的共同契约。性能模型不得继续只靠
算子名称匹配优化。

## 3. 调度层级

### 3.1 TP Group Scheduler

- 32 卡 gang admission；
- 检查所有 rank 的 queue、MC、温度和 fabric credit；
- 分配 collective epoch；
- 以最慢 rank 完成一个 token step；
- 超时/故障触发 group abort 或降级。

### 3.2 Card Scheduler

- 8 Die 分工；
- 本地 MC home 与 NUMA；
- card-local collective；
- Decode/Prefill QoS；
- 每 Die 功率和温度均衡。

### 3.3 Die Dispatcher

- 选择 L/H Core；
- 优先数据本地性；
- 控制 Shared SRAM slice；
- 分配 collective mailbox；
- 在 tile 边界迁移，不迁移正在执行的 Tensor wave。

### 3.4 Core Tile Scheduler

- 维护 Tensor、Vector、TMA dependency；
- 双缓冲/多缓冲；
- partial-ready；
- launch batching；
- scoreboard 和 event；
- fault/poison 停止后续 consumer。

## 4. 静态与动态划分

静态确定：

- 93 层顺序；
- 每层算子图；
- Tensor shape 和基础 tile；
- 权重/KV shard；
- collective 类型；
- buffer 生命周期。

动态决定：

- TMA 发起时刻；
- ready tile 的 Core 选择；
- MC/NoC credit；
- expert token packing；
- partial-ready 启动；
- Decode/Prefill QoS；
- 故障绕行和降频。

## 5. 低开销要求

1000 TPS 下 host 不应逐 kernel 介入。建议 host 每个请求或多个 token 下发
高层命令，device 持久执行完整 decode-step schedule。

当前 launch 时间模型约 8.89 μs/token。冻结目标：

- 常规 tile command 无 host doorbell；
- descriptor 预取；
- command batch；
- completion 合并；
- 控制 NoC 不被数据包阻塞；
- 可测量每类 launch stall。

## 6. PMU

至少暴露：

- Tensor/Vector active cycles；
- TMA bytes/cycles/stalls；
- Local bank conflict；
- Shared slice queue；
- NoC flit/credit/VC occupancy；
- MC bandwidth/latency/replay；
- collective phase/request/timeout；
- mailbox occupancy；
- partial-ready 提前量；
- Core/Die 温度、频率和功率；
- 每 operator/tile 时间戳。

PMU 事件必须能重建模拟器使用的时间账。

## 7. 冻结交付物

- Tile IR 和 binary descriptor；
- ISA/command queue；
- 四级调度状态机；
- 内存分配和 epoch 管理；
- 编译器 mapping 规则；
- 固件 bring-up、fault、DVFS；
- PMU 事件表；
- 软件 golden trace 与硬件回放测试。
