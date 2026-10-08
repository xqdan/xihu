# 调优契约：参数的所有权、边界与回标

- 所有者：Software（Runtime/Kernel）；共签：Hardware（可实现的边界）、Model（形状来源）
- 状态：`BASELINE`（现有参数）；**回标路径 `OPEN`**
- 权威来源：`integration/detailed/k3_rdma_final_tuning_model.js`、`integration/detailed/k3_architecture_search.js`、
  `teams/hardware/inputs/k3_mc_baseline.json#tpsDesign.hardware.x`

## 0. 本文补的是哪一块

发布点的硬件向量 `x` 是**搜索出来的**：`RETUNE` 网格 × 爬山在模型里选出最优组合。
但"搜出来"和"可实现"是两件事。本文给每个参数定三样东西：

1. **谁拥有它**——哪个团队有权改，改之前要找谁；
2. **边界在哪**——由哪个物理量决定，不是由搜索结果决定；
3. **怎么回标**——用什么证据可以把它从搜索值换成测量值。

没有本文，`x` 的所有权是模糊的：它看起来是"模型调出来的"，
于是没有任何团队对它负责；而在 `DESIGN_EVIDENCE_MATRIX.md` 里它是 `MODEL` 等级，
意味着**必须**有人回标。

## 1. 参数分类

### 1.1 硬件形态参数（搜索值 → 需硬件签核）

| 参数 | 含义 | 发布值 | 边界由什么决定 | 拥有者 |
| --- | --- | ---: | --- | --- |
| `rdmaLanes` | 每 Die scale-out lane 数 | 16 | PHY shoreline（`09` 号文档 §2）与 B-005 拓扑 | Comm/PHY |
| `vectorLanes` | 向量单元 lane 数 | 512 | 面积/功耗；再分配对象（O-020） | HW-02 |
| `hRows` × `hEngines` | H core 引擎阵列 | 48 × 5 | 面积 + `layoutImbalance` 容量约束 | HW-02 |
| `kvTile` | KV tile 大小 | 32768 | SRAM 容量；16384 是可行的更小值 | HW-03 |
| `depth` | 预取深度 | 4 | 与 SRAM window 耦合 | HW-03 |
| `windowFraction` | SRAM window 比例 | 见 `hardware.x` | 直接决定 `layoutImbalance` 风险 | HW-03 |
| `weightTileMiB` | 权重 tile | 见 `hardware.x` | 本地 SRAM 容量 | HW-03 |

**这些不是软件可以调的旋钮。** 搜索把它们的值写进 `hardware.x`，
但每一个都必须由对应硬件团队确认可实现，否则发布点无效。

### 1.2 软件机制参数（软件拥有，但需 trace 证据）

10 项机制（`tpsDesign.software.mechanisms`）：`tmaLane`、`kvPrefetch`、`persistentDecode`、
`sharedOverlap`、`tmaHidden`、`partialReady`、`epochMailbox`、`fusedRoute`、`dequantOnVector`、`prefetchDepth`。

| 项 | 语义 | 回标方式 |
| --- | --- | --- |
| 全部 | 收益来自事件/资源模型本身，`GAIN` 因子一律为 1（B-003） | **kernel 与调度器 trace**（`VV_MEASUREMENT_PLAN.md` #2） |

**B-003 的含义**：这些机制的收益**不含任何经验放大**。这是保守的，也是为什么
21 号文档第 5 节能给出一张逐项回退表——每项机制的收益都可以单独撤掉并复算。

### 1.3 未回标假设（最高风险，见 §3）

| 参数 | 发布值 | 语义 | 悲观端 | 归属 |
| --- | ---: | --- | ---: | --- |
| `OPT.launchScale` | 0.45 | 批量摊薄后保留的发射开销比例，**越小越好** | 1.0（TPS → 1088.47） | SW-01 Runtime |
| `plan.c.prediction` | 0.8 | 专家预测命中率 | 0.7 | SW-06 / HW-02 |
| `A.TECH.mcUtil` | 0.70 | MC 持续效率（盈亏点 **0.63**） | 0.65 | HW-04 |

## 2. 边界规则（搜索不得越过）

搜索结果本身不构成边界。以下边界由物理量决定，搜索空间必须显式排除越界点：

1. **`layoutImbalance` 上界 1.42**：超过则 H local tile **放不下**，是 `infeasible` 而非变慢
   （`DESIGN_TARGETS_AND_MARGINS.md` §2.1）。
2. **Die 面积 ≤ 400 mm²、Die 功耗 ≤ 300 W、卡功耗 ≤ 2800 W**：搜索已按此过滤。
3. **主域频率固定 1.0 GHz，不参与搜索**（NFR-05）。任何"降频换面积"的方案直接不合法。
4. **KV tile 与 `kvCache` dtype 耦合**：在已发布点（headTile 96、hMiB 4）上，32768 在 BF16 下 **不可行**，
   因为 BF16 KV 让每 token 的 KV slab 字节翻倍，H local tile 放不下（`A.mappedPlan` 的 H local tile 检查，
   `integration/detailed/k3_architecture_search.js:100`）。dequant 走 H 向量 lane、从 softmax 可掩盖预算中扣除，
   是 FP8 一侧的代价（`kvCache` 与 `softmaxFusion` 的耦合），不是 BF16 不可行的原因。
   同一道墙也受 headTile 和 hMiB 影响：sram 灵敏度卡的 `couplings` 里，`headTile=48 x kvCache off`、
   `hMiB=8 x kvCache off` 两对在 32768 下 BF16 可行。
   搜索必须同时选 `(kvTile, headTile, hMiB, kvCache)`，不能分别最优。
5. **条件路由的旋钮必须重新调整**：见 §4。

## 3. 回标路径（每项的关闭证据）

| 优先级 | 参数 | 回标方法 | 归口 |
| ---: | --- | --- | --- |
| 1 | `mcUtil` | MC 原型或供应商持续带宽测量 | HW-04 |
| 2 | `launchScale` | runtime trace：空批/满批对比发射周期 | SW-01 |
| 3 | `prediction` | 专家路由统计（真实 prompt 分布） | SW-06 |
| 4 | 软件机制 10 项 | kernel + 调度器 trace | SW-01/02/03 |
| 5 | 形态参数 7 项 | 综合/floorplan/功耗（P7-d） | 各单元 |
| 6 | `unpackParamsPerLaneCycle` / `matrixUtil` / `vectorUtil` | 微基准或 RTL 周期模型 | HW-02 |

**回标的终点**：写回 `teams/hardware/inputs/k3_mc_baseline.json`，
然后 `npm run search:final && npm run baseline:sync`，
并更新 `DESIGN_EVIDENCE_MATRIX.md` 的证据等级。

## 4. 条件路由的调优规则（`CONDITIONAL_ROUTES`）

`fewerBytesPerToken` 走 FP8 稠密时，模型在 `RETUNE` 网格上**重新调优**了旋钮
（`depth`、`weightTileMiB`、`windowFraction`、`kvTile`）。

**这是一个必须显式记录的调优选择**：条件路线得到的 1080.78（MC400）是在
**为 FP8 重新调过的旋钮**下取得的，而已发布基线用的是另一组旋钮。
两者不是同一个硬件配置的两个 dtype 变体。

规则：

1. 条件路线的结果**只能与同样重新调优后的基线条目比较**，不得与已发布基线直接比；
2. `CONDITIONAL_ROUTES.fewerBytesPerToken.limitation` 字段当前记录的是
   "detailed replay 把 FP8 也应用到 router 与 LM head（约 1% 的 rank 字节），
   而规划比较模型保持这两个为 BF16"——**它没有记录旋钮重调这件事**；
3. 把旋钮重调写进该字段（或另立字段），并让
   `tests/regression/test_memory_design.js` 校验该字段非空且被文档引用；
4. 采纳条件路线时，重新调过的旋钮**必须与硬件团队重新签核**——
   它们本来就是 §1.1 里的形态参数，换 dtype 不改变这一点。

## 5. 未闭合项

| 项 | 状态 | 责任 |
| --- | --- | --- |
| 全部 §1.3 假设 | `ASSUMPTION` | 见表 |
| 形态参数的可实现性 | `MODEL` | 各硬件单元 |
| 条件路线的旋钮签核 | `OPEN` | HW-01..03 |
| `RETUNE` 网格本身是否覆盖可实现边界 | `OPEN` | Software + Hardware |
