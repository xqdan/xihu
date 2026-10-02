# HARDWARE：工艺与库选择

- 所有者：Hardware（工艺/IP）；共签：Council（成本与供应）、Package（封装协同）
- 状态：**`OPEN`**——无 PDK 在手；当前面积/功耗口径基于公开节点数据缩放
- 权威来源：`integration/detailed/k3_physical_basis.js#BASIS`、
  `docs/architecture/DESIGN_EVIDENCE_MATRIX.md` §1（#16、#17）、
  `09_PACKAGE_POWER_RAS.md` §3、`HARDWARE_11_FLOORPLAN_AREA.md` §2

## 0. 本文的定位

`k3_physical_basis.js` 里有一组工艺参数，它们**不是供应商给的**，是按公开节点数据缩放出来的。
`physical_design_space.json` 已经被标为 **`UNVERIFIED`，由 agent 依仓库文档起草，待域 owner 复核**。

本文的作用是：把这组参数的来源、影响面、以及"换工艺会发生什么"写清楚，
让工艺选择成为一个有依据的决策，而不是一个待办。

**明确声明**：SF4 的节距（CPP/MMP）**未公开**，模型取的是 SF4E 的推论值。
任何以"SF4 官方节距"为依据的结论都是假的。本文不给假结论。

## 1. 当前使用的口径（全部为 `ASSUMPTION`）

| 参数 | 值 | 来源 | 状态 |
| --- | ---: | --- | --- |
| 工艺 | 三星 SF4 级 4 nm（SF4/SF4X 节距未公开，取 SF4E 推论） | 公开节点数据 | `ASSUMPTION`（B-006） |
| 逻辑折算 | ×1.277（按 CPP×MMP） | 公开节点缩放 | `ASSUMPTION` |
| SRAM 折算 | ×1.248（按 HD bitcell） | 同上 | `ASSUMPTION` |
| PHY 折算 | ×1 | UCIe PHY 为硬 IP，不缩放 | 合理 |
| 矩阵密度 | 3.2 TF/mm²（N4 口径 @1 GHz，原 1.6） | 公开数据 | `ASSUMPTION` |
| 备选口径 | `N4-ref`（293.912 mm²，封装余量 638.604 mm²） | `physical_design_space.json` | `optionHeldOut:process=N4-ref` |

## 2. 影响面（这一节有依据）

工艺口径不只影响面积，它同时决定**面积、功耗、频率上限、成本**，而这几项在本设计里已经互相顶到了：

| 影响 | 机制 | 当前状况 |
| --- | --- | --- |
| Die 面积 | 矩阵密度直接决定 | 3.2 时 365.341 mm²（余 34.659）；**1.6 时 476.518 mm² 且封装同时超**（`09_PACKAGE_POWER_RAS.md` §3） |
| 封装可行性 | 裸片面积合计 | `N4-ref` 有 638.604 mm² 封装余量，SF4 只有 67.172 |
| 功耗 | 漏电与动态功耗随节点 | Die 283.269 W / 300 W 上限 |
| 频率 | 1.0 GHz 固定（NFR-05） | 未做时序分析，见 `HARDWARE_14_TIMING_SIGNOFF.md` |
| 成本 | 大裸片 + 16 颗 MC 的 KGD 良率 | 未建模（`HARDWARE_13_DFT.md` §1-4/10） |

**矩阵密度是唯一一个"单独就能决定成败"的工艺参数**：
取 1.6 时 Die 超上限、封装也超；取 3.2 时两者都有余量。
这个 2 倍差异不是微调，它取决于 MAC 阵列宏的实测密度，而**该宏尚不存在**。

## 3. 选择判据（决策框架）

| # | 判据 | 内容 |
| ---: | --- | --- |
| 1 | Die 面积 ≤ 400 mm² | 硬约束 |
| 2 | 封装 ≤ 5248 mm² | 硬约束（ADR-0018） |
| 3 | 卡功耗 ≤ 2800 W | 硬约束，且 §2 的 8 项未计入项需落在余量内（`HARDWARE_POWER_BUDGET.md`） |
| 4 | 主域 ≥ 1.0 GHz | NFR-05 |
| 5 | SRAM compiler 提供所需的 bank 配置与 `layoutImbalance` ≤ 1.30 | `DESIGN_TARGETS_AND_MARGINS.md` §2.1 |
| 6 | MAC 阵列宏密度 ≥ 3.2 TF/mm² | 否则面积路线要重做 |
| 7 | UCIe/SerDes IP 可用 | `09_PACKAGE_POWER_RAS.md` §2 |
| 8 | 供应与成本 | 未建模 |

判据 6 是**门槛式的**：达不到就必须换工艺或换架构（近存计算 MC 是备选路线，
`docs/architecture/README.md` §1 第 5 条已声明不混入本轮基线）。

## 4. 换工艺的连锁反应

若 `N4-ref`（当前 `optionHeldOut`）转为选中：

1. 面积从 365.341 → 293.912 mm²，封装余量从 67.172 → 638.604 mm²；
2. **功耗模型需要重做**：`k3_physical_basis.js` 的功耗分量与节点绑定；
3. **频率上限需重验**：NFR-05 的 1.0 GHz 在新节点下未必是同一难度；
4. **全部文档数字重算**：`npm run physical:search && npm run search:final && npm run baseline:sync`，
   然后 `node tests/regression/test_physical_design.js`；
5. `DESIGN_EVIDENCE_MATRIX.md` #16/#17 的证据等级记录。

**换工艺不是改一个常数**，它触发全链重算——这正是为什么本文把它写成决策框架而不是一个下拉选项。

## 5. 未闭合项

| 项 | 状态 | 责任 | 关闭证据 |
| --- | --- | --- | --- |
| 工艺选择 | `OPEN` | Council + Hardware | 本文 §3 全部判据 |
| SF4/SF4X 节距 | 未公开 | 供应商 | PDK |
| SRAM compiler | 未获取 | 供应商 | 宏尺寸与功耗数据 |
| MAC 阵列宏 | 不存在 | HW-02 + 供应商 | 密度实测（判据 6） |
| UCIe/SerDes IP | 未选型 | PHY | IP 规格 |
| `physical_design_space.json` 复核 | 待域 owner | Hardware | 逐项签核 |
