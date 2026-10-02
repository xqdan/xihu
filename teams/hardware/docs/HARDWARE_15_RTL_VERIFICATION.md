# HARDWARE-15：RTL 验证计划

- 所有者：V&V（独立于 Hardware）；执行：Hardware（RTL）
- 状态：**计划**——RTL 尚不存在，本文定义 RTL 出现后必须满足什么
- 权威来源：[`VV_PLAN.md`](../../vv/docs/VV_PLAN.md)（证据等级与 Gate）、
  `docs/architecture/contracts/TILE_IR.md`、各单元文档的接口章节

## 0. 本文与 `VV_PLAN.md` 的关系

`VV_PLAN.md` 管的是**模型层**证据：`ASSUMPTION` → `PLANNING_ESTIMATE` → `MODEL_OBSERVED` → `SILICON_OBSERVED`。
本文管的是**下一层**：当 RTL 出现后，如何独立验证它实现了设计文档所述的行为。

两层不能混：模型层的 `MODEL_OBSERVED` 证明的是"模型可信"，
RTL 验证证明的是"RTL 等于模型"。**两者都成立，才轮到 `SILICON_OBSERVED`。**

## 1. 验证对象与证据等级映射

| 设计文档 | RTL 单元 | 验证层次 | 对应证据等级跃迁 |
| --- | --- | --- | --- |
| `02_AI_CORE.md` | Tensor/Vector | 单元 + 子系统 | `ASSUMPTION` → 实测利用率 |
| `03_TMA_AND_SRAM.md` | TMA/SRAM | 子系统 | `ASSUMPTION` → 实测 `layoutImbalance`、端口 |
| `04_MEMORY_SUBSYSTEM_MC.md` | MC controller | 子系统 + 系统 | `BLOCKER` → 实测带宽/效率 |
| `05_ON_DIE_NOC.md` | NoC | 系统 | `OPEN` O-003/O-004 |
| `06_MULTIDIE_AND_SCALEOUT.md` | 环 + UCIe | 系统 | `BLOCKER` B-004/B-005 |
| `07_COLLECTIVE_RDMA.md` | Reduce + mailbox | 系统 | `OPEN` O-009/O-010 |
| `08_ON_DIE_SCHEDULER_AND_PMU.md` | Dispatcher/PMU | 系统 | `ASSUMPTION` → 实测 launch 开销 |
| `10_COMM_CORE.md` | Comm Core | 子系统 | `ASSUMPTION`（O-018）→ 周期模型 |
| `HARDWARE_11/12/14` | 顶层/时钟/时序 | 顶层 | 见各文档判据 |

**这张表的用途**：RTL 验证的**目的**是把上表右列填上。它的 KPI 不是覆盖率数字，
而是"关掉了几个 `ASSUMPTION`"。

## 2. 验证层次与判据

| 层次 | 范围 | 判据 | 状态 |
| --- | --- | --- | --- |
| 单元级 | 单个 IP 的功能 | 与文档接口行为逐条对应 | 计划 |
| 子系统级 | TMA+SRAM、MC controller、Reduce | 背压、错误、复位流程 | 计划 |
| 系统级 | 单 Die 全链路 | Tile IR 执行一次 decode step | 计划 |
| 多 Die | 8 Die 环 + TP32 | 393 次集合通信的语义与顺序 | 计划 |
| 性能 | 同 §2 系统级 | 周期数与 `MODEL` 预测比对 | 计划 |

## 3. 必须覆盖的类别（对应已有 `OPEN` 与风险项）

| # | 类别 | 为什么特别重要 | 关联问题 |
| ---: | --- | --- | --- |
| 1 | **CDC 与跨域** | 主域固定 1.0 GHz，PHY 域频率未定；每个跨域路径需断言或形式化 | `HARDWARE_12_CLOCK_RESET_POWER.md` §4 |
| 2 | **复位顺序** | R-1..R-5 的每条都要有对应测试，尤其 R-4（epoch/mailbox 确定性清零） | O-010 |
| 3 | **背压与流控** | NoC、TMA、MC 的 credit 机制；`R-002` noC 面积/功耗风险的源头 | O-003、O-004 |
| 4 | **collective 语义** | partial-ready 阈值（O-009）与 mailbox epoch（O-010）的正确性 |
| 5 | **错误注入** | MC 错误、link 降级、epoch 超时的恢复路径 | `09` 号文档 RAS |
| 6 | **PMU 计数正确性** | PMU 是回标的数据源，计数错误会污染后续所有证据 | `08` 号文档 |
| 7 | **确定性** | 同输入同 TP 配置逐位可重现（`PRODUCT_REQUIREMENTS.md` FR-08） | `PRECISION_POLICY.md` §5 |
| 8 | **DFT 模式** | 测试模式的复位与时钟不得改变功能行为 | `HARDWARE_13_DFT.md` |

## 4. 与模型层的一致性检查（本仓库特有的要求）

RTL 出现后，必须建立 **RTL 周期数 ↔ 模型时长** 的逐算子比对，而不是只比总 TPS：

```
每个 kernel（K1–K8）在 RTL 下的周期数
  vs  teams/model/src/... 中同一 kernel 的时长
```

超过阈值的偏差必须回到 `teams/software/docs/KERNEL_SPEC.md` 与模型侧修正，
**不得通过调 RTL 去凑模型数字**。方向只能是 RTL → 模型（回标），
与 `VV_PLAN.md` §0 第 4 条"修复只能从上游改"一致。

## 5. 未闭合项

| 项 | 状态 | 责任 |
| --- | --- | --- |
| 验证环境（仿真器、TB、VIP） | 未建立 | V&V |
| RTL 本体 | 不存在 | Hardware |
| 覆盖率目标 | `OPEN` | V&V + Hardware |
| 形式化范围（CDC 之外） | `OPEN` | V&V |
| RTL–模型比对阈值 | `OPEN` | Council 定 |

**本文在本轮不产生冻结结论。** 它的作用是把"RTL 出现后必须做什么"固定下来，
避免届时把验证范围临时缩小成"跑通一次 decode"。
