# SW-05 专题：MoE 层双 all-reduce 融合（Wup AR + Shared-output AR）

| | |
|---|---|
| Owner | SW-05 Collective/Comm-Compute Overlap |
| 共签 | SW-04 Fusion（合法性、alias/precision/workspace） |
| Stage | quantification（legacy Q4/Q6） |
| Evidence class | `PLANNING_ESTIMATE`，confidence `E0` |
| 模型基座 | `src/rdma/k3_rdma_final_tuning_model.js`、`src/rdma/k3_sram_memory_rdma_model.js`、`src/simulation/k3_operator_sram_sim.js`、`src/core/design_engine.js#kimiK3` |
| 载荷条件 | K3，B=1，context 1M，TP32，PP=1，8 die/card |
| Status | 候选，未进入任何 Gate；不构成 D-Gate/Q-Gate 证据 |
| **部分被取代** | **§0 的收益数字（+27.67 / +15.51 TPS）与 §5 的"结构下限是每层 4 次"表述，已被 [`SW-05_COLLECTIVE_STRATEGY_REVISION.md`](SW-05_COLLECTIVE_STRATEGY_REVISION.md) 取代**：删除 `Shared output all-reduce` 是把模型对齐到参考页基线（4 次/层），不构成软件收益；4 次是全分片基线，允许复制时结构下限为 2 次/层。本文 §2（合法性判据）、§3（字节账）、§6（实现前提）、§8（blockers）仍然有效 |

## 0. 结论

把每层 MoE 末端的两次 all-reduce（`Wup all-reduce` 与 `Shared output all-reduce`）合并成一次，**净减少数据搬移，不是增加**。

提出的质疑（融合要新增一次本地累加、并把 routed 分支的 partial 跨 shared-FFN 常驻）机制上成立，但量级相反：在本模型里一次 all-reduce 对 shared SRAM 的 staging 读写是其 payload 的 **6.9× / 5.0×**，而新增的本地累加只有 2×/1× payload。每层每 rank 的净账是 shared-SRAM 读 **−84,672 B**、写 **−57,888 B**、NoC **−99,552 B**、网络 wire **−49,600 B**，代价是 **+14,336 B** 的常驻张量和 **+3.9 µs** 的向量计算（全模型合计）。

诚实建模（补回本地累加算子、修正末端三路加为两路）后的收益：

| 基线 | TPS | 融合后 | ΔTPS |
|---|---:|---:|---:|
| 发布候选 `data/rdma/k3_rdma_final_tuning_results.json#search.best.x` | 859.18 | **886.85** | +27.67 |
| B4（重新坐标打磨 + 去端口放大块，见 §7） | 922.77 | **938.28** | +15.51 |

若只是粗暴地把 collective 时长置 0（不补本地累加），会得到 +21.1（B4 上），**高估 5.6 TPS**。本文采用诚实值。

---

## 1. 触发问题

> 合并 all-reduce，会增加数据的搬移。

这个质疑指向两处真实成本：

1. 融合要求把 `Wup all-reduce` **推迟**到 shared-FFN 之后，于是 routed 分支的 partial 必须在整段 shared 权重流式读取期间保持存活；
2. 融合本身需要一个新的本地累加算子（两个 partial 相加）。

两点都成立。本文把它们连同收益一起完整计价。

---

## 2. 合法性

### 2.1 实测算子序列

`build()` 生成的第 5 层（linear-attention 层）MoE 块：

```
174 V     MoE RMSNorm                       read  14.0KiB  write 14.0KiB
175 L     Latent Wdown                      (weight 1568KiB)
176 L     Router logits                     (weight  392KiB)
177 COMM  Wdown + Router all-gather         link  17.5KiB
178 V     Top-k / route resolve
179 V     Dispatch local pack
180 L     Expert gate/up                    (expert 5712KiB)
181 V     SiLU x up
182 L     Expert down                       (expert 2856KiB)
183 V     Expert weighted sum               write 14.0KiB
184 COMM  Routed latent merge               link  14.0KiB
185 L     Latent Wup                        (weight 1568KiB)  write 28.0KiB
186 COMM  Wup all-reduce                    link  28.0KiB      <-- 融合对象 A
187 L     Shared gate/up                    (weight 2688KiB)
188 V     Shared SiLU x up
189 L     Shared down                       (weight 1344KiB)
190 L     Shared gate/up                    (weight 2688KiB)   <-- 第 2 个 shared expert
191 V     Shared SiLU x up
192 L     Shared down
193 COMM  Shared output all-reduce          link  28.0KiB      <-- 融合对象 B
194 V     Shared + routed + residual add    read  42.0KiB = 3 x 14KiB
```

### 2.2 三条判据

1. **186 与 193 之间没有任何 norm**，只有两个 shared expert 的 FFN（全是线性算子 + 逐元素 SiLU）。
2. **shared 支路不消费 186 的输出**。op 194 读 42.0 KiB = 3 × 14 KiB（shared / routed / residual 三个独立张量），说明 shared 与 routed 是从 op 174 `MoE RMSNorm` 输出分叉的并行支路，shared 的输入是 h_norm。
3. **两个 collective 同形**：payload 均为 `B*H*2` = 14,336 B，同一 TP32 组，同一 H 维切分。融合后 payload 不变（先本地相加，再规约一次），所以"少一次 collective"是准确建模，不存在 payload 膨胀。

因此重排为 `185 → 187..192 → (本地累加) → 单次 all-reduce → 194(两路加)` 合法。

### 2.3 与现有代码注释的关系

`k3_operator_sram_sim.js` 中：

```js
// Shared experts are full-hidden FFNs, not latent routed experts.
// Keep a separate reduction rather than silently fusing incompatible shapes.
```

该注释针对的是**专家计算**不可融合（shared 为 H→F，routed 为 I→F），这一点正确。但两次 all-reduce 的 shape 完全一致（见 §2.2 判据 3），注释给出的理由不覆盖 collective 融合。本文不修改该代码，只记录这一区分。

### 2.4 两个被否决的相邻方案（负面结论，同样登载）

| 方案 | 判定 | 理由 |
|---|---|---|
| 把 `Wdown + Router all-gather` 融进 `Attention output all-reduce` | **非法** | 二者之间隔着 op 173 `Attention residual add` 和 op 174 `MoE RMSNorm`。RMSNorm 需要对完整 hidden 求 RMS，必须拿到已完成规约的值，all-reduce 不能推迟到它之后。 |
| 消除 `Routed latent merge` | **无法定价** | 专家输出是 F 维上的 partial sum，必须在 `Latent Wup` 前规约。唯一可省的做法是把 Wup 改成按 I 行切分、把 all-reduce 降级为 reduce-scatter——那是"换更便宜的 collective"而非"删一次"。而 `R.collective` 仅按算子名区分 all-gather 与 reduce-scatter+all-gather，**没有纯 reduce-scatter 原语**，实测降级后 phases 仍为 2、duration 比值 1.000。该收益在当前模型中不可计价，不予登载。 |

---

## 3. 数据搬移账（对 §1 的正面回答）

### 3.1 一次 all-reduce 的完整字节账

`R.collective('Wup all-reduce', 14336, ...)`，B=1：

| 字段 | 值 | 相对 payload |
|---|---:|---:|
| kind | FP32 reduce-scatter + BF16 all-gather | |
| logicalPayload | 14,336 B | 1.00× |
| transportBytes | 28,672 B | 2.00× |
| phases / requests / activeNICs | 2 / 62 / 1 | |
| wireBytes（网络） | 49,600 B | 3.46× |
| **readBytes（shared SRAM）** | **99,008 B** | **6.91×** |
| **writeBytes（shared SRAM）** | **72,224 B** | **5.04×** |
| nocBytes | 142,560 B | 9.94× |
| workspace（mailbox+queue） | 276,480 B | 19.29× |

关键点：**collective 的成本主体不是 payload，而是它自身的 staging**。reduce-scatter + all-gather 两个 phase、每个 phase 的 read/write/NoC、加上 `reduceRead/reduceWrite` 和 `logicalPayload*2` 的进出，使 shared-SRAM 读达到 payload 的 6.9 倍。

### 3.2 融合后的每层每 rank 净变化

| 资源 | collective 侧 | 本地累加 | 末端三路加→两路 | **净** |
|---|---:|---:|---:|---:|
| 网络 wire | −49,600 | 0 | 0 | **−49,600 B** |
| shared-SRAM read | −99,008 | +28,672 | −14,336 | **−84,672 B** |
| shared-SRAM write | −72,224 | +14,336 | 0 | **−57,888 B** |
| NoC | −142,560 | +43,008 | 0 | **−99,552 B** |
| 常驻张量 | — | — | — | **+14,336 B** |

四项搬移全部**下降**。质疑中"新增搬移"的那部分（本地累加 28,672 读 + 14,336 写）确实存在，但只有被删除的 collective staging 的约 1/3。

---

## 4. 代价清单（不隐藏）

1. **新增本地累加算子**：92 层各一个，全模型 compute **+3.91 µs**（B4 上实测 716.81 → 720.72）。已计入 §0 的收益数字。
2. **y_routed partial 跨阶段常驻**：B=1 为 14,336 B，需要在 shared-FFN 流式读取 **8.26 MB/layer/rank** 的权重期间保持存活且不被 alias。容量上可忽略（48 MiB × 8 的 shared window 的 0.004%），但**生命周期约束是真实的**，见 §6 前提 5。
3. **DMA 重叠窗口变化**：COMM 是 DMA 的重叠窗口之一，删掉一次会改变 prefetch 的可用时间。实测方向不固定——发布候选上 wait 从 76.63 降到 64.62，B4 上从 71.00 升到 74.75。已计入收益。
4. **batch 线性**：所有项（payload、staging、本地累加、常驻）都与 B 线性相关，所以**收益/代价比与 B 无关**。唯一不随 B 缩放的是每次 collective 的固定协议延迟，这使融合在**小 B 下更划算**。

| B | 额外常驻 | 本地累加流量/层 | ×92 层 |
|---:|---:|---:|---:|
| 1 | 14.0 KiB | 42.0 KiB | 3.96 MB |
| 8 | 112.0 KiB | 336.0 KiB | 31.65 MB |
| 32 | 448.0 KiB | 1,344.0 KiB | 126.62 MB |
| 64 | 896.0 KiB | 2,688.0 KiB | 253.23 MB |

---

## 5. 为什么这个融合值得做：COMM 是延迟问题，不是带宽问题

支撑性实测（同一候选）：

- 把 `LIMITS.networkGBs` 从 800 提到 1600、3200，**comm 一位不变**（138.43 µs）。
- 把一次 hot all-reduce 的 payload 压到 64 B，duration 从 0.7729 µs 只降到 0.6796 µs，即 **87.9% 是固定协议延迟**（`oneWayUs` + rx/commit/notify/ack cycles + die merge），与 wire 带宽无关。
- 全模型 **510 次 collective，平均 271 ns/次**。

结论：COMM 的 138.43 µs 只能靠**减少 collective 次数**来压，不能靠加链路。每层 5 次 collective 中，经本文分析只有 1 次可合法删除，**结构下限是每层 4 次**，对应 comm ≈ 115.5 µs。

---

## 6. 实现前提（软件收益必须带前提）

本收益**不得**在未满足以下条件时计入任何 TPS 平面：

1. **SW-02 编译器**能把 `Wup all-reduce` 推迟到 shared-FFN 子图之后，即调度器支持把 y_routed_partial 作为跨权重流式阶段的 live value。
2. **K3 层拓扑确认**：shared expert 的输入是 `MoE RMSNorm` 的输出 h_norm，而非 Wup 之后的 hidden。**这是从算子图语义推断的，不是图本身强制的**（见 §8）。若实际拓扑不同，本方案整体失效。
3. 本地累加在 **FP32** 下进行，随后进入 FP32 reduce-scatter。
4. routed 与 shared 两个 partial 具有**相同的 H 维 TP 切分和相同 layout**，可直接逐元素相加而无需 relayout。
5. **Alias 约束**：y_routed_partial 的 buffer 不得被 shared-FFN 的 output tile 复用；需在 buffer lifecycle 契约中显式登记。
6. Fallback：若 3–5 任一不满足，退回两次独立 all-reduce，无正确性风险。

**精度**：融合后精度不劣反优。现状是 reduce(y_routed)→BF16、reduce(y_shared)→BF16、再相加，两次 BF16 取整；融合后是 FP32 本地相加 → 单次规约 → 一次 BF16 取整，**少一次 BF16 round-trip**。

---

## 7. 量化结果

两个基线均为 `F.evaluate` 路径（含 GAIN/OPT），margin 1.17。

| 配置 | TPS | raw µs | compute | comm | wait |
|---|---:|---:|---:|---:|---:|
| 发布候选 best.x | 859.18 | 994.79 | 779.73 | 138.43 | 76.63 |
| 发布候选 + 融合（诚实） | **886.85** | 963.75 | 783.67 | 115.46 | 64.62 |
| B4 | 922.77 | 926.23 | 716.81 | 138.43 | 71.00 |
| B4 + 融合（诚实） | **938.28** | 910.93 | 720.72 | 115.46 | 74.75 |
| B4 + 融合（乐观，duration→0，**不采用**） | 943.90 | — | 716.81 | 115.46 | 73.25 |

B4 = `best.x` 基础上 `lBanks 8→16, hBanks 16→32, sharedMiB 24→48, weightTileMiB 4→8`，并关闭 `OPT` 的 shared-SRAM 端口放大块（`localWriteRatio/tmaDedicatedPort/tmaPortWriteScale/sharedReadScale/sharedReadPerWrite`），dieArea 394.5/400、cardPower 2387/2400，均合法。B4 本身属独立议题，不是本文结论的前提；融合在发布候选上单独成立。

---

## 8. 未建模风险 / blockers

1. **模拟器没有 activation 级依赖边**。`plan.ops` 的 `inputs/outputs` 只挂 weight/KV/state/prediction/write job，算子纯按 index 串行执行。因此 §2 的合法性是从 MoE 语义 + op 194 的三路读**推断**的，模型本身既不强制也不验证。需要 SW-02 在 schedule IR 上补依赖边后复核。
2. **激活张量不在 SRAM job 账本里**，所以 §4.2 的常驻代价在模拟中未被计价（B=1 下可忽略，B=64 下 896 KiB 仍 <0.2% shared window，但应在 buffer lifecycle 契约中登记）。
3. **本模型无纯 reduce-scatter 原语**（`R.collective` 按算子名分派），导致 §2.4 的 `Routed latent merge` 方案不可计价。若要评估该方案，需先扩展 `k3_sram_memory_rdma_model.js` 的 collective kind。
4. 本文所有数字建立在 `GAIN`（25 项 ASSUMPTION 因子，Blocker B-003）与 `UNVERIFIED_PLANNING_MANIFEST` 之上，不可作为 silicon observation 或 validated replay 引用。

---

## 9. 复现

以下两段在**仓库根目录**下用 `node -e '...'` 执行（相对 `require` 按 cwd 解析）。

```js
// 复现 §7 的"发布候选 + 融合（诚实）"一行
const F=require('./src/rdma/k3_rdma_final_tuning_model.js');
const {simulate}=require('./src/simulation/k3_operator_sram_sim.js');
const best=require('./data/rdma/k3_rdma_final_tuning_results.json').search.best.x;
const payload=7168*2;                       // B*H*2
const m=F.mapped(best);
const tmpl=m.plan.ops.find(o=>o.name==='Attention residual add');   // 2-in/1-out, B*H*2
for(const o of m.plan.ops){
  if(o.name==='Shared output all-reduce'){   // 删掉一次 collective，补回本地累加
    o.name='Routed+shared partial accumulate (fused)'; o.unit='V';
    o.duration=tmpl.duration; o.timing={...tmpl.timing};
    o.read=2*payload; o.write=payload; o.linkBytes=0;
  } else if(o.name==='Shared + routed + residual add') o.read=2*payload;  // 三路加 -> 两路加
}
console.log(F.evaluate(best).tps, simulate(m.plan,m.window).tps);   // 859.18 -> 886.85
```

§3.1 的字节账：

```js
const R=require('./src/rdma/k3_sram_memory_rdma_model.js');
const A=require('./src/search/k3_architecture_search.js');
console.log(R.collective('Wup all-reduce',7168*2,A.physical(best),best,{...R.MEM,...F.OPT}));
```

---

## 10. 下一步

| # | 动作 | 责任 |
|---|---|---|
| 1 | 在 schedule IR 上补 activation 依赖边，复核 §2 的合法性推断 | SW-02 |
| 2 | 把 y_routed_partial 的跨阶段 liveness 与 alias 约束写入 buffer lifecycle 契约 | SW-04 |
| 3 | 向 Model 团队确认 K3 shared expert 的输入张量（前提 2） | MODEL-* |
| 4 | 扩展 `R.collective` 支持纯 reduce-scatter，重估 §2.4 的 latent merge 方案 | SW-05 |
| 5 | 本收益进入 `software_gain_budget` 前须带 §6 全部前提，并标注 `PLANNING_ESTIMATE` | SW-07 |
| 6 | 若采纳，由 V&V 增加"每层 collective 次数 = 4"的回归断言 | VV-* |
