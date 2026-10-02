# 设计-证据追溯矩阵

- 所有者：Council（维护）/ V&V（核对）
- 状态：`BASELINE`
- 权威来源：`teams/hardware/inputs/k3_mc_baseline.json#tpsDesign`、`out/` 各产物、`tests/regression/`

## 0. 本文解决什么

本仓库已经有 95 个文档数字被 `tests/regression/test_tps_design_baseline.js` 逐条核对——**文档不会和模型脱节**。
但那只保证"数字一致"，不保证"这个数字有资格支撑这个决策"。

本文补上后者：把**每个设计决策**连到它的**模型产物**，再把每个**未测量输入**连到它的**测量计划**。
一张表回答三件事：

1. 这个设计决策依据哪个产物？
2. 这个产物是 `MODEL` 还是 `ASSUMPTION`？
3. 如果是假设，谁、用什么、什么时候把它变成测量？

## 1. 决策 → 证据链

| # | 设计决策 | 值 | 依据产物 | 证据等级 | 测量计划 |
| ---: | --- | --- | --- | --- | --- |
| 1 | 目标 1000 TPS/usr、B=1、Context 1M、TP32 | — | ADR-0009 | `FROZEN` | 不适用 |
| 2 | 卡组织 8 Die + 16 MC，2 MC/Die | — | ADR-0011 | `BASELINE` | 封装签核 |
| 3 | 发布点硬件向量 `x` | 见 `tpsDesign.hardware.x` | `out/rdma/k3_rdma_final_tuning_results.json#search.best.x` | `MODEL` | **B-006 综合/floorplan 回标** |
| 4 | MC 640 GB/s | 640 | ADR-0019 | `BLOCKER` | **B-002 供应商规格** |
| 5 | τ = 1.15 µs | 1.15 | ADR-0004 | `BLOCKER` | **B-008 物理推导（O-018）** |
| 6 | 计数口径 reference-393 | 393 | ADR-0004、ADR-0024 | `BASELINE` | 供应商 shared expert 结构说明（确认性） |
| 7 | FP8 KV cache | `OPT.kvCache='fp8'` | `PRECISION_POLICY.md` §2.1 | `MODEL`（B-001） | **精度验收（`VV_MEASUREMENT_PLAN.md` #8）** |
| 8 | MXFP4 routed expert | 0.53125 B/参数 | 模型发布格式 | `MODEL` | K3 已是发布格式；DS 待确认 |
| 9 | dense 权重 BF16 | — | `PRECISION_POLICY.md` §2.3 | `MODEL`（O-012） | **精度签核（#9）**；FP8 稠密路线见 O-020 |
| 10 | 软件机制 10 项（`tmaLane`、`kvPrefetch` 等） | 见 §5 回退表 | `tpsDesign.software.mechanisms` | `MODEL` | **kernel/调度器 trace（B-003）** |
| 11 | `launchScale` 0.45 | 0.45 | `OPT.launchScale` | `ASSUMPTION` | **runtime trace（#2）** |
| 12 | 专家预测命中率 0.8 | 0.8 | `plan.c.prediction` | `ASSUMPTION` | **实测（#4）** |
| 13 | 利用率类参数（4 项） | 见 `DESIGN_TARGETS_AND_MARGINS.md` §2.1 | `A.TECH` | `ASSUMPTION` | **#1 #3 #5 #6** |
| 14 | GAIN 全部为 1 | 25 项 | `O.GAIN` | `BASELINE` | 任何因子离开 1 需 B-003 证据 |
| 15 | 液态冷却 Die 300 W / 卡 2800 W | — | `k3_physical_basis.js` | `ASSUMPTION`（O-015） | **#7 冷板/VRM 建模** |
| 16 | SF4 面积折算 ×1.277 / ×1.248 / ×1 | — | `k3_physical_basis.js#BASIS` | `ASSUMPTION`（B-006） | **#10 PDK** |
| 17 | 矩阵密度 3.2 TF/mm² | 3.2 | 同上 | `ASSUMPTION`（B-006） | **#10 MAC 阵列宏** |
| 18 | 规划 token-time 5 系数 | — | ADR-0008 | `PLANNING_ESTIMATE` | **#11 样本外核对（O-016）** |
| 19 | GLM-5.2 / DS-V4-Pro 部署布局 | — | ADR-0006/0007/0020/0024 | `ASSUMPTION` | **#12 逐模型详细点** |

## 2. 未测量输入的汇总（按风险排序）

风险 = 该参数偏到悲观端时对 TPS 的杀伤 × 它离测量有多远。排序与
`DESIGN_TARGETS_AND_MARGINS.md` §2 一致，此处只列**归口**：

| 排序 | 参数 | 当前等级 | 归口测量计划 | 责任 |
| ---: | --- | --- | --- | --- |
| 1 | `A.TECH.mcUtil` 0.70（盈亏点 0.63） | `ASSUMPTION` | #5 | HW-04 |
| 2 | τ = 1.15 µs（盈亏点 1.35） | `BLOCKER` | #13 | Comm Core / PHY |
| 3 | MC 640 GB/s | `BLOCKER` | #14 | Memory MC |
| 4 | 软件机制 10 项 | `MODEL`（无 trace） | #2 | SW-01/02/03 |
| 5 | `unpackParamsPerLaneCycle` 2（盈亏点 0.82） | `ASSUMPTION` | #3 | HW-02 |
| 6 | `layoutImbalance` 1.15（上界 1.42，超了不可行） | `ASSUMPTION` | #6 | HW-03 |
| 7 | `launchScale` 0.45 | `ASSUMPTION` | #2 | SW-01 |
| 8 | 专家预测命中率 0.8 | `ASSUMPTION` | #4 | SW-06 / HW-02 |
| 9 | `matrixUtil` 0.65 / `vectorUtil` 0.35 | `ASSUMPTION` | #1 | HW-02 |
| 10 | 面积/功耗/SF4 系数 | `ASSUMPTION` | #10 | HW-01 |
| 11 | 规划系数（5 个） | `PLANNING_ESTIMATE` | #11 | Model |
| 12 | GLM/DS 布局 | `ASSUMPTION` | #12 | Model |

详细的测量方法、完成定义和验收线见 [`VV_MEASUREMENT_PLAN.md`](../../teams/vv/docs/VV_MEASUREMENT_PLAN.md)。

## 3. 覆盖缺口（本文承认的不足）

诚实登记——以下决策**没有**合格的追溯链，是本文尚未覆盖的部分：

| 缺口 | 说明 | 影响 |
| --- | --- | --- |
| 时钟域/复位/电源域 | `HARDWARE_12_CLOCK_RESET_POWER.md` 之前不存在；现为框架文档 | RTL 前必须补实 |
| DFT | `HARDWARE_13_DFT.md` 之前不存在 | 同上 |
| 时序签核条件 | `HARDWARE_14_TIMING_SIGNOFF.md` 是决策框架，无具体 corner | 同上 |
| 物理实现流程 | 无 PDK 依据，`OPEN` | P7 阶段 |
| 硅后 bring-up | `BRINGUP_AND_POST_SILICON.md` 是框架 | P7 阶段 |

这些缺口不是"遗漏"，而是**当前阶段不该有的具体值**：没有 PDK 就没有真实 corner，
写上去的数字会伪装成依据。它们被登记在这里，是为了让"未闭合"可见，而不是被一段看起来完整的文字掩盖。

## 4. 维护规则

1. **新增设计决策**必须在本表登记一行，否则不算进入设计基线。
2. **证据等级变化**（`ASSUMPTION` → `MODEL` → `MODEL_OBSERVED`）必须同时更新本表与
   `VV_MEASUREMENT_PLAN.md` 的对应行。
3. **升级只能靠新产物**，不能靠改标签（`VV_PLAN.md` §1）。
4. 本表的数字不另行定义，一律引用权威来源；`tests/regression/test_tps_design_baseline.js`
   与 `test_cross_team_contracts.js` 会核对其中被文档化的部分。
