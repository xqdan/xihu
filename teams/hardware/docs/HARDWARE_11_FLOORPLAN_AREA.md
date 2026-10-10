# HARDWARE-11：Compute Die 布局与面积预算

- 所有者：Hardware（后端/物理实现）；共签：Council（面积包络）
- 状态：面积口径 `MODEL`（B-006）；布局本身 **`OPEN`**——**没有任何 floorplan 依据，本文不编造坐标**
- 权威来源：`teams/hardware/inputs/k3_mc_baseline.json#tpsDesign.hardware`、
  [`09_PACKAGE_POWER_RAS.md`](09_PACKAGE_POWER_RAS.md) §1、`integration/detailed/k3_physical_basis.js#BASIS`、
  [`DESIGN_TARGETS_AND_MARGINS.md`](../../../docs/architecture/DESIGN_TARGETS_AND_MARGINS.md)

## 0. 本文的边界（先读这一节）

面积**数字**已有模型依据，面积**排布**没有。本文因此分两部分：

- §1–§3 是有依据的：面积预算表、互斥约束、余量。这些可以直接进设计规格。
- §4 之后是**决策框架**：什么时候做 floorplan、拿什么做、按什么判收敛。

强行在本文画出 Die 平面图会产出一个看起来完整、实际无依据的图。没有 PDK、没有综合网表、
没有 SRAM compiler 的宏尺寸，任何 floorplan 都是装饰。**本文拒绝这么做。**

## 1. 面积预算（发布点）

| 项 | 值 | 依据 |
| --- | ---: | --- |
| Compute Die 面积 | 365.341 mm² | 搜索选中点 |
| 上限 | 400 mm² | 约束（retaining 34.659 mm²，8.7%） |
| 每 Die MC | 100 mm² × 2 | 规划值（封装侧，不计入 Die 上限） |
| 裸片合计 | 4522.728 mm² | 8 × 365.341 + 16 × 100 |
| Placement window | 5248 mm² | ADR-0018 |
| 封装余量 | 67.172 mm² | 见 `09_PACKAGE_POWER_RAS.md` §1 |

**两个余量不是一回事**：Die 余量 34.659 mm²（相对 400）是**单个 Die 的**，封装余量 67.172 mm² 是**整包十个裸片合计**的。
把它们相加或混用是本项目容易犯的第三类判据错误（前两类见 `PRODUCT_REQUIREMENTS.md` §0）。

## 2. 面积口径的敏感度（关键风险）

面积不是测量值，是按公开节点数据缩放出来的：

| 口径 | 值 | 影响 |
| --- | ---: | --- |
| 逻辑折算 | ×1.277（按 CPP×MMP） | 若改用面积比，可能更小；**这是乐观方向** |
| SRAM 折算 | ×1.248（按 HD bitcell） | SF4 HD bitcell 若更大，直接超 400 |
| PHY 折算 | ×1（不缩放） | UCIe PHY 是硬 IP，合理 |
| 矩阵密度 | 3.2 TF/mm² | 取 1.6 时 Die 476.518 mm²、裸片 5412.145 mm²，**封装同时超**——见 `09_PACKAGE_POWER_RAS.md` §3 |

**结论**：矩阵密度这一项单独就能决定成败。3.2 TF/mm² 取的是 N4 口径 @1 GHz（原 1.6 是更保守的旧值），
而它没有任何 MAC 阵列宏依据。**这是面积侧唯一的 P0 级假设**（B-006）。
B-006 关闭前，365.341 mm² 这个数不能在对外材料上当作已实现面积引用。

## 3. 互斥约束（floorplan 必须同时满足）

这些约束已经存在于模型里，floorplan 必须复现它们，而不是另起一套：

1. **每 Die 2 颗 MC**（ADR-0011），MC 走 UCIe 128 lane（`09_PACKAGE_POWER_RAS.md` §2）。
   每 Die 有 4 个 UCIe controller group：2 个接本地 MC，2 个接环上相邻 Die。**岸线由此确定**。
2. **PHY shoreline 24.213 mm / 预算 52.946 mm**——余量充足，但这是抽象参数，
   不能直接进 bump map（`09_PACKAGE_POWER_RAS.md` §2 已声明）。
3. **H local tile 的容量约束**由 `layoutImbalance` 表达，上界 1.42，超了**不可行**而非变慢
   （`DESIGN_TARGETS_AND_MARGINS.md` §2.1）。floorplan 的 SRAM 形状不均衡必须守住这条。
4. **主域单一时钟 1.0 GHz**（`09_PACKAGE_POWER_RAS.md` §5），不用 DVFS 换算力。
5. **reduce/collective 独立功率计数器**——floorplan 上需要有独立的供电与测量点。

## 4. 要到什么程度才算有 floorplan

| 阶段 | 输入 | 产出 | 判据 |
| --- | --- | --- | --- |
| P7-a 宏准备 | SRAM compiler、UCIe/AI Core 硬 IP | 各单元尺寸与 pin 分布 | 宏面积合计 ≤ 365.341 mm² |
| P7-b 顶层规划 | 网表 + 宏 + 岸线约束 | block 级 floorplan | 满足 §3 全部约束 |
| P7-c 收敛 | 布局 + 时钟树 + PDN | 时序/拥塞/IR-drop 报告 | 见 `HARDWARE_14_TIMING_SIGNOFF.md` |
| P7-d 回标 | 实际面积/功耗 | 更新 P1 | 365.341 mm² 被替换为实测值 |

**回标是目的，不是副产品**：B-006 的关闭证据就是 P7-d 的实测面积/功耗写回 P1，
并用 `npm run search:final && npm run baseline:sync` 重跑全部文档数字。

## 5. Die 面积再分配（探索，非基线）

21 号文档 §6.5 的 `die_area_reallocation.js` 给出了一条把联合悲观点从 921.63 抬到 998.91 的面积/功耗交换路径
（`vectorLanes` 512→1024、`rdmaLanes` 16→12、`hRows×hEngines` 48×5→40×6），
代价是卡功耗余量 55.12 W → 4.7 W。

**这不是本文的方案。** 它登记在这里是为了说明：面积余量不是"留着好看"的，它有明确的买主。
但它的代价（卡功耗余量降到 0.17%）比收益（+77.3 TPS）更接近红线，
**采纳与否必须由向量单元负责人与功耗模型负责人共同签核**，见 `OPEN_ISSUES.md` O-020。

## 6. 未闭合项

| 项 | 状态 | 责任 | 关闭证据 |
| --- | --- | --- | --- |
| 面积缩放系数 | `ASSUMPTION` | HW-01 | 三星 SF4 PDK 的 SRAM compiler 与 MAC 阵列宏 |
| 矩阵密度 3.2 TF/mm² | `ASSUMPTION`（B-006） | HW-01 | 同上 |
| floorplan 本体 | `OPEN` | 后端 | §4 P7-b |
| 单元级面积拆分 | `MODEL` | 各单元 | 综合报告 |
| 再分配方案 | 探索（O-020） | HW-02 / 功耗 | 双签核 |
