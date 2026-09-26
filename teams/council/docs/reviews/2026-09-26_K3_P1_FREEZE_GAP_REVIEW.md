# K3 P1 冻结门槛差距评审（多 agent，2026-09-26）

> 本文件是 `integration/orchestration/k3_multiteam_review.workflow.js` 一次运行的原始输出存档，由 agent 生成，所有结论均为 MODEL 等级，**不是 ADR，也不是 gate 结论**。其中的 ADR 要点只是草案，需 Council 正式评审后另立 ADR。报告中引用的 claim 编号（`CLM-*`）指该次运行的 ledger，不是仓库工作项编号。
>
> 运行概况：112 个 agent，0 失败；52 条 claim（blocker 18 条，全部经三视角对抗核验：12 存活、2 split、4 killed）；6/6 接口配对；Council 新增 5 项，回核 3 存活、1 split、1 killed；未被探针覆盖的职责：council/contracts。

## 目录

- 第一部分：Council 集成报告
- 第二部分：Council 增补（新增项回核后的撤回与修订）
- 第三部分：Completeness critic 漏项清单

---

# 第一部分：Council 集成报告


主题：K3 P1（TP32 / PP1 / B=1 / Context=1M）。目标值 1000 TPS/usr（ADR-0009 FROZEN），架构冻结门槛 1050 TPS/usr。
结论状态：**P1 未达到冻结条件，状态仍为 BASELINE。** 本报告不给出任何门槛放行结论。

口径约定：
- TPS/usr = 1e6 /（raw µs × 1.17），1.17 为 engineeringMargin。
- 1050 门槛对应 raw 预算 814.00 µs；1000 目标对应 854.70 µs。
- 下文所有"余量"均相对 1050 门槛计算，不使用 1000 目标的余量。
- K3 形状只取自 teams/model/src/design_engine.js 的 kimiK3 preset：93 层，hidden 7168，896 experts / 16 active / 2 shared，latent 3584，activeParams 104.2B（计算器口径）。

---

## 1. 距 1050 门槛还差多少，依据是什么，哪些仍是假设

### 1.1 两个关键数：MC640 点与可制造点

| 口径 | TPS/usr | raw µs | 相对 1050 | 证据 | 性质 |
|---|---|---|---|---|---|
| MC640 模型点（P1 搜索解） | 1101.77 | 775.75 | +51.77（余 38.25 µs） | k3_mc_baseline.json:734-748 | 建立在 stretch/aggressive 档位上，不可制造，不能作为门槛依据 |
| Planning 点 | 1102.41 | 775.30 | 余 38.70 µs | 与上行同一 slot 拟合 | **不是独立证据** |
| MC560 | 977.00 | — | −73.00 | k3_mc_baseline.json:734-748 | fixed-x 回放，STRETCH 档 |
| **MC480（ADR-0019 默认上限）** | **853.44** | 约 +187.48 µs | **−196.56**（需 ×1.230） | k3_mc_baseline.json:734-748；k3_tps_design_baseline.js:119 | fixed-x 回放 |
| MC400 | 721.01 | — | −328.99 | 同上 | fixed-x |
| MC320（参考器件，UCIe 1.1） | 586.46 | — | −463.54 | 同上 | fixed-x |
| BF16 KV（kvTile 16384） | 1027.08 | 832.17 | −22.92 | k3_mc_baseline.json:755-759；k3_tps_design_baseline.js:120 | fixed-x 回放 |

k3_mc_baseline.json:215 自己也写明：`architectureGateStatus: "not-met (engineering model; gate requires the selected manufacturable MC route in the detailed tile model)"`。

### 1.2 缺口的上下界

- **MC480 的 fixed-x 回放没有在约束内重新搜索。** k3_tps_design_baseline.js:119 用 `{...x, mcGBs: g}` 只替换带宽，其余决策变量 x 保持 P1 在 MC640 下的解。
  - 因此 853.44 是"同一组其余假设不变时，MC480 重搜最优值"的**下界**。
  - 相应地 −196.56 是缺口的**条件上界**：只在其余假设全部成立时才是上界。0.7 sustained 效率、τ、activeParams、FP8 KV 等任何一项失效，缺口都会扩大，所以它不是无条件上界。
  - 此判定为 CLM-NEW-01（PENDING，待回核）。
- **BF16 的 1027.08 同样是 fixed-x 下界。** 就现有投票而言，其他 BF16 路径都低于 1050（未经重搜，UNVERIFIED）。见 CLM-NEW-03（PENDING，待回核）。
- **MC640 的 +51.77 只是模型点余量。** 它依赖不可制造的档位，还依赖没有来源的 0.7 sustained 效率，不能当作门槛余量。
- **Council 结论（区间表述）：**
  - 在可制造默认档 MC480 上，距 1050 的缺口 ≤196.56 TPS/usr。这是条件上界，前提是其余假设全部成立。
  - 若允许 STRETCH 档 MC560，缺口 ≤73.00。条件同上，并且 MC560 本身仍需要 ADR 决策。
  - 只有在 MC640 + 0.7 效率 + 其余全部假设成立时，才有 +51.77 的正余量。

### 1.3 哪些仍是假设（未测、没有来源、或只有纸面值）

1. **MC sustained 效率 0.7 没有来源**（O-001）。这是 EXTERNAL_DEPENDENCY：MC/DRAM 厂商需要提供 sustained 效率和命令混合实测。
2. **MC 档位**（B-002）。按 ADR-0019，480 是默认上限，560/640 属于 STRETCH/AGGRESSIVE。
3. **τ（每次集合通信的固定开销）没有物理推导**（B-008，依赖 B-004/B-005）。
4. **FP8 KV 精度尚未验收**（B-001 / O-013）。
5. **K3 形状仍在 E0 阶段**（ADR-0003）。activeParams 的残差方法及其敏感性也未闭合。
6. **液冷与封装面积**（O-015）。这是 EXTERNAL_DEPENDENCY：封装/热厂商需要确认液冷方案和封装面积的可制造性。
7. **PPA 系数未校准**（B-006 / ADR-0018）。
8. **软件机制（TMA lane、DMA preempt、调度重叠）没有实测，也没有 schedule trace。** 这些收益都是纸面收益，不计为已验证收益。
   - k3_operator_sram_sim.js:40-44 和 :351-359 显示 preempt 是零成本建模：残留 stripe 被忽略，job 立即挂起。

### 1.4 单项 breakeven（相对 1050，均为单独压线值）

**单项验收线不能同时压线。** 这些项共用同一份约 38.25–38.70 µs 的模型点余量（以 MC640 为前提）。任意两项同时压线，合计就会低于 1050。

| 参数 | 相对 1050 的单项 breakeven | 1000 口径（仅供对照，不得用作门槛） | 证据状态 |
|---|---|---|---|
| 每 cube MC 带宽 | peak 约 607 GB/s / sustained 约 425 GB/s | — | 插值得到，UNVERIFIED |
| mcUtil | 0.6634 | 0.6284 | 内存回放，结果不在仓库中 |
| τ | 线性 1.247 µs（保守）；二分 1.2512（UNVERIFIED）；planning 链 1.304 | 1.351 / 1.408 | 公式见 k3_tps_design_baseline.js:116 |
| activeParams | +3.97B（planning）至 +4.3B（detailed，UNVERIFIED） | — | derive 口径下为 987.71 |
| matrixUtil | 约 0.5198 | — | 回放 |
| expert 命中率 | 约 0.50 | — | 回放 |
| MC480 所需 mcUtil | ≥0.885 | — | UNVERIFIED |

多项余量如何联合分配，列为 ADR 待定项 P-6。本报告不给出联合分配线。

---

## 2. 缺口逐项归属（owner 与可检验交付指标）

| # | 缺口项 | 归属 | owner | 可检验交付指标 |
|---|---|---|---|---|
| G1 | MC 可制造档位与 sustained 带宽（B1） | Hardware + EXTERNAL_DEPENDENCY（MC/DRAM 厂商） | Hardware / MC 负责人 | (a) 选定档位的可制造证明。(b) 厂商 sustained 效率实测：命令混合下的效率 ≥ 使 detailed tile model 在该档位重搜后 ≥1050 所需值（MC480 fixed-x 口径约为 mcUtil ≥0.885，UNVERIFIED）。(c) 在约束内重新搜索 MC480/560，给出新的 x* 和 TPS/usr。 |
| G2 | τ 物理推导（B2） | Hardware（互连/集合）+ Software（collective 实现） | Hardware 互连负责人；Software collective 负责人协同 | 从 B-004/B-005 推导 τ 并实测；在 detailed 链上 τ ≤1.247 µs（保守线），并附测量方法。 |
| G3 | FP8 KV 精度验收（B3） | 待定：Model 或 Software（ADR 待定 P-1） | MISSING_OWNER（仅限验收归属一项） | 在 1M context 下给出 FP8 KV 相对 BF16 的质量差异报告，阈值由 ADR 确定；同时对 BF16 fallback 重新搜索。 |
| G4 | K3 形状与 activeParams（B4、B5） | Model + EXTERNAL（厂商 config） | Model 负责人 | 用厂商 config 替换 E0 preset；activeParams 残差须 ≤ +3.97B（planning 单项线），并附残差方法敏感性分析。 |
| G5 | 液冷与封装（B6） | Hardware + EXTERNAL_DEPENDENCY（封装/热厂商） | Hardware 封装负责人 | 厂商给出液冷方案和封装面积的可制造性书面确认；D-Gate 功耗/冷却检查项的归属见 P-4。 |
| G6 | PPA 系数（B7） | Hardware | Hardware PPA 负责人 | 依据 ADR-0018 完成校准报告，并以校准后系数回放 P1。 |
| G7 | 软件机制与 schedule trace（B8） | Software + V&V | Software 调度负责人；V&V 负责复核 | TMA/DMA/overlap 的 schedule trace；preempt 残留 stripe 成本进入模型（CLM-NEW-02，PENDING，待回核）；trace 与 detailed 模型的偏差需在 ADR 规定范围内。 |
| G8 | 门槛治理（1050 与 P99 没有决策条款；证据等级之争） | Council | Council | 写入 ADR：1050/P99 的决策条款、门槛证据等级、门槛计算须校验 MC 档位可制造。 |
| G9 | 契约职责 council/contracts | Council | **MISSING_OWNER** | 指定 owner，并交付接口契约清单。 |

---

## 3. ADR 草案要点

### 3.1 现在即可决定（Status: Proposed → 建议 Accepted）

- **D-1**：P1 不冻结，状态保持 BASELINE。
  - 后果：所有下游团队都以 BASELINE 口径推进，不得引用 MC640 点作为门槛达成依据。
- **D-2**：重申 ADR-0019/0017/0005，MC640 不是制造默认档，MC480 是默认上限。
  - 后果：门槛计算必须以选定的可制造档位为输入（对应 k3_mc_baseline.json:215 的门槛定义）。
- **D-3**：在 spec 中登记 1050 口径的 raw 预算 814.00 µs，作为派生字段（由 1e6/1050/1.17 派生，不作为独立参数）。
  - 后果：各单项 breakeven 统一以 814.00 µs 为基准，不再引用 854.70 µs。
- **D-4**：τ 验收采用 1050 口径和 detailed 链。在 B-008 闭合之前，以线性 1.247 µs 为保守线。
  - 后果：planning 链的 1.304 和 1000 口径的 1.351/1.408 不作验收用途。
- **D-5**：门槛计算流程增加"MC 档位可制造"前置校验。
  - 后果：stretch 档位的结果只能标注为模型点。

### 3.2 须待证据（Status: Deferred，列出触发证据）

- **E-1 MC 档位选择**：等待厂商 sustained 实测和 MC480/560 约束内重搜。
- **E-2 0.7 效率**：等待 MC/DRAM 厂商的命令混合实测（EXTERNAL_DEPENDENCY）。
- **E-3 FP8 KV**：等待精度报告（验收 owner 见 P-1）。
- **E-4 冷却边界**：等待封装/热厂商确认（EXTERNAL_DEPENDENCY）。
- **E-5 PPA 校准**：等待 ADR-0018 校准报告。
- **E-6 K3 形状**：等待厂商 config 使形状脱离 E0。
- **E-7 schedule trace**：等待软件 trace 与 preempt 成本建模。

### 3.3 ADR 待定项（owner 或政策争议，本报告不作裁决）

- **P-1**：FP8 KV 精度验收的 owner 归 Model（MODEL-06 主张）还是 Software/PRECISION_POLICY（SW-03 相关主张）。待定。
- **P-2**：O-015 冷却边界的 owner。待定。
- **P-3**：门槛证据等级。V&V 主张 ≥ MODEL_OBSERVED；ARCH 主张 detailed tile model 即足够。待定。
- **P-4**：D-Gate 是否纳入功耗/冷却检查。待定。
- **P-5**：P99 ≥1000 是否与 1050 门槛绑定。ADR-0009:7 只是"建议"，没有决策条款（对应台账 ARCH-06）。待定。
- **P-6**：多项 breakeven 的联合余量分配。待定。
- **P-7**：393-fold 的 fallback 取 485 还是 510。待定。
- **P-8**：ADR-0008:190 与 ADR-0005:66-67 表述矛盾，需裁定以哪一条为准。待定。

---

## 4. Blocker 清单（按根因去重，每个根因只保留一条）

| ID | 根因 | 主 claim | 其余合并项 | 保留为 blocker 的理由 |
|---|---|---|---|---|
| **B1** | MC sustained 带宽：可制造档位（B-002）与 0.7 效率没有来源（O-001） | ARCH-01 | HW-03、HW-04、SW-03 均见 B1；HW-02（未经对抗核验）见 B1 | 在可制造档上缺口 ≤196.56（条件上界） |
| **B2** | τ 没有物理推导（B-008，依赖 B-004/B-005） | VV-09 / ARCH-02 | SW-06（split）见 B2；MODEL-09（split）见 B2；HW-07 见 B2 | τ 的 breakeven 仅 1.247 µs，且没有推导 |
| **B3** | FP8 KV 精度未验收（B-001 / O-013） | MODEL-03 | — | BF16 fixed-x 为 1027.08，低于 1050 |
| **B4** | K3 形状仍处于 E0（ADR-0003） | MODEL-01 | 与 B5 共享厂商 config 交付物 | 形状决定全部工作负载 |
| **B5** | activeParams 残差方法与敏感性 | MODEL-02 | 交付物见 B4 | 单项线仅 +3.97B |
| **B6** | 液冷（O-015） | ARCH-03 | HW-10（未经对抗核验）见 B6 | 外部依赖，未闭合 |
| **B7** | PPA 系数（B-006 / ADR-0018） | ARCH-04 | HW-11（未经对抗核验）见 B7 | 未校准 |
| **B8** | 软件机制没有实测，也没有 schedule trace | SW-08 | VV-11（split）见 B8 | 软件纸面收益不能当作已验证收益 |

**明确声明：B1–B8 全部作为 blocker 记录，本轮不释放任何一项。** 严重度异议见第 5 节，异议只作记录，不改变本轮的记录状态。

---

## 5. 异议保留

### 5.1 严重度异议

- **HW-02**（未经对抗核验）：pairing 主张从 gap 升为 blocker。已并入 B1，按 blocker 记录。
- **HW-07**：对抗核验后存活，评级为 gap；另有意见主张 blocker。已并入 B2，按 blocker 记录，gap 异议保留。
- **SW-08 / B8**：gate-governance 配对主张降为 gap，除非 Council 裁定门槛证据等级 ≥ MODEL_OBSERVED。此项与 P-3 联动，本轮仍记为 blocker，降级异议保留。
- **HW-06**（未经对抗核验）：主张从 info 升为 gap，翻转点约为 0.51 而非 0.3。作为异议保留，本轮不改动。
- **HW-10 / HW-11**（均未经对抗核验）：评级为 gap，与 Council 的 blocker 评级不一致。异议保留，B6/B7 仍记为 blocker。
- **HW-08**（未经对抗核验）：只作列示，不作结论依据。

### 5.2 门槛治理异议

- 门槛证据等级（P-3）：V&V 与 ARCH 意见对立。
- ADR-0008:190 与 ADR-0005:66-67 相互矛盾（P-8）。
- 1050 与 P99 在 ADR-0009 中只是建议（P-5）。

### 5.3 Split claims（仅列为 contested，不收窄、不改写、不推翻）

- **SW-06**
  - 反驳视角：口径（basis）。
  - 理由：959 是 planning 数；在 1050 口径下，不存在 τ 单独翻转的条件。
- **VV-11**
  - 反驳视角：口径。
  - 理由：stretch 点与可制造门槛口径不同；launchScale 不能单独使结论翻转。
- **MODEL-09**
  - 反驳视角：证据链。
  - 理由：393 计数已由 B-007/ADR-0004 接受，不属于 MISSING_SOURCE。

### 5.4 Killed claims（不作任何结论依据，仅列反驳理由）

- **SW-02**：独立 TMA 端口只值 0.06 TPS；64 KiB stripe 是 RDMA 参数；preempt 在模型中是零成本。
- **SW-05**：它把某项称为"共同前提"和"唯一 fallback"，均不成立。headTile48 可达 1028.20，hMiB8 可达 1000.15。
- **VV-10**：重复套用了 640 的 sustained 口径。
- **VV-12**：393-fold 已由 B-007 接受，且有回归测试。
- **VV-02**：stage_a/stage_b 确实在 planning 口径下计算了 1050。
- **HW-09**：混淆了 H local 与 shared SRAM。
- **HW-01**：6.413 是解析值，不是模拟器实测值，而且 640 属于 stretch 档。

### 5.5 未经对抗核验（unverified_contested）

HW-02、HW-06、HW-08、HW-10、HW-11 均**未经对抗核验**。incomplete 状态一律按未核验处理。

---

## 6. 台账字段处理声明

- **absent_teams**：无。
- **uncovered_responsibilities**：council/contracts → **MISSING_OWNER**。
- **external_dependencies**：
  1. MC/DRAM 厂商的 sustained 效率与命令混合实测（0.7 没有来源）→ **EXTERNAL_DEPENDENCY**，关联 B1。
  2. 封装/热厂商的液冷与封装面积可制造性 → **EXTERNAL_DEPENDENCY**，关联 B6。
- **stage_failures**：全部为空或 0。
- **unpaired_interfaces**：无。
- **mislabeled_claims**（gate-governance：CLM-VV-08、CLM-MODEL-10）：
  - VV-08 是结构测试绕过问题，属 info。
  - MODEL-10 指出资格矩阵不完整，因此 0/45 低估了未验证范围。
  - gate-governance 的判定没有引用这两条，**误路由不影响该接口的结论**。
  - MODEL-10 的内容没有在 k3-shape 接口中审查，但对应根因 B4 已是 blocker，结论不变。

---

## 7. 新增项（均为 PENDING，待回核）

- CLM-NEW-01（PENDING，待回核）：MC 档位 sweep 为 fixed-x 回放，因此 196.56 是条件上界。
- CLM-NEW-02（PENDING，待回核）：把 tmaLane/dmaPreempt 硬件前提改述为"每域 TMA lane + DMA preempt 语义"，与 O-007 分开跟踪；preempt 零成本建模需要补上残留 stripe 成本。
- CLM-NEW-03（PENDING，待回核）：BF16 1027.08 为 fixed-x 下界，需要在约束内重搜。
- CLM-NEW-04（PENDING，待回核）：6.413 TB/s 应标注为解析闭式值，契约改按 320 参考档口径表述。
- CLM-NEW-05（PENDING，待回核）：BF16 不可行是每核 H local 约束所致，目前不存在 BF16 shared-SRAM 峰值。

---

# 第二部分：Council 增补


本增补只修订受回核影响的段落，报告其余部分不变。五项新增项都已收到 3/3 票，因此没有 incomplete 项。

## 1. Killed 项及其撤回和改写

**CLM-NEW-03（被 2/3 反驳：evidence-chain 与 basis-consistency）**

反驳理由：
- 1027.08 不是 fixed-x 回放值。它来自 k3_tps_design_baseline.js:120，同时改了两处：kvCache 从 fp8 改为 bf16，kvTile 从 32768 改为 16384。所以它是一个联合变体。
- 在已发布的 x 上（kvTile 32768），BF16 KV 不可行，原因是 H local tile（k3_mc_baseline.json:639-650）。这个点没有 TPS 值。
- 仓库中没有任何约束内重搜，所以"下界"一说没有依据。
- "现有投票显示其他 BF16 路径也低于 1050"在仓库中找不到来源。

由此撤回或改写以下内容：

| 位置 | 原表述 | 处理 |
|---|---|---|
| §1.1 表中 "BF16 KV（kvTile 16384）" 行 | 性质写为"fixed-x 回放" | **改写**：这是联合变体（bf16 + kvTile 16384），只作敏感性点。1027.08 相对 1050 为 −22.92，这个算术成立，但该值不是下界。另外补充一行：在 fixed-x 下 BF16 KV 不可行（H local tile）。 |
| §1.2 第二条 | "BF16 的 1027.08 同样是 fixed-x 下界……其他 BF16 路径都低于 1050" | **整条撤回**。 |
| §4 B3 "保留理由" | "BF16 fixed-x 为 1027.08，低于 1050" | **改写**：在已发布 x 上，BF16 fallback 因每核 H local 约束不可行（见 CLM-NEW-05）。因此 FP8 KV 在该点没有可行的 fallback，其精度仍未验收（B-001）。B3 仍保留为 blocker，而且依据比原来更强。 |
| §2 G3 交付指标 | "同时对 BF16 fallback 重新搜索" | **改写**：先在约束内搜出 BF16 的可行点。在搜索结果出来之前，1027.08 只能作为 kvTile 16384 的敏感性点引用，不能作为下界或验收线。 |
| §5.4 SW-05 中的 headTile48 = 1028.20 和 hMiB8 = 1000.15 | — | 这两个值只作为 SW-05 的反驳理由，**不得用作"BF16 路径低于 1050"的依据**。其中 hMiB8 = 1000.15 是回核票的自行探测，仓库中没有记录。 |
| §7 CLM-NEW-03 | PENDING | 改为 **KILLED**。 |

## 2. Split 与 incomplete 项：改标为"有争议"或"未核验"

**CLM-NEW-04：有争议（split，被 1/3 反驳，反驳视角为 basis-consistency）。** 本增补不收窄、不改写这一项，它不作为任何结论的依据。

- 三票都认同一点：6.413 TB/s 是闭式解析值（k3_architecture_search.js:109-113），不是模拟器实测值。模拟器实际得到的是约 6.404 TB/s。
- 争议在后半句。6.413 是 MC640 STRETCH 档每卡的有效值，MC320 有自己的值 3.385 TB/s（k3_mc_baseline.json:185）。contract.json:34-36 已经同时列出 320 和 640 两档。改按 320 口径表述得到 586.46，并不能闭合任何缺口，真正的问题仍是 B-002。
- 对结论的影响：
  - Council 不采纳"契约改按 320 口径表述"这一动作，也不据此生成 ADR 条目。
  - B1 不受影响。
  - §5.4 中 HW-01 的 killed 状态维持 ledger 原判。
  - 6.413 的标注问题（涉及 21_TPS_DESIGN_BASELINE.md:190 和 sync_baseline_spec.js:84）只作记录，留待下轮分项裁定。

**Incomplete 项：无。**

**已存活但回核票提出措辞修正的项**（不改变存活状态，但须同步修正报告措辞）：

- **CLM-NEW-01**
  - §1.2 中"任何一项失效，缺口都会扩大"改为"仅当假设偏向不利方向时，缺口才扩大"。
  - 条件清单补入 1.17 engineeringMargin。
  - 回核票指出：MC320 搜索值与回放值只差约 0.03，所以重搜的余量可能很小，不应指望靠重搜闭合 196.56 的缺口。
- **CLM-NEW-02**
  - 零成本建模只针对 dmaPreempt。tmaLane 不是零成本建模，仍留在 O-007。因此 §1.3 第 8 条要改成：只有 dmaPreempt 的收益在 stripe 成本进入模型之前算纸面收益。
  - 单独关闭 dmaPreempt 后 TPS/usr 为 1041.66，低于 1050（21_TPS_DESIGN_BASELINE.md:303）。
  - 回核票估算 stripe 在约 3 MiB 以内时收益仍能保留。这个数是票内推算，不是仓库记录，只作参考，不作验收线。
- **CLM-NEW-05**
  - "BF16 不可行"只在 kvTile 32768 下成立。以后引用时必须注明 tile 条件。

## 3. 修订后的 Blocker 清单

| ID | 根因 | 主 claim | 合并项 | 保留理由（已修订） |
|---|---|---|---|---|
| **B1** | MC 可制造档位（B-002）与 0.7 sustained 效率没有来源（O-001） | ARCH-01 | HW-03、HW-04、SW-03；**CLM-NEW-01（survived）**；HW-02（未经核验） | 在 MC480 上，853.44 是 fixed-x 下界，缺口 ≤196.56 是条件上界（前提含 0.7、τ、activeParams、FP8 KV、1.17）。NEW-01 的提议严重度是 gap，但回核票认为应记为 blocker，本清单按 blocker 记录。 |
| **B2** | τ 没有物理推导（B-008，依赖 B-004/B-005） | VV-09 / ARCH-02 | HW-07（gap 异议保留） | τ breakeven 只有 1.247 µs，且没有推导。SW-06 和 MODEL-09 已移出合并列，只列为"有争议"，不作依据。 |
| **B3** | FP8 KV 精度未验收（B-001 / O-013） | MODEL-03 | **CLM-NEW-05（survived）** | 在已发布 x（kvTile 32768）上，BF16 因每核 H local 约束不可行，也不存在 BF16 的 shared-SRAM 峰值，所以在该点没有可行 fallback。1027.08 只是敏感性点。验收 owner 仍待 P-1 裁定；NEW-05 提议 hardware 为 owner，这一点有争议。 |
| **B4** | K3 形状仍处于 E0（ADR-0003） | MODEL-01 | 与 B5 共享厂商 config 交付物 | 不变。 |
| **B5** | activeParams 残差方法与敏感性 | MODEL-02 | — | 单项线 +3.97B，不变。 |
| **B6** | 液冷（O-015） | ARCH-03 | HW-10（未经核验） | 外部依赖，未闭合。 |
| **B7** | PPA 系数（B-006 / ADR-0018） | ARCH-04 | HW-11（未经核验） | 未校准。 |
| **B8** | 软件机制没有实测，也没有 schedule trace | SW-08 | **CLM-NEW-02（survived）** | 单独关闭 dmaPreempt 后为 1041.66，低于 1050，而 preempt 的残留 stripe 成本按 0 建模。hardware 负责 DMA preempt 与 MC QoS 语义及 stripe 尺寸，与 O-007 分开跟踪；software 负责 trace。NEW-02 的提议严重度 gap 作为异议保留。VV-11 已移出合并列，只列为"有争议"。 |

说明：
- 已移除的依据：CLM-NEW-03（killed），CLM-NEW-04（有争议，不入清单）。
- 本增补不增加新根因，B1–B8 本轮仍全部记为 blocker，一项都不释放。P1 状态仍为 **BASELINE，未达到冻结条件**。
---

# 第三部分：Completeness critic 漏项清单


## 1. 从未被任何核验视角覆盖的 claim

我对照了 claims 全集、interface_findings 的 claim_ids 和 adversarial 三个来源。

**三处都没有出现的 claim：**
- **CLM-VV-05**：Stage B 的 `selectedCandidateSlotsMeetTarget` 在 formal 分支是恒真式；Q-Gate 的 `exploratoryOnly`/`decision` 被写成字面量。
  - 它不在 mislabeled 列表里，所以不是路由错误，而是被漏掉了。
  - 报告全文没有提到它。G8/D-5 只修 gate 计算，没有修这两个测试。
- **CLM-MODEL-10**：资格矩阵漏了 activeParams/totalParams、expertHidden/moeLatent、线性注意力层数和 stateDim、专家命中率、token-time 系数；asOf 日期也已过期。
  - 报告 §6 写"对应根因 B4 已是 blocker，结论不变"，这是没有经过核验的断言。
  - 漏掉的字段还直接影响 B5（activeParams）、§1.4 中的命中率 breakeven（约 0.50），以及 MODEL-08（token-time 拟合）。
  - 它从未被放到 k3-shape 或 workload-operator 接口里重审。
- **CLM-VV-08**：结构测试可被绕过。severity 为 info，但证据边界的可信度依赖它。它同样没有被重新路由。

**只有接口配对单视角、没有经过对抗核验，却被报告当作数值依据的 claim：**

报告 §5.5 只把 HW-02/06/08/10/11 标为"未经对抗核验"。下面这些同样没有对抗核验，但报告没有标注：
- **SW-07**：联合回退 1005.64，UNVERIFIED。
- **SW-09**：matrixUtil breakeven 0.5198，被写进 §1.4。
- **MODEL-06**：命中率 breakeven 0.50，被写进 §1.4。
- **MODEL-07**：P99。
- **MODEL-08**：planning 值不是独立证据。
- **ARCH-06**：1.17 和 1050 都没有出处，而报告的全部口径都建立在它上面。
- **HW-05**：MC 侧 PHY。
- **HW-12**：治理不闭环。
- 其余：SW-01、SW-04、MODEL-04/05/11/12、VV-01/03/04/06/07。

---

## 2. 接口：形式上都配对了，实质上有多处单边或需求无人回应

`missing_sides` 全部为空，但以下需求在 finding 里被标为"未回应"，报告的 G 表、B 表和 ADR 都没有接住。

| 接口 | 未回应的需求 | 报告现状 |
|---|---|---|
| hw-sw-abi | **每域 TMA lane 的 ABI**。SW-02 的对抗投票已证实 O-007 只管独立端口（值 0.06 TPS），不管 lane 本身。 | 增补反而写"tmaLane 仍留在 O-007"。结果是损失最大的单项机制（tmaLane 回退为 984.20，raw 缺口 54.42 µs，同时跌破 1000 和 1050）**没有任何跟踪项**。B8 只提 dmaPreempt。 |
| hw-sw-abi | HW-08 指出 hop 耦合：`ucieHopUs` 同时进入 τ 和 DMA startup。 | 缺失。B2 只看 τ，没有看 B-004 拓扑修正后对有效 DMA 带宽的影响。 |
| workload-operator | 逐算子 DMA 覆盖账本（HW-06 向 model 提出）。 | 缺失。 |
| workload-operator | 1/32 专家切片下的 expertFill 实测（MODEL-06 向 HW 提出）。 | 缺失。 |
| workload-operator | 硬件侧 matrixUtil 口径不一致：resource_profiles 为 0.51，sim 为 0.6，发布点为 0.65。 | 缺失。 |
| k3-shape | 由 V&V 用测试锁定 K3 activeParams。 | G4 只写了厂商 config，没有测试锁定这一交付项。 |
| sw-model-precision | 393-fold 合法性判据 1 和 2 是 K3 层结构事实，依赖 B-001 冻结；另有 25 个集合通信被改记为本地算子，这一点没有证明。 | P-7 只讨论 fallback 取 485 还是 510，没有处理结构前提的确认和 owner。 |
| sw-model-precision / workload | collectiveBytes 为 MISSING_SOURCE；公式值 0.361 GB 与实际 0.566 GB 对不上（三票一致认可）。 | MODEL-09 被移出 B2 以后，这个 gap **从报告中消失**。 |
| ppa-gap | 640 GB/s cube 的面积，以及 MC 侧 PHY 和 shoreline（HW-05、ARCH-04）。 | 没有 owner，也没有交付指标。 |
| ppa-gap | Council 选定可制造档位，并给出 B-002 关闭时间表（ADR-0019:15）。 | D-2 只重申 480 是上限，E-1 被 Deferred，没有日期也没有决策人。 |
| ppa-gap / gate | HW-12 要求 O-015 和 B-006 有具体 agent、日期和证据链接。 | G 表的 owner 都是泛称的"某某负责人"，**全表没有一个日期**。 |
| gate-governance | Council 定义 1050 的计算函数（VV-02、ARCH-05）。 | D-5 只给出原则，没有 owner 和交付物。 |
| hardware 团队 blocker | B-004/B-005 片内与 scale-out 拓扑决策（ADR-0016），它是 τ 推导的前提。 | 报告的 ADR 清单中没有这一项。 |

另外，没有任何接口覆盖以下三类：
- 多模型可比性，即 GLM-5.2 和 DeepSeek-V4-Pro 的 slot。
- 团队与外部厂商之间的请求规格。
- council/contracts（本身未覆盖，因此跨团队 contract.json 的一致性没有人查）。

---

## 3. 被写成定论、实际只是假设的内容，以及 split 项被单票改写

**写成定论，但 flip_evidence 尚未出现：**
- **1050 作为"架构冻结门槛"**：报告标题和全文都把它当定论。但 ADR-0009:7 只写了"建议"，报告自己在 P-5/G8 也承认没有决策条款。整份报告以 1050 为基准度量缺口，而这个基准本身待定。
- **D-3/D-4 列为"现在即可决定"**：它们登记了 814.00 µs 和 1.247 µs。这两个值依赖两件事：1.17 没有出处（ARCH-06 未经对抗核验），1050 没有决策条款（P-5 待定）。先决事项还没裁决，就把派生值固化了。
- **"MC640 不可制造"（§1.1）**：ADR 的原意是"供应商证据闭合前不得作为制造默认"，并没有证明它不可制造。应改为"未证可制造"。
- **"853.44 是下界，196.56 是条件上界"**：条件清单不全。增补只补了 1.17，还缺以下几项：
  - MC 侧 UCIe 1.1 PHY 截断（HW-05）：参考器件只有 320，按这个口径 480 本身就交付不了。
  - dmaPreempt 零成本建模。
  - tmaLane/kvPrefetch/softmaxFusion 的兑现。
  - launchScale 0.45、命中率 0.8、matrixUtil 0.65。
- **B3 在增补中改写的理由"已发布 x 上无可行 fallback，依据更强"**：SW-05 的对抗投票已给出 tile 32768 + headTile48 下 BF16 **可行**，为 1028.20。"无 fallback"只在 headTile96 时成立。B3 真正站得住的依据是 ADR-0005:31-33 禁止冻结依赖 B-001 的配置，报告没有引用这一条。
- **§1.4 的 breakeven 表和 G1(b) 引用的数**：mcUtil 0.885、τ 二分值 1.2512、matrixUtil 0.5198、命中率 0.50、activeParams +4.3B 都来自探针内存回放，没有入库。它们被直接写成了交付指标。

**split 项被单票改写：**
- **CLM-NEW-04**：报告声明"不收窄、不改写"，但接着写"Council 不采纳改按 320 口径表述"。这等于采纳了那一张 basis-consistency 反驳票，否掉了 claim 的后半句。
- **SW-06**：§5.3 的理由写成"在 1050 口径下不存在 τ 单独翻转的条件"。原反驳票的意思是：在可制造口径下门槛本来就不通过，所以没有可被翻转的放行结论。它并没有说 τ 不能翻转 1050。现在的写法和 B2 自相矛盾。
- **MODEL-09**：报告把反驳票"393 已由 B-007 接受"当作事实写入。三票一致的"collectiveBytes 缺来源"因此随整条 claim 被移出，这一 gap 丢失（见第 2 节）。

---

## 4. 验收线不唯一：余量被重复分配，基准也混用了

- **两套基准并存。** D-2 和 D-5 规定门槛必须按可制造档（MC480）计算。但 §1.4 的全部 breakeven，以及 G2（τ≤1.247）和 G4（activeParams ≤ +3.97B），都是在 **MC640 stretch 点**上算的。
  - 在 MC480 上 raw 已经超出 187.48 µs，τ 和 activeParams 都不存在可行的 breakeven。
  - 所以 G2 和 G4 的验收线在报告自己规定的门槛基准下没有意义。
- **同一份余量被分配了多次。** §1.4 写明"单项线不能同时压线"，P-6 也说联合分配待定，但 G 表各行都把整份余量当作自己的交付线：
  - G1(b)：mcUtil ≥ 0.885，吃掉 MC480 上的全部余量。
  - G2：τ ≤ 1.247，吃掉 MC640 上全部 38.25 µs。
  - G4：+3.97B，吃掉 MC640 上全部 38.70 µs。
  - 这三条同时验收，结果必然低于 1050。
- **detailed 与 planning 混用。** "约 38.25–38.70 µs"把 detailed 和 planning 两种口径并列。G4 的 +3.97B 是 planning 外推值，G2 的 1.247 是 detailed 值，两者不能共用一份余量。
- **1000 与 1050 的混用。** §1.4 带有 1000 列"仅供对照"，可以接受。但"raw 约 +187.48 µs"写在 raw 列，没有标明它是相对 814.00 的超出量。
- **联合敏感度没有入账。** workload-operator 已算出"+2B 加上命中率 0.65"即触及 1050，SW-07 的联合回退约为 1005–1020。报告没有用这些数来约束各单项线。

---

## 5. uncovered_responsibilities 与 external_dependencies 的处理

- **council/contracts** 只标了 MISSING_OWNER（G9），没有做下面几件事：
  - 没有指定临时 owner。
  - 没有把已知的契约缺口挂到这个职责下：software contract 的 strategies 与 OPT 没有一一对应；hardware contract 仍是 PARTIAL；model contract 承诺的 golden trace 没有交付。
  - D-1 到 D-5 建议 Accepted，但没有契约落点。
- **报告新产生的无主项没有登记进 §6：** G3 的 FP8 验收 owner（P-1）、O-015 的 owner（P-2），以及增补中 B3 的 owner 争议。它们实际上都是 MISSING_OWNER。
- **external_dependencies 只处理了台账上的两条。** 以下外部依赖在报告正文中出现或隐含，但没有登记为 EXTERNAL_DEPENDENCY：
  - K3 厂商 config 或 checkpoint（B4、B5，正文写作"EXTERNAL"）。
  - MC 厂商的 MC 侧 PHY 规格和 640 cube 面积。
  - SF4 PDK/MAC 宏回标（B7，属于 foundry）。
  - VRM、光模块、SerDes 的 datasheet（B6 的 2800 W 边界）。
- **外部依赖没有请求规格。** G1(b) 只写"命令混合"，没有采用 04_MEMORY_SUBSYSTEM_MC.md §8 规定的 8 MiB weight tile、32K KV tile、656 B gather 流量。
- **外部依赖没有截止日期，也没有失败后的备选路线。** 如果 MC 厂商给不出高于 480 的档位，报告里没有任何人负责 ≤480 档的替代路线。ppa-gap 已证明靠增加 MC 颗数不可行，只剩 R-001 字节压缩或近存方案，以及 HW 提出的 readBytes 降低 7% 的路线。

---

## 6. 本轮没有跑到的角度

1. **在可制造档位上做约束内重搜。** MC480 和 MC560 都没有做。这是"距离门槛到底差多少"的核心，本轮只有 fixed-x 回放。
2. **入库的扫描产物。** 包括 580–620 GB/s 档位扫描、mcUtil 0.62–0.70 扫描、1050 口径下的 τ 扫描、多开关联合回退，以及 BF16 约束内搜索（headTile/kvTile/hMiB）。
3. **多模型门槛。** stage_a 的 meetsArchitectureGate 取的是"最差可比模型"。VV-02 的投票指出 detailed_architecture_run.json 中 all18/comparable 都是 false，**18 个可比 slot 中有 11 个低于 1000**。报告只看 K3，没有回答冻结门槛是否要求所有可比模型都达标。
4. **尾部与 P99。** 没有逐 token 的命中分布 trace。
5. **独立回放。** 没有事件级或 RTL 级回放。VV-04 指出 0/18 是自回放。
6. **物理签核。** 没有热仿真、PDN、MC 侧 PHY/shoreline 分析，也没有风冷回退点的回放。
7. **拓扑。** 没有 interconnect 视角：B-004/B-005 的推导，以及 hop 数对 τ 和 DMA startup 的联合影响。
8. **FP8 KV 质量评估。** 本轮没有任何模型质量类 agent。
9. **报告自洽性审查。** 本轮没有 agent 检查报告内部的验收线、基准和余量分配是否一致（见第 4 节）。
10. **治理修复落地。** candidate_register 的 `meetsArchitectureGate=true`、两处固定矛盾标志的测试、ADR-0008:190 与 ADR-0005:66-67 的冲突、VV-05，这些都只登记了，没有人负责落实。
11. **被 kill 的 claim 中未被反驳的实质内容。** 这些内容随 kill 一起丢失，需要重新立项：
    - HW-09 的 shared SRAM 余量 8.56 MiB（7.9%），SW-04 的 kvPrefetch 依赖它。
    - VV-10 指出的"560–640 之间没有扫描点"。
    - SW-02 中 tmaLane 对硬件的依赖。

---

## 7. 下一轮 agent 派发清单

1. **INT-SEARCH（integration/detailed）**
   - 在 MC480 和 MC560 上做约束内重搜。
   - 扫描 580–620 GB/s、mcUtil 0.62–0.70、1050 口径下的 τ。
   - 做多开关联合回退和 BF16 约束内搜索。
   - 全部结果入库到 out/。
2. **ARCH-ALT（hardware + model）**：负责 ≤480 档的替代路线，包括 R-001 字节压缩、近存方案、readBytes 降低约 7%，目标是闭合约 187 µs 的 raw 缺口。
3. **VV-ADV-2（对抗核验补跑）**
   - 从未覆盖的：MODEL-10、VV-05、VV-08。
   - 被报告当作依据但只有单视角的：SW-07、SW-09、MODEL-06/07/08、ARCH-06、HW-02/05/06/10/11/12。
4. **HW-TMA（hardware TMA/SRAM）**：把每域 TMA lane 的 ABI 从 O-007 中拆出来单独立项，给出 owner 和日期。同时补上 dmaPreempt 的 stripe 尺寸和抢占成本建模。
5. **COUNCIL-GATE**
   - 建立单一验收线：只用可制造档和 detailed 口径。
   - 把余量分配（P-6）落成数值预算，并重写 G1、G2、G4。
   - 先裁决 P-5（1050 与 P99 的决策条款）和 1.17 的出处，然后再决定 D-3 和 D-4。
6. **COUNCIL-CONTRACTS**
   - 为 council/contracts 指定 owner，把三份 contract.json 的缺口挂到这个职责下。
   - 给 P-1、P-2、B-006、O-015 指派具体 agent 和日期。
   - 补上 B-004/B-005 拓扑的 ADR。
7. **EXT-LIAISON**
   - 为外部依赖起草请求规格：MC 混合流量 sustained 值、MC 侧 PHY 和 640 cube 面积、K3 厂商 config、SF4 PDK、VRM/光模块 datasheet。
   - 登记为 EXTERNAL_DEPENDENCY，附截止日期和失败时的回退路线。
8. **MODEL-WL（model）**
   - collectiveBytes 的来源和对账。
   - 393-fold 判据 1、2 的结构确认，以及 25 个本地算子改记的证明。
   - 逐算子 DMA 覆盖账本。
   - 重新生成资格矩阵（MODEL-10）。
   - 联合 V&V 用测试锁定 activeParams。
9. **MULTI-MODEL-GATE（V&V + model）**：核实冻结门槛是否适用于 GLM-5.2 和 DeepSeek-V4-Pro 的可比 slot，重新审查 18 个 slot 中 11 个低于 1000 的影响。
10. **INTERCONNECT**：推导 B-004/B-005 拓扑下的 τ，评估 hop 表对 τ 和 DMA startup 的联合敏感度，给出 P99。
11. **MODEL-06（精度）**：FP8 KV 在 1M context 下的质量评估，由它给出指标和容差。
12. **HW-KERNEL**：expertFill 与 matrixUtil 实测，统一 0.51/0.6/0.65 三处口径。
13. **VV-TAIL**：采集逐 token、逐层的命中分布 trace，按分布计算 P99。
14. **HW-SRAM**：在正确的资源划分下重新立项 shared SRAM 余量，并给出 BF16 下的 shared 峰值。
15. **VV-GOV-FIX**：修复 register 标志和两处固定矛盾标志的测试；处理 VV-05 的恒真断言；处理不可运行的诊断脚本（scripts/、src/），要么修复，要么移出证据链。