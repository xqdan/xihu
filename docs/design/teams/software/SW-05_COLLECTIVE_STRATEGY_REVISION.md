# SW-05 专题（修订）：集合通信优化策略的三轴重构

| | |
|---|---|
| Owner | SW-05 Collective/Comm-Compute Overlap |
| 共签 | SW-04 Fusion（合法性）、SW-07（收益口径） |
| Stage | quantification（legacy Q4/Q6） |
| Evidence class | `PLANNING_ESTIMATE`，confidence `E0` |
| 触发 | 阅读 `docs/communication/k3_replication_vs_collectives.html` 后复核 |
| 取代 | `SW-05_ALLREDUCE_FUSION.md` §0 的收益数字与 §5 的"结构下限"表述；该文其余部分（字节账、合法性判据、实现前提）仍有效 |
| Status | 修订，未进入任何 Gate |

## 0. 修订摘要

原策略是**单轴**的：把每层 collective 次数从 5 压到 4。参考页引入了**第二个轴**：把某个张量在 TP 组内复制，用 MC 字节换掉一次归约。本次复核发现，真正 binding 的是**第三个轴**：单次 collective 的时间基准。

| 轴 | 本仓库现状 | 可达空间 | 判定 |
|---|---|---|---|
| **N** 次数 | 510 | 393（参考基线）→ 209（复制地板） | 393 不需优化即可达；209 在本带宽下**关闭** |
| **τ** 单次成本 | 271 ns | spec 为 1150 ns | **4.24× 口径差**，最高杠杆 |
| **复制代价** | — | Wup 需 199 TB/s、Wdown+Router 需 243 TB/s | 现有 6.199 TB/s，差 **32–39×** |

三条结论：

1. **原策略报的 +21.1 TPS（C1 融合）是把模型恢复到参考基线，不是优化收益。** 参考页的每 MoE 层 4 次本就把 Shared 输出并进 ★3（`恒有 → {merge, latentDim} // 专家输出合并（Shared 融合其中）`），我的模拟器把它单独发了一次（`Shared output all-reduce`），构成 510 与 393 之间 117 差额中的 92。
2. **"结构下限 4 次"必须补限定为"全分片下限"。** 允许复制时结构下限是 2 次/层（209）；参考页自己的措辞即为 `下限为 4 次（全分片）`。原策略漏了这个限定。
3. **已发布的 859.18 TPS 只存在于 τ = 271 ns 之下。** 按 spec 的 1150 ns，即使取参考页的理想地板 209 次，天花板也只有 **837.9 TPS**，低于已发布值；取参考基线 393 次为 **693.9 TPS**。

---

## 1. 轴一：次数对账

### 1.1 分解

```
本仓库  510 = 92×5 + 1(稠密层 attn) + 24(LSE) + 24(Q/new-KV all-gather) + 1(sampling)
参考页  393 = 92×4 + 1                + 24(LSE)
差额    117 = 92 + 24 + 1
```

逐项实测频次（`F.mapped(best).plan.ops`，unit === 'COMM'）：

| 频次 | 算子名 |
|---:|---|
| 93 | `Attention output all-reduce` |
| 92 | `Latent Wup` 后的 `Wup all-reduce` |
| 92 | `Wdown + Router all-gather` |
| 92 | `Routed latent merge` |
| 92 | `Shared output all-reduce` |
| 24 | `LSE merge / output reduce-scatter` |
| 24 | `Q / new-KV all-gather` |
| 1 | `Distributed sampling candidates` |

### 1.2 差额归属

> **已应用到主线（2026-09-25，ADR-0004）**：三项差额已全部对齐到参考口径，`OPT.countBasis='reference-393'`，主线次数 510 → 393。其中 `Q / new-KV all-gather`（24）与 `Distributed sampling candidates`（1）**保留为本地算子**（同样字节与依赖边，不走网络），不是直接删除；`Shared output all-reduce`（92）并入 `Wup + Shared output all-reduce`。本节对账结论已被 `tests/test_k3_rdma_final_tuning.js` 固化为双向守卫（393 / 510 均可复现）。

- **92 = `Shared output all-reduce`**：参考页把它并入 ★3 的专家合并。这是 510 vs 393 的主体，也是原策略 C1 融合所删除的那一次。
- **24 = `Q / new-KV all-gather`**：参考页的 393 不包含它（其注意力子层只计 ★1 与 LSE 合并）。
- **1 = `Distributed sampling candidates`**：参考页未计。

### 1.3 对原策略 C1 的更正

`SW-05_ALLREDUCE_FUSION.md` §0 报告 C1 融合（删除 `Shared output all-reduce`）在发布候选上得 **+27.67 TPS**、B4 上 **+15.51 TPS**。该计算本身正确（诚实建模，含补回的本地累加算子与末端三路加改两路），但**参照系错了**：删除这一次恰好把 5/层 降到 4/层，即参考页的默认口径。

因此 C1 应从"候选优化"改列为**基线对齐**：

- 它不产生可计入 `software_gain_budget` 的收益；
- 它的价值在于**确认模拟器与参考口径的差额**，而不是提升性能；
- 原策略 §5 的"COMM 的 138.43 µs 只能靠减少 collective 次数来压"仍然成立，但"每层 5 次中只有 1 次可合法删除"应改为"本模型每层多发了 1 次（Shared 输出），对齐参考口径后即为 4 次基线"。

---

## 2. 轴二：τ 基准（决定性）

### 2.1 本仓库存在三个互不衔接的基准

| 来源 | 值 | 标注 |
|---|---|---|
| `HIGH_LEVEL_ARCHITECTURE.md:87,:117`、`k3_1000tps_metric_summary.html` | **1.15 µs @TP8 flat** | 一次完整 all-reduce（spec 基线） |
| `src/core/tiered_memory_engine.js:40` | 1.15 µs flat | 同上 |
| `src/simulation/k3_operator_sram_sim.js:11` | `tauUs = 1.15` | 模拟器原生默认 |
| `07_COLLECTIVE_RDMA.md:40` | one-way **0.05 µs** | 标记 `MODEL`，无推导 |
| `k3_sram_memory_rdma_model.js:6` | `MEM.oneWayUs = 0.10` | 另一默认 |
| `k3_rdma_final_tuning_model.js:15` | `OPT.oneWayUs = 0.05` | **发布 859.18 所用** |

发布候选的实测平均单次成本为 **`138.425 / 510 = 271 ns`**，即 spec 的 **1/4.24**。`F.mapped()` 在 `mappedPlan()` 用 `TECH.matrixUtil` 定完 `o.duration` 之后，用 `R.collective()` 重写全部 COMM 的 duration，spec 的 1.15 µs 路径在这条链上从未被触发。

另有一个中间档可作参照：`data/rdma/k3_b1_1000_rdma_sram_results.json`（2026-09-19）实测 `commUs = 444.324 / 510 = 871 ns`。三个档位 1150 / 871 / 271 ns 之间没有任何书面论证，只有默认值的替换。

### 2.2 天花板（解析，闭式）

模拟器 `tryOp()` 把 COMM 记入 `coll`、其余记入 `compute`，两者共用同一个 `running` 槽，且 `simulate()` 断言 `raw = compute + comm + wait`。因此 `busy = compute + comm` 是**恒等式**而非近似，天花板可直接算：

```
ceiling = 1e6 / ((compute + N × τ) × 1.17)
compute = 779.73 µs（MC320 与 MC640 两点逐位相同）
```

| N | comm µs | busy µs | 天花板 TPS | vs 预算 854.70 |
|---:|---:|---:|---:|---|
| **510**（实测） | 586.5 | 1366.2 | **625.6** | busy 超预算 **1.60×** |
| 485（去掉 Q/KV、sampling） | 557.8 | 1337.5 | 639.0 | 超 1.57× |
| **393**（参考基线） | 452.0 | 1231.7 | **693.9** | 超 1.44× |
| 301（复制 Wup） | 346.2 | 1125.9 | 759.1 | 超 1.32× |
| **209**（参考页地板） | 240.4 | 1020.1 | **837.9** | 超 1.19× |

对照：已发布的 859.18 对应 `busy = 918.16 µs`、天花板 930.9 TPS。

**结论：在 spec 的 τ 下，"减少次数"这条轴的整个可达区间（510→209）不足以回到已发布值。** 最激进的组合（复制 Wup+Wdown+Router 到 209 次）也只有 837.9 TPS，仍低于 859.18，且复制本身在本带宽下不可行（§3）。所以 τ 基准不是与次数并列的一轴，而是**先决条件**：它不解决，次数轴上的任何改动都不改变"未达标"这个结论。

### 2.3 与既有 blocker 的关系

- `B-003` 只覆盖 `GAIN` 表的经验因子，未覆盖 τ 基准；
- `MR-007` 说 "collective 使用 `log2(TP)` 缩放，未表达真实拓扑、payload、拥塞和算法"，但本路径连 `log2` 都不是——它是 `flat`，只是基准值不同；
- `B-004`（卡内 topology 口径冲突）、`B-005`（TP32 scale-out 拓扑未定义）是 τ 的**物理上游**：没有拓扑就没有 τ 的物理依据。

因此本项应作为独立条目登记，而不是并入上述任何一条。

---

## 3. 轴三：复制换归约（本带宽下关闭）

### 3.1 参考页的判据

参考页给出复制一个张量 W 的盈亏条件：

```
Δbytes = w_layer · (TP − 1) / TP        每卡每层多读
Δt     = τ(TP) + payload                省掉的一次通信
划算   ⇔  bwCard > bw* = Δbytes / Δt
前提   ：设计必须是归约受限（忙侧 > MC 侧），MC 有余量吞下多读的字节
```

### 3.2 本仓库的实测

**前提检查（满足）**：`busy = 918.16 µs` > `byteFloor = 863.82 µs`，即本点是**归约/忙侧受限**，MC 确有余量。

**余量规模**：`slack = 918.16 − 863.82 = 54.34 µs`，可吞 `54.34e-6 × 6.1993 TB/s = 0.3369 GB`。

**逐张量盈亏**：

| 张量 | 总量 | 每卡多读 | 每层/卡 | 省下/层 | bw* | 相对可用 |
|---|---:|---:|---:|---:|---:|---:|
| Wup | 4.727 GB | 4.579 GB | 49.77 MB | 0.2496 µs | **199 TB/s** | **32×** |
| Wdown + Router | 5.909 GB | 5.724 GB | 62.22 MB | 0.2557 µs | **243 TB/s** | **39×** |
| Attention | 36.93 GB | 35.78 GB | 384.7 MB | 0.2496 µs | 1541 TB/s | 249× |

**地板方案（同时复制 Wup + Wdown + Router，得 209 次）**：每卡多读 **10.30 GB**，是可用余量 0.3369 GB 的 **30.6×**。

### 3.3 与参考页自身结论的关系

参考页在 TP16（32 MC × 480 GB/s × 0.7 = 10.8 TB/s 有效）下算得复制"亏 ~28%"，并明确标注报告里"复制从未胜出"是**网格范围决定的**（`k3_1000tps_chip_designs.html` 的 MC 上限只有 1.5×）。

本仓库 P1 点是 TP32、6.199 TB/s 有效/卡，每卡带宽只有参考页 TP16 场景的 57%，因此复制的劣势从 28% 放大到 **32–39 倍**。方向与参考页一致，量级更极端：不是"没搜到"，是量化差距。

**判定：复制轴在本仓库 P1 点上关闭。** 重新打开的条件是每卡有效带宽提升约 32×（或分母侧 τ 提升同倍数），后者与 §2 是同一问题。

### 3.4 部分复制（参考页的"模型没表达的中间档"）

参考页指出引擎只有 `shard | replicate` 两态，缺 `r ∈ {1,2,4,…}` 的复制因子。本模型同样无法表达：

- `k3_sram_memory_rdma_model.collective()` 的签名不含 `groupSize`，τ 只随算子名分派（all-gather / LSE / FP32 reduce-scatter+BF16 all-gather 三态）；
- 因此 `r=2` 子组带来的 τ 下降无法定价。

粗算 `r=2` 的字节代价（`bytes × r/TP`）：Wdown+Wup 每卡 **+0.2954 GB**，合每层 3.21 MB/卡 = 0.52 µs/层 = **47.5 µs/token**（占 raw 4.8%）。若子组能把单次 τ 从 271 ns 降到 ~180 ns（按参考页 ≤8 卡一步到位约 0.66 vs 1.15 的比例外推），可省 `510 × 91 ns ≈ 46 µs`——**两者几乎抵消**。结论：`r=2` 在本带宽下不构成明确收益，需要先扩展 `collective()` 支持组大小才能定价。

---

## 4. 修订后的策略

### 4.1 杠杆排序（取代原策略）

| 优先级 | 杠杆 | 状态 | 归属 |
|---|---|---|---|
| **P0** | τ 基准显式化：为 `OPT.oneWayUs = 0.05 µs` 补物理推导，或改回 spec 的 1.15 µs 并重算全部 TPS | 2026-09-25 已改回 1.15 µs（`OPT.tauUs` 下限）并重算：681.06 TPS（加入 shared 专家重叠后 729.14，独立 TMA 通道后 774.77，KV 跨层预取与 DMA 抢占后 860.03）；物理推导仍未做 | SW-05 + D4/B-004/B-005 |
| **P1** | 次数对齐参考基线（5/层 → 4/层） | **已应用**（2026-09-25，ADR-0004）；**不产生收益** | SW-05（本次） |
| **P2** | 减少每次的固定协议延迟（实测占单次的 87.9%） | 属 PHY/协议/拓扑，非调度 | B-004 / B-005 |
| **P3** | 复制换归约（393 → 301 → 209） | **关闭**（32–39× 差距） | 需 MC 带宽或 τ 大幅改善 |
| **P4** | 部分复制 `r=2` | 不可定价，粗算净收益≈0 | 需扩展 `collective()` |

### 4.2 明确撤销的表述

- ~~"每层 5 次 collective 中，经本文分析只有 1 次可合法删除，结构下限是每层 4 次"~~
  改为：**本模型每层多发 1 次（`Shared output all-reduce`），与参考口径对齐后为 4 次；4 次是全分片基线，不是结构下限。允许复制时的结构下限是 2 次/层（209），但复制在本带宽下关闭。**
- ~~C1 融合 +27.67 / +15.51 TPS 记为软件收益~~ 改为基线对齐，不入预算。

### 4.3 保留的表述

原 `SW-05_ALLREDUCE_FUSION.md` 中以下部分经本次复核仍然成立：

- §3.1 一次 all-reduce 的字节账（`readBytes = 6.91× payload`、`writeBytes = 5.04×`）——COMM 的成本主体是 staging 而非 payload；
- §3.2 融合的净搬移为负（四项全降）；
- §2 的合法性三判据与两个被否决的相邻方案（RMSNorm 阻断 ★1↔★2；`Routed latent merge` 不可删）；
- §6 的实现前提 1–6；
- §8 的 four blockers（无 activation 依赖边、激活不在 SRAM 账本、无纯 reduce-scatter 原语、`GAIN` 的 ASSUMPTION 性质）。

---

## 5. 未决 / 需要外部输入

1. **τ 的物理依据**：`oneWayUs = 0.05` 是设计假设还是从某次链路估算反推？若是后者，估算过程在哪？`B-004`/`B-005` 关闭前无法回答。**口径已登记为 B-008 / ADR-0004（`spec.tauBasis` 记录四个来源与天花板表），物理依据仍未收口。**
2. ~~**参考页的 393 口径是否已在本仓库登记**~~ **已结项**（2026-09-25）：`OPT.countBasis` 切换 + `spec.collectiveCount` 字段 + `tests/test_k3_rdma_final_tuning.js` 双向守卫 + ADR-0004。
3. **`Shared output all-reduce` 的归属**：参考页并入 ★3；本模型在 `Latent Wup` 之后单独发。二者是否等价取决于 shared 专家是否真以 `MoE RMSNorm` 输出为输入（原策略 §6 前提 2，仍未确认）。**已登记为 B-007：这是 92 次差额成立的前提，前提不成立则回退 `repo-510`。**
4. **部分复制**：需要先扩展 `k3_sram_memory_rdma_model.collective()` 接受 `groupSize`。

## 6. 复现

本文全部数字可由以下表达式复现（仓库根目录）：

```
computeUs            = spec/k3_mc_baseline.json#modelResults.*.computeUs        = 779.7324474251067
commUs（发布候选）    = 同上 .commUs                                             = 138.42546670161298
平均单次（510 口径）  = commUs / 510                                             = 271.4 ns
平均单次（393 口径）  = spec/k3_mc_baseline.json#tauBasis.observedNsPerCollective
归约次数             = spec/k3_mc_baseline.json#collectiveCount.total            = 393
ceiling(N)           = 1e6 / ((computeUs + N×1.15) × 1.17)
ceiling(393)         = 760.58 TPS（仍低于 1000 目标；即使降到结构下限 209 也只有 937.03，τ 未收口前次数轴不可达）
                       2026-09-25 GAIN 置 1 后 compute 变大：720.19 / 876.47 TPS；加入 shared 专家重叠后 781.26 / 968.61 TPS；加入独立 TMA 通道后 845.72 / 1069.69 TPS；加入 KV 跨层预取与 DMA 抢占后 874.42 / 1116.02 TPS（spec.tauBasis；DMA 等待取 0、掩盖量按观测值固定，209 次的值是乐观上界）
byteFloor            = readBytesPerRankPerToken / effectiveDmaTBsPerCard
MC slack             = (computeUs + commUs) − byteFloor                          = 54.34 µs
Wup bytes            = 92 × 7168 × 3584 × 2                                      = 4.727 GB
bw*(Wup)             = (Wup×31/32/92) / ((22.96/92)×1e-6)                        = 199 TB/s
```

`k3_1000tps_algorithm_spec.html` §3.7 与 §8 的局限清单（`下限为 4 次（全分片）`、`归约延迟 flat 缩放假设内存语义两轮 all-reduce`）是本修订的口径依据。
