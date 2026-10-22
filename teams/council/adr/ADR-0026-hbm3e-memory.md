# ADR-0026：内存器件改为 HBM3E，卡功耗上限 2800 W → 3200 W，`search:final` 增加三条下游可见的约束

- 日期：2026-10-20
- 状态：`PROPOSED`（`ASSUMPTION` 等级；1152 GB/s 由引脚速率换算，未对照供应商规格；待 Hardware / Memory MC owner 确认。**此 ADR 随一个 WIP 提交落盘，规格尚未被采纳，见「未解决」**）
- 变更控制：按 `OPEN_ISSUES.md` 关闭纪律，"超过 5% 功耗的变化进入变更评审"。卡功耗上限 +14.3%，发布点卡功耗 +10.5%（2744.9 → 3031.9 W），均须评审后才能从 `PROPOSED` 转 `BASELINE`
- 修订：ADR-0019（带宽档位）、ADR-0021（唯一硬件规格）、ADR-0005 第 3 条（液冷卡功耗 2800 W）

## 背景

`design.arch.direction` 首次在真实模型后端上跑通全链路，结果是 `INVARIANT_VIOLATED`：

- 简报绑定 `mcProfile = MC320`（ADR-0021：唯一可制造默认）；
- L1 预算合同要求 `B-MEM-BW ≥ 640 GB/s/颗`，只有 `MC640`（`STRETCH_AGGRESSIVE`）能满足；
- 打分卡 `meetsTarget` 16 条中 MC320 条目为 0；MC320 分支只达到目标的 55.1%。

也就是说，在当时的可制造档位上没有达标形态。用户要求把内存换成 HBM3E 并刷新。

## 决策

1. **内存器件改为 HBM3E，16 栈，每 Die 2 栈**（`card.memoryCubes = 16`、`memoryCubesPerComputeDie = 2` 不变）。
2. **每栈带宽取 1152 GB/s**：9.0 Gb/s/pin × 1024 bit ÷ 8。这是引脚速率换算值，**不是供应商数据表数字**。取 9.0 而不是 9.2（1177.6 GB/s）是因为 `1177.6 × 0.7 = 824.3 GB/s` 高于每颗 UCIe 端口的 819.2 GB/s，端口钳位会让 memory 域 400 个候选 0 个可行；`1152 × 0.7 = 806.4 < 819.2`。
3. **`MC640` 档位槽位的数值由 640 改为 1152。** `MC320`（320 GB/s，`REFERENCE`）不变。
4. **卡功耗上限 2800 W → 3200 W**（`integration/detailed/k3_physical_basis.js` 的 `BASIS.limits.cardPower` 为权威值，其余副本同步）。Die 功耗 300 W、Die 面积 400 mm²、封装窗口 5248 mm² 不变。
5. **搜索网格 `SPACE.mcGBs` 为 `[160, 320, 1152]`**，原位替换以保持数组长度；冻结种子在 `run()` 中从 640 映射到 1152（否则被最近值吸附回 320）。
6. **memory 域锁定 16 栈**（`memory_search.js` 的 `cubesNotSpec`）。不锁时它会选 8 栈（TPS 1003.5，刚过 1000 线），与本 ADR 的决定相反，且耦合回放只模型化规格栈数。
7. **`MC320` / `MC640` 不再以 320 / 640 这两个数字出现在代码里**：`sync_baseline_spec.js`、`k3_tps_design_baseline.js`、`mtp_exploration.js` 与相关测试都从 `bandwidthTiers`（经 `resource_profiles.js`）读取档位值。
8. **`search:final` 增加三条下游可见的约束**（`integration/detailed/robust_model.js`，默认关闭，`run()` 打开），见下节。
9. **`TECH.mcPjPerBit = 5`、`TECH.mcBaseW = 7` 不改。** 它们是 MC 时代的假设，整体序列化进 `out/rdma/k3_rdma_final_tuning_results.json`；沿用不代表 HBM3E 的搬运能耗。

## 三条约束为什么必须有

调优模型自己的限值看不到下游检查。只加 HBM3E 与 3200 W、不加约束时，`search:final` 给出 1154.55 TPS/usr，看上去净赚 4.8%，但它每一步都在被下游悄悄否定或放宽：

| 搜索选出的点 | 名义 TPS | 问题 |
| --- | ---: | --- |
| 首次 HBM3E 点（`hMiB 2`） | 1154.55 | 联合悲观重放 `H local tile` **不可行**。同一点 `hMiB 4` 的名义 TPS 完全一样，搜索的平局裁决（TPS 并列取面积小）选了更小的 SRAM |
| 其 `hMiB 4` 同胞 | 1154.55 | 悲观可行（1021.85），但 Die 375.80 mm² 在观测 keep-out 0.1254 下封装缺口 −16.54 mm²；物理域**悄悄改用未证实的 keep-out 0.10** 才放得下，与 ADR-0023「不得放宽 keep-out 取得可行解」相反 |
| 把它挤进 keep-out（`rdmaLanes 16→8`） | 1145.32 | 最慢一类集合通信 1.43 µs，超过 L1 合同 B-TAU 的 τ = 1.15 µs；Comm Core 搜索 **0 / 216000** 可行，耦合搜索 **0 / 76** 可行 |

三条约束把这三种"选出来下游却不认"的点排除在外：

1. **联合悲观重放可行**：`compute` 与 `allUnmeasured` 两条（`k3_tps_design_baseline.js` 的 `JOINT_PESSIMISTIC`）都必须可行。**是可行性要求，不是 TPS 水平**。
2. **装得进窗口扣掉观测 keep-out 0.1254**：来源 `matrix_vector_design_space.json#requirements.packageFit.keepOutFraction`，与 `physical_design_space.json` 里记为"观测值"的选项一致。
3. **每次集合通信 ≤ τ**（B-TAU）：协议时间 + `CONTROL_PATH_BUDGET_US = 0.042 µs` ≤ 1.15 µs。**0.042 是 `ASSUMPTION`**：它取自已提交的 Comm Core 设计的最大单类控制路径，写成常量是因为 Comm Core 搜索读本搜索的发布点，直接读会成环；Comm Core 搜索仍是判断自己的控制路径是否装得下的最终裁判（O-018）。

`tests/regression/test_robust_search.js` 用这三个点的向量逐一钉住，并断言已存的搜索结果里每一行都满足三条。

## 后果

| | 改前（MC640，2800 W） | 本 ADR（HBM3E 1152 GB/s，3200 W） | 变化 |
| --- | ---: | ---: | ---: |
| 发布点 TPS/usr | 1101.77 | **1124.70** | +22.93（+2.1%） |
| raw | 775.75 µs | 759.94 µs | −15.81 µs |
| 联合悲观点 `compute` | 921.63 | **947.09** | +25.46 |
| 联合悲观点 `allUnmeasured` | 906.51 | **935.44** | +28.93 |
| MC320 TPS/usr | 586.46 | 585.93 | −0.53 |
| Die 面积 | 365.34 mm² | 364.03 mm² | −1.31 |
| Die 功耗 | 283.27 W | 290.48 W | +7.21 |
| 卡功耗 | 2744.88 W | **3031.92 W** | **+287.05（+10.5%）** |
| MC 功耗 | 398.72 W | 628.10 W | +229.38（+57.5%） |
| 封装已占用 | 4522.73 mm² | 4512.26 mm² | −10.46 |

发布点只改了四个旋钮：`hEngines 5→6`、`reduceLanes 4096→2048`、`mcGBs 640→1152`、`kvTile 32768→16384`；`vectorLanes`（512）、`hMiB`（4）、`rdmaLanes`（16）与改前相同。

下游状态：Comm Core 2740 / 216000 可行，耦合 15 / 77 可行，物理域保持 keep-out 0.1254（封装余量 +77.64 mm²），D-Gate 仍为 `PASS`。

**净收益是小的。** 内存带宽几乎翻倍（640 → 1152 GB/s），名义 TPS 只涨 2.1%，因为发布点的瓶颈已经从内存带宽移到集合通信（393 次 × τ 1.15 µs = 451.95 µs，占 raw 的 59%）。换来的代价是卡功耗 +10.5%、MC 功耗 +229 W。**联合悲观点仍低于 1000（947.09 / 935.44），`PRODUCT_REQUIREMENTS.md` 的 AC-1 仍未通过。**

## 有意保留的名字与数值脱节

`MC640` 这个标签此后装的是 **1152 GB/s**。保留它是为了不触动 `design_brief.schema.json` 的枚举、`profileBinding`、`MC320`/`MC640` 分离检查以及约 16 个测试。代价：

- "MC640 = 640 GB/s" 的直觉不再成立，读者须以本 ADR 和 `bandwidthTiers` 为准；
- ADR-0021 的"MC640 只能是 stretch"语义不变，**因此背景中 `INVARIANT_VIOLATED` 的结构性矛盾（简报绑定 MC320，而达标只有 stretch 槽位）并未消除**，只是 stretch 槽位的数值变了。

## 未解决

- **规格是否值得采纳。** 见上：+2.1% 名义、悲观点仍 <1000、卡功耗 +10.5%。本 ADR 没有为此论证；留给评审。
- **`arch.direction` 的 `INVARIANT_VIOLATED` 未消除，也未重跑。** 本轮只重算确定性产物，没有重跑真实模型的 intake → arch.direction（约 2 小时）。
- **文档与测试字面量没有追到本 ADR 的发布点。** 一次同步到过中间点（1154.55 / 1024 lane），现已过期；`npm test` 当前 50 / 70 通过。
- **回退到旧发布点的机制失效测试没有处理。** HBM3E 把瓶颈推到集合通信后，`sharedPortScaling` 回退后 TPS 不变、预取深度 1~4 无差别、MC320 下 `kMemory ×1.3` 只掉 4.4% 等断言不再成立；这些是模型行为的如实报告，未放宽。
- **规划模型的标定变差。** 规划模型在集合通信绑定的点上拟合，memory 侧系数几乎不受约束，MC320 留出点残差 −14.6%（门是 10%），`kMemory` 校准残差 −11.9 µs（容差约 7.4 µs）。GLM-5.2 / DeepSeek-V4-Pro 的 16 个槽位靠这套系数外推。
- **`CONTROL_PATH_BUDGET_US = 0.042` 是 ASSUMPTION。** Comm Core 搜索换了赢家，这个常量就需要重新取值。
- **冷板与供电（O-015）仍未建模；** 3200 W 上限没有对应的散热证据。
- **1152 GB/s、5 pJ/bit、`mcBaseW`、栈面积（100 mm²）、容量都不是供应商数据。**
