# HARDWARE：封装与基板规格

- 所有者：Hardware（封装）；共签：Council（系统包络）、Memory MC（MC 侧）
- 状态：面积与放置包络 `BASELINE`（ADR-0018）；**基板电气细节 `OPEN`**
- 权威来源：[`09_PACKAGE_POWER_RAS.md`](09_PACKAGE_POWER_RAS.md) §1/§2、
  `teams/hardware/inputs/k3_mc_baseline.json#tpsDesign.package`、
  [`HARDWARE_11_FLOORPLAN_AREA.md`](HARDWARE_11_FLOORPLAN_AREA.md)

## 0. 本文与 09 号文档的分工

`09_PACKAGE_POWER_RAS.md` 覆盖封装、I/O、功耗、时钟、散热、RAS 六件事，
每件都只到"包络与抽象参数"深度（该文档 §2 已声明 UCIe 是抽象参数，不能进 bump map）。

本文把其中**封装与基板**这一件单独展开到可采购、可布线的深度。
其余五件不重复，分别以 `HARDWARE_12_CLOCK_RESET_POWER.md`、
`HARDWARE_POWER_BUDGET.md`、`HARDWARE_13_DFT.md` 为落点。

## 1. 封装形态（有依据）

| 项 | 值 | 依据 |
| --- | ---: | --- |
| 裸片数 | 8 Compute Die + 16 MC | ADR-0011 |
| 裸片面积合计 | 4522.728 mm² | 8 × 365.341 + 16 × 100 |
| Placement window | 5248 mm²（约 82 × 64 mm） | ADR-0018 |
| 理论 reticle 面积 | 6006 mm²（26 × 33 mm/reticle × 7） | `09` 号文档 §1 |
| Keep-out | 658.10 mm² | `reserveFraction` 0.1254（选中值） |
| 未占用余量 | 67.172 mm² | 见 `HARDWARE_11_FLOORPLAN_AREA.md` §1 |

拓扑：4 × 2 Compute Die 阵列，每 Die 本地 2 颗 MC，Die 之间双向环。
**一个 package 对软件表现为一个 TP rank**，32 个 package 组成 TP32。

```text
            ← 约 82 mm →
  +------------------------------------------------+
  | MC MC   MC MC   MC MC   MC MC                  |
  | [Die0]  [Die1]  [Die2]  [Die3]    scale-out    |
  |   ↕ UCIe 环 ↔     ↔       ↔       PHY 边缘      |
  | [Die7]  [Die6]  [Die5]  [Die4]    host / mgmt  |
  | MC MC   MC MC   MC MC   MC MC                  |
  +------------------------------------------------+
```

## 2. 互连与岸线

每 Die 有 **4 个 UCIe controller group**：2 个接本地 MC，2 个接环上相邻 Die；
每组 128 lane × 64 Gbps；另有 16 条 112 Gbps RDMA lane。

| 端口类 | 端口数/Die | payload | PHY | 状态 |
| --- | ---: | ---: | --- | --- |
| MC local | 2 | 每 MC 448 GB/s（640 × 0.7） | UCIe 类 | `BLOCKER`（B-002） |
| Die fabric | 2 | 819.20 GB/s/端口；环切面 1638.40 GB/s | UCIe / 自定义短距 | `BLOCKER`（B-004） |
| Scale-out | 16 lane | 168 GB/s/Die；800 GB/s/卡（上限） | 电/光 SerDes | `BLOCKER`（B-005） |
| Host | 待定 | 非关键路径 | PCIe/CXL | `OPEN` |
| Management | 若干 | 低速 | JTAG/I3C/BMC | `OPEN` |

**PHY shoreline：24.213 mm / 预算 52.946 mm**。余量充足，但这是抽象计算，
**不能直接进 bump map**——真实 bump 间距、escape routing、电源/地 bump 需求都会改变这个数。

## 3. 基板电气（本文新增，全部 `OPEN`）

09 号文档没有覆盖的部分，逐项登记：

| # | 项 | 为什么重要 | 状态 |
| ---: | --- | --- | --- |
| 1 | 层数与叠层 | 决定 PDN 阻抗与信号完整性 | `OPEN` |
| 2 | PDN 阻抗目标 | 2744.88 W 的电流下，IR-drop 直接影响时序（见 `HARDWARE_14_TIMING_SIGNOFF.md` §4） | `OPEN` |
| 3 | UCIe 通道损耗预算 | 819.20 GB/s/端口需要眼图余量 | `OPEN` |
| 4 | Scale-out 通道：电 vs 光 | 168 GB/s/Die 的传输距离超过电通道能力时需光 | `OPEN`，且功耗未计入（`HARDWARE_POWER_BUDGET.md` §2 #1） |
| 5 | 去耦电容布置 | 与 PDN 联合 | `OPEN` |
| 6 | 散热路径（冷板接触） | `ASSUMPTION`（O-015） | `OPEN` |
| 7 | 翘曲与机械应力 | 82 × 64 mm 大基板上的裸片应力 | `OPEN` |
| 8 | 测试通道（ATE 探针） | 与 `HARDWARE_13_DFT.md` 联动 | `OPEN` |

**ICD（interconnect design rules）与 bump map 在 PDK/IP 到手前无法产出**，
本文不做假图。

## 4. 判据

1. 全部裸片落在 5248 mm² placement window 内，keep-out 与余量按 §1；
2. PHY shoreline 满足 §2 的抽象预算，且**在真实 bump map 下重新核算**；
3. PDN 满足 IR-drop 目标（与 `HARDWARE_14_TIMING_SIGNOFF.md` 联合签核）；
4. 散热方案（冷板）能带走 2744.88 W 且维持 Die ≤ 300 W；
5. 任何使面积/功耗变化 > 5% 的封装改动走变更评审。

## 5. 未闭合项

| 项 | 状态 | 责任 |
| --- | --- | --- |
| §3 全部 8 项 | `OPEN` | 封装/电源 |
| UCIe 参数 → bump map | `OPEN`（09 号文档已声明） | 封装 + PHY |
| 工艺选择（影响裸片面积） | `OPEN` | 见 `HARDWARE_PROCESS_AND_LIBRARY.md` |
| MC 档位（影响 MC 面积与功耗） | `BLOCKER`（B-002） | Memory MC |
| 散热建模（O-015） | 未建模 | Package/Power |
| 翘曲/应力 | 未建模 | 封装 |
