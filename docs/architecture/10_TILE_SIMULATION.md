# 算子与 Tile 级模拟计划

## 1. 目标

建立能回答以下问题的可执行模型：

- 每个算子如何切成 tile；
- tile 在 L/H/Vector/TMA/Collective 上何时运行；
- 每个 tile 读写哪些 SRAM bank、NoC link 和 MC channel；
- 哪些传输可与计算重叠；
- partial-ready 在什么数据到达后真正可启动；
- P50/P95/P99 token latency；
- 物理 320 GB/s MC 下距离 1000 TPS 还差多少；
- 规格变化对面积、功耗和 TPS 的真实影响。

## 2. 当前模型已有能力

[`integration/detailed/k3_operator_sram_sim.js`](../../integration/detailed/k3_operator_sram_sim.js)
已经提供：

- 93 层 operator graph；
- weight、KV、state、prediction 和 writeback job；
- weight tile、KV tile、head tile；
- SRAM 容量和对象生命周期；
- DMA/compute/collective 离散事件；
- TMA、Local SRAM、Shared SRAM、NoC、MC 和链路带宽上限；
- online-softmax m/l/O；
- 预测命中/误读/淘汰；
- layer/operator 时间账；
- 执行 trace 导出（2026-10-10，[`execution_trace.js`](../../integration/detailed/execution_trace.js)，`npm run trace:published`）：
  发布点一个 step 的计算槽、集合通信、等待、DMA、TMA-L/H、SRAM 占用时间线（Chrome Trace，Perfetto 可开），
  逐轨与时间账守恒对账；每类集合通信抽样一次展开 RDMA 阶段和逐 peer 事件；`--diff` 按算子对比机制回退。
  契约见 [`contracts/EXECUTION_TRACE.md`](contracts/EXECUTION_TRACE.md)，证据等级 MODEL；
- 前台重叠争用选项（2026-10-10，ARCH-CH-01）：`simulate(..., {contention:'proportional'})` 让运行中的算子和集合通信按剩余工作量推进，
  两者对 shared SRAM 读口、写口和 fabric 的总需求超过上限时按需求比例分配，不含标定因子；默认 `'none'` 即发布模型。
  `npm run contention:delta` → `out/detailed/contention_delta.json`；
- 算子成本提供者（2026-10-10，ARCH-CH-02）：`mappedPlan` 的 `kernel` 一项按"实测 → 两点插值 → 解析式"取值
  （[`cost_provider.js`](../../integration/detailed/cost_provider.js)，实测表
  [`teams/vv/inputs/operator_cost_observations.json`](../../teams/vv/inputs/operator_cost_observations.json) 目前为空），
  每个算子带 `costSource` / `costEvidence`。`npm run cost:coverage` → `out/detailed/cost_coverage.json`：
  raw 按证据来源分解，以及按本文 §8 和 24 号文档顺序排列的待测 shape 队列；
- 链路级 τ 推导（2026-10-10，HW-CH-01）：[`collective_topology.js`](../../integration/detailed/collective_topology.js)
  把集合通信协议模型里固定的单程时延换成各 scale-out 拓扑候选的路径（链路、交换、中继、卡内 Die 跳），
  按 one-shot / halving-doubling / ring 和两种 ACK 语义自底向上算出每类集合通信的 τ，并回放发布点。
  `npm run tau:derivation` → `out/detailed/tau_derivation.json`，候选与延迟均为 `ASSUMPTION`，不改 `OPT.tauUs`；
- 负载形态扫描（2026-10-10，ARCH-CH-03）：`O.mapped(x, {tokens, context})` 可以给出 1M 以外的上下文（默认仍是 `LIMITS.context`）。
  [`workload_shape.js`](../../integration/detailed/workload_shape.js) 在发布硬件上扫 batch（每点重选映射参数）和短上下文，
  `npm run shape:explore` → `out/detailed/workload_shape.json`，只作附加视角，不改 ADR-0009 的目标。

这是良好起点，但还不是签核级模型。

### 2.1 行为假设清单（已建模 / 未建模）

`ASSUMPTION` 标签只标参数的证据等级。下表标的是**模拟器行为**：哪些资源争用、依赖和状态已经进入
`simulate`，哪些没有。引用"差值为零"或"收益已计入"之类的结论时，以此表判断适用范围。
参考做法：AccelForge 的 `assumptions.rst` 对每条假设说明它支撑哪一步算法、什么会让它失效
（外部方法参考，不是证据，见 `references/README.md`）。

| 项 | 状态 | 依据 / 失效条件 |
|---|---|---|
| shared SRAM 读口、写口、fabric 在 DMA、TMA fill 与前台之间的分配 | 已建模 | `fillSpeeds()`、`dmaRate()`：fill 和 DMA 只拿前台用剩的带宽 |
| 前台算子与前台集合通信之间的争用 | 默认**未建模**；`contention:'proportional'` 时仅覆盖 shared 读口、写口、fabric 三项 | 默认 `end = t + duration`，被拉长的时间不入账。发布点和 8 个联合点差值为 0（24 号文档 §2.2）；该结论只对这三项成立 |
| local SRAM 写口 | 只约束 TMA fill | 不约束前台算子之间；前台算子的时长取自映射值 |
| MC 带宽 | 只约束 DMA | 不进前台争用 |
| 单个算子内部的 bank 冲突、地址相关行为 | **未建模** | `TECH.bankUtil` 是一个常数折减，不是 bank 级仿真；见 `memory-subsystem.md` 对访问模式的讨论（外部参照，不是证据） |
| 算子 kernel 时长 | 解析式；实测表为空 | `cost_provider.js`；raw 的 29.0% 来自解析 kernel，71.0% 不是 kernel（24 号文档 §2.4） |
| 集合通信时长 | 协议模型 + 统一下限 τ；链路级拓扑为 `ASSUMPTION` | B-008；`tau_derivation.json` |
| 专家预测命中率 | 常数 0.8，路由均匀（`union` 取 worst 或 expected） | 无按层分布，无路由倾斜；倾斜会让 FFN 与通信按 skewness 放大，当前不入账 |
| 跨层状态 | 已建模 | KV 预取、SRAM 驻留、DMA 抢占与恢复；这也是不能做单 block 抽取的原因（24 号文档 §1） |
| 映射器合法性 | mapper 只强制 `legal`；`assumes` 事后由 `checkRules` 报告 | 见 24 号文档 §2.8 的 4 项发现；其中 pvMerge `'layer'` 的累加器预留见下 |

**已核对的一项（pvMerge `'layer'` 累加器，2026-10-12，只读）**：`hLocalBytes` 只为一个 head tile 预留 m/l/O 累加器，
而该规则的 `assumes` 要求容纳一层交错的全部 `96/headTile` 个。对 `out/rdma/k3_rdma_final_tuning_results.json` 里
headTile < 96 的 109 个可行点，用模型自己的 `mappedPlan` 重算（补上 `(96 − headTile) × 512 × 4 × 1.15` 字节），
**没有一个点翻转为不可行**，最佳点（headTile = 96）不受影响。但有一个点（headTile 48，hMiB 1，275.1 TPS/usr）
余量从 0.133 MiB 降到 0.026 MiB。结论：对当前产物无影响，但边界已经很窄；若搜索空间或 `hMiB` 档位放宽，
该偏差可能开始改变可行集合。脚本为 `scratch/review/pv_accumulator_check.js`（`scratch/` 不构成证据，按 AGENTS.md 需要时再走 generator 落进 `out/`）。

## 3. 当前需要移除的经验项

Final Tuning 中以下优化主要以乘法缩放实现：

- matrix utilization 0.88；
- attention fusion；
- MoE token packing；
- Wup/router fusion；
- tile partial-ready；
- phase fusion；
- hierarchical/direct reduce；
- local port read/write scale；
- launch batching。

下一版必须把它们替换为：

- 明确的 fused operator graph；
- 明确的 tile 数和 shape；
- 明确的端口占用周期；
- 明确的 packet/request；
- 明确的依赖和可重叠窗口；
- 明确的资源冲突。

## 4. 签核级模型层次

### L0：解析模型

- FLOP/byte/capacity；
- 设计空间早期筛选；
- 允许使用利用率，但不得用于最终通过。

### L1：Operator/Tile 离散事件

- 当前主模型升级版；
- 精确 tile DAG；
- resource reservation；
- bank/slice/link/VC；
- 可作为架构 KPI 主模型。

### L2：NoC/MC/RDMA transaction model

- packet、credit、queue、replay；
- 与 L1 co-simulation；
- 校准通信和 DMA。

### L3：Kernel cycle model

- Tensor/Vector/TMA pipeline；
- 关键 kernel：QK/PV、softmax、expert、state update；
- 校准 L1 的 service time。

### L4：RTL/emulation trace

- 单元 RTL 和 FPGA/仿真器；
- 回放相同 tile trace；
- 架构冻结后持续回归。

## 5. 精确算子图

必须从模型清单生成，不再使用“每四层一个 Softmax”近似。每层记录：

- Attention 类型和完整投影矩阵；
- q/k/v/o shape；
- Linear Attention state；
- MoE/dense 类型；
- expert 路由、shared expert；
- dtype 和 accumulation；
- collective 边界；
- residual/norm/fusion 合法性。

Attention 投影不能继续只用 active-parameter residual 拟合。

## 6. Tile 维度扫描

至少扫描：

- weight tile：1/2/4/8 MiB；
- KV tile：1K/2K/4K/8K/16K token；
- head tile：8/16/32/48/96；
- expert token tile：1/2/4/8；
- partial stripe：4/16/64 KiB；
- prefetch/overlap depth：0–4；
- Local/Shared buffer 数：2–4。

每个候选必须报告：

- Tensor fill；
- Vector fill；
- Local bank conflict；
- Shared slice conflict；
- TMA/NoC/MC service；
- collective tail；
- live SRAM；
- energy/token。

## 7. 真实运行场景

### 必测主场景

- B=1，Context=1M，TP32，Decode；
- 24 个 Softmax MLA 层；
- 69 个 Linear Attention 层；
- 92 个 MoE 层；
- Final LM Head。

### 敏感性

- Context：32K/128K/1M/2M；
- Batch：1/2/4/8；
- MC：320/更高带宽；
- dense dtype：BF16/FP8；
- 路由分布：均匀/热点/最坏；
- MC/Die/链路故障；
- Prefill 并发；
- 热降频；
- P99 重放。

## 8. 校准顺序

1. 通过 reference kernel 或 GPU trace 校准 FLOP/byte；
2. 通过 Tensor/Vector cycle model 校准 Core；
3. 通过 SRAM bank model 校准 TMA；
4. 通过 packet model 校准 NoC；
5. 通过 MC vendor model/样片校准内存；
6. 通过 RDMA transaction model 校准 collective；
7. 用整 token trace 关闭时间守恒；
8. 比较解析、tile、transaction、RTL 四层误差。

## 9. 性能通过标准

架构冻结前：

- 使用可实现 MC 规格；
- 不使用未解释的全局缩放因子；
- B=1/1M/TP32 达到至少 1050 TPS/usr；
- P99 不低于 1000 TPS/usr；
- 所有资源利用率和队列深度可实现；
- SRAM 至少 15% 可用工程余量；
- 卡功耗至少 10% 架构余量；
- 多 seed/多路由 trace 均通过；
- 结果由独立回归测试复算。
