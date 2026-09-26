# 上手指引

写给第一次接触本仓库的人（或 agent）。读完能做到：跑通模型、看懂发布点的数字从哪来、自己做一次"改一个参数看 TPS/usr 怎么变"的实验、知道正式改动该走什么流程。

仓库是什么、为什么这样组织，见顶层 [`README.md`](../README.md)；这里只讲怎么用。

## 1. 第一个小时

### 1.1 环境

只需要 Node.js 18 或更高版本，没有第三方依赖，不需要 `npm install`。

```sh
git clone https://github.com/xqdan/xihu.git && cd xihu
npm test            # 24 个测试文件，全部应输出 PASS；约一分钟
```

`npm test` 失败说明你的工作区和仓库基线不一致，先解决它再做别的。

### 1.2 看两份生成好的报告

不用跑任何东西，直接在浏览器里打开：

| 文件 | 看什么 |
|---|---|
| [`out/rdma/k3_rdma_final_tuning_report.html`](../out/rdma/k3_rdma_final_tuning_report.html) | K3 发布点（1101.77 TPS/usr）：时间账、开了哪些优化、硬件规格 |
| [`out/dashboard/architecture_global_dashboard.html`](../out/dashboard/architecture_global_dashboard.html) | 三个模型的规划估算、Gate 状态、未关闭的阻塞项 |

### 1.3 按这个顺序读文档

1. [`00_CURRENT_STATE.md`](architecture/00_CURRENT_STATE.md)：现在的基线、证据等级、阻塞项。
2. [`21_TPS_DESIGN_BASELINE.md`](architecture/21_TPS_DESIGN_BASELINE.md)：1101.77 这个数是怎么一项项算出来的，每个软件机制关掉会掉到多少。
3. [`OPEN_ISSUES.md`](architecture/OPEN_ISSUES.md)：`B-*` 阻塞项和 `O-*` 未决问题，大部分工作都从这里领。
4. [`AGENTS.md`](../AGENTS.md)：团队划分和目录规则。
5. 你所在团队的 README：[hardware](../teams/hardware/README.md) · [software](../teams/software/README.md) · [model](../teams/model/README.md) · [council](../teams/council/README.md) · [vv](../teams/vv/README.md)。
6. 需要时查 [ADR 索引](../teams/council/adr/README.md)：某个设定为什么是现在这样。

## 2. 必须先弄清的几个口径

这个仓库里大多数误读都来自口径混用。引用任何数字前先确认下面几点。

| 口径 | 说明 |
|---|---|
| **目标 1000 vs 门槛 1050** | 1000 TPS/usr 是目标（ADR-0009）；1050 是架构冻结门槛。两者的 raw 预算不同：1000 对应 854.70 µs，1050 对应 814.00 µs。仓库里现成的余量（如 raw 余量 78.95 µs、τ 盈亏点约 1.35 µs）大多是按 1000 算的，不能当作 1050 的余量。 |
| **raw 与 e2e** | `TPS/usr = 1e6 / (raw × 1.17)`。raw 是模型算出的单 token 时间，1.17 是工程余量系数（engineeringMargin）。 |
| **peak 与 sustained** | MC 档位（320/480/640 GB/s/颗）是名义值；模型内部乘以 0.7 得到 sustained。ADR-0019 规定 480 是可制造默认上限，640 是 STRETCH 档，发布点用的是 640。 |
| **detailed 与 planning** | 详细模型（`integration/detailed/`）产生发布点；规划模型（`integration/planning/token_time.js`）只在 K3 MC640 这一点上与之对齐，用来估算其他模型和配置。两者的数字不能混着用。 |
| **证据等级** | 每个数字都带等级：`ASSUMPTION`、`MODEL`、`PLANNING_ESTIMATE`、`MODEL_OBSERVED`、`SILICON_OBSERVED` 等，定义见 [`14_TPS_OBSERVATION_METRICS.md`](architecture/14_TPS_OBSERVATION_METRICS.md)。当前所有 TPS 数字都是 `MODEL` 或更低，不是产品承诺。 |

## 3. 数字在哪里

| 想找 | 去哪里 |
|---|---|
| 硬件规格（唯一来源） | [`teams/hardware/inputs/k3_mc_baseline.json`](../teams/hardware/inputs/k3_mc_baseline.json) |
| K3 模型形状（唯一来源） | [`teams/model/src/design_engine.js`](../teams/model/src/design_engine.js) 的 preset |
| 软件优化开关 `OPT`、经验因子 `GAIN`（全为 1） | [`integration/detailed/k3_rdma_final_tuning_model.js`](../integration/detailed/k3_rdma_final_tuning_model.js) |
| 硬件工艺与效率系数（`TECH`：matrixUtil、mcUtil 等） | [`integration/detailed/k3_architecture_search.js`](../integration/detailed/k3_architecture_search.js) |
| 面积、功耗系数 | [`integration/detailed/k3_physical_basis.js`](../integration/detailed/k3_physical_basis.js) |
| 发布点（搜索结果） | `out/rdma/k3_rdma_final_tuning_results.json` 的 `search.best` |
| 各团队对外承诺 | `teams/<team>/contract.json`，合成后在 `out/contracts/` |
| Gate 状态 | `out/governance/`，由 [`integration/governance/evaluate_gates.js`](../integration/governance/evaluate_gates.js) 计算 |

文档只引用这些来源，不另行定义数值。发现文档和来源不一致时，以来源为准，并提 issue 或修文档。

## 4. 做一次"如果……会怎样"的实验

最快的上手方式：在内存里改一个参数，重算发布点，不改任何文件。在仓库根目录运行：

```sh
node - <<'EOF'
const O = require('./integration/detailed/k3_rdma_final_tuning_model.js');
const x = require('./out/rdma/k3_rdma_final_tuning_results.json').search.best.x;  // 发布点的硬件/映射变量
const show = (name, r) => console.log(name.padEnd(16),
  r.feasible === false ? 'infeasible' : `${r.tps.toFixed(2)} TPS/usr, raw ${r.rawUs.toFixed(2)} µs`);
const withOpt = (patch, fn) => { const saved = {...O.OPT}; Object.assign(O.OPT, patch); try { return fn(); } finally { Object.assign(O.OPT, saved); } };

show('published', O.evaluate(x));
show('mcGBs=480', O.evaluate({...x, mcGBs: 480}));                  // 改硬件变量：换到可制造默认档
show('tauUs=1.3', withOpt({tauUs: 1.3}, () => O.evaluate(x)));      // 改集合通信单次成本
show('tmaLane=off', withOpt({tmaLane: false}, () => O.evaluate(x))); // 关掉一个软件机制
EOF
```

应得到：

```text
published        1101.77 TPS/usr, raw 775.75 µs
mcGBs=480        853.44 TPS/usr, raw 1001.48 µs
tauUs=1.3        1025.83 TPS/usr, raw 833.18 µs
tmaLane=off      984.20 TPS/usr, raw 868.42 µs
```

- 硬件变量在 `x` 里（`nL`、`nH`、`ghz`、`lMiB`、`sharedMiB`、`mcGBs`、`kvTile`、`depth` 等），用 `{...x, key: value}` 改。
- 软件开关在 `O.OPT` 里，用上面的 `withOpt` 临时改，结束后自动恢复。
- 这是**只换一个变量、其余不变**的回放，不是在新约束下重新搜索。例如 853.44 是 MC480 下的回放值，不是 MC480 下能达到的最优值；要得到后者需要重新跑搜索。
- 仓库已经算好的单项回退和敏感性表，在 `k3_mc_baseline.json#tpsDesign`（由 [`k3_tps_design_baseline.js`](../integration/detailed/k3_tps_design_baseline.js) 生成），先查那里，不必自己重算。

## 5. 按专业领域上手

三个领域共用同一个详细模型，区别在于你的专业知识对应到模型里的哪些变量。下面每一节都分四块：你熟悉的东西在哪、它对应模型里的哪个变量、一个可以直接运行的实验、现在有哪些活可以接。

所有实验都在仓库根目录用 `node - <<'EOF' … EOF` 运行，和第 4 节一样只改内存、不改文件。先把下面三行放在脚本开头：

```js
const O = require('./integration/detailed/k3_rdma_final_tuning_model.js');
const x = require('./out/rdma/k3_rdma_final_tuning_results.json').search.best.x;
const f = r => r.feasible === false ? 'infeasible' : `${r.tps.toFixed(2)} TPS/usr, raw ${r.rawUs.toFixed(2)} µs`;
```

每个领域都要先读的一段：`21_TPS_DESIGN_BASELINE.md` 的第 5 节（逐项回退）和第 8 节（变更控制）。

### 5.1 硬件

**你熟悉的东西在哪。**

- 单元设计文档在 [`teams/hardware/docs/`](../teams/hardware/docs/)：
  - 02 AI Core
  - 03 TMA/SRAM
  - 04 MC
  - 05 NoC
  - 06 多 Die/Scale-out
  - 07 Collective/RDMA
  - 08 调度器/PMU
  - 09 封装/功耗/RAS
- 各 agent 的分工（HW-01 到 HW-06）见 [`teams/hardware/README.md`](../teams/hardware/README.md)。
- 唯一的硬件规格是 [`k3_mc_baseline.json`](../teams/hardware/inputs/k3_mc_baseline.json)。它是混合文件：一部分字段手工维护，另一部分由 `baseline:sync` 重写，哪些字段属于后者见 hardware README。

**你的参数在模型里叫什么。** 硬件量分散在三个地方：

- 搜索向量 `x`：搜索器选出的微架构参数。
- `TECH`：效率和工艺系数，在 `k3_architecture_search.js`。
- `BASIS`/`PROCESS`：面积和功耗基准，在 `k3_physical_basis.js`。

| 单元 | `x` 中的变量 | `TECH` 与其他系数 |
|---|---|---|
| AI Core | `nL`、`nH`、`lRows`/`lCols`、`hRows`/`hCols`、`lEngines`/`hEngines`、`vectorLanes`、`ghz`（固定为 1.0） | `matrixUtil` 0.65、`vectorUtil` 0.35 |
| SRAM | `lMiB`、`hMiB`、`sharedMiB`、`lBanks`/`hBanks`、`bankBytes`、`sharedSlices` | `bankUtil` 0.75 |
| TMA | `tmaEngines`、`tmaBytes` | `tmaSetupCycles`；独立端口开关在 `OPT.tmaDedicatedPort`（O-007） |
| MC | `mcGBs`（320/480/640） | `mcUtil` 0.7，也就是 peak 到 sustained 的系数（O-001） |
| NoC | `nocBytes`、`nocLanes` | `nocUtil` 0.65、`routerCycles` |
| Die-to-Die | `ucieLanes`、`ucieGbps` | `ucieUtil` 0.8、`ucieHopUs` 0.025 |
| Scale-out | `rdmaLanes` | `rdmaUtil` 0.75、`rdmaStepUs` 0.14 |
| 集合通信 | — | `OPT.tauUs` 1.15。它是物理量，却放在 `OPT` 里，推导前提是 B-004/B-005（B-008） |

`O.evaluate(x)` 返回的 `r.p` 是物理侧结果：

- `dieArea`、`diePower`、`cardPower`、`packageArea`；
- 带宽包络，如 `mcDieGB`、`uciePortGB`、`rdmaCardGB`；
- `feasible`/`reasons`，给出违反了哪条面积、功耗或 shoreline 约束。

**实验：效率系数变化，以及"不涨 TPS 的面积"。**

```js
const A = require('./integration/detailed/k3_architecture_search.js');
const withTech = (patch, fn) => { const s = {...A.TECH}; Object.assign(A.TECH, patch); try { return fn(); } finally { Object.assign(A.TECH, s); } };
console.log('mcUtil=0.6     ', f(withTech({mcUtil: 0.6}, () => O.evaluate(x))));       // 961.50
console.log('matrixUtil=0.55', f(withTech({matrixUtil: 0.55}, () => O.evaluate(x))));  // 1064.26
console.log('sharedMiB=12   ', f(O.evaluate({...x, sharedMiB: 12})));                   // 1022.73
for (const s of [16, 24]) { const r = O.evaluate({...x, sharedMiB: s}), p = r.p;
  console.log(`sharedMiB=${s}`, r.tps.toFixed(2), 'TPS/usr, die', p.dieArea.toFixed(2), 'mm²,', p.diePower.toFixed(2), 'W'); }
// sharedMiB=16 1101.77 TPS/usr, die 373.71 mm², 286.22 W
// sharedMiB=24 1101.77 TPS/usr, die 381.64 mm², 286.94 W
```

从这组结果可以读出三点：

- sustained 效率从 0.7 降到 0.6，就会跌破 1000。0.7 至今没有来源（O-001），所以 MC 厂商给出的混合流量 sustained 值比名义档位更重要。
- shared SRAM 从 16 MiB 减到 12 MiB 会损失约 79 TPS/usr，加到 24 MiB 则只增加面积、TPS 不变。评估一个单元时，两个方向都要试。
- `hMiB` 这类变量在发布点附近可能完全不敏感。不敏感本身也是结论，应写进设计文档。

**可以接的活。**

- B-002：MC 档位和 sustained 效率。这是缺口最大的一项，MC480 回放只有 853.44。
- B-004/B-005：卡内与 TP32 拓扑，τ 的物理推导以它们为前提。
- B-006：频率、面积和功耗系数的回标，需要 SF4 PDK 和 MAC 宏的数据。
- O-001 到 O-008、O-015：各单元的可实现性问题，如 O-007 TMA 独立端口、O-015 液冷供电。

**规则。**

- 改规格数值要走 ADR（ADR-0005）。
- `TECH`、`BASIS`、搜索空间都在 `integration/detailed/`，由 Council 拥有。硬件团队提出数值和证据，PR 由 Council 审。
- 改动之后按第 6.1 节全量重新生成。
- 交付的证据要能把某个 `ASSUMPTION` 换成更高等级，而不是只再给一个估计值。

### 5.2 软件

**你熟悉的东西在哪。**

- 设计文档在 [`teams/software/docs/`](../teams/software/docs/)：
  - `KERNEL_SPEC`：2347 个非通信算子归成 8 个 kernel 族。
  - `COLLECTIVE_SCHEDULE`：393 次集合通信的构成与重叠。
  - `PRECISION_POLICY`：dtype 与取整点。
  - `MULTI_MODEL_LOWERING`：GLM/DS 的映射。
  - `COMPILER_RUNTIME_AND_FIRMWARE`：runtime、persistent decode、KV 分页。
- 各 agent 的分工（SW-01 到 SW-07）见 [`teams/software/README.md`](../teams/software/README.md)。
- 机制的语义说明在 `21_TPS_DESIGN_BASELINE.md` 第 4 节。

**你的策略在模型里叫什么。** 软件决策全部在 `O.OPT` 里，共 44 项，大致分为：

| 类别 | `OPT` 键 |
|---|---|
| 调度 | `commOverlap`、`tmaLane`、`kvPrefetch`（`'window'`/`'layer'`）、`dmaPreempt`、`launchBatching`、`launchScale`（0.45，未回标，B-003） |
| kernel 融合 | `attentionFusion`、`softmaxFusion`、`epilogueFusion`、`pvMerge`、`wupRouterFusion`、`moeTokenPacking` |
| 集合通信协议 | `tauUs`、`stripeKiB`、`oneWayUs`、`commitCycles`/`notifyCycles`/`ackCycles`、`commitBatchSize`/`ackBatchSize`、`phaseFusionFactor`、`epochs` |
| 归约层级 | `dieDirectReduce`、`dieGroupReduce`、`hierarchicalReduce`、`remoteDirectReduce`、`groupAck`、`readyCounter` |
| partial-ready | `tilePartialReady`、`partialRelease`、`partialThreshold*`、`reduceStartThreshold`（正确性见 O-009） |
| 格式与口径 | `kvCache`（`'fp8'`/`'bf16'`）、`countBasis`（`'reference-393'`/`'repo-510'`，B-007） |

`GAIN` 里的 25 个经验因子全部为 1。软件收益只能来自改变事件和资源的占用，不能靠乘系数。

**时间账。** `O.evaluate(x).services` 是逐项时间账，单位 µs，所有项加上 `waitUs` 就等于 `rawUs`。

- 计算侧：`kernel`、`localTma`、`tmaFill`、`reduce`、`dieLink`、`launch`，合计约 434.6。
- 通信侧：`memoryTransport`、`tpReduce`、`cardLocal`、`tauFloor`，合计约 452.0。
- 掩盖项为负值：`commOverlap`、`tmaHidden`。

看一个机制的收益从哪里来，就对比开关前后的时间账：

```js
const diff = (patch) => { const saved = {...O.OPT}, a = O.evaluate(x);
  Object.assign(O.OPT, patch); const b = O.evaluate(x); Object.assign(O.OPT, saved);
  console.log(JSON.stringify(patch), f(b));
  for (const k in a.services) { const d = b.services[k] - a.services[k]; if (Math.abs(d) > 0.01) console.log('  ', k.padEnd(16), d.toFixed(2)); }
  console.log('   waitUs'.padEnd(19), (b.waitUs - a.waitUs).toFixed(2)); };
diff({tmaLane: false});
// {"tmaLane":false} 984.20 TPS/usr, raw 868.42 µs
//    localTma         134.77    fill 不再提前发到每域的 TMA lane 上，进了关键路径
//    commOverlap      -13.71
//    tmaHidden        106.91    原来被掩盖的部分不再被掩盖
//    waitUs           -0.54
diff({kvPrefetch: 'layer'});       // 991.52：主要体现为 waitUs +76.55
diff({countBasis: 'repo-510'});    // 941.74：集合通信次数口径变化，不能记为性能收益
```

**新增或修改一个机制**必须同时满足四条（`21_TPS_DESIGN_BASELINE.md` 第 8 节第 3 条）：

1. 在 `OPT` 里有开关。
2. 收益能在时间账上追溯到具体的服务项。
3. 在 `k3_tps_design_baseline.js` 的 `MECHANISMS` 中登记回退值和证据等级。
4. 单独回退时 TPS 会下降。不满足这一条的放进 `noEffectAtPublishedPoint`。

机制的实现在 `k3_rdma_final_tuning_model.js`。这个文件由 Council 拥有，软件团队写实现和前提条件，PR 由 Council 审。

**可以接的活。**

- B-003：用 kernel 或调度 trace 回标 `launchScale` 和预测命中率 0.8。
- B-008：和硬件一起给出 τ 的推导。
- B-007：393 次集合通信口径的供应商确认。
- O-009、O-010：partial-ready 阈值的正确性，mailbox epoch 与 timeout。
- `KERNEL_SPEC` 中 kernel contract 必填字段的实测值。
- 让 `contract.json` 的 strategies 和 `OPT` 一一对应。

**规则。**

- overlap 不能重复计算。
- 单项回退值共享同一份余量（见第 8 节误区）。
- estimate 和 measured 分开标注。
- 改 `OPT` 后必须全量重新生成（第 6.1 节）。

### 5.3 模型部署

**你熟悉的东西在哪。**

- 逐模型的部署方案在 [`teams/model/docs/deployment/`](../teams/model/docs/deployment/README.md)：
  - `K3.md`、`GLM-5.2.md`、`DeepSeek-V4-Pro.md`：切分、dtype、KV/index 布局、每 rank 容量、集合通信次数。
  - `OPERATOR_LEDGER.md`：规划算子账。
  - `SCENARIO_MATRIX.md`：场景矩阵和选择政策。
- manifest 在 [`teams/model/inputs/formal_model_manifests.json`](../teams/model/inputs/formal_model_manifests.json)。三个模型目前都是 `UNVERIFIED_PLANNING_MANIFEST`，K3 的置信度为 E0。
- 各 agent 的分工（MODEL-01 到 MODEL-06）见 [`teams/model/README.md`](../teams/model/README.md)。
- 部署前提：只用 TP，不用 EP（ADR-0020）；B=1 decode；1M context。

**两条计算路径，不要混用。**

| 模型 | 形状来源 | 进入哪个模型 | 结果在哪 |
|---|---|---|---|
| K3 | `design_engine.js` 的 `MODEL_PRESETS.kimiK3`（唯一来源，由 `test_k3_manifest_consistency.js` 检查） | 详细模型。`k3_operator_sram_sim.js` 在每次 evaluate 时调用 `deriveModel`，目前只映射了 TP32 | 发布点，等级 `MODEL` |
| GLM-5.2、DeepSeek-V4-Pro | manifest 的 `shape` 加上 `workload_derivation.js` 里显式标出的 ASSUMPTION | 规划模型 `integration/planning/token_time.js`，标定点只有 K3 一个（O-016） | 18 个槽位，见 `out/workload/tps_observation_matrix.json`，等级 `PLANNING_ESTIMATE` |

**实验一：改 K3 形状。**

```js
const E = require('./teams/model/src/design_engine.js');
const K3 = E.MODEL_PRESETS.kimiK3;
const withShape = (fn, mutate) => { const saved = JSON.parse(JSON.stringify(K3)); mutate(K3);
  try { return fn(); } finally { Object.assign(K3, saved); } };
console.log('activeParams +2B', f(withShape(() => O.evaluate(x), m => { m.activeParams += 2e9; })));        // 1077.26
console.log('activeExperts 12', f(withShape(() => O.evaluate(x), m => { m.moe.activeExperts = 12; })));     // 998.10
```

第二行 TPS 反而下降，原因是 `attention.paramsPerLayer` 取的是 `"residual"`：注意力参数等于 `activeParams` 减去其他可推算的部分（`design_engine.js` 的 `deriveModel`）。

- 只减少激活专家数、不改 `activeParams`，少掉的专家参数会被算进注意力。
- 专家参数按 MXFP4 计，约 0.53 B/参数；注意力按 BF16 计，2 B/参数。所以字节反而增加。

改形状时要同时核对 `activeParams`。K3 的 `activeParams` 目前没有厂商 config 佐证（B-001），注意力参数又是从它倒推出来的，所以它的误差会直接进入 TPS。

**实验二：看三个模型的规划槽位。**

```js
for (const o of require('./out/workload/tps_observation_matrix.json').observations)
  console.log(o.observationId.padEnd(38), o.status, o.tpsPerUser.toFixed(1));
```

读这张表时注意三点：

- K3 TP32/MC640 的规划值是 1102.4，和详细模型的 1101.77 对齐，这是标定点。其余槽位都是外推。
- GLM 和 DS 的数字高，不代表它们已经达标，它们的部署布局里仍有 ASSUMPTION（O-016、O-017）。
- 冻结门槛是否要求所有可比模型都达标，目前还没有定论。

**可以接的活。**

- B-001：K3 逐层结构与 dtype 的冻结，以及 FP8 KV 的精度评估。发布点用了 FP8 KV；在发布点的 tile 下，BF16 不可行。
- O-012、O-013、O-014：权重 FP8、1M KV/state 布局与精度、LM Head。
- O-016：规划系数的标定。
- O-017：GLM/DS 的 router gather。
- MODEL-05 的 golden trace 目前没有交付，它是软件回标（B-003）的输入。

**规则。**

- 未确认的字段只能标 `UNVERIFIED`。
- K3 形状只改 preset，不在别处另写一份。
- planning estimate 不能当作 observed。
- 改 preset 或 manifest 后运行 `npm run model:planning` 和 `npm test`；如果影响 K3 发布点，按第 6.1 节全量重新生成。

## 6. 正式改动怎么走

### 6.1 改了输入之后必须重新生成

改了硬件参数、软件开关、物理系数或模型形状，要按顺序重新生成，再跑测试：

```sh
npm run search:final     # Final Tuning 搜索，约 1 分钟 -> out/rdma/
npm run baseline:sync    # 把发布点写回 k3_mc_baseline.json 的模型推导字段
npm run model:planning   # 规划模型、Stage A/B、contract、看板
npm test
```

`out/` 下的文件不能手改；测试用 sha256 把它们绑定到输入，漏了重新生成 `npm test` 会失败。Stage A/B 生成物里带 git HEAD 和生成时间，所以每次重新生成都会有 diff，review 时只看数值字段。各入口的说明见 [`integration/pipelines/README.md`](../integration/pipelines/README.md)。

### 6.2 按团队目录改

| 你要改的 | 改哪里 | 还要做什么 |
|---|---|---|
| 硬件单元设计 | `teams/hardware/docs/`、`teams/hardware/inputs/` | 改规格数值须走 ADR（ADR-0005 的变更控制） |
| 软件优化策略 | `teams/software/docs/`；开关的实现在 `integration/detailed/` | 给出单项回退值和实现前提；`GAIN` 保持为 1，收益必须来自事件/资源模型 |
| 模型形状、workload | `teams/model/src/`、`teams/model/inputs/` | K3 形状只能改 `design_engine.js` 的 preset；未确认字段标 `UNVERIFIED_PLANNING_MANIFEST` |
| 跨团队组合、搜索、Gate | `integration/` | 由 Council 拥有；改公共 contract 须同时更新 `docs/architecture/contracts/`、新增 ADR，并由 V&V 加测试 |
| 测试 | `tests/<group>/test_*.js` | V&V 拥有；按组跑：`npm run test:unit`、`test:regression`、`test:governance`、`check:structure` |

`teams/<team>/` 下的代码不能 require 其他团队、`integration/` 或 `out/`，`npm run check:structure` 会拦住。

### 6.3 提交

- 从 `main` 拉分支，命名 `arch/…`、`model/…`、`verify/…`、`docs/…`、`agent/…`，不要直接推 `main`。
- 一个 PR 一个主题；PR 里写明改了哪个团队目录、`npm test` 结果、对 TPS/usr 的影响（基线、seed、单位、原因）。
- 完整清单见 [`CONTRIBUTING.md`](../CONTRIBUTING.md)。

## 7. 用 agent 协作

仓库按"每个 agent 只负责一小块"组织，有两种用法。

**单个 agent 做一个任务。** 先写任务卡（职责、允许改的路径、输入版本、输出、验收），完成后交 handoff packet。模板：[`DETAIL_AGENT_TASK_CARD.md`](../teams/council/docs/detailed/DETAIL_AGENT_TASK_CARD.md)、[`DETAIL_HANDOFF_PACKET.md`](../teams/council/docs/detailed/DETAIL_HANDOFF_PACKET.md)，工作流计划见 [`AGENT_WORKSTREAM_PLAN.md`](../teams/council/docs/AGENT_WORKSTREAM_PLAN.md)。在 Claude Code 里让 agent 先读 `AGENTS.md` 和任务卡，只在允许的路径里改。

**多团队 agent 评审一个问题。** [`integration/orchestration/`](../integration/orchestration/README.md) 下有一个 Claude Code Workflow 脚本，按团队派探针和 lead，按接口交叉核对，对 blocker 做对抗核验，最后由 Council agent 集成、critic 查漏。全程只读。一次完整运行约 100 个 agent、数百万 token、45 分钟左右，适合需要跨团队给出结论的问题，不适合日常小改动。运行存档见 [`teams/council/docs/reviews/`](../teams/council/docs/reviews/)；存档是 `MODEL` 等级的评审意见，不是 ADR，也不是 Gate 结论。

无论哪种用法，agent 产出的内容都要由对应团队的人审查后才能合入。

## 8. 常见误区

- **把 1101.77 当成"已经达标"。** 它是 MC640（STRETCH 档）上的 `MODEL` 结果；在可制造默认档 MC480 上回放只有 853.44。当前候选没有达到 1050 冻结门槛。
- **引用 1000 口径的余量讨论 1050。** 见第 2 节。
- **把单项回退值当成独立的余量。** 四个软件机制单独关掉都会跌破 1050，但它们共享同一份余量，不能各自按全额余量计算。
- **给某个机制加经验折扣来"提高"TPS。** `GAIN` 全为 1 是规则；折扣必须来自事件/资源模型或实测。
- **手改 `out/` 或 `k3_mc_baseline.json` 里的模型推导字段。** 这些都由脚本重写。
- **在 runner 或文档里写 `PASS` 之类的 Gate 结论。** Gate 只由 `evaluate_gates.js` 计算。
- **用 `scripts/`、`src/` 下的本地脚本作证据。** 它们不在仓库结构内，可能已经跑不起来。

## 9. 从哪里开始干活

- 看 [`OPEN_ISSUES.md`](architecture/OPEN_ISSUES.md)，挑一个你所在团队的 `B-*` 或 `O-*`，确认它的 owner 和关闭证据要求。
- 当前最主要的阻塞项：MC 可制造档位与 sustained 效率（B-002）、τ 的物理推导（B-008）、卡内与 TP32 拓扑（B-004、B-005）、调度假设的 trace 回标（B-003）、模型结构签核（B-001）。
- 最近一次多团队评审列出的下一步工作，在 [`teams/council/docs/reviews/`](../teams/council/docs/reviews/) 存档的第三部分。
