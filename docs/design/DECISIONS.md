# 架构决策记录

## ADR-001：目标口径

- 日期：2026-09-20
- 决策：以 B=1、Context=1M、TP32、PP1、1000 TPS/usr 为主目标。
- 状态：`FROZEN`
- 备注：架构冻结门槛建议为 1050 TPS/usr，P99 不低于 1000。

## ADR-002：主存储路线

- 日期：2026-09-20
- 决策：本轮以外置 Memory Cube 为主线，MC 不承担 Tensor/GEMM。
- 状态：`BASELINE`
- 影响：近存计算 MC 文档保留为备选，不与主线性能数字混用。

## ADR-003：卡级组织

- 日期：2026-09-20
- 决策：8 Compute Die + 16 MC，每 Die 本地 2 MC；一张卡是一个 TP rank。
- 状态：`BASELINE`

## ADR-004：Compute Die 候选

- 日期：2026-09-20
- 决策：以 4 L Core + 4 H Core、1.2 GHz、44 MiB 数据 SRAM 作为细化起点。
- 状态：`MODEL`
- 说明：只有在 MC 和 tile 模型闭合后才能冻结。

## ADR-005：SRAM 统计口径

- 日期：2026-09-20
- 决策：122.20 MiB peak 是整卡 Shared SRAM 工作窗口峰值，不是每 Die。
- 状态：`FROZEN`

## ADR-006：远端 SRAM 语义

- 日期：2026-09-20
- 决策：保留 write→visible→commit/ready→consume→ACK→release→epoch reuse。
- 状态：`BASELINE`

## ADR-007：LSE 归约

- 日期：2026-09-20
- 决策：使用 m/l/O online-softmax 语义，不允许按普通 sum 近似。
- 状态：`FROZEN`

## ADR-008：卡内拓扑

- 日期：2026-09-20
- 候选：4×2 mesh + 4+4 hierarchical reduce。
- 状态：`OPEN`
- 关闭条件：packet 模型、封装 floorplan 和 PPA 同时通过。

## ADR-009：MC 性能点

- 日期：2026-09-20
- 决策：320 GB/s/MC 是当前参考兼容点；640 GB/s/MC 只能标为 Stretch。
- 状态：`FROZEN`
- 影响：998.81 TPS 不能作为已实现承诺。

## ADR-010：7-reticle 单芯片物理边界

- 日期：2026-09-21
- 决策：将一个 7-reticle advanced package 定义为单芯片系统边界；包含 8 个 Compute Die、16 个 Memory Cube、package-local fabric、collective 和 scale-out endpoint。一个 package 是一个 TP rank，32 个 package 构成 TP32。
- 状态：`BASELINE`
- 物理主候选：8×400 mm² Compute Die、16×100 mm² MC、96 MiB data SRAM/Die、256 GB/package 优先容量档。
- 兼容模型：现有 4 L + 4 H、44 MiB/Die、约 259.57 mm²/Die 仅作为 compact executable profile。
- 关闭条件：7R placement/bump/RDL、P0 tile/PPA model、MC payload 和 package thermal 通过联合签核。
