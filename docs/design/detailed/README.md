# Detailed Architecture Design Document Set

本目录是 Stage B 详细架构设计的模块化文档入口。详细设计遵循：

```text
B0 候选/配置/证据绑定
  -> B1 manifest + arithmetic intensity + Roofline + sizing
  -> B2 tile/memory + NoC/collective + kernel events
  -> B3 scheduler/software + PPA/thermal/RAS
  -> B4 fine TPS integration
  -> B5 independent verification and feedback
```

详细设计不是在 Stage A 之后盲目展开所有模块，而是每个工作包都有一个 decision question、输入契约、输出证据和退出条件。

## 文档地图

| 文档 | Agent | 工作包 | 关键问题 |
|---|---|---|---|
| [00_DETAILED_DESIGN_CONTROL_PLANE.md](00_DETAILED_DESIGN_CONTROL_PLANE.md) | A0/Q0 | B0 | 本次量化哪个候选、模型和 profile？ |
| [01_Q1_MANIFEST_OPERATOR_SPEC.md](01_Q1_MANIFEST_OPERATOR_SPEC.md) | Q1 | B1 | 是否能生成统一 operator DAG？ |
| [02_Q2_ARITHMETIC_INTENSITY_ROOFLINE_SPEC.md](02_Q2_ARITHMETIC_INTENSITY_ROOFLINE_SPEC.md) | Q2 | B1 | 方向在算术强度和资源墙下是否成立？ |
| [03_Q3_TILE_MEMORY_EVENT_SPEC.md](03_Q3_TILE_MEMORY_EVENT_SPEC.md) | Q3 | B2 | tile 如何使用 SRAM/TMA/MC？ |
| [04_Q4_NOC_COLLECTIVE_EVENT_SPEC.md](04_Q4_NOC_COLLECTIVE_EVENT_SPEC.md) | Q4 | B2 | packet、credit、collective 如何执行？ |
| [05_Q5_KERNEL_CYCLE_SPEC.md](05_Q5_KERNEL_CYCLE_SPEC.md) | Q5 | B2 | core pipeline 的真实 cycle 是多少？ |
| [06_Q6_SCHEDULER_EVENT_SPEC.md](06_Q6_SCHEDULER_EVENT_SPEC.md) | Q6 | B3 | 软件和硬件事件如何形成 critical path？ |
| [07_Q7_PPA_THERMAL_RAS_SPEC.md](07_Q7_PPA_THERMAL_RAS_SPEC.md) | Q7 | B3 | 事件路径是否满足 PPA/thermal/RAS？ |
| [08_Q8_FINE_TPS_INTEGRATION_SPEC.md](08_Q8_FINE_TPS_INTEGRATION_SPEC.md) | Q8 | B4 | 细粒度路径产生多少 TPS/usr？ |
| [09_Q9_VERIFICATION_GATE_SPEC.md](09_Q9_VERIFICATION_GATE_SPEC.md) | Q9 | B5 | 证据是否足以签核或回流？ |

## 公共契约

- [详细设计 Operating Model](../19_DETAILED_ARCHITECTURE_OPERATING_MODEL.md)
- [Arithmetic Intensity Agent](../16_ARITHMETIC_INTENSITY_AGENT.md)
- [Agent Catalog and Interaction Protocol](../18_AGENT_CATALOG_AND_INTERACTION_PROTOCOL.md)
- [ADR-0001 exploratory Stage B](../decisions/ADR-0001-exploratory-stage-b-tp-sweep.md)
- `data/analysis/detailed_architecture_operating_model.json`

## 产物目录

```text
data/detailed/
  model_manifests/
  operator_ledgers/
  roofline/
  tile_events/
  packet_events/
  kernel_cycles/
  schedule_events/
  ppa/
  performance_results/

models/detailed/
reports/detailed/
verification/detailed/
```

当前仓库仍处于探索性 Stage B：Q1/Q2 有 planning 级 K3 ledger，Q3-Q8 因 D-Gate、manifest 和 event model 未闭合而保持 blocked。目录先定义清楚，避免后续 agent 把不同阶段的结果混在一起。
