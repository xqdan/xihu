# 产品需求与验收判据

- 所有者：Council（产品需求）/ MODEL-06（KPI 与验收）/ V&V（判定）
- 状态：`BASELINE`（需求本身）；判据中的「联合悲观点」一项为 2026-10-02 新增，尚未被 Gate 采纳
- 权威来源：目标与口径取自 `teams/hardware/inputs/k3_mc_baseline.json#tpsDesign` 与 ADR-0009；
  敏感度与联合悲观点取自 [21_TPS_DESIGN_BASELINE.md](21_TPS_DESIGN_BASELINE.md) 第 6.1 / 6.1.1 节

本文回答一个问题：**这颗芯片达到什么程度才算成功，谁来判、拿什么判。** 它是全部下游设计文档的判据来源；
硬件单元文档（`teams/hardware/docs/`）、软件文档（`teams/software/docs/`）与验证计划（`teams/vv/docs/`）都从本文取验收线，
不各自定义。

## 0. 为什么不直接用 1101.77 当判据

发布点 **1101.77 TPS/usr** 是 `MODEL` 等级的**点估计**，它在全部未测量的计算参数同时取乐观值时成立。
这些参数同时偏悲观时（`tpsDesign.sensitivity.jointPessimistic`）降到 **921.63**（Die 侧组）和 **906.51**（全部未测量组），
而其中任何一项**单独**取悲观值都还在 1000 以上（21 号文档 §6.1、§6.1.1）。

因此本文区分三个不同的数字，混淆它们是本项目最容易犯的判据错误：

| 数字 | 值 | 是什么 | 不能用作 |
| --- | ---: | --- | --- |
| 发布点（nominal） | 1101.77 TPS/usr | 一个搜索点的模型结果 | 验收判据 |
| 联合悲观点（compute） | 921.63 TPS/usr | 计算侧未测量参数同时偏悲观 | 已经达标 |
| 联合悲观点（allUnmeasured） | 906.51 TPS/usr | 再加内存/软件侧未测量参数 | 已经达标 |

**结论：以发布点为判据，这颗芯片"已达标"；以联合悲观点为判据，还没有。** 现状是后者
（`acceptance.currentStatus = target-met-in-model-only`，架构闸门 1050 未通过）。

## 1. 功能需求（FR）

| ID | 需求 | 值 | 状态 | 验证方式 |
| --- | --- | --- | --- | --- |
| FR-01 | 解码吞吐 | ≥ 1000 tokens/s/user，B=1 decode | `FROZEN`（ADR-0009） | 详细模型回放；硅上实测（后补） |
| FR-02 | 上下文长度 | 1 M token | `FROZEN` | 模型容量与 KV 布局核算 |
| FR-03 | 并行策略 | TP32，PP1 | `FROZEN` | 拓扑文档与配置 |
| FR-04 | 卡组织 | 8 Compute Die + 16 MC / 卡；2 MC / Die；1 卡 = 1 TP rank；32 卡 = TP32 | `BASELINE`（ADR-0011） | 封装与拓扑签核 |
| FR-05 | 批处理 | 每步 1 个 token（Batch=1）。MTP / 推测验证**不是**基线场景 | `FROZEN` | `SCENARIO_MATRIX.md` |
| FR-06 | 多模型支持 | K3（记录配置）+ GLM-5.2 + DeepSeek-V4-Pro | `BASELINE` | 规划链路 18 槽位（`VV_PLAN.md` §4） |
| FR-07 | 精度 | routed expert MXFP4、dense BF16、KV cache FP8、矩阵计算 BF16、累加 FP32 | `MODEL`（B-001、O-012、O-013、O-014） | `PRECISION_POLICY.md` §6 精度验收 |
| FR-08 | 确定性 | 同一输入、同一 TP 配置逐位可重现 | `BASELINE` | `PRECISION_POLICY.md` §5 |

## 2. 非功能需求（NFR）

| ID | 需求 | 值 | 状态 | 验证方式 |
| --- | --- | --- | --- | --- |
| NFR-01 | Die 面积 | ≤ 400 mm² / Compute Die | `MODEL` | floorplan + 综合（B-006） |
| NFR-02 | Die 功耗 | ≤ 300 W / Die（液冷冷板） | `ASSUMPTION`（O-015） | 功耗模型 + 热签核 |
| NFR-03 | 卡功耗 | ≤ 2800 W / 卡 | `ASSUMPTION`（O-015） | 同上 |
| NFR-04 | 封装 | 7-reticle placement window 5248 mm² | `BASELINE`（ADR-0018） | 封装签核 |
| NFR-05 | 频率 | 1.0 GHz，固定，**不参与搜索**，不得靠降频换算力 | `BASELINE` | 时序签核（`teams/hardware/docs/HARDWARE_14_TIMING_SIGNOFF.md`） |
| NFR-06 | MC 带宽 | 640 GB/s/颗（Stretch 档）；参考规格仅 320 GB/s/颗 | `BLOCKER`（B-002） | 供应商规格 |
| NFR-07 | 集合通信时延基准 τ | 每次 ≥ 1.15 µs，尚无物理推导 | `BLOCKER`（B-008） | 拓扑/PHY 物理推导（B-004/B-005） |
| NFR-08 | 台面余量 | 模型面（SRAM window、封装）保留 ≥ 10% 余量 | `BASELINE` | 各单元预算表 |

## 3. 验收判据（AC）

### 3.1 主判据（本文建议，待 Council 采纳）

> **AC-1**：在**联合悲观点**（`tpsDesign.sensitivity.jointPessimistic.allUnmeasured`）下，
> 三种模型的可比槽位 TPS/usr 仍 ≥ 1000。
>
> **AC-2**：判据所用的 MC 带宽必须是可制造规格（B-002 关闭后），不得使用 MC640 的搜索假设。

当前状态：**AC-1 未通过**（906.51 < 1000）；**AC-2 未通过**（B-002 未关闭）。

### 3.2 既有闸门（不予替换，与 AC 并行）

| 闸门 | 判据 | 当前 | 责任 |
| --- | --- | --- | --- |
| 架构闸门 | ≥ 1050 TPS/usr，使用可制造 MC 路线、详细 tile 模型 | 未通过 | Council / Hardware |
| D-Gate | 8 项方向比较检查 | 通过 | V&V |
| Q-Gate | 18 槽位 `MODEL_OBSERVED` / `SILICON_OBSERVED` | 未通过（18/18 仍是 `PLANNING_ESTIMATE`） | V&V |

架构闸门的 1050 高于 AC-1 的 1000，是有意的：1050 是**名义点**的门槛，AC-1 是**悲观面**的底线。
两者都通过才算可冻结。

### 3.3 判据的责任与关闭路径

| 判据 | 缺什么 | 关闭由谁给出 |
| --- | --- | --- |
| AC-1 | 缺口 93.49 TPS/usr 中的大部分可用两条杠杆缩小：Die 面积/功耗再分配（+77.5，代价是卡功耗余量 55.1 W → 4.7 W）与 FP8 稠密条件路线（MC400 达 1080.78） | HW-01/HW-02 签核 `vectorLanes=1024`；B-001/O-012 精度签核 |
| AC-2 | MC 供应商规格或替代架构 | Memory MC / Council |
| NFR-06/07 | 物理推导 | Comm Core（O-018）+ PHY |

两条杠杆都**不是基线**（21 号文档 §6.4、§6.5，`OPEN_ISSUES.md` O-020）。在它们被采纳前，AC-1 的缺口是开放的。

## 4. 需求的可追溯性

本文的每条需求都必须指向它的设计出处与验证方法。追溯矩阵见
[`DESIGN_EVIDENCE_MATRIX.md`](DESIGN_EVIDENCE_MATRIX.md)，它把「需求 → 设计文档 → 模型产物 → 测量计划」连成一条链。

## 5. 变更控制

以下变化属于需求变更，必须走 ADR 并同步本文、`DESIGN_TARGETS_AND_MARGINS.md` 与
`DESIGN_EVIDENCE_MATRIX.md`：

- 修改目标值（1000 / 1050）或口径（B、Context、TP、PP）；
- 把 MTP 或任何推测执行场景从探索升级为基线（需先满足 21 号文档 §6.4 的两个测量前置）；
- 修改验收判据（AC-1 / AC-2）或把发布点重新当作判据；
- 接受低于联合悲观点的结果（须有显式风险接受记录，见 `HH` 流程）。
