# 软件优化策略：可兑现清单与上下界

| | |
|---|---|
| Owner | SW-07 Software KPI/Profiler |
| 共签 | SW-03 Kernel、SW-04 Fusion、SW-05 Collective、SW-06 Scheduler |
| Stage | quantification（legacy D6/Q6） |
| Evidence class | `PLANNING_ESTIMATE`，confidence `E0` |
| 模型基座 | `integration/detailed/k3_rdma_final_tuning_model.js`、`integration/detailed/k3_architecture_search.js`、`integration/detailed/k3_operator_sram_sim.js` |
| 载荷条件 | K3，B=1，context 1M，TP32，PP=1，8 die/card，`best.x` |
| Status | 未进入任何 Gate；不构成 D-Gate/Q-Gate 证据 |
| 前置 | 本清单中 τ 相关的结论依赖 [`SW-05_COLLECTIVE_STRATEGY_REVISION.md`](SW-05_COLLECTIVE_STRATEGY_REVISION.md) 的 τ 基准问题；见 §5 |

## 0. 结论

在**纯软件、不新增硬件、不新增假设、不额外吃面积或功耗**的约束下，本模型上有 4 项可兑现优化，合计把 TPS 从 **859.18 推到 1014.6–1020.9**（实测，非外推）。

| # | 项 | 责任 | 实测 ΔTPS | 可行性 |
|---|---|---|---:|---|
| D1 | TMA 与 kernel 跨 op 流水 | SW-06 / 编译器 | **+131.2** | 可兑现，需 tile 级流水契约 |
| D2 | collective 与 compute 重叠 | SW-05 / SW-06 | **+122.6** | 可兑现，需 loosening 串行槽 |
| D3 | 每 op 固定开销归零 | SW-06 | **+133.3** | 部分已在模型中，其余需硬件前提（见 §2.3） |
| D4 | QK kernel 效率对齐其余 attention 算子 | SW-03 | **+40.2** | 条件可兑现，见 §2.4 |

**实测组合**（不是各项相加）：

| 配置 | TPS | raw µs | compute | comm | wait |
|---|---:|---:|---:|---:|---:|
| 基线 `best.x` | 859.18 | 994.79 | 779.73 | 138.43 | 76.63 |
| D1 | 990.4 | 863.0 | 503.6 | 138.4 | 221.0 |
| D2 | 981.8 | 870.5 | 779.7 | 0.0 | 90.8 |
| D3 | 992.5 | 861.2 | 651.4 | 135.2 | 74.6 |
| D4 | 899.4 | 950.3 | 734.5 | 138.4 | 77.4 |
| **D1+D3** | **1014.6** | 842.4 | 486.0 | 135.2 | 221.2 |
| **D1+D2+D3** | **1020.9** | 837.2 | 486.0 | 0.0 | 351.2 |
| D1+D2+D3+D4 | *未实测* | — | — | — | — |

**各项不可相加。** 单独四项之和为 +427.3，实测 D1+D2+D3 为 +161.7，**非可加性 62%**。原因见 §3。

---

## 1. 结构性约束：busy 的释放不是线性的

```
busy      = compute + comm = 779.73 + 138.43 = 918.16 µs
byteFloor = readBytes / dmaTBs = 5.3551 GB / 6.1993 TB/s = 863.82 µs
slack     = 918.16 − 863.82 = 54.34 µs
```

`simulate()` 的 `tryOp()` 把 COMM 记入 `coll`、其余记入 `compute`，两者共用同一个 `running` 槽，且 `simulate()` 断言 `raw = compute + comm + wait`。因此 `busy = compute + comm` 是**恒等式**，不是近似；天花板可直接算：

```
ceiling(busy) = 1e6 / (busy × 1.17)
```

**busy 减少的前 ~54 µs 会 1:1 转成 raw 减少；超过之后字节地板接管。** 这一点被实测印证：D1 把 compute 从 779.7 砍到 503.6（−276 µs），但 wait 从 76.6 涨到 221.0（+144 µs），净 raw 只降 131.8 µs。**释放的 busy 有一半以上被 DMA 等待吸收。**

D1+D3 后 busy 降到 621.2 µs（busy ceiling 1375 TPS），此时**绑定约束已从 busy 转到字节**（raw 842.4 vs byteFloor 863.82）。

---

## 2. 可兑现清单

### 2.1 D1 · TMA 与 kernel 跨 op 流水（+131.2 TPS）

**现状**：`localTma` 服务时间合计 **326.91 µs**，占 kernel+localTma 的 40%。`mappedPlan()` 的 `nominalPipeline` 允许**单个 op 内**的分块流水，但 op 之间是串行的（`L` 类算子 `Linear projections` kernel 仅 18.49 µs 却要 41.66 µs 搬运；所有 V 类算子 kernel ≈ 0 但各 ~4.5 µs 搬运）。

**动作**：把 TMA fill/drain 从 op 边界解耦，做成跨 op 的流水队列，使 N+1 个 op 的权重搬运与第 N 个 op 的 kernel 重叠。

**实现前提**：
1. Tile IR 需带 `dependency token` 与 `output event`，使调度器能表达跨 op 依赖（[`TILE_IR.md`](../../../docs/architecture/contracts/TILE_IR.md) §1 已列出这两个字段，但模型未实现）；
2. Local SRAM 需支持至少双缓冲的 tile 生命周期（[`03_TMA_AND_SRAM.md`](../../hardware/docs/03_TMA_AND_SRAM.md) §5 的 generation-tagged slot 已定义）；
3. 需要「reduce-done」flip 之外的独立「tma-done」事件，否则流水退化为串行。

**未计价代价**：Local SRAM 容量。当前模型 `lLocalBytes = 2×w/NL + 2×activation/NL + write/NL×2`（`k3_architecture_search.js:65`）按双缓冲计，跨 op 流水需要更多在途 tile。**本项在模型中未作容量复核**，需 SW-04 补算。

### 2.2 D2 · collective 与 compute 重叠（+122.6 TPS）

**现状**：`tryOp()` 中 COMM 与 compute 互斥——`running` 单槽，COMM 期间不发起 compute op。

**动作**：允许 collective 与后续 compute op 并行，即释放单槽互斥。

**实现前提**：
1. collective 的 mailbox/epoch 生命周期与 compute 的 tile 生命周期必须可独立推进（[`07_COLLECTIVE_RDMA.md`](../../hardware/docs/07_COLLECTIVE_RDMA.md) §4 已定义状态机）；
2. 需要 `partial-ready` 的 consumer wavefront 模型——当前 `OPT.partialThresholdAttention/LSE/Router` 三个阈值在 `F.mapped()` 中是**惰性的**（实测扰动零影响），即模型没有真正的 partial-ready 时序；
3. NoC/共享 SRAM 的**资源配置必须独立**，否则 overlap 会重复计数（`AGENTS.md`：「overlap 不能重复计算；通信资源独立」）。

**为什么 D2 单独收益大但组合收益小**：D2 与 D1 都作用在同一个串行槽上。D1 已经把 compute 侧的 localTma 释放，D2 再释放 comm 时，两者争抢的 slack 已被字节地板吸收（D1+D2+D3 的 wait 达 351.2 µs）。

### 2.3 D3 · 每 op 固定开销归零（+133.3 TPS）

拆成三项，可行性不同：

| 分项 | 现状 | 可行性 |
|---|---|---|
| `launchUs = 0.015 µs/op` × 3062 op × `launchScale 0.45` = **20.67 µs** | 已有 `launchBatching` 折扣 | **可兑现**（合并 batch、descriptor 预取） |
| `tmaSetupCycles = 16` → 每 op **85.7 µs** 合计 | 固定 setup，未摊薄 | 可兑现（增大 tile、减少 op 数） |
| `routerCycles = 2` → 每 op flush 三跳 **44.4 µs** 合计 | mesh 跳数固定 | **需硬件前提**（降低 hop 或专用 collective 通路） |

三项合计 130.1 µs = busy 的 14%。其中 `launchUs` 与 `tmaSetup` 属软件可压；`routerCycles` 属拓扑（B-004），不应计入软件收益。**保守口径：D3 的软件可兑现部分约为 106 µs，对应约 +100 TPS。**

### 2.4 D4 · QK kernel 效率对齐（+40.2 TPS）

**现状**：`GAIN` 的算子匹配正则为

```js
const ATTN_OPS   = /Online softmax|PV|Attention/
const LINEAR_OPS = /Linear|Expert|Wup|Wdown/
```

`"QK (absorbed MLA)"` **两条都不匹配**，因此全场最大的单个算子（186.12 µs）是唯一不拿任何 kernel GAIN 的计算算子。

**动作二选一**：
- **（a）若 QK 确实无法获得与其余 attention 算子同等的 kernel 优化**：在 `GAIN` 中增加显式项（如 `kernelQk: 1.0`）并注明理由，使口径可审计；
- **（b）若 QK 可获得同等优化**：修正正则使其匹配 `ATTN_OPS`，收益 +40.2 TPS。

**注意**：当前状态方向上是**保守**的（压低了 TPS，不是虚高）。因此本项不是「找到一个优化」，而是「消除一个无文档的不一致」。修正前必须由 SW-03 确认 QK kernel 能否达到 `kernelAttention 0.88 × partialReadyAttention 0.86` 的同等程度。

---

## 3. 为什么不可相加

三项原因，全部来自模型结构：

1. **共享串行槽**。D1/D2/D3 都作用在同一个 `running` 槽上。任何一个把该槽缩短后，其余两项的可压缩空间同比减少。
2. **字节地板截断**。D1+D3 后 busy 降至 621.2 µs，已低于 byteFloor 863.82 µs 对应的约束；此后缩减 busy 只增加 wait，不增加 TPS。
3. **DMA 等待的补偿性上升**。D1 的 wait 从 76.6 → 221.0，D1+D2+D3 的 wait 达 351.2——释放的 busy 大部分被 DMA 吸收。

**因此本清单的总收益必须用组合实测值，不得用各项之和。** 任何报告如出现「+131+122+133+40 = +427」的写法即为口径错误。

---

## 4. 不计入软件收益的项（分类说明）

### 4.1 模型修正，非收益

- **删除 `Shared output all-reduce`**（原 `SW-05_ALLREDUCE_FUSION.md` §0 报 +27.67 / +15.51 TPS）。参考页的每 MoE 层 4 次本就把 Shared 输出并入 ★3；本模型多发了 1 次。删除它是**把模型对齐到参考基线**，不产生可计入 `software_gain_budget` 的收益。详见 `SW-05_COLLECTIVE_STRATEGY_REVISION.md` §1.3。

### 4.2 需硬件改动，不计软件收益

- **`matrixUtil` 0.65 → 0.88**（+90.7 TPS，实测 949.8）。`F.OPT.matrixUtil = 0.88` 已登载，但 `mappedPlan()` 用 `TECH.matrixUtil = 0.65` 定完 `o.duration` 后被覆盖、不再重算。**这是登载值与实际值的口径不一致，不是软件优化。** 若要计入，需 SW-03 提供 QK/GEMM kernel 达到 88% 矩阵利用率的证据并替换 `TECH.matrixUtil`。
- **加 H 算力**。`hEngines=8` / `hCols=128` / `hRows=64` 全部撞 **card power 2400 W**（实测 2806 W）；即使把 `nL` 砍到 4 并删除端口放大块，仍为 2506 W。面积不是绑定约束，功耗是。（2026-09-25 起按 SF4 面积、矩阵密度 3.2 TF/mm²、液冷 Die 300 W / 卡 2800 W 重新搜索，H 算力加到 4 × 5×(48×128) = 245.76 TF/Die，发布点 1101.77，见 21 号文档第 1.2 节。）

### 4.3 已关闭

- **复制换归约**（+193 TPS 的账面空间，到 209 次/层）。MC slack 54.34 µs 只够吞 0.337 GB，复制 Wup 需 4.579 GB（**13.6×**）；`bw*` = 199 TB/s（Wup）/ 243 TB/s（Wdown+Router） vs 现有 **6.199 TB/s**（**32–39×**）。关闭。

### 4.4 惰性旋钮（不得计入）

`OPT` 37 个旋钮中 **21 个对 859.18 零影响**，包括 `matrixUtil`、`vectorUtil`、`localWriteRatio`、`tmaDedicatedPort`、`tmaPortWriteScale`、`sharedReadScale`、`sharedReadPerWrite`、`chargeSharedPortCost`、`phaseFusionFactor`、`stripeKiB`、三个 `partialThreshold*`、`partialRelease`、`readyCounter` 等。任何基于这些旋钮的收益声明在模型上不可兑现。

---

## 5. 与 τ 基准的关系（前置约束）

本清单全部数字建立在实测 **τ = 271 ns/次**（`commUs 138.425 / 510`）之上。而 `HIGH_LEVEL_ARCHITECTURE.md:87/:117`、`k3_1000tps_metric_summary.html`、`tiered_memory_engine.js:40` 均写 **1.15 µs @TP8**，为实测的 **4.24×**。

按 spec 的 τ：

| N | busy µs | busy ceiling TPS |
|---:|---:|---:|
| 510（现状） | 1366.2 | **625.6** |
| 393（参考基线） | 1231.7 | 693.9 |
| 209（复制地板） | 1020.1 | **837.9** |

**在 spec 的 τ 下，§2 的全部优化也无法达到 859.18，更谈不上 1000。** 因此本清单的适用条件是 τ 基准问题先关闭；在此之前，D1–D4 的收益应标注为「在实测 τ 基准下的可兑现量」，不可作为达标证据。

---

## 6. 复现

仓库根目录执行。各项的施加方式（`drop()` 保持 GAIN 比例不变）：

```js
const F=require('./src/rdma/k3_rdma_final_tuning_model.js');
const A=require('./src/search/k3_architecture_search.js');
const {simulate}=require('./src/simulation/k3_operator_sram_sim.js');
const best=require('./data/rdma/k3_rdma_final_tuning_results.json').search.best.x;
const drop=(o,k)=>{const s=Object.values(o.timing).reduce((a,b)=>a+b,0);if(s<=0)return;
  const g=o.duration/s,d=k.reduce((a,x)=>a+(o.timing[x]||0),0);o.duration=(s-d)*g;};

function run(tma,comm,qk,fixed){
  const sv=JSON.parse(JSON.stringify(A.TECH));
  if(fixed)Object.assign(A.TECH,{tmaSetupCycles:0,routerCycles:0,launchUs:0});   // D3
  const m=F.mapped(best);
  for(const o of m.plan.ops){
    if(o.unit==='COMM'){if(comm)o.duration=1e-9;continue;}                        // D2
    if(tma)drop(o,['localTma']);                                                  // D1
    if(qk&&o.name.startsWith('QK'))o.duration*=0.88*0.86;                         // D4
  }
  const r=simulate(m.plan,m.window);Object.assign(A.TECH,sv);return r;
}
console.log(run(0,0,0,0).tps);   // 859.18
console.log(run(1,1,0,1).tps);   // 1020.9
```

**D3 的施加方式**把 `tmaSetupCycles`/`routerCycles` 一并归零，因此该行的 +133.3 是**上界**；按 §2.3 的保守口径（只压 `launchUs` + `tmaSetup`），软件可兑现部分约为 +100。

---

## 7. 下一步

| # | 动作 | 责任 |
|---|---|---|
| 1 | 确认 QK kernel 能否对齐其余 attention 算子的优化程度，据此选 §2.4 的 (a) 或 (b) | SW-03 |
| 2 | 补算 D1 的 Local SRAM 容量复核（跨 op 流水需更多在途 tile） | SW-04 |
| 3 | 在 Tile IR 补 `dependency token` / `output event` / `tma-done`，使 D1 可排程 | SW-06 |
| 4 | 实现真实的 `partial-ready` 时序，使 D2 的 overlap 可回放（当前三个阈值旋钮惰性） | SW-05 |
| 5 | 提供 `TECH.matrixUtil = 0.88` 的 kernel 证据，或从 `OPT` 撤下 0.88 | SW-03 |
| 6 | 本清单进入报告前须标注 τ 基准（§5），并只用组合实测值（§3） | SW-07 |
| 7 | 若采纳，V&V 增加「busy 低于 byteFloor 后 TPS 不再随 compute 下降」的回归断言 | VV-* |
