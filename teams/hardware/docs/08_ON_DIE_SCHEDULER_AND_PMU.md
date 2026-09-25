# 片上调度器与 PMU 设计

> 当前发布点依赖的调度与映射机制（TMA 通道、KV 跨层预取、DMA 抢占、launch batching）及其逐项回退见
> [`docs/architecture/21_TPS_DESIGN_BASELINE.md`](../../../docs/architecture/21_TPS_DESIGN_BASELINE.md) 第 4、5 节。

本文是原 `docs/architecture/08_SCHEDULER_AND_SOFTWARE.md` 的硬件部分（2026-09-25 拆分）。编译器、
TP Group / Card 两级 runtime 调度和固件见
[`teams/software/docs/COMPILER_RUNTIME_AND_FIRMWARE.md`](../../software/docs/COMPILER_RUNTIME_AND_FIRMWARE.md)；
硬件调度器消费的 tile descriptor 由 [`docs/architecture/contracts/TILE_IR.md`](../../../docs/architecture/contracts/TILE_IR.md) 定义。

## 1. 调度层级中的硬件部分

四级调度中，TP Group Scheduler 和 Card Scheduler 由 runtime 执行；下面两级在 Die 内由硬件执行。

### 1.1 Die Dispatcher

- 选择 L/H Core；
- 优先数据本地性；
- 控制 Shared SRAM slice；
- 分配 collective mailbox；
- 在 tile 边界迁移，不迁移正在执行的 Tensor wave。

### 1.2 Core Tile Scheduler

- 维护 Tensor、Vector、TMA dependency；
- 双缓冲/多缓冲；
- partial-ready；
- launch batching；
- scoreboard 和 event；
- fault/poison 停止后续 consumer。

## 2. 动态决策

运行期由硬件决定的事项（编译器只给出约束，见软件文档第 3 节）：

- TMA 发起时刻；
- ready tile 的 Core 选择；
- MC/NoC credit；
- partial-ready 启动；
- 故障绕行和降频。

## 3. 低开销要求（硬件侧）

当前 launch 时间模型约 8.89 μs/token。硬件侧冻结目标：

- 常规 tile command 无 host doorbell；
- descriptor 预取；
- command batch；
- completion 合并；
- 控制 NoC 不被数据包阻塞；
- 可测量每类 launch stall。

## 4. PMU

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

## 5. 冻结交付物

- ISA/command queue；
- Die Dispatcher / Core Tile Scheduler 状态机；
- PMU 事件表；
- 软件 golden trace 的硬件回放测试。
