# K3 架构仓库证据链与 TPS/usr 指标 Review

- 评审日期：2026-09-24
- 评审对象：`k3-architecture-repo`（HEAD `c8bd2cc`，branch `main`）
- 评审方式：只读静态审查 + 独立复算；未修改任何被评审文件
- 机器状态：`npm test` 33 个测试文件全部通过
- 文档性质：**人工撰写的评审记录，不是 runner 生成物**（不适用 `reports/README.md` 中"generated review snapshot"的约束）

---

## 1. 结论摘要

这是一个治理纪律明显高于同类的架构规划仓库。它的核心优点不是"算了多少模型"，而是**用机器可检查的方式把证据等级钉死在产物里**：Gate 决策由独立 validator 复算、runner 被禁止写入决策字面量、合成证据不得晋升为时序证据、经验缩放因子逐个命名并挂 blocker 跟踪。这些都经过验证，不是文档自述。

问题集中在三个方向：

1. **同一个 K3 TPS/usr 存在 5 条互不通约的数值平面**，其中至少 4 条无 `runId` 绑定，且有一条（`989.74`）高于文档认定的权威值（`859.18`）却未被标记废弃；
2. **P0/P1 这个贯穿全仓的治理维度，对 TPS 指标本身没有任何影响**（带宽约束主导，与 core peak 无关），导致"P1 结果不得外推 P0"这条规则在 TPS 上不可执行；
3. **若干文档之间对同一口径给出互相矛盾的现行陈述**（raw 预算分账、SRAM 峰值、MC 档位、1050 的定义），且多数没有标注哪一份已作废。

其中第 2 条与第 3 条的部分内容仓库自己已经记录（`MR-010` 已列"18 槽位仅 2 个有结果"；`tests/test_directional_units.js` 已标注 `dominant_operator_per_rank_not_model_total`），本评审的增量在于**量化其后果**并补齐未记录的项。

---

## 2. 评审方法与可复现性

- 逐一阅读设计文档（`docs/design/00`–`20`、`AGENT_METRICS_MATRIX.md`、`AGENT_WORKSTREAM_PLAN.md`、`DECISIONS.md`、`OPEN_ISSUES.md`）、模型与 runner（`models/`、`src/`、`scripts/`）、测试（`tests/`）与数据产物（`data/`）。
- 对关键数字做独立复算（见 §5、§6），不复述产物自述。
- 对 `data/` 下的大文件（4–13 MB）用定向切片读取，未整体加载。
- 工作树差异做过规范化比对（剥离 CR 与 BOM 后取 SHA），用于区分实质改动与噪音。

复算入口：

```sh
npm test
node tests/test_design_baseline.js
npm run model:planning     # Stage A -> Stage B -> contracts -> dashboard
```

---

## 3. 值得肯定的做法（建议保留，不要在后继重构中丢失）

| # | 做法 | 证据位置 |
|---|---|---|
| 1 | **Gate 决策由独立 validator 复算**，runner 不得写 `PASS` 字面量；register 状态**派生**自 validator | `models/governance/evaluate_gates.js`、`models/resolve_architecture_blockers.js` 文件头注释 |
| 2 | **mutation 测试主动篡改输入**并断言 validator 拒绝（清空候选、塞入非法候选、关闭面积守恒、伪造 register PASS） | `tests/test_planning_evidence_dashboard.js` |
| 3 | **已提交的 gate 状态必须等于 validator 重算结果**（不是断言字面量，而是断言一致性） | `tests/test_architecture_gate_governance.js` |
| 4 | **证据等级未被偷偷抬高**：`SYNTHETIC_BOTTLENECK_BOUND` 全程不得晋升；看板显式纠正此前误写的 Q-Gate PASS | `reports/dashboard/architecture_global_dashboard.html`、`ADR-0003` |
| 5 | **陈旧产物有硬防护**：runner 自身、resource_profiles、mcSpec、manifest、dashboard 的 SHA-256 都写进产物并被测试反查，失败信息带修复命令 | `models/formal_detailed_run.js`、`tests/test_stage_a_directional_run.js`、`tests/test_stage_b_detailed_run.js` |
| 6 | **K3 形状唯一来源**（`src/core/design_engine.js#MODEL_PRESETS.kimiK3`）由测试强制贯穿 manifest / profile / planning workload | `tests/test_k3_manifest_consistency.js` |
| 7 | **经验缩放因子有名有姓**：25 个 `GAIN` 因子逐项命名、全部标 `ASSUMPTION`、挂 blocker `B-003` 跟踪替换 | `src/rdma/k3_rdma_final_tuning_model.js` §GAIN |
| 8 | **`00_CURRENT_STATE.md` 刻意不抄数字**，只登载 JSON 字段路径，以避免多处漂移 | `docs/design/00_CURRENT_STATE.md` 第 3 节与第 45 行 |
| 9 | **不可比口径有显式警告**（三处，见 §7.3） | 看板、Stage A 报告、`14_TPS_OBSERVATION_METRICS.md` |
| 10 | **诚实的负面陈述**：`acceptance.currentStatus = not-met`；"该结果没有找到严格达到 1000 TPS/usr 的候选"；`Q8 = PLANNING_ONLY` | `spec/k3_mc_baseline.json`、`scripts/generate_k3_latest_design_doc.js` |
| 11 | **未确认配置一律标注**：E0 / `UNVERIFIED_PLANNING_MANIFEST` / 0-of-45 字段已验证 | `data/workload/formal_model_manifests.json`、`model_manifest_qualification_matrix.json` |
| 12 | **最强的物理测试**：解析式 1/2 buffer 时序、93 层拓扑、时间与字节守恒、60 次完整 93 层运行 | `tests/test_k3_operator_sram_sim.js` |

---

## 4. TPS/usr 指标平面总览

`TPS/usr = 1,000,000 / e2e_latency_us_per_token`（`14_TPS_OBSERVATION_METRICS.md` §2）。
目标 1000；架构冻结门槛 1050；raw 预算 `1e6/1000/1.17 = 854.7008547 µs/token`。
**推论（仓库未登载）**：1050 门槛等价于 `raw ≤ 1e6/1050/1.17 = 814.00 µs/token`。

仓库中实际存在 **5 条独立 TPS 平面**：

| # | 平面 | 代表值（K3, TP32, B1, ctx 1M） | 产物 | 证据标签 | runId |
|---|---|---|---|---|---|
| A | 规划瓶颈上界（Stage A/B 18 槽位） | MC320 `1031.74` / MC640 `2063.49` | `data/workload/tps_observation_matrix.json` | `PLANNING_ESTIMATE` / `SYNTHETIC_BOTTLENECK_BOUND` | 有 |
| B | RDMA tile 模拟（最终调优） | MC320 `533.94` / MC640 `859.18` | `spec/k3_mc_baseline.json#modelResults` ← `data/rdma/k3_rdma_final_tuning_results.json` | 曲线模型结果 | **无** |
| C | RDMA 变体阶梯 | `600.93 → 769.11 → 846.37 → 904.41 → 989.74 → 859.18` | `data/rdma/*_results.json`、`reports/rdma/*.html` | 历史各轮 | **无** |
| D | B1 单目标搜索 | `525.21`（扩展域）/ `339.90`（原域），达标数 **0** | `data/search/k3_b1_1000_results.json` | 搜索最优 | **无** |
| E | SRAM/TPS 敏感度 | `1260.79 … 1294.84`，wall = "TP 归约" | `data/sram/sram_tps_architecture_analysis.json` | "Raw local-model sensitivity outputs; not validated operator-timed predictions" | **无** |

### 4.1 平面之间的数值关系（同一 K3/TP32 配置）

| 对比 | 规划上界 | 模拟结果 | 比值 |
|---|---:|---:|---:|
| MC320 | 1031.74 | 533.94 | **1.932×** |
| MC640 | 2063.49 | 859.18 | **2.402×** |

**没有任何提交产物计算过这两者的比值或差异**；三处警告只声明"不可直接比较"。而 `13_MULTI_MODEL_ARCHITECTURE.md` §B4 又要求 Q8 输出"Stage A 粗 TPS 与 Stage B 细 TPS 的差异百分比和原因"。**该归因要求从未被满足，也从未被登记为 blocker**。

### 4.2 两条管线是耦合的，尽管被声明为不可比

规划管线的 collective 字节直接取自 RDMA 模拟结果：

```
collectiveSource: data/rdma/k3_rdma_final_tuning_results.json#/search/best/wireBytes × TP32
sourceHashes.finalTuningResults: <该文件的 SHA-256>
```

同时 `data/direction/directional_workload_baseline.json` 用 MC320 replay（`533.9434874856156`）作为 K3 的校准锚点。也就是说：**规划上界把自己锚定在平面 B 的数值上，却在同一次运行里把它改写成平面 A 的 `1031.74`**。这是本仓库最尖锐的内部矛盾。

---

## 5. 规划上界（平面 A）：`max` 与 `Σ` 的差异

### 5.1 公式（已逐项复算，与发布值一致）

`models/resolve_architecture_blockers.js:65-105,137-142`、`models/formal_detailed_run.js:68-79,186-202`：

```
rB_op = (globalBytes_op / tp) × 1000 / mcEffective
rC_op = (globalFlops_op / tp) × 1000 / (0.51 × peakByCore[core_op])
tps   = 1000 / max( max_op rC_op , max_op rB_op )
```

其中 `mcEffective = 16 × mcGBsPerCube × 0.70`（MC320 = 3.584e12 B/s，MC640 = 7.168e12 B/s）。
带宽约束下化简为 `tps = mcEffective × tp / bytes`。

**三个结构性事实（复算确认）**：

1. **`target` 在公式中约掉**：`tpsPerUser = 1 / max(max_op[flops/(tp·peak·0.51)], max_op[bytes/(tp·bw)])`。把 1000 改成 1050 **不会改变任何已发布数值**，只会翻转 `meetsTarget` 比较结果。
2. **`utilization × dutyCycle` 只出现在算力分支**：带宽分支除 `effectiveBytesPerSecond` 内含的 0.70 外**没有任何效率折扣**。18 个槽位全部带宽受限，所以每个发布值都形如 `effectiveBytesPerSecond / (bytes_per_rank)`。
3. **取 `max` 而非 `Σ`**：两个聚合都是对独立求值的算子行取最大值，不求和、不串行化。

### 5.2 量化 `max` 与 `Σ` 的差距（本评审新增）

用仓库自己的字节账复算 K3（`data/workload/planning_operator_workload.json`）：

```
Σ 非 collective 字节/token（global） = 166,413,968,384
TP32 每 rank                        = 5,200,436,512 B
MC320 有效带宽                      = 3.584e12 B/s
1000 TPS 的需求                     = 5.2004e12 B/s   →   ratio = 1.4510
Σ-口径下界                          = 689.18 TPS
该槽位发布值                        = 1031.74 TPS
比值                                = 1.497×
```

**同一个 K3/TP32/MC320 槽位，在 `Σ`-口径下是 689 TPS（低于 1000 目标），在 `max`-口径下是 1031.74 TPS（高于目标）。** 两个口径落在目标线两侧，足以改变读表结论。

诚实说明：仓库已经把该口径**标注**为 `scope: 'dominant_operator_per_rank_not_model_total'`（`tests/test_directional_units.js:12`）并在看板写明"取最慢单算子的瓶颈上界，未累计完整依赖链或网络延迟"。所以缺的不是披露，而是**这个 1.50× 的松紧度从未被量化**。建议直接把 `Σ`-口径下界作为一列加入矩阵。

### 5.3 该口径忽略的项（逐项确认）

| 项 | 是否计入 | 证据 |
|---|---|---|
| 专家预取未命中（2−p）重读 | 否 | 产物自述 "Derived bytes count each weight/KV byte once" |
| tile 重载 | 否 | 同上 |
| collective **延迟**（区别于带宽） | 否 | 只以字节率进入；`hopCountP99` 只存在于合成事件中 |
| 跨算子依赖链 | 否 | 取 max，不求和、不串行化 |
| 工程裕量 1.17 | 否 | 逐行标注 `optimistic_single_operator_bottleneck_no_schedule_or_margin` |

### 5.4 8.2 提到的 `target` 约掉带来的一个后果

`data/analysis/arithmetic_intensity_contract.json:8` 的 `targetTimeUsPerToken: 1000`，与被测试固定（`tests/test_arithmetic_intensity_agent.js:20`）。但 1000 TPS/usr 对应的是 **854.7009 µs/token**（含 1.17 裕量）或 **1000 µs**（不含裕量）。该字段把"目标时延"写成 1000 µs 而不注明是否含裕量，是全仓唯一一处把 `e2e` 与 `raw` 口径混写的目标定义。

---

## 6. RDMA 模拟（平面 B）：859.18 的构成

### 6.1 数值与分解

| MC | TPS | raw µs | e2e µs | compute µs | comm µs | DMA 等待 µs |
|---|---:|---:|---:|---:|---:|---:|
| 320 | 533.94 | 1600.73 | 1872.86 | 779.73 | 138.43 | 682.57 |
| 640 | 859.18 | 994.79 | 1163.90 | 779.73 | 138.43 | 76.63 |

- `e2e = raw × 1.17`，`tps = 1e6 / e2e`，裕量**已含在内**（口径正确）。
- 两点差异中 **compute 与 comm 完全相同**，全部差别来自 DMA 等待（605.94 µs）。与 `00_CURRENT_STATE.md` 的判断一致：首要矛盾是可实现的 MC 聚合带宽，而非 Tensor peak。
- 达成 MC640 时 `rawUs` 仍比 854.70 预算高 **140.09 µs**，因此 `acceptance.currentStatus = not-met`。

### 6.2 GAIN 表的真实暴露（本评审确认）

25 个因子全部逐项乘在 duration 上，证据等级均为 ASSUMPTION。要判断 859.18 的稳健性，关键是区分哪些因子**真正影响**该数值：

- **真正生效**：`hotPhaseDuration(0.55, 通信侧最大单因子)`、算力侧复合簇 `kernelAttention(0.88) × kernelLinear(0.91) × partialReady*(0.86/0.88) × 三个 fusion(0.86/0.84/0.88)` ≈ **0.83**，作用于占 raw 78% 的算子。
- **零影响**：五个字节缩放因子（`hotWire`、`hotReadWrite`、`hotNoc`、`remoteReadWrite`、`remoteNoc`）只通过 `resourceFloor` 影响 `portTail`，而最优候选的 `portTail = 0`（`src/rdma/k3_sram_memory_rdma_model.js:79-81`）。**这五项对 859.18 完全没有作用。**
- **反向作用**：`hotWorkspace(1.18)` 增加 SRAM 需求，使可行性更难，不是收益。
- **计数器错觉**：`q.phases / q.requests` 被 `phaseFusionFactor` 除，但 `q.duration` 在 `R.collective` 内已按原始 phase 数算完。所以报告里的"phases 510"是**标签**，不是已建模的成本下降；phase fusion 的时间收益全部来自 `hotPhaseDuration = 0.55` 这一个乘数。

**GAIN 贡献估算**：算力侧去掉 159.6 µs（939.34 → 779.73），通信侧另需反推约 165–170 µs（`hotPhaseDuration`/`hierDuration`/`remoteDuration` 只改 `q.duration` 不改任何 `timing` 字段）。合计 raw 从 ≈1250–1330 µs 降到 994.79 µs：

```
GAIN = 1.0 时 tps ≈ 1e6/(1250×1.17) … 1e6/(1300×1.17) ≈ 658 … 684
报告值 859.18
GAIN 贡献份额 ≈ 15%–25%（约 170 TPS）
```

该估算为解析推导（无法执行全 1.0 消融），已在文中标明。**仓库目前没有任何地方给出 "GAIN=1.0 基线" 或单因子弹性**，这是 859.18 唯一的诚实置信区间来源，也是 `B-003` 最该先交付的中间产物。

### 6.3 报告时间账的读者陷阱

`reports/rdma/k3_rdma_final_tuning_report.html` §3 的 `services` 表逐项相加为 **1167.18 µs**，大于 `rawUs = 994.79 µs`。原因是算力侧 GAIN 只改 `o.duration` 不改 `o.timing`，因此 `services` 与 `computeUs/commUs` **不是同一口径，不可相加**。报告未说明这一点，容易被读成直接的延迟分解。

时间项：kernel 483.55、localTma 326.91、reduce 56.94、dieLink 51.28、launch 20.67、memoryTransport 198.12、tpReduce 1.66、cardLocal 28.05、portTail 0 µs。

---

## 7. P0 级问题：会产生错误结论

### 7.1 `P0` 与 `P1` 对 TPS 指标没有影响（治理规则不可执行）

因 §5.1 事实 2，所有 18 个槽位都是带宽受限，绑定项 `bytes × target / effectiveBytesPerSecond` **不含 core peak**。实测确认：`directional_tps_scorecard.json` 中 P0 K3/TP8/MC320 与 P1 K3/TP8/MC320 **逐位相同**（`257.93623504903707`），尽管两者的 `effectiveFlopsPerSecond` 相差一倍（1.07e15 vs 5.35e14）。

后果：

1. `tps_observation_matrix.json` 全部 18 行标 `P0`，而 scorecard 的 P1 行数值相同 → 看板的 "Profile = P0" 列**不可falsify**；
2. `00_CURRENT_STATE.md`"P1 的性能回归结果不能直接宣称为 P0"与 `AGENT_METRICS_MATRIX.md` §1.1 的规则，在 TPS 上**无法执行**；
3. Gate 项 `p0P1DistinctResources` 证明的是**峰值不同**，不是**结果不同**；
4. `data/workload/multi_model_tp_matrix.json:10` 把九个 caseId 的 `physicalProfile` 声明为 `P1-compact-executable`，而矩阵把它们实例化为 `P0`（并由 `tests/test_tps_observation_matrix.js:28` 硬断言）——矩阵覆盖了 case 自身声明的 profile，同时断言 `caseId` 归属。

建议：要么让 P0/P1 在绑定项上真正区分（例如把 `utilization`/`dutyCycle` 设为 profile 属性），要么在看板上明确"该指标与 physical profile 无关"。

### 7.2 `989.74` 高于权威值 `859.18`，却未标记废弃

| 变体 | TPS | raw µs | 提交时间 | 测试断言 |
|---|---:|---:|---|---|
| optimized | 769.11 | 1111.29 | 09-21 | `phases<879`, `memoryTransport<344` |
| joint | 846.37 | 1009.85 | 09-21 | `memoryTransport<250` |
| localport | 853.50 | 1001.40 | 09-21 | `localTma<281.36` |
| kernel fusion | 854.64 | 1000.07 | 09-21 | `tps>853.5` |
| **final tuning（权威）** | **859.18** | **994.79** | **09-23** | 硬绑定 `spec` |
| localport compete | 904.41 | 945.04 | 09-20 | `localTma<292.7` |
| **tile pipeline** | **989.74** | **863.56** | 09-21 | `rawUs<900` |

`989.74` 比权威值高 **15.2%**，raw 863.56 µs 离 854.70 预算只差 8.86 µs。`src/rdma/k3_rdma_tile_pipeline_model.js` 有两个实质缺陷：

1. **免费带宽**：`mapped()` 直接把 `sramWriteTBs × 1.70 × 1.55`、`sramReadTBs × 1.18 + 0.18 × write`，且**从不调用** `chargeSharedPortCost`（该函数只存在于 final tuning 模型中）。端口放大的面积/功耗成本未被计入 die/card 限值。
2. **重复键字面量**：`OPT` 中 `reduceStartThreshold:.25` 与稍后 `.5` 同时出现，后者静默覆盖前者。而 final tuning 模型恰为**同一 bug 类**写了注释并加了守卫（`tests/test_k3_rdma_final_tuning.js:9-12` 断言 `OPT` 无重复键）——**守卫不覆盖兄弟文件**。

`ADR-004`（2026-09-23 更新）已认定"原 4 L + 4 H 候选的 998.81 TPS 不再复现，因为其中约 140 µs 的收益来自无成本的端口放大和重复的 launch 折扣"。`989.74` 与该被撤回的点高度同源（同为 09-20/09-21 时代、同 4L+4H/44MiB 候选、同一类免费放大），但**没有被同一处撤回**。

**该缺陷是族级而非孤例。** 逐一检查七个变体模型的 `OPT` 与 `mapped()`：

| 变体模型 | write 放大 | TMA 放大 | read 放大 | 是否计费端口成本 |
|---|---|---|---|---|
| `k3_rdma_final_tuning_model.js` | 1.70 | 1.55 | 1.18 + 0.18w | **是** |
| `k3_rdma_tile_pipeline_model.js` | 1.70 | 1.55 | 1.18 + 0.18w | 否 |
| `k3_rdma_localport_compete_model.js` | 1.70 | 1.55 | 1.18 + 0.18w | 否 |
| `k3_rdma_localport_model.js` | 1.45 | 1.30 | 1.08 | 否 |
| `k3_rdma_kernel_fusion_model.js` | 1.45 | 1.30 | 1.08 | 否 |
| `k3_rdma_joint_optimized_model.js` | 1.35 | 1.15 | — | 否 |
| `k3_rdma_optimized_model.js` | 0.75（降额） | — | — | 否 |

**七个变体中六个在无成本地抬高 SRAM 端口带宽**，其中 `989.74` 与 `904.41` 用的放大倍数与 final tuning 相同，却没有 final tuning 的计费。

### 7.3 五个已废弃/半废弃 runner 会覆盖现行 Gate 证据

- `models/detailed_run.js`：顶部标 DEPRECATED，但**仍可执行**，且会 `write()` 覆盖 `data/detailed/detailed_architecture_run.json`（Q-Gate 的证据载体）、`data/governance/gate_status.json` 与一份旧 runId 的报告。其内部 `rooflineBound` 判断为反向逻辑（`roof < intensity × bandwidth ? 'bandwidth' : 'compute'`，因 `roof = Math.min(...)` 该条件恒为 false，即所有算子被标为 `compute`）。
- `models/direction/run_directional_tps.js`：同样标 DEPRECATED，会覆盖 `data/direction/directional_tps_scorecard.json` 与 `data/governance/candidate_register.json`。

两者**都只有注释警示，没有抛错守卫**。任何一次误操作都会把发布基线换回旧 runId 的产物（且必须靠集成测试才发现）。

---

## 8. P1 级问题

### 8.1 文档对同一口径给出互相矛盾的现行陈述

| 冲突 | 一方 | 另一方 | 状态 |
|---|---|---|---|
| **raw 预算分账** | `01_SYSTEM_ARCHITECTURE.md:118-125` 列 390/250/115/55/20 µs 表，含"MC/DMA 暴露等待 55 µs" | `HIGH_LEVEL_ARCHITECTURE.md:559` 明确"不再使用按 390/250/115/55/20 µs 拆开的旧分账…那组分账没有对应到 MC 读取、预取缓冲和 all-reduce 次数" | 两份都未标作废 |
| **SRAM 峰值** | `00_CURRENT_STATE.md:97-103` 仍写 122.20 MiB 峰值 / 122.40 MiB window（`0.85 × 0.75`），文件版本标 2026-09-23 | `spec/k3_mc_baseline.json:165-171` 为 163.2 window / 162.94 峰值（只有 0.85，无 0.75） | 相差 40.7 MiB，旧值仍在"当前状态"名下 |
| **同文件内 Local SRAM** | 同上节写 "Local SRAM 20 MiB/Die" | 同文件 `:54` 写 "2 MiB/Core，64 MiB/Die" | 自相矛盾 |
| **1050 的定义** | `DECISIONS.md:8` 记门槛为"**建议**"，`AGENT_WORKSTREAM_PLAN.md:15` 用 `>=1050` 作签核门槛 | `src/core/k3_compute_node.js:21` `const TARGET = 1050`（把门槛称作目标）；整个 RDMA/search 家族只写 `target: 1000`、**从不提 1050**；`HIGH_LEVEL_ARCHITECTURE.md:564` 又把 1050 当"达标"判据 | 五种用法并存 |
| **1000 的地位** | `model_profiles.json:7`、`DECISIONS.md:6` 记为 `FROZEN` 目标 | `11_PLAN_AND_DELIVERABLES.md:21` 把"明确 1000 是最低值还是发布值"列为**未完成的 P0 任务** | 目标已冻结但定义未决 |
| **P1 规格** | `models/planning/resource_profiles.js` 从 `k3_mc_baseline.json#computeDieCandidate` 派生 P1 = 24 L + 8 H @ 1.0 GHz | `hardware_resource_contract.json:29` 写 P1 = "4L+4H, 1.2 GHz"；`AGENT_METRICS_MATRIX.md:15,134,166`、`OPEN_ISSUES.md:12`、`12_7_RETICLE…:73-74` 同样写 4L+4H | 契约文本滞后于机器 profile |
| **第三种 P1 形状** | — | `tests/test_k3_architecture_search.js:7` 固定 `totalMiB 96`、`lTF 32.768`/`hTF 262.144`（= P0 8L+8H 单 die 口径） | 与上述两种都不符 |
| **卡内拓扑** | `06_MULTIDIE_AND_SCALEOUT.md:13-21` 自述存在三种描述（4×2 mesh / 双向 ring / 4+4 hierarchy），"三者必须统一" | `ADR-008` 状态 `OPEN` | 已知冲突，未闭合 |
| **SRAM 容量池** | `reports/sram/sram_architecture_capacity.md` 建议 256（可重分配）/ 288（固定）/ 320 MiB per card | `spec/k3_mc_baseline.json:168` 共享 SRAM 物理 192 MiB/card | 该报告自己也在 §7 标记为未闭合 |

### 8.2 溯源绑定与既定要求不符

`data/analysis/agent_catalog_interaction_protocol.json:28` 的 `artifactEnvelopeRequired` 把 `runId` 列为**必填**字段，`18_AGENT_CATALOG_AND_INTERACTION_PROTOCOL.md:47-72` 给出完整 envelope 定义。但实际：

- `runId` 在 `data/**.json` 中**只出现于** `data/detailed/formal_event_replay.json`（以及一份 schema 清单）。
- 因此平面 B/C/D/E 的全部 TPS 数字都**没有 runId 绑定**：`data/rdma/*_results.json`（8 个）、`data/search/*.json`（2 个）、`data/sram/k3_operator_sram_tps_results.json`、`data/sram/sram_tps_architecture_analysis.json`（后两者连 `inputHash` 都没有）。
- `docs/design/spec/k3_mc_baseline.json` 承载权威的 533.94/859.18，同样无 `runId`，只靠 `tests/test_design_baseline.js` 与 `directional_tps_scorecard.json:26` 的 `inputHashes.mcSpec` 间接绑定。

### 8.3 看板的 RDMA 数字不受新鲜度保护

`reports/dashboard/architecture_global_dashboard.html` 的 `dashboard-source-hashes` 列了 10 个文件并有测试反查（`tests/test_planning_evidence_dashboard.js:43-48`），**但不包含 `k3_mc_baseline.json`**。而该看板的散文里直接注入 `533.94 / 859.18`（由 `scripts/generate_global_dashboard.js` 从 `mcBaseline.modelResults` 插值）。结果：18 槽位表受哈希保护，RDMA 引用数字不受。

### 8.4 Q-Gate 检查项在 UI 上语义反转

`evaluateQuantificationGate` 计算 `exploratoryOnly: detail.runMode !== 'FORMAL_QUANTIFICATION'`，而通过条件要求 `detail.runMode === 'FORMAL_QUANTIFICATION'`。因此当运行确实是规划模式时 `exploratoryOnly = true`，看板以绿色 **PASS** 渲染该行——**一个实质阻断条件被显示为通过**。建议把该项改为正向命名（如 `formalRunMode`）或在 UI 上反色渲染。

### 8.5 `direction_feedback.json` 的字段命名与产出者

- `optimisticGapFactor` 实际为 **目标 ÷ 上界**（K3 `0.4846 = 1000/2063.49`，GLM `0.5242`，DS `0.6110`），是小于 1 的比率，不是"gap"。命名会引导读者得出相反结论。
- 该产物的 `status` 为 `OPEN`，而其上游 D-Gate 已 `PASS`。
- 它由 `scripts/generate_global_dashboard.js`（一个展示层脚本）写入 `data/governance/`——**生成器写治理状态**是耦合异味，与 AGENTS.md"不直接编辑 runner 生成的 JSON"的精神相悖。

### 8.6 `verification/` 目录没有 V&V 产物

`verification/README.md` 声明 V&V 独立维护 `verification/direction/` 与 `verification/detailed/`，并产出 gate report / regression report / report index / blocker list。实际 `find verification -type f` 只返回 `verification/README.md`。Q-Gate 的独立 V&V 依据（`VV-02`/`VV-03`）在仓库中不存在实体产物。

### 8.7 `.github/CODEOWNERS` 完全被注释

`AGENTS.md` §2 依赖"同一文件只有一个 owner"，但 CODEOWNERS 每一行都是注释（`# Replace placeholders…`），GitHub 不强制任何 ownership。CI 本身是有的（`npm test`，node 18，push/PR 到 main）。

---

## 9. P2/P3 级问题

1. **`bytes × 1.25` 无定义**：`models/resolve_architecture_blockers.js:88` 与 `models/formal_detailed_run.js:102` 的 `networkIntensity` 用了未命名的 1.25 系数（另一处 `k3_rdma_final_tuning` 的 1.25 无关）。不影响 gate（`rooflineBound` 用未修正的 `intensity`），但会随 ledger 流向读者。
2. **`ep` 写死**：`models/formal_detailed_run.js:89` 的 `ep: modelId === 'K3' ? 1 : 6` 不受任何契约校验。
3. **合成事件里的无出处常量**：`:154` tile 行数 `8 * 1024 * 1024`、`:161` 包大小 `64e3`、`:179-181` overlap `0.85/0.9`、stall `0.15`。当前无害（合成事件不驱动时延），但若 Q3–Q6 真接时序，必须先按 `GAIN` 的方式命名。
4. **同一计算两种状态标签**：`formal_detailed_run.js:117` 把 ledger 行标为 `MODEL_REPLAY_ESTIMATE`，而由同一管线导出的 observation 标为 `PLANNING_ESTIMATE`。
5. **`data/analysis/arithmetic_intensity_results.json` 不存在**：`16_ARITHMETIC_INTENSITY_AGENT.md` §3 把它列为主结果，仅有 contract 存在。规划管线的 Q2 实际替代了它。
6. **工作树 17 个文件的改动全是噪音**：逐文件规范化比对（去 CR、剥 BOM 后取 SHA）显示与其 HEAD 版本**完全一致**，改动是 LF→CRLF 与 BOM 漂移（HEAD 为 LF+BOM，工作树为 CRLF+BOM）。`data/analysis/architecture_stage_operating_model.json` 排版全变而语义相同。
7. **BOM 处理靠约定**：至少 8 处 `replace(/^﻿/,'')`，而 `scripts/generate_agent_org_detail.js:2` 就是裸 `JSON.parse` 未剥（当前因文件无 BOM 而侥幸通过）。根治办法是清掉仓库内 BOM，而不是继续加 `replace`。
8. **测试守卫的边界**：`tests/test_planning_evidence_dashboard.js:53` 断言看板**不得包含** `28.05×` 或 `167.06×`（旧的 Roofline 比值）。但这两个数字仍存在于已提交的 `reports/detailed/stage_b_detailed_run_20260921.md`（max compute ratio 28.05、max bandwidth ratio 167.06）中。

---

## 10. 必要的 MC 带宽反推（本评审新增）

由 §5.2 的字节账可直接给出冻结场景（K3、TP32、1000 TPS/usr）的带宽需求：

```
每 rank 有效带宽需求 = 5,200,436,512 B/token × 1000 TPS = 5.2004e12 B/s
raw（÷0.70 持续效率）                                  = 7.4292e12 B/s
每颗 MC（÷16）                                        = 464.3 GB/s/cube
```

对照 `ADR-011` 的档位网格：

| 档位 | 纯字节口径可达 TPS | 对 1000 目标 |
|---:|---:|---|
| 320（REFERENCE） | 689.18 | **不可能** |
| 400（GRID） | 861.48 | 不够 |
| 480（DEFAULT_SEARCH_CAP） | 1033.78 | 刚好越过 |
| 560（AGGRESSIVE） | 1206.07 | 有余量 |
| 640（STRETCH） | 1378.37 | 约 38% 余量 |

该推导与 `ADR-011` 把 480 定为"默认搜索上限"的选择高度吻合。**口径提醒**：这是无重叠的一阶下界，实际可达值还要扣除 compute/comm 串行与未建模的重读，因此 464 GB/s/cube 是**必要条件而非充分条件**。（RDMA 模拟在 MC320 给 533.94、MC640 给 859.18，均低于对应档位的纯带宽天花板，方向一致。）

这把 `B-002`"MC 档位未选定"从定性表述变成了一个定量分界：**320 档在字节需求上就不可能达到 1000 TPS**。

---

## 11. 测试体系评估

**设计良好的部分**：

- 规划槽位 TPS **从不断言字面量**，只断言重算恒等式（`obs.tpsPerUser == target/ratio`、`tps × e2e == 1e6`）与新鲜度哈希。这是正确做法。
- RDMA/搜索层则硬断言字面量（`test_design_baseline.js` 对 533.94/859.18 用 1e-9 容差）。两层的严格度不一致。
- `tests/test_k3_operator_sram_sim.js` 是全仓最强的物理测试：解析式 buffer 时序、93 层拓扑计数（24 Softmax / 69 Linear / 92 MoE / 92 router）、时间守恒（`rawUs = compute + comm + wait`）、字节守恒（depth=0 时 readBytes 等于强制读取量）、60 次完整运行。
- `tests/test_planning_evidence_dashboard.js` 的 mutation 断言（篡改输入必须被拒）是真正的验证测试。

**薄弱处**：

1. **七个 RDMA 变体测试只验"未被改动"，不验"有意义"**。共同结构是：`b.tps == max(rows)` + `|evaluate(b.x).tps − b.tps| < 1e-7` + 一个宽松单边界（如 `rawUs < 900`）。一个物理上无意义（例如免费端口带宽）的变体只要产物没被碰过就能全绿。`989.74` 正是这样通过的。
2. **`tests/test_design_baseline.js:63` 的 `stretch.tps > reference.tps × 1.5`**：实际比值 1.609，余量仅约 7%。MC 缩放特性稍有侵蚀即会失败，而该断言的本意只是"灵敏度未被意外改变"。
3. **`tests/test_arithmetic_intensity_agent.js:20` 把 `targetTimeUsPerToken` 固定为 1000**，把 §5.4 的口径混淆固化进测试。
4. **seed 覆盖缺失**：`tps_observation_matrix.json` 全部 `seed: null`，`dimensions` 列了 seed 但 `requiredCoverage` 没有，测试只检查 `source/sourceSelector/manifestHash/runId/boundingOperatorId`（`tests/test_tps_observation_matrix.js:32-36`）**不检查 seed**。而 `13_MULTI_MODEL_ARCHITECTURE.md:466` 声明 `seed = 11, 23, 47, 89, 131`，`AGENT_METRICS_MATRIX.md` 的 A10 要求 `3 × 3 × 2 × 5 = 90` 个结果。实际产物是**单点、无 seed 的 18 行**。

---

## 12. 建议行动顺序

按"先消除会误导外部读者的项，再补口径，最后才是新模型"排序。

### 第一批：一天内可完成，纯清理（零物理风险）

1. **给 `models/detailed_run.js` 与 `models/direction/run_directional_tps.js` 加抛错守卫**或直接删除。二者能覆盖现行的 Q-Gate 证据与候选注册表，且 `detailed_run.js` 的 `rooflineBound` 逻辑是反向的。这是唯一"手滑即污染基线"的入口。
2. **处理 `989.74` 变体**：删除 `src/rdma/k3_rdma_tile_pipeline_*.js` 与对应产物，或在文件头加抛错守卫并注明被 `ADR-004` 取代。同时把"无重复 OPT 键"守卫从 final tuning 扩展为遍历 `src/rdma/*_model.js`，让该类 bug 无法在守卫之外复发。
3. **给六个无成本端口放大的变体统一标注**：在各自的 `OPT` 旁注明"带宽放大未计费，指标不可与 final tuning 比较"，或直接补上 `chargeSharedPortCost`。
4. **加 `.gitattributes`**（`* text=auto eol=lf`）并丢弃当前 17 个文件的 CRLF/BOM 噪音；在此之前不要改源码，否则真实改动会淹在 177 行假 diff 里。
5. **`bytes × 1.25` 定性**：命名进常量表或删除该字段。

### 第二批：口径对齐（需要决策，建议一周内）

6. **规划上界补一列 `Σ`-口径下界**（约 5 行计算），并在看板写明其与 `max`-口径的 ~1.50× 关系。这能让"K3@MC320/TP32 是否过 1000"不再依赖口径歧义。
7. **P0/P1 口径决策**（§7.1）：要么让绑定项真正区分 profile，要么在看板声明该指标与 profile 无关，并相应调整 `p0P1DistinctResources` 的语义。
8. **冻结 1000/1050 的定义**（最低值 vs 发布值），登载 1050 对应的 raw 预算 814.00 µs，统一 `k3_compute_node.js` 的 `TARGET` 命名。
9. **清理三处互相矛盾的现行陈述**：`01_SYSTEM_ARCHITECTURE.md` 的分账表、`00_CURRENT_STATE.md` §4.1 的 122.20 MiB、`hardware_resource_contract.json` 的 P1 规格。标注或改写，不要留两份都像现行的版本。
10. **修正 `direction_feedback.json` 的 `optimisticGapFactor` 命名**，并考虑把写入动作从 dashboard 生成器移出。
11. **看板 hash 列表加入 `k3_mc_baseline.json`**，使 RDMA 引用数字也受新鲜度保护。
12. **修正 `exploratoryOnly` 的 UI 语义反转**（§8.4）。

### 第三批：实质补强（需要工程投入）

13. **发布 GAIN 敏感度分解**：给出"全部 GAIN = 1.0"的 TPS 基线，以及单因子 ±10% 的 TPS 弹性。这是 `B-003` 的可交付中间产物，也是 859.18 唯一诚实的置信区间。
14. **`Σ`-口径上界做成 gate 条件**：`16_ARITHMETIC_INTENSITY_AGENT.md` §4.3 已经写明"如果 bytes 约束给出的时间大于目标时间，则应标记 `bandwidth_blocked`"——规划管线从未实现该条。
15. **建立 Stage A ↔ Stage B 差异归因**（`13_MULTI_MODEL_ARCHITECTURE.md` §B4 要求，且当前 1.93×/2.40× 无任何解释），并把 `MR-010`/该归因提升为显式 blocker。
16. **补 `verification/` 实体产物**或修正 `verification/README.md` 的声明；启用 `CODEOWNERS`。
17. **修复 seed 覆盖**：18 槽位至少补上声明过的 5 个 seed，或把 `requiredCoverage` 与文档要求对齐并显式登记差距。

### 不建议现在做的事

- 继续扩大规划搜索维度（`D2-D6` 缺的面积/功耗/collective 轴）。在 `Σ`-口径、P0/P1 语义、MC 档位三件事未定之前，扩大搜索只会增加不可解释的数字。
- 把 `SYNTHETIC_BOTTLENECK_BOUND` 的数值用于任何选址或规格决策。

---

## 13. 未验证与超出本次评审范围

以下内容本次**未验证**，不应从本评审推断：

1. **平面 E（`1260.79 … 1294.84`）的聚合口径**：`data/sram/sram_tps_architecture_analysis.json` 的 `stage ≈ 0.66`、`compute 0.17`、`coll 0.48`、`tps 1260–1294` 之间的换算关系（是否 per-layer、是否已含裕量、`S` 是何单位）未在字段或注释中说明；其 `source` 字段指向 `docs/sram/k3_sram_tps_model.html`，该路径**未确认存在**。该平面的数值不应被引用，直到口径被文档化。
2. **`GAIN` 各因子的量级是否合理**：本评审确认了它们的**结构性暴露**（哪些生效、哪些为零），未评估其物理可信度。这需要 kernel trace 或 RTL。
3. **MC320/MC640 档位的可实现性**：§10 只给出字节需求的必要下界，不构成可实现性结论。
4. **规划上界与 RDMA 模拟差距的完整归因**：本评审量化了差距（1.93×/2.40×）并指出主因（单向字节计数、无串行化、无 collective 延迟），但未做逐步拆解。
5. **`getGitStatus` 快照之外的 git 语义**：未检查分支保护、远端 CI 是否真的通过（看板自己声明"本页不声明远端 CI 已通过"）。
6. **P0 物理实现的任何结论**：`k3_7r_package_baseline.json` 的 `profiles.note` 明确说 P0 的 8L+8H/96MiB tile 与 PPA 模型尚未实现。

---

## 14. 一页速览

**可以对外说的**：

> 规划链路自洽；Gate 由独立 validator 计算且有 mutation 测试；陈旧产物有哈希防护；K3 形状单一来源；经验因子全部命名并挂 blocker；两条管线的字节账互相印证到 2.2%；所有未确认配置都标了 `UNVERIFIED`，且从未谎称达标。

**尚不能对外说的**：

> 任何 TPS 数值已达标或接近达标；任何 TPS 数值可直接跨管线比较；P0/P1 两种物理 profile 已被区分验证；18 槽位有 seed 覆盖或时序证据。

**最该先做的一件事**：给五个已废弃 runner 加抛错守卫——它们是唯一能静默覆写现行 Gate 证据的入口。

---

## 附录 A：关键数值复算对照

| 量 | 复算 | 结果 |
|---|---|---|
| raw 预算 | `1e6/1000/1.17` | `854.7008547008547` ✓ |
| 1050 对应 raw 预算 | `1e6/1050/1.17` | `814.00` µs |
| e2e（MC640） | `994.7898021483887 × 1.17` | `1163.9040685136147` ✓ |
| TPS（MC640） | `1e6/1163.9040685136147` | `859.1773386247104` ✓ |
| P1 单 die 峰值 | `(1.96608e14 + 1.048576e15)/8/1e12` | `155.648` TFLOPS = `bf16DenseTflops` ✓ |
| K3 每 rank 字节 | `166413968384/32` | `5,200,436,512` B |
| 字节对账 | `5200436512/5312958547.199947` | `0.97882` = `bytesRatioDerivedOverCalibrated` ✓ |
| FLOP 对账 | `1755347919872/1755347919872` | `1.000` ✓ |
| `Σ`-口径下界（MC320） | `3.584e12/5200436512 × 1000` | `689.18` TPS |
| 发布值/下界 | `1031.7449/689.18` | `1.497×` |
| MC 带宽反推 | `5200436512×1000/0.7/16` | `464.3` GB/s/cube |
| `optimisticGapFactor` | `1000/2063.4898803922965` | `0.4846158` ✓ |

## 附录 B：TPS 数值全集（含输入条件）

| 数值 | 文件 | 模型 | TP | MC | profile | runId | 标签 | 产出者 |
|---|---:|---|---:|---|---|---|:--:|---|
| 257.94 | `data/workload/tps_observation_matrix.json` | K3 | 8 | MC320 | P0 | 有 | PLANNING_ESTIMATE | `models/formal_detailed_run.js` |
| 515.87 | 同上 | K3 | 8/16 | MC640/MC320 | P0 | 有 | 同上 | 同上 |
| 1031.74 | 同上 | K3 | 16/32 | MC640/MC320 | P0 | 有 | 同上 | 同上 |
| 2063.49 | 同上 | K3 | 32 | MC640 | P0 | 有 | 同上 | 同上 |
| 238.45 / 476.89 / 953.79 / 1907.57 | 同上 | GLM-5.2 | 8/16/32 | 两档 | P0 | 有 | 同上 | 同上 |
| 204.58 / 409.16 / 818.33 / 1636.66 | 同上 | DeepSeek-V4-Pro | 8/16/32 | 两档 | P0 | 有 | 同上 | 同上 |
| 533.94 | `spec/k3_mc_baseline.json#modelResults.referenceMc320GBs` | K3 | 32 | MC320 | P1 | **无** | 曲线模型结果 | `src/rdma/k3_rdma_final_tuning_search.js` |
| 859.18 | 同上 `stretchMc640GBs` | K3 | 32 | MC640 | P1 | **无** | 同上 | 同上 |
| 600.93 | `reports/rdma/*.html` | K3 | 32 | — | — | **无** | 历史基线 | 早期模型 |
| 769.11 | `data/rdma/k3_rdma_optimized_results.json` | K3 | 32 | — | — | **无** | 历史 | `k3_rdma_optimized_search.js` |
| 846.37 | `data/rdma/k3_rdma_joint_results.json` | K3 | 32 | — | — | **无** | 历史 | `k3_rdma_joint_search.js` |
| 853.50 / 854.64 / 904.41 | `data/rdma/k3_rdma_{localport,kernel_fusion,localport_compete}_results.json` | K3 | 32 | — | — | **无** | 历史 | 对应 search |
| **989.74** | `data/rdma/k3_rdma_tile_pipeline_results.json` | K3 | 32 | — | — | **无** | 历史（**与 ADR-004 撤回点同源**） | `k3_rdma_tile_pipeline_search.js` |
| 525.21 | `data/search/k3_b1_1000_results.json` | K3 | 32 | — | — | **无** | 搜索最优（达标数 0） | `src/search/k3_b1_1000_search.js` |
| 339.90 | 同上 | K3 | 32 | — | — | **无** | 原域最优 | 同上 |
| 1260.79 … 1294.84 | `data/sram/sram_tps_architecture_analysis.json` | K3 | 32 | — | — | **无** | 敏感度原始输出（口径未文档化） | 本地页面模型 |


## 附录 C：2026-09-25 跟进（ADR-0006）

本评审正文保留 2026-09-24 的原始记录，不改写。以下条目已在 2026-09-25 处理，数值以现行产物为准：

| 评审条目 | 处理 | 现行产物 |
|---|---|---|
| §4 / §5 平面 A 取最慢单算子的 `max` 上界，与平面 B 相差 1.9–2.4× | 改为规划 token 时间：`raw = max(访存 × kMemory, 计算 × kCompute + 集合通信 × τ)`，×1.17；kMemory 1.1553、kCompute 1.4139 在 K3 P1/MC640/TP32 详细点（1101.77）上标定，规划回放 1102.41；MC320 样本外 551.21 对 586.46（0.94） | `models/planning/token_time.js`、`planning_operator_workload.json#/calibration` |
| 附录 B 的 GLM-5.2 / DeepSeek-V4-Pro 数值（按 K3 比例缩放） | GLM-5.2 改为 `BLOCKED_CONFIG`，无 TPS；DeepSeek-V4-Pro 由 manifest `shape` 推导，公布字段以外全部 `ASSUMPTION`，MTP 不计入，无 EP dispatch 行 | `formal_model_manifests.json`、`tps_observation_matrix.json` |
| K3 规划 KV 按 BF16 1152 B/token/层 | 改为 FP8 FlashMLA 656 B，与详细模型一致 | `planning_operator_workload.json#/provenance/K3` |
| §7.3 两个 DEPRECATED runner 可覆盖 Gate 证据 | 已删除 | `models/detailed_run.js`、`models/direction/run_directional_tps.js`（不再存在） |
| §9-2 `ep` 写死 | 删除；槽位只有 TP | `models/formal_detailed_run.js` |
| §8.5 `optimisticGapFactor` 命名 | 改为 `gapFactor`（目标 ÷ 规划估算），BLOCKED_CONFIG 模型为 null | `direction_feedback.json` |

后果：GLM-5.2 缺配置使 D-Gate 为 `BLOCKED_MODEL_CONFIG_INCOMPLETE`；Stage B 以 `EXPLORATORY_AFTER_BLOCKED_D_GATE` 运行，Q-Gate 仍阻塞。

同日追加（ADR-0007）：GLM-5.2 改由公开 HF `config.json` 推导（含 MTP 总参数 753.3B 对公布 753B），不再 `BLOCKED_CONFIG`；D-Gate 按现有规则为 `PASS`，Stage B 转 `PLANNING_QUANTIFICATION`，Q-Gate 仍阻塞。
---

*本评审为只读静态审查的产物；所有结论均可由附录 A 的复算与正文引用的文件位置独立验证。未修改任何被评审文件。*
