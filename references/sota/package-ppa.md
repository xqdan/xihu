# 封装、面积、功耗与热

> 领域：多 die / 多 reticle 封装的面积与 RDL/PHY 开销占比、面积受限时提高内存带宽的可行路径
>（垂直堆叠、封装内互联、外挂）、高功耗密度下的液冷可制造性边界、
> 功耗/热约束如何反过来锁死内存档位与核心数。

**as_of**：2026-01
**review_due_months**：12

**本文件是知识，不是证据。** 没有仓库内 `path:line`，不得作为任何 claim 的 `evidence`，不得用来覆盖、修正或重算仓库里的任何基线值。有冲突以仓库文件为准。

## 0. 与已有文件的关系

本单元文件为本次新增。README 把本单元登记为 `package-ppa.md`，本文落盘到该路径。

**明确不重复的部分**（这些在 [`interconnect-collective.md`](interconnect-collective.md) 里已有卡片，本文一律引用不重做）：

| 已有覆盖 | 卡片 | 本文的处理 |
|---|---|---|
| UCIe flit 效率、MPE 50% 上限 | SOTA-IC-01/02/03 | 不重复 |
| UCIe PHY 的 2 ns 时延与 0.25–0.6 pJ/bit | SOTA-IC-04 | 不重复 |
| **bump pitch → shoreline 带宽密度（22–1350 GB/s/mm²）** | SOTA-IC-05 | 本文只补它没算的一侧：**这些带宽要吃掉多少封装 XY 面积** |
| 112G 串联 vs UCIe 并联取舍 | SOTA-IC-06 | 不重复 |
| RDMA / scale-out 时延构成 | SOTA-IC-16 | 本文只补"外挂带宽"的功耗与面积代价 |

**本文的边界**：只回答"面积 / 功耗 / 热这三个约束把什么锁死了，公开资料里同类问题的常规取值是多少"。不评价本项目任何取值。

## 1. 这个领域最重要的一件事：面积、功耗、热不是三道独立的墙，而是同一个量的三种表现

公开资料里这三者通过**单位封装面积的功耗（W/mm²）**耦合在一起，因果链是单向锁死的：

```
封装面积固定
  → 能放多少 compute die / 多少内存档位（面积账）
  → 这些 die 加起来的功耗（功耗账）
  → 这个功耗除以冷板能覆盖的面积 = 热流密度（热账）
  → 热流密度超过冷板能力，就只能降频 / 减 die / 减档位
  → 回到第一行
```

这条链的**关键数字来自冷板侧而不是芯片侧**：IDTechEx 在 2025-11 对数据中心价值链（芯片厂、冷板供应商、系统集成商）的访谈给出的一致口径是——单相直接到芯片（D2C）冷却在 **~1500 W TDP 附近开始遇到瓶颈，~2000 W 附近到达实用上限**（IDTechEx, 2025）。而 2025 年的高端 GPU 已经在 1400–1600 W，2026 年路线图是 1600–1800 W。也就是说：**"液冷"在公开资料的语境里已经不是一个二值前提，而是一条从 1500 W 到 2000 W 的渐近带**——在这条带里，单相冷板还能用但余量在消失；超过它必须换两相或微通道方案。

第二个同样重要的事实是：**封装面积其实是两笔不同的账，两者的限制来源完全不同。**

- **中介层（interposer）面积**：受 reticle 拼接与 CoWoS 世代限制。CoWoS-S 时代卡在 3.3× reticle（≈2500 mm²）；CoWoS-L 靠 RDL+LSI 混合结构把这个上限打开。
- **封装基板（substrate）面积**：受机械标准与 ABF 载板工艺限制。5.5× reticle 的中介层就已经需要 >100×100 mm 的基板，逼近 OAM 2.0 的 102×165 mm 上限；9× reticle 需要 >120×120 mm。

这两笔账必须分开核，因为它们的供应商、交期和失效模式都不同。只算中介层面积会严重低估机械与供电侧的可行性风险。

## 2. 方案分节

### 2.1 经典方案（上一代通行做法，用来判断"是不是落后了"）

**经典 A：单 reticle 上限 = 26 × 33 mm = 858 mm²（部分厂按 830 mm² 折算）。**
这是 EUV 一次曝光的最大面积，也是过去十年"单芯片"这个词的物理边界。围绕它形成的一整套设计习惯是：
把 die 做到接近 reticle 上限（Hopper 的 GH100 是 ~814 mm²），多余的内存挂在 die 的两侧 shoreline 上。
**这套习惯的隐含假设是"封装 XY 面积是免费的，只要 shoreline 够长"。** 多 reticle 封装直接推翻了这个假设。

**经典 B：把封装面积当作 bump 数的函数反推。** 学术界的成本模型做法是：
封装面积不是"die 面积之和 + 内存面积之和"，而是**由三类 bump 的数量与 pitch 决定的下限**——
(i) 供电 bump，(ii) 内存接口 bump，(iii) I/O 接口 bump；`A_pkg ∝ (bump pitch)² × (N_power + N_MC·N_MC + N_IO·N_IO)`。
同时，"bump 约束"和"wire fan-out 约束"各自给 compute die 面积一个**下界**，取严者生效
（Illinois 成本模型，年份 UNVERIFIED）。这条是本项目"封装面积锁死 MC 颗数"最直接的公开对应模型：
**内存档位数不是由"还剩多少 mm²"决定的，而是由"基板能引出多少个内存接口 bump"决定的。**

**经典 C：风冷 / 高流量单相冷板的 <700 W 单 die 时代。** 2024 年之前高端加速卡的 TDP 在 700 W 量级，
单相冷板在这个功率下热阻余量充足，工程问题只是"流量和压差"。这套做法在 1500 W 以上不再成立（见 §2.2）。

**经典 D：HBM 是唯一的内存层，且必须挂在 compute die 的 shoreline 上。** 这个假设的代价在
"经典 B"的模型里被显式量化：interposer 面积 = compute die 面积 + HBM stack 面积，二者直接竞争同一块 XY 空间。

### 2.2 SOTA 方案（近两代）

**SOTA A：CoWoS-L 的 RDL + LSI 混合结构，把高密度区做成"只在需要的地方付代价"。**
CoWoS-S 用整片硅中介层，成本与尺寸都卡在 3.3× reticle。CoWoS-L 改成：**die-to-die 高密度互联处放 LSI 硅桥，
其余大面积走 RDL 重布线层**。这样封装可以超过 2500 mm² 而不用整片大硅中介层。
这是"多 reticle 封装的 RDL/PHY 开销占比"这个问题在公开资料里的**标准答案形态**：
业界不是去优化"RDL 占百分之几"，而是**把 RDL 铺满、只在必须高密度的地方插 LSI**。

**SOTA B：垂直堆叠（3D / 混合键合）——不占封装 XY 面积的那一路。**
TSMC SoIC 的键合间距 6 µm 已量产，路线图是 2029 年 4.5 µm；公开宣称互连密度提升 50×、能效提升 5×。
对"面积受限时提高带宽"这个问题，3D 的价值在于**把带宽预算从 shoreline 搬到面密度上**：
UCIe-3D 的带宽面密度是 4000（9 µm）–300000（1 µm）GB/s/mm²，而 2.5D 是 188–1350 GB/s/mm²（见
`interconnect-collective.md` SOTA-IC-05）。**代价是散热**：3D 叠起来的 die 里，下层 die 的散热路径被上层挡住。

**SOTA C：把 PHY 从先进节点搬走。** 公开的技术披露（Google, 2020）指出：HBM PHY、SerDes、PCIe、GPIO
这类 I/O 接口在 3 nm 等新节点上**占掉可观面积且不随节点缩放**，因此把计算 core 与 I/O 接口分成两颗 die，
计算用 3 nm、I/O 用 7/10/14/16 nm，是降低验证成本同时释放计算 die 面积的做法。
这条对"RDL/PHY 开销占比"的回答是：**开销占比本身没被公开量化，业界的应对是改变分母（把 PHY 移出计算 die）而不是缩小分子。**

**SOTA D：两相直接到芯片冷板 + 微通道液冷冷板（MLCP）。**
两相把热流密度上限从单相的 ~250–300 W/cm² 提到 >500 W/cm²，热阻从 ~0.045–0.15 降到 0.035–0.080 °C·cm²/W，
流量从 ~1.5 L/min·kW 降到 0.7–0.8 L/min·kW。MLCP 进一步**把 IHS 和两层 TIM 从热路径上删掉**，
微通道宽 50–150 µm（传统冷板流道 1–3 mm），换热系数提升 2–3×，热阻低至 ~0.03 °C·cm²/W。

**SOTA E：垂直供电（IVR）。** 传统 VRM 放板上，电流要穿过基板与封装。TSMC 2025 年公开的集成式电压调节器（IVR）
宣称相对板级分立 PMIC 有 **5× 的垂直功率密度**传输。这与封装面积直接相关：供电 bump 是"经典 B"里三类 bump 之一。

## 3. 明确查不到的部分（不要用相邻领域数字凑）

1. **没有任何公开来源给出"多 reticle 单芯片封装里，跨 reticle 拼接（stitching）/ 缝合区的面积开销占百分之几"。**
   业界表述停留在"stitch map 需与封装厂确认"，没有百分比。本项目若要填这个洞，只能向封装厂索取 stitch map 与 keep-out 规则。
2. **没有公开的"RDL 层数 → 可提供的互联带宽/面积"换算表。** 公开资料只给了 CoWoS-L 是"RDL + LSI 局部硅桥"这个结构，
   RDL 能做到几层、每层多少走线密度、良率随层数怎么变，均无公开数字。
3. **没有公开的 HBM PHY / MC 控制器在先进节点上占 die 面积的具体百分比。**
   有定性表述（"occupies substantial area"、"don't scale well"）和建模方法（PHY 面积 ∝ 32-bit interface group 数 × 单元面积 + 通道数 × 地址字单元面积），
   但没有可直接引用的百分比。任何"PHY 占 X%"的引用都应视为编造。
4. **没有公开的"每 mm² 封装面积的可用内存带宽"基准曲线。** 能拼出来的是两个端点：
   每 HBM stack 的 footprint（11×11 mm）与每 stack 带宽（HBM3E >1.2 TB/s），中间那层"给定封装面积下最优的内存档位组合"没有公开解。
5. **HBM4 的换代会改变本节多个数字，但本轮未取到 `as_of` horizon 之内的可核查一手来源。**
   HBM4 的 2048-bit 接口、每 stack >2 TB/s、2026 年量产这些方向性事实在 2025 年已由 JEDEC 与厂商公布，
   但本轮检索命中的比较表来自 horizon 之后的日期，故不纳入卡片（见 `unresolved`）。
6. **热侧的"厂商 demo 数字"与"行业共识数字"差距很大，必须分开读。**
   冷板供应商的自测（单 reticle 热点 600 W/cm²、2-reticle 封装 40 °C 入口下 Tj 80.5 °C、宣称可支持 4400 W 级芯片）
   都是 2026-01 CES 上的厂商演示条件，不是可外推的行业共识。

## 4. 各卡片索引

| 卡片 | 一句话 |
|---|---|
| SOTA-PPA-01 | 单 reticle 858 mm² 与多 reticle 封装的世代台阶（1.5× → 3.3× → 3.5× → 5.5× → 9×/9.5×） |
| SOTA-PPA-02 | 经典方案：封装面积 = 三类 bump 数 × pitch² 的下限，不是面积求和 |
| SOTA-PPA-03 | CoWoS-L 的 RDL + LSI 混合：高密度只在需要的区域付代价 |
| SOTA-PPA-04 | interposer 面积 ≠ 基板面积：机械封装（OAM 2.0、ABF 层数）是第二道墙 |
| SOTA-PPA-05 | HBM3E 每 stack 的面积 / 带宽 / 功耗三笔账 |
| SOTA-PPA-06 | 面积受限时提高带宽路径 A：垂直堆叠（SoIC / 混合键合） |
| SOTA-PPA-07 | 面积受限时提高带宽路径 B：拆出 I/O die，把 PHY 从先进节点移走 |
| SOTA-PPA-08 | 面积受限时提高带宽路径 C：外挂（co-packaged optics / scale-out） |
| SOTA-PPA-09 | 单相冷板的功耗边界：~1500 W 见顶、~2000 W 上限 |
| SOTA-PPA-10 | 热流密度与热阻：单相 250–300 W/cm² vs 两相 >500 W/cm² |
| SOTA-PPA-11 | MLCP：把 IHS 和两层 TIM 从热路径上删掉 |
| SOTA-PPA-12 | 功耗的另一条锁死路径：PDN / IVR / 基板层数 |
| SOTA-PPA-13 | 大封装的可制造性边界：翘曲随封装尺度上升 |

confidence 分配原则：厂商数据表与厂商路线图 = `vendor_datasheet`（口径通常偏乐观，且路线图日期常顺延）；
论文/第三方实测 = `public_measurement`；行业调研与标准组织材料 = `industry_survey`。
没有一条是 `model_memory`。

## 5. 知识卡

### SOTA-PPA-01 单 reticle 的物理上限是多少，以及多 reticle 封装按什么台阶往上走

- **approach**：EUV reticle limit 与 CoWoS 世代的 reticle 倍数路线图
- **what_it_is**：EUV 光刻机一次曝光能转印的最大面积由 reticle 尺寸决定，业界通行值是 26 × 33 mm = 858 mm²（部分厂在面密度估算里按 830 mm² 折算）。任何单颗 die 都受这个上限约束，跨过它的唯一办法是把多颗 die 放到同一封装里，用中介层（interposer）互联。于是「封装能做多大」这件事，行业用「几倍 reticle」来度量：中介层面积 ≈ N × 858 mm²。这个倍数在近十年按世代往上走，每一级都对应一次结构变化，而不是简单的尺寸放大。
- **who_uses_it**：所有做超大 AI 加速器封装的团队。TSMC CoWoS 是当前的默认载体：NVIDIA Hopper/Blackwell、AMD MI300/MI450、Google TPU、AWS Trainium、Meta MTIA 都在其上。Intel 走 Foveros-S/EMIB 路线作对照。
- **typical_numbers**：单 reticle 上限：26 × 33 mm = 858 mm²（ECTC 2024 取 830 mm² 作计算基准）。CoWoS 世代台阶（公开路线图口径）：2016 初代约 1.5× reticle；量产后长期停在 3.3× reticle / ≈2500–2831 mm²，可放 8 个 HBM3/HBM3E 堆栈（NVIDIA Blackwell 3.3× ≈ 2700 mm² / 8× HBM）；2025–2026 年 5.5× reticle，容纳最多 12 个 HBM4 堆栈（第三方推算 5.5× ≈ 4565–4719 mm²）；2027 年 9×–9.5× reticle，为 chiplet 与内存提供最高 7722 mm²、并支持 12 个以上 HBM 堆栈；更远期 14× 及以上。所有这些是厂商路线图口径，量产日期历史上经常顺延。
- **applies_when**：需要判断某个体量的封装在此刻的工艺世代下属于「主流可达」「路线图上但未量产」还是「超出公开路线图」；或者为「多 reticle 单芯片」找一个面积量级上的同类项。
- **not_applicable_when**：不适用于 (a) 把路线图的**峰值面积**当成**今天可下线的面积**——9×/9.5× 的 7722 mm² 属于规划值，不能当作可用约束；(b) 用 TSMC 的 reticle 倍数换算非 TSMC 封装（Intel EMIB/Foveros、三星 I-Cube/SAINT、日月光 FOCoS 的面积口径与结构都不同）；(c) 把它当成本核算——reticle 倍数越大，硅中介层良率与基板层数代价是非线性的，路线图只给尺寸不给良率曲线；(d) 微型封装或单 die 设计，reticle 倍数概念不成立。
- **project_premises**：7-reticle
- **what_to_check_here**：去核 `teams/hardware/inputs/k3_mc_baseline.json#package` 块的 `reticles=7` 与 `placementWindowMm2=5248`：把 7 × 858 = 6006 mm² 与 7 × 830 = 5810 mm² 两个口径都算出来，确认 5248 mm² 这个 placement window 相对两个口径分别留了多少 engineering 余量；再核 ADR-0018（`teams/council/adr/ADR-0018-7-reticle-package-boundary.md`）里是否记录了「7-reticle 对应的是哪一代 CoWoS 结构」——公开路线图上 7× 落在 5.5× 与 9.5× 之间，属于 2026–2027 区间，要确认封装厂档期能对上。
- **sources**：
  - ECTC 2024 Special Session on Metrology（CoWoS reticle 世代与 1 reticle ≈ 830 mm²），2024，https://ectc.net/files/2024highlights/2024%20ECTC%20Special%20Session%20on%20Metrology.pdf
  - TrendForce: Wafer-Level Packaging Showdown: TSMC Scales up CoWoS Reticle Size，2025，https://www.trendforce.com/news/2025/05/02/news-wafer-level-packaging-showdown-tsmc-scales-up-cowos-reticle-size-as-intel-readies-foveros-s/
  - IT之家 / C114：台积电 OIP 论坛宣布 2027 年 9 倍光罩尺寸 CoWoS，7722 mm²，12 个 HBM4 堆叠，2025，http://www.c114.net.cn/chip/71852.html
  - 经济日报系（imeritz 研究简报）：CoWoS 封装大型化，3.3-reticle 2700 mm² → 5.5-reticle 4565 mm² → 9.5-reticle 7885 mm²，2025，http://home.imeritz.com/include/resource/research/WorkFlow/20250707073731490K_02.pdf
- **confidence**：vendor_datasheet
- **relative_validity**：约 1–2 年。reticle 倍数路线图每年在技术论坛上被改写一次（9.5× 是在 2025 年论坛上从更早的 9× 口径修订来的），面积与堆栈数会随下一代论坛更新。

### SOTA-PPA-02 封装面积到底被什么锁死：不是 die 面积之和，而是基板能引出多少 bump

- **approach**：以 bump 数与 bump pitch 反推封装面积下界；bump 约束与 wire fan-out 约束共同给 die 面积下界
- **what_it_is**：学术界的芯片-封装协同设计（DSE）成本模型里，封装面积不是「compute die 面积 + 内存面积」的求和，而是由封装到 PCB 的 bump 阵列决定的下界：总 bump 数 = 供电 bump（正比于 die 功率除以电压与单 bump 电流承载）+ 内存接口 bump × 内存控制器数 + I/O 接口 bump × I/O 数；再乘以 bump pitch 的平方得到面积。同时，compute die 面积本身有两个下界：bump 约束（die 上必须放下所有到封装的 bump）和 wire fan-out 约束（走线扇出），二者取严者生效。这套模型把「封装能不能多挂一颗内存」翻译成「基板还能不能引出这么多内存接口 bump」，与「还剩多少 mm²」是两个不同的问题。
- **who_uses_it**：做 die/package 协同设计空间探索的团队；也用于解释为什么同样的封装面积下，供电 bump 会挤掉内存接口 bump 的位置。学术界（UIUC 系）的芯片-封装-内存协同设计论文是这条方法的公开来源。
- **typical_numbers**：模型形式（非实测值，单位为公式量）：`A_pkg ≈ (bump pitch)² × ( [P_die / (V_die × I_bump)] × 2 + N_bump_MC × N_MC + N_bump_IO × N_IO )`；`A_interposer = A_compute_die + A_HBM_stack`（每个内存控制器配一个 HBM stack）。模型中的关键变量是单 bump 电流承载 I_bump 与 bump pitch——公开资料未给出这两个量的通用取值，必须按具体封装世代向封装厂索取。提示：bump pitch 是封装面积公式里的平方项，pitch 从 130 µm 降到 110 µm 会让同样的 bump 数占用面积减少约 28%（算术推论，非公开实测）。
- **applies_when**：需要在「加一颗内存档位」与「提升单档位带宽」之间做取舍；或者怀疑某个体量的封装是供电 bump 而不是信号 bump 先触顶；或者要判断封装面积预算里哪些部分是可压缩的。
- **not_applicable_when**：不适用于 (a) 用公式里的系数（I_bump、bump pitch）直接代入本项目而不向封装厂确认——这些系数随封装世代、基板层数、材料变化；(b) CoWoS-L 这类「RDL + 局部 LSI」结构——基板走线不再受单一 bump pitch 支配，模型的几何假设部分失效；(c) 3D 堆叠方案——垂直方向不消耗 XY bump 面积，模型不覆盖；(d) 把「面积下界」当作「面积预算」——实际封装面积通常显著大于下界，差额是 keep-out、散热与机械结构。
- **project_premises**：封装面积锁死 MC 颗数
- **what_to_check_here**：去核 `teams/hardware/inputs/k3_mc_baseline.json#package` 块：把 `memoryCubes=16`、`memoryCubesPerComputeDie=2`、`memoryCubeAreaMm2Planning=100` 拿出来，与 `placementWindowMm2=5248` 的余量项 658.29 mm²（见 `teams/hardware/docs/09_PACKAGE_POWER_RAS.md` 第 1 节 pie 图）对齐，确认这个余量里是否已经含三类 bump 的开销；然后向封装厂索取两件事：I_bump（单 bump 电流承载，按目标基板层数与材料）与基板到 PCB 的 bump pitch 规格——用它们重算「16 颗 MC 的接口 bump + 供电 bump」需要的最小基板面积，看是否仍在 OAM 类机械标准内。
- **sources**：
  - UIUC 芯片-封装-内存协同设计成本模型（bump 约束与 wire fan-out 约束给出 compute die 面积下界；封装面积 = 三类 bump 数 × pitch²），UNVERIFIED，https://www.ideals.illinois.edu/items/131937/bitstreams/438019/data.pdf
  - HBM base die 建模：PHY 面积 = N_DW × A_DW,unit + N_ch × A_AW,unit，以及 bump-map footprint 计算，UNVERIFIED，https://dermatology-s10.cdlib.org/content/qt4q14k7xf/qt4q14k7xf.pdf
- **confidence**：public_measurement
- **relative_validity**：约 3–5 年。方法是封装面积账的通用框架，不随代际失效；但公式里的系数（I_bump、bump pitch、I/O bump 数）每代都要重新索取。relative_validity 指的是框架本身，不是系数。

### SOTA-PPA-03 多 reticle 封装里 RDL 与高密度区怎么分工：不是优化 RDL 占比，而是把 LSI 只放在需要的地方

- **approach**：CoWoS-L：RDL 重布线层铺满全封装，die-to-die 高密度互联处局部插入 LSI 硅桥
- **what_it_is**：CoWoS 有三条路线。CoWoS-S 用整片硅中介层：互联密度最高，但中介层面积受硅片良率与尺寸限制，长期卡在 3.3× reticle / 约 2500 mm²。CoWoS-R 改用有机聚合物（RDL）中介层，成本低但互联密度低。CoWoS-L 是两者的混合：大面积用 RDL，只有在需要 die-to-die 高密度互联的位置嵌 LSI（Local Silicon Interconnect）硅桥。这样封装尺寸可以突破 2500 mm²，而高密度硅工艺面积只按「实际需要高密度的那几处」付费，而不是整片。这是「RDL 与 PHY 面积开销占比」这个问题在公开资料里的真实答案形态：业界不追求降低 RDL 占比，而是把硅基高密度区从 100% 降到局部。
- **who_uses_it**：NVIDIA Blackwell 世代（GB200/GB300）起切换到 CoWoS-L；AMD、Broadcom 也在同一路线上。CoWoS-R 用于成本敏感的边缘推理与网通 ASIC（如 AWS Trainium 一类的口径）。CoWoS-S 仍是 Hopper、MI300 初代的主力。
- **typical_numbers**：CoWoS-S：最高 3.3× reticle，中介层面积上限约 2500–2831 mm²，8 个 HBM3/HBM3E 堆栈。CoWoS-L：3.5× reticle 已量产，5.5× 在 2026 年认证节点上（≈4565–4719 mm²），可支持 12 个 HBM4 堆栈。CoWoS-R：公开口径称 2027 年可达 9× 光罩尺寸。RDL 本身的层数-密度对应关系、LSI 桥的数量与尺寸规则，公开资料均无数字。
- **applies_when**：做一个大于 3.3× reticle 的封装方案，需要在「整片硅中介层」「RDL+局部硅桥」「RDL only」三条路线间选型；或者需要解释为什么大面积封装的成本不随面积线性增长。
- **not_applicable_when**：不适用于 (a) 封装面积在 3.3× reticle 以内——CoWoS-S 在这个区间仍是密度与成熟度最优，上 CoWoS-L 不划算；(b) 需要全封装范围均匀极高互联密度（比如大规模 die 间全互联）——LSI 是局部结构，密度不均匀；LSI 的数量与位置受 die 排布约束；(c) 需要向供应商索取 RDL 层数与线密度数据来算账——公开资料没有这张表，只能走封装厂的设计规则文档；(d) 把它当作「RDL 开销占比很低」的证据——公开资料没有给出任何占比数字。
- **project_premises**：7-reticle
- **what_to_check_here**：去核 `teams/hardware/docs/09_PACKAGE_POWER_RAS.md` 第 1 节与第 8 节冻结交付物清单：当前「余量（RDL、间距、keep-out、PDN、维修）= 658.29 mm²」是一个**集总余量**，没有把 RDL 走线面积与 LSI 桥面积分开。行动项：向封装厂索取三样东西——(1) 7-reticle 面积下 RDL 的可用层数与每层走线密度；(2) LSI 桥的数量/位置规则与最小尺寸；(3) die-to-die 高密度互联区（`k3_mc_baseline.json#package` 里的 die fabric 端口）落在哪几条边上。然后用这三项把 658.29 mm² 拆成 RDL + LSI + keep-out + PDN 四笔，看是否仍然非负。
- **sources**：
  - TSMC 先进封装路线与 CoWoS-S/R/L 三路线划分（含 CoWoS-L 的 LSI 硅桥 + RDL 混合结构与 12× HBM 支持），2026，https://m.elecfans.com/article/8224977.html
  - Bits, FLOPS, and Watts: A Systems-Level Perspective of Scaling LLMs（CoWoS-S/R/L 变体与封装尺寸跨 reticle 的描述），UNVERIFIED，https://github.com/asheeshgoja/bits-flops-and-watts/raw/main/Bits,%20FLOPS,%20and%20Watts_%20A%20Systems-Level%20Perspective%20of%20Scaling%20LLMs.pdf
- **confidence**：industry_survey
- **relative_validity**：约 2 年。CoWoS 三条路线的分工在 2024–2026 稳定，但 CoWoS-R 的 9× 目标与 CoWoS-L 的 14× 目标会持续改写「哪条路线支持多大面积」这张表。

### SOTA-PPA-04 中介层面积不等于封装面积：机械标准与基板层数是第二道墙

- **approach**：把封装可行性拆成「中介层面积账」与「基板/机械账」两笔分别核
- **what_it_is**：多 reticle 封装的可行性有两道独立的墙。第一道是中介层（芯片侧）能拼多大，由 CoWoS 世代与 reticle 拼接决定。第二道是封装基板（substrate）——中介层要装到一块 ABF 载板上，载板尺寸受机械标准约束，层数受翘曲与微孔对准约束。公开资料显示这两道墙的斜率不同：中介层做大一档，基板尺寸与层数要跳一级。所以「面积能做多大」的答案必须同时给出 interposer 尺寸与 substrate 尺寸两个数，只给一个会严重低估机械与供电侧的可行性风险。
- **who_uses_it**：做超大封装可行性评估的封装/机械团队；数据中心整机团队用它判断机箱、供电与冷却的配套是否需要改版。
- **typical_numbers**：5.5× reticle 的中介层需要 >100 × 100 mm 的基板，已经逼近 OAM 2.0 标准的 102 × 165 mm 上限；9× reticle 需要 >120 × 120 mm 的基板。为支撑 5.5× 与更大的封装，高端 ABF 载板正在升级到 18–20 层；面向 14× 级别封装的载板尺寸估计可达 100 × 100 mm 量级。9.5× 级别的中介层本身公开确认可到 18000 mm²。适用条件：TSMC CoWoS 系列的公开口径，2025–2027 年窗口。
- **applies_when**：评估一个多 reticle 封装的整体可行性；或者判断封装是否还能装进目标机箱/插槽；或者做供电与冷却的配套预算。
- **not_applicable_when**：不适用于 (a) 只做 chiplet 划分与 die 间互联预算——那是中介层侧的问题，与基板尺寸无关；(b) 把 OAM 2.0 当作唯一机械标准——OCP、PCIe CEM、各厂自研载板尺寸并存，若目标不是 OAM 模块则整套约束不同；(c) 用基板尺寸推算冷却方案——基板面积与会发热面积不是一回事，冷板覆盖的是裸片区域；(d) 把 18–20 层当作通用值——这是为大尺寸封装升级后的口径，小封装仍在更低的层数上。
- **project_premises**：7-reticle
- **what_to_check_here**：去核 `docs/architecture/HIGH_LEVEL_ARCHITECTURE.md` 与 `teams/hardware/docs/09_PACKAGE_POWER_RAS.md` 第 1 节：当前封装登记为「约 82 × 64 mm」的中介层/placement window 尺寸。行动项有两个：(1) 用这个尺寸反查基板尺寸——向封装厂确认 82 × 64 mm 的中介层需要多大基板，以及该基板尺寸是否仍在目标机械标准（OAM 2.0 为 102 × 165 mm）与 ABF 载板供应能力之内；(2) 确认 18–20 层 ABF 载板在本项目的量产时间窗口内是否可获配（公开资料指出 ABF 载板是 2025–2026 先进封装的供给瓶颈之一）。
- **sources**：
  - C114 / cnBeta：台积电超大版 CoWoS，5.5 倍光罩需 >100×100 mm 基板、9 倍需 >120×120 mm、逼近 OAM 2.0 的 102×165 mm，2025，http://www.c114.net.cn/chip/71466.html
  - 电子发烧友：CoWoS 产能与 ABF 载板层数升级至 18–20 层的口径，2026，https://m.elecfans.com/article/8224977.html
- **confidence**：industry_survey
- **relative_validity**：约 2 年。OAM 标准尺寸与 ABF 层数供给都是会变的量；ABF 载板供给瓶颈是当前周期的现象，会随产能扩张缓解。

### SOTA-PPA-05 一个内存档位吃掉多少封装面积、给多少带宽、烧多少功耗

- **approach**：HBM3E 每 stack 的 footprint / 带宽 / 功耗三笔账
- **what_it_is**：HBM 是当前 AI 加速器的默认内存档位，它以堆叠体的形式贴在中介层上，占用封装 XY 面积。每颗 stack 的三笔账可以分别核：footprint（中介层上占多大地方）、带宽（1024-bit 接口 × 每 pin 速率）、功耗（stack 自身耗电，同时决定热点位置）。这三笔账必须一起看，因为它们是同一个物理对象在不同约束下的投影——带宽提高会推高功耗，功耗又决定散热设计，散热结构又占用封装面积。
- **who_uses_it**：所有用 HBM 的加速器：NVIDIA H100/H200/B200/B300、AMD MI300X/MI325X/MI355X、Intel Gaudi、以及各云厂商自研 ASIC。HBM3E 是 2024–2026 高端 AI 加速器的通用内存。
- **typical_numbers**：HBM3E 每 stack：footprint 11 × 11 mm（= 121 mm²），8-Hi 堆叠高度 0.72 mm；接口 1024-bit，16 个独立通道，每通道 2 个伪通道；pin 速率 9.2–9.6 Gb/s；每 stack 带宽 >1.2 TB/s（最高约 1.22–1.33 TB/s）；容量 24 GB（8-Hi）到 36 GB（12-Hi）。每 stack 功耗 5–8 W（@1.1 V 核心 / 1.8 V I/O）。能效口径分歧很大：厂商与行业汇总给出 1.2–2.0 pJ/bit（HBM3E），也有分析口径给到约 3.9 pJ/bit——差异来自是否计入 PHY 与控制器侧；引用时必须指明口径。整机口径：H100 6× HBM3 = 3.35 TB/s；H200 6× HBM3E = 4.8 TB/s；B200/B300 8× HBM3E = 8 TB/s（B300 用 12-Hi 拿到 288 GB）。
- **applies_when**：做封装面积预算时把内存按「每 stack 固定 footprint + 固定带宽」的离散档位来排布；或者评估在给定封装面积下最多能挂几档内存；或者为内存侧算功耗与热点。
- **not_applicable_when**：不适用于 (a) 片外/机架级内存池——那些不占用封装面积，footprint 账不成立；(b) 用 footprint 反推「还剩几档」而不计入 keep-out、TSV 落区、bump map 与维修余量——121 mm² 是裸堆叠体的尺寸，实际占位更大；(c) 把 1.2 pJ/bit 直接用于系统功耗预算——不同来源差到 3 倍，必须确认是 die 级还是含 PHY 的接口级；(d) 把 5–8 W/stack 当作冷板热点估算——冷板关心的是热流密度（W/cm²）与热点位置，不是 stack 总功耗；(e) 12-Hi 与 8-Hi 的散热表现不同，12-Hi 通过减薄 die 与先进 MUF 维持同一高度，热阻特性不等价。
- **project_premises**：封装面积锁死 MC 颗数
- **what_to_check_here**：去核 `teams/hardware/inputs/k3_mc_baseline.json` 的 `memoryCubeAreaMm2Planning=100` 与 `memoryCubes=16`：公开参照系是 HBM3E 每 stack 的裸叠体 footprint 为 11 × 11 = 121 mm²。行动项：(1) 向 MC 供应商索取其「100 mm² 规划值」的定义——是裸叠体 footprint、还是含 TSV 落区/bump map/keep-out 的占位面积，两者差多少；(2) 索取每 MC 的功耗实测（当前基线里 MC 功耗按 16 × (7 W + 640 GB/s × 0.7 × 8 bit × 5 pJ/bit) 计算，其中 5 pJ/bit 这个接口能耗系数与 HBM3E 的公开区间关系需要单独确认）；(3) 索取每 MC 的热阻与热点位置（`teams/hardware/docs/09_PACKAGE_POWER_RAS.md` 第 6 节已把「MC 堆叠热点」列为验证项）。
- **sources**：
  - Micron HBM3E Product Brief（8-Hi 24GB，>9.2 Gb/s，>1.2 TB/s，11mm × 11mm × 0.72mm，16 通道 / 2 伪通道），2023，https://www.jp.micron.com/content/dam/micron/global/public/documents/products/product-flyer/hbm3e-product-brief.pdf
  - SK hynix HBM3E 产品页（9.6 Gbps、>1.23 TB/s、36 GB、MR-MUF 散热改善 10%），2024，https://www.directindustry.com/ja/prod/sk-hynix/product-34497-2687699.html
  - HBM3e 参数汇总（每 stack 5–8 W @1.1V VDD / 1.8V VDDQ，约 2.0 pJ/bit；各加速器 stack 数与总带宽对照），2025，https://www.superb-tech.com/hbm-memory-substrate-2tb/s-bandwidth-pcb-interconnect-challenges.html
  - HBM3E vs DDR5 能效对照（HBM3E 1.2 pJ/bit 口径），2025，https://raw.githubusercontent.com/laozdao/dao-quant-research/e585f1488518c1e0e5da105c0af1198a76a59c61/articles/I05-semiconductor/I05-08-micron-fy26q3-earnings-impact-quantification.md
- **confidence**：vendor_datasheet
- **relative_validity**：约 1–2 年。HBM3E 的量产参数已稳定，但 pJ/bit 口径分歧会在 HBM4 换代时被重新定义；stack 数与总带宽的对照表每个 SKU 都会更新。

### SOTA-PPA-06 面积受限时提高内存带宽的路径 A：垂直堆叠，把带宽预算从 shoreline 搬到面密度

- **approach**：3D 混合键合（SoIC 类）与 UCIe-3D：用 Z 方向换 XY 面积
- **what_it_is**：当封装 XY 面积被锁死、而 shoreline 上的带宽已经用尽时，第一条公开成型的路径是把互联搬到垂直方向。逻辑 die 之间或逻辑与内存之间用混合键合（hybrid bonding）直接贴合，键合间距做到微米级，互联面密度比 2.5D 的中介层布线高一到两个数量级。这条路线的本质是：用 Z 方向的面积换 XY 方向的面积，并顺带把互联距离从毫米级压到微米级，降低每 bit 能耗。代价有两个：一是散热路径被上层 die 挡住，二是键合工艺良率与堆叠层数强相关。
- **who_uses_it**：TSMC SoIC（AMD 3D V-Cache、以及 CoWoS 之上再叠 SoIC 的组合方案）；UCIe-3D 标准的混合键合路线。公开路线图里被用来在 9× 级别 CoWoS 上叠 1.6nm 逻辑于 2nm 逻辑之上。
- **typical_numbers**：TSMC SoIC 键合间距：6 µm 已量产，路线图 2029 年 4.5 µm；公开宣称相对传统互连密度提升 50×、能效提升 5×。UCIe-3D 带宽面密度 4000（9 µm 间距）–300000（1 µm 间距）GB/s/mm²，对比 2.5D 的 188–1350 GB/s/mm²（见 `interconnect-collective.md` SOTA-IC-05）；UCIe-3D 的每 bit 能耗 0.05 pJ/b（9 µm）–0.01 pJ/b（1 µm），对比 2.5D 的 0.25–0.3 pJ/b。适用条件：advanced package、混合键合工艺、被叠 die 的功耗密度在可散热范围内。
- **applies_when**：封装 XY 面积已经触顶、shoreline 带宽已经用尽，需要在不增加封装面积的前提下提升 die 间或 die-内存带宽；或者需要降低跨 die 传输的 pJ/bit。
- **not_applicable_when**：不适用于 (a) 散热受限的设计——3D 堆叠让下层 die 的结温上升，在液冷边界附近（见 SOTA-PPA-09/10）会先撞热墙再撞面积墙；(b) 需要高良率大面积的堆叠——键合面积越大、层数越多，良率损失越快，公开资料没有给出可外推的良率-面积曲线；(c) 把 300000 GB/s/mm² 当作可得值——那是 1 µm 间距的理论面密度，不是任何量产产品的实测；(d) 用 SoIC 的 5× 能效提升做系统级功耗预算——那是互连层的能效，不是系统能效。
- **project_premises**：封装面积锁死 MC 颗数
- **what_to_check_here**：去核 `teams/hardware/docs/06_MULTIDIE_AND_SCALEOUT.md` 与 `teams/hardware/docs/09_PACKAGE_POWER_RAS.md` 第 6 节：当前设计是 4×2 的平面 die 排布 + 环互联，属于纯 2.5D。行动项：如果在面积锁死后需要更多带宽，把「3D 堆叠 MC 或堆叠部分 compute die」作为一个候选方案送进封装评估，向封装厂索取三件事——(1) 6 µm 键合间距在中介层面积量级上的可用键合区域与 keep-out；(2) 堆叠后的热阻增量（下层 die 到冷板的等效热阻）；(3) 堆叠后的良率与维修策略。这三项与 `teams/hardware/inputs/k3_mc_baseline.json#package` 的 `memoryCubeAreaMm2Planning=100` 直接联动。
- **sources**：
  - TSMC 2025 北美技术论坛：SoIC 混合键合 6 µm 量产、9.5× CoWoS 上叠 1.6nm 于 2nm 之上，2025，https://www.chinatimes.com/realtimenews/20250424001162-260410?chdtv
  - On-Package Memory with UCIe（UCIe-2D/2.5D/3D 带宽面密度与 bump pitch 对照表），2025，https://browse-export.arxiv.org/pdf/2510.06513
- **confidence**：vendor_datasheet
- **relative_validity**：约 2 年。键合间距 6 µm → 4.5 µm 的路径已公开，代际变化会改写面密度上下限；能效数字随间距变化很快，需按目标间距重取。

### SOTA-PPA-07 面积受限时提高带宽的路径 B：把 PHY 从先进节点搬走，改变分母而不是缩小分子

- **approach**：I/O die / compute die 分离（计算用先进节点，I/O 用成熟节点）
- **what_it_is**：公开的技术披露指出，HBM PHY、SerDes、PCIe、GPIO 这类 I/O 接口在高性能 ASIC 上占据可观面积，而且它们在新节点上缩放很差——3 nm 的 I/O 相对 7 nm 并不显著变小，导致 I/O 在计算 die 上的面积占比随节点演进反而上升。业界的应对有两种形态：一是把 I/O 与计算分成两颗 die，计算用 3 nm、I/O 用 7/10/14/16 nm，好处是 I/O 的验证成本降到成熟节点，计算 die 面积被释放；二是把内存控制器与 PHY 直接搬进内存堆叠体的 base die。第二种是更激进的形态，其公开数字属于 2026 年之后的信息，不在本文件 horizon 内，但方向已被公开讨论。
- **who_uses_it**：高性能 ASIC 的分割方案；公开技术披露来自 Google（搜索 ASIC 类）。工业上，Broadcom/Marvell 的定制 ASIC 与各云厂商的加速器都在做 I/O 与计算的分割。
- **typical_numbers**：定性结论：「I/O 接口是计算功能的 overhead，在 3 nm 等新节点上缩放很差」。量化方法（可复用）：HBM base die 的 PHY 面积按 `A_PHY = N_DW × A_DW,unit + N_ch × A_AW,unit` 建模，即数据字部分随 32-bit 接口组数线性、地址字部分随通道数线性——**说明 PHY 面积正比于接口宽度**，因此把接口做宽（如 HBM4 的 2048-bit）会让 PHY 面积线性上升。**公开资料中不存在「PHY 占 die 面积百分之几」的可引用数字。**
- **applies_when**：需要论证「提高内存带宽会先撞 PHY 面积墙」；或者在做 die 分割决策时评估把 I/O 移到成熟节点的收益。
- **not_applicable_when**：不适用于 (a) 引用任何具体百分比——公开来源只有定性表述（substantial / don't scale well），任何「PHY 占 X%」都是编造；(b) 把 I/O die 方案套到不需要极高 shoreline 带宽的设计上——分割本身有 D2D 互联成本；(c) 当作降低延迟的方案——I/O 分割会引入跨 die 跳数（见 `interconnect-collective.md` SOTA-IC-10）；(d) 用 base die 内的控制器方案（后 horizon）的具体数字。
- **project_premises**：封装面积锁死 MC 颗数
- **what_to_check_here**：去核 `teams/hardware/docs/09_PACKAGE_POWER_RAS.md` 第 2 节的端口表与第 0 节规格表：当前 PHY shoreline 为 24.21 mm、预算 52.95 mm。行动项：(1) 把「每 Die 4 个 UCIe controller group × 128 lane + 16 条 112 Gbps RDMA lane」换算成 die 上的 PHY 面积占用（不只是 shoreline 长度），向 UCIe / SerDes IP 供应商索取其 PHY 在目标数据率与目标节点下的 mm²/IP；这个数字目前在仓库里没有，属于 UNVERIFIED 缺口。(2) 把 PHY 面积从 373.71 mm² 的 compute die 面积里显式扣出来，看阵列可用面积还剩多少。
- **sources**：
  - Technical Disclosure Commons (Google): Three-dimensional Integration of Compute Core and I/O in High-performance ASIC（I/O 接口在新节点缩放差、占 substantial area；3nm 计算 + 7nm I/O 的分割），2020，https://www.tdcommons.org/cgi/viewcontent.cgi?article=4735&context=dpubs_series
  - HBM base die 建模：PHY 面积 ∝ 32-bit interface group 数 + 通道数；TSV 落区、bump map、DFT 面积分别建模，UNVERIFIED，https://dermatology-s10.cdlib.org/content/qt4q14k7xf/qt4q14k7xf.pdf
  - OCP: EDA for Multi-die System Integration in a Package（并列 vs 串联 D2D 接口的密度/时延/成本对照；interposer 面积上限 2x reticle 的口径），UNVERIFIED，http://files.opencompute.org/oc/public.php?service=files&t=86d9e2fecbd001a9a0f5cf9bdfbbbf4f&download
- **confidence**：industry_survey
- **relative_validity**：约 3 年。处理器侧「I/O 不随节点缩放」这个结论本身长期有效；但 I/O 分割的具体收益随节点对（如 N3 vs N7）变化，需按目标节点重估。

### SOTA-PPA-08 面积受限时提高带宽的路径 C：外挂——把带宽搬出封装，代价换成功耗与热

- **approach**：Co-packaged optics（CPO）与封装外 scale-out：用光互联替代封装内短距铜互联
- **what_it_is**：当封装面积锁死后，第三条路径是不在封装里解决带宽问题，而是把带宽需求送到封装外——机架级互联或远端内存池。公开资料里这条路径当前的主要载体是共封装光学（Co-packaged Optics, CPO）：把光引擎与交换/计算 ASIC 放在同一封装内，把电互联的长度从板级压到封装级。它的直接收益是 I/O 功耗与距离，代价是把热负荷搬回了封装——光引擎本身发热，且在封装边缘形成热点。这与「面积受限时提高带宽」的问题是同一个：外挂路线不受封装 XY 面积约束，但受封装边缘的热与供电约束。
- **who_uses_it**：交换机 ASIC（CPO 已在交换侧量产）、以及超大 AI 集群的 scale-out 层。TSMC 的 COUPE（Compact Universal Photonic Engine）是公开的硅光子集成平台。
- **typical_numbers**：TSMC 公开的 COUPE 硅光子集成方案与 N12/N3 逻辑基础裸晶一起，作为 HBM4 与 AI 应用的配套技术被公布（具体带宽/功耗数字未在同一材料中给出）。关于外挂路线的能耗量级，`interconnect-collective.md` SOTA-IC-06 已给出对照：并联 UCIe <0.25–0.6 pJ/b，串联 112G XSR 约 1.2 pJ/b——即「出封装」这一步本身就有一个数量级的能耗台阶。
- **applies_when**：封装内带宽已被面积锁死、且负载能容忍跨封装时延（如 all-reduce、KV 卸载、专家并行的 all-to-all），此时用外挂换面积是成立的。
- **not_applicable_when**：不适用于 (a) 单 token decode 的时延敏感路径——跨封装往返的时延量级与片内差 1–2 个数量级（见 `interconnect-collective.md` SOTA-IC-10/16），对 B=1 的 ITL 是直接伤害；(b) 把 CPO 当作降低封装内热负荷的方案——它把热负荷移到了封装边缘，形成新的热点位置；(c) 把外挂带宽当作「不受面积约束」——封装边缘的 shoreline、供电 bump 与冷板覆盖范围仍然约束它可以引出多少；(d) 用「外挂无限」来回避封装内面积账，只有在时延预算允许时才成立。
- **project_premises**：封装面积锁死 MC 颗数
- **what_to_check_here**：去核 `teams/hardware/docs/09_PACKAGE_POWER_RAS.md` 第 2 节端口表与第 6 节散热验证项：scale-out 端口登记为「16 lane × 112 Gbps = 168 GB/s/Die，800 GB/s/卡（上限）」，且第 5 节已把「scale-out PHY 边缘热点」列为验证项。行动项：(1) 向光模块 / SerDes 供应商索取 168 GB/s/Die 与 800 GB/s/卡的**真实功耗**——09 号文档第 4.2 节已明确把「高速 SerDes / 光模块真实功耗」列为尚未可靠计入的项目，而卡功耗余量只有 31.53 W；(2) 索取封装边缘在 CPO 形态下的热流密度（W/cm²）与冷板能否覆盖到边缘，(3) 确认 800 GB/s/卡的上限是 shoreline 约束还是时延约束。
- **sources**：
  - TSMC 2025 北美技术论坛：COUPE 紧凑型通用光子引擎硅光子整合（与 N12/N3 HBM4 基础裸晶并列公布），2025，https://www.chinatimes.com/realtimenews/20250424001162-260410?chdtv
  - 串联（112G XSR）与并联（UCIe）D2D 的 pJ/bit 对照（并联 <0.25–0.6 pJ/b，串联 ~1.2 pJ/b），2025，https://browse-export.arxiv.org/pdf/2510.06513
- **confidence**：industry_survey
- **relative_validity**：约 2 年。COUPE/CPO 的落地节奏与技术形态变化很快；外挂路线的能耗台阶随 SerDes 代际（112G → 224G）变化。

### SOTA-PPA-09 单相冷板在什么功率量级开始不够用

- **approach**：单相 vs 两相直接到芯片（D2C）冷板的 TDP 边界
- **what_it_is**：直接到芯片（Direct-to-Chip, D2C）液冷是当前高端 GPU 的主流热管理方案，用高沸点水基冷却液（如 PG25 水-乙二醇）通过对流吸热，不发生相变。行业调研对这条路线给出的边界是：单相 D2C 在约 1500 W TDP 附近开始遇到瓶颈，在约 2000 W 附近到达实用上限。超过这条带的芯片要么换两相冷板（利用相变潜热，低流量高换热），要么换微通道液冷冷板（MLCP，见 SOTA-PPA-11）。这个边界是从冷板侧给出的——不是芯片耐温给出的——所以它对「封装面积一定时能放多少功耗」构成硬约束。
- **who_uses_it**：所有做 >700 W 级加速器的整机与数据中心团队。2025 年高端 GPU 在 1400–1600 W；公开路线图给出 2026 年 1600–1800 W、2027 年最高 3600 W。
- **typical_numbers**：单相 D2C：约 1500 W TDP 开始遇瓶颈，约 2000 W 达实用上限（行业访谈一致口径，2025-11）。数据中心 GPU 的 TDP 轨迹：2025 年 1400–1600 W；2026 年 1600–1800 W；2027 年最高 3600 W（厂商路线图 + 第三方预测）。单相冷却一个 1000 W 芯片需要约 1.5 L/min 冷却液流量；两相约 0.3 L/min。单相冷板系统（含快接头、歧管、软管）安装成本约 USD 200–400。两相大规模部署的预测时点是 2026–2027 年。这些是冷板与整机侧的数字，不是芯片侧。
- **applies_when**：判断一个给定卡级功耗是否还在单相冷板的舒适区；或者为「封装面积一定时能承受多少总功耗」找边界；或者规划冷却路线的换代时点。
- **not_applicable_when**：不适用于 (a) 把 1500/2000 W 当作芯片的耐温上限——这是冷板能力的边界，不是结温边界；(b) 把冷板级 TDP 直接等同于封装内所有 die 的功耗之和——冷板覆盖的是裸片区域，基板边缘、VRM、连接器的热量走不同路径；(c) 把 2000 W 上限套到定制冷板或浸没式方案上——那些是不同技术路线，边界不同；(d) 忽略流量与压差的二阶约束——同样 2000 W，流量不足时压差与泵功耗会成为新瓶颈；(e) 把两相的 2026–2027 时点当作已达成——那是预测。
- **project_premises**：液冷前提
- **what_to_check_here**：去核 `teams/hardware/docs/09_PACKAGE_POWER_RAS.md` 第 4.2 节与第 6 节：当前卡功耗 2768.47 W（上限 2800 W）、每 Die 286.22 W（上限 300 W），冷却登记为「liquid (cold plate)」并且是 ASSUMPTION（O-015）。行动项：公开资料的对照系是——单相冷板的实用上限约 2000 W（卡级 TDP 口径），**单相**冷却 1000 W 需约 1.5 L/min。请冷板供应商针对 2800 W 级卡给出：(1) 明确的技术路线（单相 / 两相 / MLCP）——当前文档只写「液冷（冷板）」，没有区分；(2) 该路线下所需流量、压差与入口温度；(3) 单相若在 2800 W 不可行，两相或 MLCP 方案的成本与时点。这一项直接决定 `k3_mc_baseline.json#basis.cooling` 的 ASSUMPTION 能否转成已验证前提。
- **sources**：
  - IDTechEx: Two-Phase Cold Plate Cooling Will Take Off as Early as 2026-2027（单相 D2C 在 ~1500W 遇瓶颈、~2000W 达实用上限；GPU TDP 轨迹 2025 1400–1600W / 2026 1600–1800W / 2027 up to 3600W），2025，https://www.idtechex.com/en/research-article/two-phase-cold-plate-cooling-will-take-off-as-early-as-2026-2027/34068
  - DQI India / IDTechEx: Two-phase liquid cooling — the future of high-end GPUs（1000W 芯片单相 ~1.5 L/min vs 两相 ~0.3 L/min；冷板系统 USD 200–400），2025，https://www.dqindia.com/esdm/two-phase-liquid-cooling-the-future-of-high-end-gpus-10567529
- **confidence**：industry_survey
- **relative_validity**：约 1–2 年。1500/2000 W 这两个数是 2025-11 的调研快照，随两相与 MLCP 量产会往上移；两相的部署时点预测本身也在变。

### SOTA-PPA-10 冷板的热流密度与热阻分别是多少，以及厂商 demo 数字与行业共识的差距

- **approach**：单相 vs 两相冷板的热流密度上限、热阻与流量对照
- **what_it_is**：评价一个冷板能不能带走某个 die 的热，看两个量：热流密度上限（W/cm²，决定热点会不会超温）和热阻（°C·cm²/W，决定同样的热流下结温会高出多少）。行业调研给出的行业级数字与冷板厂商自测给出的数字差距很大，读的时候必须区分：前者是跨厂商访谈形成的一致口径，后者是特定流量/特定流体/特定测试台上的最好结果。
- **who_uses_it**：散热设计团队、冷板供应商（如 ACT、ToneCooling 等）、以及做系统级热预算的整机团队。
- **typical_numbers**：行业/产品手册口径（单相冷板）：最大热流密度约 250–300 W/cm²，热阻约 0.045–0.15 °C·cm²/W，流量 >1.5 L/min·kW，推荐设施水温 ≤30 °C。两相冷板：最大热流密度 >500 W/cm²，热阻 0.035–0.080 °C·cm²/W（随流量与测试条件变化），流量 0.7–0.8 L/min·kW，设施水温可放宽到 >40–45 °C。厂商 demo 口径（2026-01 CES，Frore LiquidJet）：单 reticle 热点 600 W/cm²；单 reticle ASIC + 6× HBM 共 1200 W；2-reticle die + 8× HBM 在入口约 40 °C 下维持 Tj 80.5 °C（TJmax 80.5 °C 口径）；宣称可支持 4400 W 级芯片。另有冷板厂自测案例：3000 W 板级热负荷、局部热点 200 W/cm²、30 °C 入口、4 L/min、压降约 45 kPa、ΔT 约 10 °C；以及单 GPU 700 W、1.5 L/min、ΔT 约 5 °C、压降约 20 kPa。
- **applies_when**：需要把「每 Die 多少 W」换算成「冷板能不能带走」；或者要判断热点（而非平均功率）是否构成约束。
- **not_applicable_when**：不适用于 (a) 把厂商 demo 当作可外推保证——那些是特定流量/流体/测试台上的最好结果，且多为单点功率而非长期可靠性数据；(b) 用冷板热阻直接推结温而不加 TIM、IHS、扩散热阻——冷板热阻只是热路径的一段（MLCP 的价值正是删掉其中几段，见 SOTA-PPA-11）；(c) 把 500 W/cm² 当作封装级平均热流——那是冷板在热点区域的能力，封装级平均热流密度通常远低于此（例如整颗 2-reticle 封装的总功率除以封装面积）；(d) 跨流体比较——两相数字基于 R515B 一类制冷剂，单相基于 PG25 水-乙二醇，不可混用；(e) 忽略设施水温：两相能在 >40 °C 设施水下工作，这是它相对单相的系统级优势，不是芯片级差异。
- **project_premises**：液冷前提
- **what_to_check_here**：去核 `teams/hardware/docs/09_PACKAGE_POWER_RAS.md` 第 4.1 节与第 6 节：每 Die 286.22 W，Die 面积 373.71 mm²（SF4）。行动项：(1) 算出每 Die 的**平均**热流密度（286.22 W / 373.71 mm²）与公开的行业冷板口径（单相 250–300 W/cm²、两相 >500 W/cm²）对照，确认平均热流不是约束；(2) 真正要核的是**热点热流密度**——09 号文档第 4.1 节的功耗构成显示矩阵占 47%（133.69 W）而面积分布未知，请 H Core 的 floorplan owner 给出矩阵阵列的实际占位面积，由此算热点 W/cm²，再与冷板的 >500 W/cm²（两相）或 250–300 W/cm²（单相）对照；(3) 索取 MC 侧的等效热流密度（第 6 节已列「MC 堆叠热点」为验证项）；(4) 在冻结交付物清单（第 8 节）里把「热仿真与冷板需求」这一项明确到「必须输出 W/cm² 云图」，而不是只输出温度场。
- **sources**：
  - ACT 单相/两相冷板数据表（单相 300 W/cm²、0.045 °C·cm²/W、>1.5 LPM/kW；两相 >500 W/cm²、0.035 °C·cm²/W、0.7 LPM/kW），2026，https://www.1-act.com/wp-content/uploads/2026/09/LCP-CS-01_LiquidColdPlates-DataCenters-CutSheet_V1_2026-09-03_Web.pdf
  - ACT 两相冷板数据表（>500 W/cm²、0.080 °C·cm²/W、<0.8 LPM/kW、流体温度 20–60 °C、单一相 ~250 W/cm² / ~0.150 °C·cm²/W），2025，https://www.1-act.com/wp-content/uploads/2025/11/TPCP-CS-01_TwoPhaseColdPlates-DataCenters-CutSheet_V1_2025-11-12_Web.pdf
  - Accelsius / ASME InterPACK 2025：Two-Phase Direct-on-Die Cooling for High-Power GPUs（TTV 模拟 B200 60×26 mm die，0–3 kW 负载，R515B 工质），2025，https://accelsius.com/wp-content/uploads/164278-Direct-on-Die-Two-Phase-Cooling-Approach-for-High-Power-GPUs-1-1.pdf
  - Frore Systems LiquidJet CES 2026 演示（单 reticle 热点 600 W/cm²；2-reticle + 8×HBM，40 °C 入口、Tj 80.5 °C；宣称 4400 W 级），2026，https://wccftech.com/frore-systems-demos-liquidjet-coldplate-1950w-tdp-cooling-on-nvidia-rubin-gpus/
  - ToneCooling 3000 W GB200 冷板案例（局部热点 200 W/cm²、30 °C 入口、4 L/min、压降 ~45 kPa、ΔT ~10 °C），2025，https://tonecooling.com/gpu-liquid-cold-plates/
- **confidence**：vendor_datasheet
- **relative_validity**：约 1–2 年。热流密度上限与热阻值随冷板工艺与工质演进；厂商 demo 数字更新更快，reference 时优先取行业调研口径而非 demo 口径。

### SOTA-PPA-11 微通道液冷冷板（MLCP）：把界面层从热路径上删掉

- **approach**：微通道液冷冷板：蚀刻微米级水道，并将 IHS 与冷板一体化
- **what_it_is**：传统散热热路径是：芯片 → TIM → 金属盖（IHS）→ 另一层 TIM → 冷板。每一层界面都贡献一段热阻，层数越多热阻累积越多。MLCP（Micro-Channel Liquid Cooling Plate）把 IHS 与水冷板做成一体，中间的界面与导热材料被删掉，冷却液直接逼近芯片表面。同时把流道从毫米级（传统冷板 1–3 mm）缩到微米级（10–1000 µm，典型量产口径 50–150 µm），换热面积提升 10× 以上，微尺度下流体呈层流、热边界层大幅减薄，换热系数可达传统液冷的 2–3×。这条路线的公开状态是：热性能已有多方验证，但量产仍在验证期，核心瓶颈是液体渗透与泄漏——冷却液直接接触芯片，一次泄漏的损失量级极高。
- **who_uses_it**：面向 >1500 W 级芯片的下一代散热方案；公开讨论中与两相冷板并列作为单相冷板之后的接续路线。
- **typical_numbers**：微通道宽度：10–1000 µm（传统冷板流道 1–3 mm；量产关注口径 50–150 µm）。换热系数：传统液冷的 2–3×。热阻：可低至约 0.03 °C·cm²/W（对比单相冷板 0.045–0.15、两相 0.035–0.080 °C·cm²/W）。量产状态：截至 2025-11 仍在测试验证期，公开估计距量产还需 3–4 个季度。设计寿命参照：服务器 5–8 年。工艺风险：微米级水道加工精度、液体渗透率精准控制、规模化良率；失效形态包括翅片弯折与微通道堵塞。
- **applies_when**：冷板的热阻与热流密度是瓶颈（而非流量或压差），且能接受冷板与芯片深度耦合（需与封装设计同步做）；也适用于想在 >2000 W 级保住单相工质的场景。
- **not_applicable_when**：不适用于 (a) 需要现场可更换冷板的设计——IHS 与冷板一体化后不可独立更换，维修策略必须重做；(b) 泄漏后果不可接受的部署——冷却液直接接触芯片，风险等级高于传统冷板；(c) 把 0.03 °C·cm²/W 当作在产保证——那是最好条件下的口径，且 MLCP 尚未进入量产验证；(d) 短期项目——2025-11 的口径是还需 3–4 个季度到量产，若项目时间窗更紧则不可用；(e) 微通道对压降敏感的系统——微米级流道的压降与堵塞敏感性远高于毫米级流道。
- **project_premises**：液冷前提
- **what_to_check_here**：去核 `teams/hardware/docs/09_PACKAGE_POWER_RAS.md` 第 6 节散热验证项与第 8 节冻结交付物：当前验证项已列「Compute Die 和 MC 共面/热阻」「冷板流量、压差、入口温度」「单泵/单回路故障」。行动项：把 MLCP 是否入选作为显式决策记录下来。若要入选，需向冷板供应商索取三项：(1) 在目标 Flow/压差下微通道的热阻与热流密度实测；(2) 冷板-芯片共面设计与封装厂（中介层/基板）的接口定义——因为 IHS 被删掉后，封装翘曲会直接传递到冷板贴合面（与 SOTA-PPA-13 联动）；(3) 泄漏检测与单回路故障下的保护策略（09 号文档第 6 节已列单泵/单回路故障，但未定义泄漏检测）。
- **sources**：
  - ZEISS / 工控网：液冷技术新趋势 — AI 服务器微通道水冷板（MLCP）质量保证（微通道 50–150 µm、换热系数 2–3×、热阻低至 0.03 °C·cm²/W、量产仍需 3–4 个季度、泄漏为核心瓶颈），2025，http://c.gongkong.com/PhoneVersion/NewDetail?newsId=447073
- **confidence**：industry_survey
- **relative_validity**：约 1 年。MLCP 处于量产前夜，良率、成本与量产时点都在快速变化；热性能数字相对稳定，制造与可靠性数字半衰期很短。

### SOTA-PPA-12 功耗如何从供电侧反过来锁死档位：PDN、IVR 与基板层数

- **approach**：垂直供电（IVR）与基板层数升级：把 PDN 损耗与压降纳入封装面积账
- **what_it_is**：卡级功耗不能只算 die 的开关功耗——从 VRM 到 die 的路径上有 VRM 损耗、封装基板与中介层的 IR drop、以及 PDN 的交流阻抗（SSN）。公开资料显示，多 reticle 封装的做大同时推高了这条路径的难度：供电 bump 的数量随 die 数增加而增加（见 SOTA-PPA-02），基板层数为支撑大封装升级到 18–20 层，而板级 VRM 的电流要穿过更长的路径才能到大 die。TSMC 公开的集成式电压调节器（IVR）是把 VRM 从板上搬进封装的方案，宣称相对板级分立 PMIC 有 5× 的垂直功率密度传输。这条链锁死档位的方式是：卡功耗上限一定时，PDN 损耗越大，能留给 die 的净功率越少；而 PDN 损耗又随封装尺寸与层数上升。
- **who_uses_it**：做封装供电设计（PDN/IR-drop/SSN）与卡级功耗预算的团队；所有大尺寸 AI 加速器封装。
- **typical_numbers**：TSMC 集成式电压调节器（IVR）：相对板级分立 PMIC 宣称 5× 的垂直功率密度传输（厂商口径，2025-04）。大尺寸封装的基板层数：为支撑 5.5× reticle 与更大封装，高端 ABF 载板升级到 18–20 层（公开口径）。公式参照（来自 SOTA-PPA-02 的封装面积模型）：供电 bump 数 ∝ `P_die / (V_die × I_bump) × 2`，即供电 bump 面积正比于 die 功率——**提高单 die 功率会直接消耗封装面积预算**，这是功耗与面积耦合的又一条路径。
- **applies_when**：卡功耗接近上限、需要判断余量是否被 PDN 吃掉；或者在 chiplet 划分与供电结构（板级 VRM vs 封装内 IVR）之间选型。
- **not_applicable_when**：不适用于 (a) 把 5× 垂直功率密度当作系统级功耗节省——它是供电传输密度，不是能效倍数；(b) 用「供电 bump 数 ∝ 功率」直接算面积而不问 I_bump——I_bump 随基板材料、层数、bump 类型变化，公开资料没有通用值；(c) 中低功耗设计（<数百瓦）——PDN 通常不是约束，讨论供电结构收益有限；(d) 忽略交流阻抗与 SSN——IR drop 只是直流项，开关噪声在大电流跳变下可能更严重；公开资料中关于大封装 SSN 的量化数据未在本轮检索中获得。
- **project_premises**：液冷前提
- **what_to_check_here**：去核 `teams/hardware/inputs/k3_mc_baseline.json#tpsDesign.hardware` 与 `teams/hardware/docs/09_PACKAGE_POWER_RAS.md` 第 4.2 节：卡功耗余量只有 31.53 W，而文档已自列「VRM 损耗」「PDN/IR-drop/SSN」「PVT guardband」「老化和漏电」均为尚未可靠计入的项目（第 4.2 节与第 8 节）。行动项：(1) 索取一个显式的 PDN 损耗预算（VRM 效率、基板与中介层 IR drop 百分比、SSN 余量），并确认它是否已在 2768.47 W 里含；若不含，则 31.53 W 的余量在公开口径下不足以覆盖这些项的总和。(2) 向封装厂确认目标封装面积对应的基板层数（公开口径为大封装 18–20 层），以及该层数对 IR drop 与载板交期的影响。(3) 把「供电 bump 面积」显式写进 placement window 的 658.29 mm² 余量拆分里（当前余量项写的是「RDL、间距、keep-out、PDN、维修」，PDN 已出现但无分量）。
- **sources**：
  - TSMC 2025 北美技术论坛：新型集成型电压调节器（IVR）相对板级独立电源管理芯片具 5 倍垂直功率密度传输，2025，https://www.chinatimes.com/realtimenews/20250424001162-260410?chdtv
  - 电子发烧友：为支撑 5.5 倍及以上光罩封装，高端 ABF 载板升级至 18–20 层，2026，https://m.elecfans.com/article/8224977.html
  - UIUC 芯片-封装协同设计成本模型：供电 bump 数 ∝ P_die /(V_die × I_bump) × 2，与内存接口及 I/O bump 共同决定封装面积下界，UNVERIFIED，https://www.ideals.illinois.edu/items/131937/bitstreams/438019/data.pdf
- **confidence**：vendor_datasheet
- **relative_validity**：约 2 年。IVR 的 5× 是单点厂商口径；基板层数随封装世代上升；PDN 建模方法稳定但系数每代重取。

### SOTA-PPA-13 大封装的可制造性边界：翘曲随封装尺度上升，是面积与共面性的共同约束

- **approach**：封装翘曲（warpage）与共面性：大尺寸封装的机械边界
- **what_it_is**：封装由多种热膨胀系数不同的材料组成（硅中介层、有机基板、金属盖板、TIM、underfill）。尺寸越大、层数越多、经历的热循环越多，各层之间的应力梯度越显著，结果是封装翘曲。翘曲同时打击三件事：封装组装的良率、中介层与基板之间的微凸块连接可靠性、以及冷板与芯片的共面贴合（后者直接决定热阻）。因此封装面积的上限不只是「能拼多大」，还包括「拼这么大之后还能不能压平」。
- **who_uses_it**：所有做大尺寸封装的团队；晶圆级/面板级封装（TSMC SoW 系列）的检测与良率工程。
- **typical_numbers**：晶圆级封装（SoW 类）在检测视角下报告的翘曲量级为跨世代 1500 µm → 3000 µm → 4000 µm 的台阶（ECTC 2024 度量专题）。大尺寸封装的对策方向包括盖板结构优化、TIM 选材、以及无盖（lidless）方案。**公开资料中没有「翘曲量与封装面积/层数」的可外推关系式。**
- **applies_when**：评估一个多 reticle 封装的组装良率风险与冷板贴合方案；或者在「加金属盖 / 无盖」之间选型。
- **not_applicable_when**：不适用于 (a) 把 1500/3000/4000 µm 当作本项目可比的翘曲预算——那是晶圆级（整片晶圆）封装的量级，与 chiplet 级 CoWoS 封装的翘曲不是同一个尺度问题；(b) 用翘曲数字直接推良率——公开资料只给翘曲量级，没有翘曲-良率曲线；(c) 忽略无盖方案对冷板设计的影响——无盖会改变热路径与共面性要求，与 SOTA-PPA-11（MLCP 删掉 IHS）是同一个决策面；(d) 短期评估——翘曲是老化与多次热循环后的累积现象，单次仿真的结果不代表寿命末期。
- **project_premises**：7-reticle
- **what_to_check_here**：去核 `teams/hardware/docs/09_PACKAGE_POWER_RAS.md` 第 6 节与第 8 节：第 6 节验证项包含「Compute Die 和 MC 共面/热阻」「冷板流量、压差、入口温度」，第 8 节冻结交付物包含「热仿真与冷板需求」「封装厂、PHY/IP、MC 供应商确认」。行动项：(1) 向封装厂索取 82 × 64 mm 中介层尺寸下的翘曲预算（含回流焊后与寿命末期的两种情况），以及盖板方案（有盖/无盖）的推荐；(2) 确认「Compute Die 和 MC 共面」这一验证项的验收数值是多少 µm——当前文档只写了验证项名称，没有给出共面容差指标，这是一个可量化的缺口；(3) 若选择 MLCP 或两相冷板（冷板与芯片深度耦合），把翘曲传递到冷板贴合面的路径显式建模，并在冻结交付物里增加「共面容差 + TIM 厚度公差」的联合预算。
- **sources**：
  - ECTC 2024 Special Session on Metrology（晶圆级封装的翘曲台阶 1500 µm → 3000 µm → 4000 µm；SoW 检测挑战），2024，https://ectc.net/files/2024highlights/2024%20ECTC%20Special%20Session%20on%20Metrology.pdf
- **confidence**：industry_survey
- **relative_validity**：约 3 年。翘曲是大尺寸封装的长期工程问题，量级稳定；但盖板结构、TIM 材料与无盖方案的工艺进展会持续改变可达的共面容差。

## 6. 未解（UNVERIFIED）

1. **跨 reticle 拼接区（stitch region）的面积开销百分比**：公开资料完全没有数字。业界的表述停留在「stitch map、keep-out 与最大尺寸需与封装厂确认」，没有「stitching 吃掉 X% 面积」的可引用结论。取证对象：TSMC / 日月光 / Amkor 的 stitch map 与 keep-out 设计规则文档。**这是本项目「7-reticle 单芯片」最直接相关的缺口**——`k3_mc_baseline.json#package.note` 已经写明「The vendor must confirm stitch map, keep-out and maximum dimensions」，但仓库里没有任何 stitching 面积开销的数值。

2. **RDL 层数到可达互联密度的换算表**：公开资料只给出结构描述（CoWoS-L 用 RDL 铺满 + 局部 LSI 硅桥），没有「RDL 做 N 层能提供多少走线密度/多少带宽」的表。取证对象：封装厂 RDL 设计规则。

3. **HBM PHY / 内存控制器在先进节点上占 die 面积的百分比**：只有定性表述（"occupy substantial area"、"don't scale well"）与建模方法（PHY 面积 ∝ 32-bit interface group 数 + 通道数），没有任何可直接引用的百分比。任何「PHY 占 X%」的说法都应视为编造。取证对象：UCIe/SerDes/HBM PHY IP 供应商（Synopsys、Cadence、Alphawave、或自研 PHY 团队）的面积报告。

4. **HBM4 的换代参数在本轮未取到 horizon（2026-01）内的可核查一手来源**。JEDEC HBM4（2048-bit 接口、每 stack >2 TB/s、2026 年量产、不与 HBM3E 控制器兼容）这些方向性事实在 2025 年已由标准组织与厂商公布，但本轮检索命中的比较表均来自 horizon 之后的日期，因此不纳入卡片，只在本文档第 3 节记录存在性。取证对象：JEDEC HBM4 标准文本与 SK hynix / Samsung / Micron 的 HBM4 数据表。

5. **多 die 封装内 die 间温度不均匀（thermal non-uniformity）的量级**：工程上反复被提到（本项目 09 号文档第 6 节也列了「8 Die 热不均匀」），但没有任何一份公开资料给出「同一封装内最热 die 与最冷 die 的温差」分布。取证对象：热仿真报告或 TTV 实测数据。这一项对 TP 类同步语义的系统尤其重要，因为最慢 rank 决定 step 完成时间。

6. **两相冷板在 >2000 W 且长时间运行下的可靠性数据**：目前只有厂商 demo 与短期测试（如 ASME InterPACK 2025 的 0–3 kW TTV 测试），没有部署年限级别的可靠性数据。两相工质（R515B 一类）的 GWP 与安全合规性也是未解项。

7. **CPO / 光引擎在封装边缘的热流密度与功耗实测**：公开资料只有「COUPE 是硅光子集成平台」这一层描述，没有带宽、功耗、以及边缘热点热流密度的数字。取证对象：光模块与 SerDes 供应商。
