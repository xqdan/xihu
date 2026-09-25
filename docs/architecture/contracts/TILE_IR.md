# Tile IR 契约

- 所有者：Architecture Council（接口变更需 Hardware、Software、Model 三团队 review，并记录 ADR）
- 生产者：编译器（[`teams/software/docs/COMPILER_RUNTIME_AND_FIRMWARE.md`](../../../teams/software/docs/COMPILER_RUNTIME_AND_FIRMWARE.md)）
- 消费者：Die Dispatcher / Core Tile Scheduler（[`teams/hardware/docs/08_ON_DIE_SCHEDULER_AND_PMU.md`](../../../teams/hardware/docs/08_ON_DIE_SCHEDULER_AND_PMU.md)）、模拟器、RTL
- 来源：原 `docs/architecture/08_SCHEDULER_AND_SOFTWARE.md` 第 2 节（2026-09-25 拆分，内容未改）

## 1. Tile descriptor 字段

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

## 2. 约束

Tile IR 是编译器、模拟器和 RTL 之间的共同契约。性能模型不得继续只靠算子名称匹配优化。

## 3. 冻结交付物

- Tile IR 文本定义和 binary descriptor 编码；
- 每个字段的合法取值、默认值和版本规则；
- 编译器输出与硬件回放共用的 golden trace 格式。
