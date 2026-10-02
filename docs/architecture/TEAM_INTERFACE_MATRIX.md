# 团队接口矩阵

- 所有者：Council（维护）；核对：V&V
- 状态：`BASELINE`（现有接口）/ **`OPEN`（未闭合接口，见 §3）**
- 权威来源：各团队文档的接口章节、`docs/architecture/contracts/`、
  `integration/pipelines/generate_team_contracts.js`、`out/contracts/`

## 0. 本文补的是哪一块

`docs/architecture/contracts/` 存的是**机器可读的接口契约**（Tile IR、contract pack），
它们由 `npm run contracts` 生成、由 `test_cross_team_contracts.js` 校验。

本文补的是**没有契约文件的那些接口**：谁向谁提供什么、以什么形式、当前是"已实现"还是"口头约定"。
一张表回答：两个团队之间现在**实际**靠什么协作。

**判据**：矩阵中每一格必须指向一个产物或一份文档。
"已经说好了"不算——这是 `VV_PLAN.md` §1 的规则在团队层面的应用。

## 1. 团队与职责

| 团队 | 目录 | 职责 | Gate 角色 |
| --- | --- | --- | --- |
| Council | `teams/council/` | 系统架构、ADR、Gate 判定输入、文档索引 | 提出判据 |
| Hardware | `teams/hardware/` | 硬件单元设计、P1 硬件规格、PPA | 被验方 |
| Software | `teams/software/` | kernel、调度、精度策略、编译器/runtime | 被验方 |
| Model | `teams/model/` | 模型形状、部署布局、算子账、规划链路 | 被验方 |
| V&V | `teams/vv/` | 证据等级、测试、Gate 判定 | **判定方（独立）** |

**V&V 独立性的实现**：`tests/structure/test_project_structure.js` 强制 `teams/*` 之间不互相 `require`——
每个团队的代码不得依赖其他团队。跨团队只能通过 `out/` 产物与 `docs/architecture/contracts/` 交互。

## 2. 接口矩阵

列 = 提供方，行 = 使用方。

| 使用方 ＼ 提供方 | Council | Hardware | Software | Model | V&V |
| --- | --- | --- | --- | --- | --- |
| **Council** | ADR、文档索引 | P1 硬件规格、单元文档 | PRECISION_POLICY、KERNEL_SPEC | 部署文档、SCENARIO_MATRIX | Gate 判定结果 |
| **Hardware** | 判据与包络（面积/功耗/频率） | — | KERNEL_SPEC（资源需求）、COLLECTIVE_SCHEDULE | 模型形状与字节数 | 未测量参数清单、测量计划 |
| **Software** | 判据、`TUNING_CONTRACT` | 单元规格（可实现边界）、P1 | — | 算子账、逐层结构 | 精度签核路径 |
| **Model** | 场景矩阵政策 | 带宽/容量可实现性 | kernel 族与时长 | — | 证据等级要求 |
| **V&V** | 判据与关闭纪律 | 单元文档的可验证性 | 精度与确定性条款 | 规划链路产物 | — |

## 3. 关键接口逐条

| # | 接口 | 提供方 | 消费方 | 载体 | 状态 |
| ---: | --- | --- | --- | --- | --- |
| 1 | 模型形状（K3 唯一来源） | Model | 全部 | `teams/model/src/design_engine.js#MODEL_PRESETS.kimiK3` | `BASELINE` |
| 2 | 硬件规格（唯一） | Hardware | 全部 | `teams/hardware/inputs/k3_mc_baseline.json` | `BASELINE`（ADR-0021） |
| 3 | Tile descriptor | Software + Hardware | 编译器/调度/模拟/RTL | `docs/architecture/contracts/TILE_IR.md` | `BASELINE` |
| 4 | 算子 → 资源映射 | Model | Hardware | `workload_resource_contract.json` | 见 `contracts/README.md` |
| 5 | deployment → hardware 边界 | Hardware | Software | `deployment_hardware_contract.json` | 同上 |
| 6 | 融合合法性 | Software | 全部 | `fusion_legality_contract.md` | 同上 |
| 7 | 通信/计算 overlap | Software + Hardware | Model | `collective_overlap_contract.md` | 同上 |
| 8 | 验收指标 | Council + V&V | 全部 | `test_acceptance_contract.md` | 同上 |
| 9 | 判据与验收线 | Council | 全部 | `docs/architecture/PRODUCT_REQUIREMENTS.md` | `BASELINE`（AC 待采纳） |
| 10 | 下达指标 | Council | Hardware/Software | `DESIGN_TARGETS_AND_MARGINS.md` | `BASELINE` |
| 11 | 决策→证据链 | Council + V&V | 全部 | `DESIGN_EVIDENCE_MATRIX.md` | `BASELINE` |
| 12 | 调优参数所有权 | Software + Hardware | Model | `teams/software/docs/TUNING_CONTRACT.md` | `BASELINE` |
| 13 | MTP 调度 | Software | Model/Council | `teams/software/docs/MTP_SCHEDULING_CONTRACT.md` | 探索 |
| 14 | 未测量参数清单 | V&V | Hardware/Software/Model | `teams/vv/docs/VV_MEASUREMENT_PLAN.md` | 计划 |

## 4. 未闭合接口（矩阵中还没有载体的）

以下协作在文档里**存在**，但没有契约文件或产物支撑。登记为缺口，不假装已闭合：

| 缺口 | 双方 | 缺什么 | 影响 |
| --- | --- | --- | --- |
| 拓扑口径 | Hardware ↔ Hardware（卡内 vs 板间） | 统一拓扑与 packet 模型（B-004） | 带宽、hop、封装无法签核 |
| τ 的物理推导 | Comm Core ↔ PHY | 推导文档（B-008 / O-018） | 53% 的 raw 预算无依据 |
| MC 供应商规格 | Hardware ↔ 外部 | 规格书（B-002） | 发布点前提不成立 |
| PMU 计数定义 | Hardware ↔ V&V | 计数语义表（`08` 号文档） | 回标数据源不可用 |
| 精度签核负载集 | Workload ↔ Council | 负载集与阈值 | 精度无判据 |
| MTP 接受率 | Model ↔ Software | 实测证据 | 探索无法升级 |
| 工艺选择 | Hardware ↔ Council | 判据判定（`HARDWARE_PROCESS_AND_LIBRARY.md` §3） | 面积/功耗口径不定 |

## 5. 维护规则

1. **新增跨团队接口**必须有载体（contract 文件、产物、或本文的一行），否则不算接口；
2. **接口变更**由三团队 review 并由 Council 记 ADR（`contracts/README.md` 的规则）；
3. **V&V 必须为每个接口增加回归测试**（同上）；
4. 本文不定义任何数字，一律引用权威来源。
