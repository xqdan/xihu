# K3 1000 TPS/usr 芯片设计文档集

- [`teams/council/docs/AGENT_WORKSTREAM_PLAN.md`](../../teams/council/docs/AGENT_WORKSTREAM_PLAN.md)：并行 agent workstream、依赖图、合并顺序和签核闸门。
- [`teams/council/docs/AGENT_METRICS_MATRIX.md`](../../teams/council/docs/AGENT_METRICS_MATRIX.md)：A0–A13 按模块拆解的量化指标、交付物、依赖和退出条件。

版本：2026-09-26。

本目录把现有搜索和模拟器整理成一套可逐步冻结的芯片设计文档。硬件规格只有一份（P1，ADR-0021）。
目标交付深度为**单元级**：明确 Tensor Core、Vector Core、TMA、SRAM、
NoC、MC 接口、Die 间互联、Scale-out/RDMA、调度和封装等单元的数量、
接口、拓扑、位宽、性能预算和验证条件；单元内部流水线与 RTL 暂不展开。

## 1. 当前结论

1. 工作负载暂定为 K3 工程 preset：93 层、B=1、Context=1M、
   TP=32、PP=1，目标为 1000 TPS/usr。K3 的形状唯一来源是
   `teams/model/src/design_engine.js#MODEL_PRESETS.kimiK3`。
2. 当前发布点 1101.77 TPS/usr（`MODEL`）及其计算过程见 `00_CURRENT_STATE.md` 第 3 节和
   `teams/hardware/inputs/k3_mc_baseline.json#modelResults`；是否达标以 `acceptance.currentStatus` 为准。
   支撑该结果的全部软硬件设计、逐项回退和变更控制见
   [`21_TPS_DESIGN_BASELINE.md`](21_TPS_DESIGN_BASELINE.md)（`teams/hardware/inputs/k3_mc_baseline.json#tpsDesign`）。
3. 该结果使用的是每颗 MC **640 GB/s** 的 Stretch 搜索假设（ADR-0019）。
   本地 Memory Cube 参考规格给出的 KGD 最大单向带宽是
   **320 GB/s/颗**。在相同 Compute Die 和优化参数下，320 GB/s 点明显不达标。
4. 因此目前不能把 MC640 结果视为已经证明可实现的芯片指标。首先需要
   冻结可制造的 MC 带宽与连接方式，再冻结 Compute Die。
5. 当前路线以**外置 Memory Cube**为主：MC 提供容量和带宽，矩阵计算仍在
   Compute Die。带 GEMM base die 的近存计算 MC 是备选路线，不混入本轮基线。

## 2. 状态标记

| 标记 | 含义 |
| --- | --- |
| `FROZEN` | 项目目标或已明确约束，修改需走设计变更 |
| `BASELINE` | 当前推荐基线，可进入细化设计，但尚未物理签核 |
| `MODEL` | 仅由性能/PPA 模型假设得到，必须校准 |
| `OPEN` | 尚未决定或现有资料相互冲突 |
| `BLOCKER` | 不关闭就不能宣称达到目标或冻结架构 |

## 3. 文档索引

### 高层架构总纲

- [HIGH_LEVEL_ARCHITECTURE.md](HIGH_LEVEL_ARCHITECTURE.md)：K3 1000 TPS/usr 高层架构、模块边界、详细设计文档树、接口契约、里程碑和签核门槛。
- [19_DETAILED_ARCHITECTURE_OPERATING_MODEL.md](../../teams/council/docs/19_DETAILED_ARCHITECTURE_OPERATING_MODEL.md)：详细设计按 B0-B5 工作包组织，定义 Q1-Q9 的输入、输出、约束、并行关系和方向回流。
- [detailed/README.md](../../teams/council/docs/detailed/README.md)：Q0-Q9 详细设计规格、任务卡、handoff packet 和产物目录。

文档按签核团队存放：本目录只放系统级、跨团队的文档；硬件单元设计在 `teams/hardware/docs/`，
软件设计在 `teams/software/docs/`，模型部署方案在 `teams/model/docs/deployment/`。
原 `08_SCHEDULER_AND_SOFTWARE.md` 已于 2026-09-25 拆成下表中的软件、硬件和 Tile IR 契约三份。

#### 系统级（本目录，Council）

| 文档 | 负责范围 |
| --- | --- |
| [00_CURRENT_STATE.md](00_CURRENT_STATE.md) | 已确定事项、冲突、证据等级和当前性能 |
| [01_SYSTEM_ARCHITECTURE.md](01_SYSTEM_ARCHITECTURE.md) | 系统边界、卡/Die/MC 分层和端到端数据流 |
| [10_TILE_SIMULATION.md](10_TILE_SIMULATION.md) | 算子/tile 模型、资源竞争、校准和签核标准 |
| [11_PLAN_AND_DELIVERABLES.md](11_PLAN_AND_DELIVERABLES.md) | 分阶段设计计划、里程碑、交付物和退出条件 |
| [21_TPS_DESIGN_BASELINE.md](21_TPS_DESIGN_BASELINE.md) | 支撑 TPS/usr 发布点的软硬件设计基线：时间账、单元规格、软件机制、逐项回退、敏感度与变更控制（ADR-0005） |
| [ADR 索引](../../teams/council/adr/README.md) | 架构决策记录（`teams/council/adr/`，四位编号） |
| [OPEN_ISSUES.md](OPEN_ISSUES.md) | 阻塞项、责任子系统和关闭证据 |
| [teams/hardware/inputs/k3_mc_baseline.json](../../teams/hardware/inputs/k3_mc_baseline.json) | 唯一硬件规格与回归数值（P1，含 package 面积约束） |
| [13_MULTI_MODEL_ARCHITECTURE.md](13_MULTI_MODEL_ARCHITECTURE.md) | K3 / GLM-5.2 / DeepSeek-V4-Pro 多模型架构调整 |
| [14_TPS_OBSERVATION_METRICS.md](14_TPS_OBSERVATION_METRICS.md) | TPS 观测指标矩阵和证据状态 |
| [contracts/TILE_IR.md](contracts/TILE_IR.md) | Tile IR 契约：编译器、硬件调度器、模拟器和 RTL 共用的 tile descriptor |
| [contracts/](contracts/README.md) | 其他跨团队接口 contract |

#### 硬件单元设计（`teams/hardware/docs/`，Hardware）

| 文档 | 负责范围 |
| --- | --- |
| [02_AI_CORE.md](../../teams/hardware/docs/02_AI_CORE.md) | L/H AI Core、Tensor、Vector 和执行接口 |
| [03_TMA_AND_SRAM.md](../../teams/hardware/docs/03_TMA_AND_SRAM.md) | TMA、本地 SRAM、共享 SRAM、bank 与生命周期 |
| [04_MEMORY_SUBSYSTEM_MC.md](../../teams/hardware/docs/04_MEMORY_SUBSYSTEM_MC.md) | Memory Cube、容量、带宽、地址映射和 MC 控制器 |
| [05_ON_DIE_NOC.md](../../teams/hardware/docs/05_ON_DIE_NOC.md) | 单 Die NoC 拓扑、位宽、VC、QoS 和流控 |
| [06_MULTIDIE_AND_SCALEOUT.md](../../teams/hardware/docs/06_MULTIDIE_AND_SCALEOUT.md) | 8 Die 卡内扩展、TP32 和板间物理拓扑 |
| [07_COLLECTIVE_RDMA.md](../../teams/hardware/docs/07_COLLECTIVE_RDMA.md) | 远端 SRAM 语义、归约引擎、epoch 和可靠性 |
| [08_ON_DIE_SCHEDULER_AND_PMU.md](../../teams/hardware/docs/08_ON_DIE_SCHEDULER_AND_PMU.md) | Die Dispatcher、Core Tile Scheduler、硬件侧低开销要求和 PMU |
| [09_PACKAGE_POWER_RAS.md](../../teams/hardware/docs/09_PACKAGE_POWER_RAS.md) | 封装、I/O 岸线、功耗、时钟、散热和 RAS |

#### 软件设计（`teams/software/docs/`，Software）

| 文档 | 负责范围 |
| --- | --- |
| [KERNEL_SPEC.md](../../teams/software/docs/KERNEL_SPEC.md) | K3 发布点 K1–K8 kernel 族：单元、shape、限制因素、时长 |
| [COLLECTIVE_SCHEDULE.md](../../teams/software/docs/COLLECTIVE_SCHEDULE.md) | 393 次集合通信的构成、依赖与重叠、τ 敏感性；GLM/DS 集合通信 |
| [PRECISION_POLICY.md](../../teams/software/docs/PRECISION_POLICY.md) | 三个模型的 dtype、取整点、集合通信精度、确定性与精度验收 |
| [MULTI_MODEL_LOWERING.md](../../teams/software/docs/MULTI_MODEL_LOWERING.md) | GLM-5.2 / DeepSeek-V4-Pro 到 kernel 族的映射与新增 kernel |
| [COMPILER_RUNTIME_AND_FIRMWARE.md](../../teams/software/docs/COMPILER_RUNTIME_AND_FIRMWARE.md) | 编译器、runtime 调度、launch 账、persistent decode、KV 分页（提案） |

#### 模型部署方案（`teams/model/docs/deployment/`，Model）

| 文档 | 负责范围 |
| --- | --- |
| [deployment/README.md](../../teams/model/docs/deployment/README.md) | 三个模型共同的部署决定与机器可读来源 |
| [K3.md](../../teams/model/docs/deployment/K3.md) · [GLM-5.2.md](../../teams/model/docs/deployment/GLM-5.2.md) · [DeepSeek-V4-Pro.md](../../teams/model/docs/deployment/DeepSeek-V4-Pro.md) | 逐模型的切分、dtype、KV/index 布局、每 rank 容量、集合通信次数和未闭合项 |
| [OPERATOR_LEDGER.md](../../teams/model/docs/deployment/OPERATOR_LEDGER.md) · [SCENARIO_MATRIX.md](../../teams/model/docs/deployment/SCENARIO_MATRIX.md) | 规划算子账与 token-time 系数；场景矩阵与选择政策 |

#### 运行模型（`teams/council/docs/`，Council）

| 文档 | 负责范围 |
| --- | --- |
| [15_MODELING_REVIEW_BY_AGENT.md](../../teams/council/docs/15_MODELING_REVIEW_BY_AGENT.md) | 按 agent 的建模评审 |
| [16_ARITHMETIC_INTENSITY_AGENT.md](../../teams/council/docs/16_ARITHMETIC_INTENSITY_AGENT.md) | 算术强度 / Roofline / sizing agent |
| [17_TWO_STAGE_ARCHITECTURE_OPERATING_MODEL.md](../../teams/council/docs/17_TWO_STAGE_ARCHITECTURE_OPERATING_MODEL.md) | Stage A 方向 / Stage B 量化两阶段流程 |
| [18_AGENT_CATALOG_AND_INTERACTION_PROTOCOL.md](../../teams/council/docs/18_AGENT_CATALOG_AND_INTERACTION_PROTOCOL.md) | agent 目录与交互协议 |
| [20_INDUSTRIAL_AGENT_ORGANIZATION.md](../../teams/council/docs/20_INDUSTRIAL_AGENT_ORGANIZATION.md) | 工业界团队组织 |

#### 验证（`teams/vv/docs/`，V&V）

| 文档 | 负责范围 |
| --- | --- |
| [VV_PLAN.md](../../teams/vv/docs/VV_PLAN.md) | 证据等级、测试分组与守恒检查、D-Gate / Q-Gate 判定和待补验证项 |

## 4. 设计文档完成定义

每个子系统文档进入 `FROZEN` 前至少要包含：

- 功能和非功能需求；
- 单元级框图与实例数量；
- 所有上下游接口、数据宽度、时钟域和流控；
- 容量、带宽、延迟、吞吐、面积和功耗预算；
- 正常流程、背压流程、错误流程和复位流程；
- 算子/tile 映射及最坏资源并发；
- 可执行模型或回归测试；
- 未决项为零，或者有明确的风险接受记录。

## 5. 基线复算

```sh
npm test
node tests/regression/test_design_baseline.js
```

机器可读基线中的数字由当前 Final Tuning 模型回归。它们是工程模型结果，
不是硅上保证。
