# HARDWARE-14：时序约束与签核条件

- 所有者：Hardware（STA/签核）；共签：Council（频率承诺）、V&V（判据）
- 状态：**`OPEN`**——无 PDK、无 corner、无寄生参数。本文是**签核条件清单**，不是签核结果
- 权威来源：`09_PACKAGE_POWER_RAS.md` §5、`HARDWARE_11_FLOORPLAN_AREA.md`、
  `HARDWARE_12_CLOCK_RESET_POWER.md`；频率承诺见 `PRODUCT_REQUIREMENTS.md` NFR-05

## 0. 本文的定位

主域频率 **1.0 GHz 固定、不参与搜索、不得靠降频换算力**——这是 NFR-05。
本文回答的是：**这个承诺在什么条件下才算被证明了。**

当前状态：**没有证明**。没有 PDK 就没有真实的 cell 库与时序模型，
写一组 corner 参数只会让读者以为"已经跑过 STA"。因此本文只给条件和判据。

## 1. 时序承诺分解

主域 1.0 GHz 是**单一周期**，由多个路径类别共同支撑。签核必须逐类给出结论，
不能用"整体 timing clean"一句概括：

| 路径类别 | 关键路径来源 | 当前证据 |
| --- | --- | --- |
| AI Core 矩阵阵列 | `matrixUtil` 0.65 的假设隐含了算力利用率，与流水线深度耦合 | `ASSUMPTION`（B-006） |
| AI Core 向量 | `vectorUtil` 0.35（原 0.3，含 dequant），**向量单元是面积再分配的对象** | `ASSUMPTION` |
| TMA / 本地 SRAM | `layoutImbalance` ≤ 1.42 是**容量**约束，非时序 | 见 `DESIGN_TARGETS_AND_MARGINS.md` §2.1 |
| NoC | 4096-bit link 是否可布线（O-003） | `OPEN` |
| Reduce 引擎 | 4096 lane（`09_PACKAGE_POWER_RAS.md` §4.1 指出其功耗占比 12% 偏大） | `MODEL` |
| Comm Core 控制路径 | 搜索选中 0.042 µs/次，raw 预算内上限 0.620 µs/次（O-018） | `ASSUMPTION`，待 RTL/周期模型 |
| SRAM 访问 | 与 `layoutImbalance`、bank class 比例（O-008）相关 | `ASSUMPTION` |

**注意 Comm Core 那一行的余量**：0.042 µs 对 0.620 µs 看似极宽，但那是**控制路径**，
最慢的 LSE merge 加控制路径是 1.07 µs（卡内阶段按 8 Die 环计，B-004），已逼近 spec τ（1.15 µs）。
O-018 记录了两个只差 2–8 ns 余量的方案（`descriptorExpand`、`sharedSram`），
**回标后可能翻转**。这是时序侧最脆弱的一点，不是 Comm Core 内部的问题，而是它决定 τ 能否成立（B-008）。

## 2. 签核条件（必须在设计冻结前补齐）

| # | 条件 | 内容 |
| ---: | --- | --- |
| 1 | 工艺角覆盖 | 至少含 SS/TT/FF、温度（冷/热）、电压（±10% 或 PDK 规定）的完整组合 |
| 2 | OCV/AOCV 与 derate | PDK 规定的方法学与 derate 值 |
| 3 | 互连寄生 | 建议从 P7-b floorplan 提取；无寄生不得签核 |
| 4 | 时钟不确定性 | PLL jitter、clock tree skew、CDC 路径的额外余量 |
| 5 | 跨域路径 | 全部 CDC 按 `HARDWARE_12_CLOCK_RESET_POWER.md` §4 逐条建立约束 |
| 6 | PHY 接口 | UCIe/SerDes 的 IP 内部时序由其供应商签核，本文只签核接口 |
| 7 | 测试模式时序 | `HARDWARE_13_DFT.md` §2，通常另给一组约束 |
| 8 | 功耗-时序联合 | IR-drop 与电压降不得使路径失效（与 `HARDWARE_POWER_BUDGET.md` 联合） |

## 3. 签核判据

1. **全部角下无 setup/hold 违例**，含跨域与测试模式；
2. **无未约束路径**（unconstrained path 报告为空）——这一条比"无违例"更重要，
   因为漏约束会伪装成 clean；
3. 主域 1.0 GHz 在所有角下成立，不得通过降频换算力；
4. 每条 §2 条件有对应的报告与被审记录；
5. 回标：实测频率/电压曲线写回 P1，并重跑全部文档数字
   （`npm run search:final && npm run baseline:sync`）。

## 4. 与功耗的联合签核

时序与功耗在本设计里耦合得很紧：卡功耗余量只有 55.12 W（1.97%），
而 `die_area_reallocation.js` 的方案会把它压到 4.7 W。同样的物理事实会同时影响：
电压降（时序）与动态功耗（热）。**两者不得分开签核**。

## 5. 未闭合项

| 项 | 状态 | 责任 | 关闭证据 |
| --- | --- | --- | --- |
| PDK 与 corner 定义 | `OPEN` | HW-01 | 三星 SF4 PDK |
| 频率-电压曲线 | `OPEN` | 后端 | P7-c |
| Comm Core 控制路径 | `ASSUMPTION`（O-018） | Comm Core | RTL 或周期模型 |
| NoC 可布线 | `OPEN`（O-003） | NoC | P7-b |
| TMA 独立端口可实现性 | `OPEN`（O-007） | TMA/SRAM | RTL |
| **签核结果本体** | **未做** | 后端 | 全部 §2 条件满足 |
