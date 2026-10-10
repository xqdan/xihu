# Execution Trace 契约（模型侧）

- 所有者：Architecture Council（字段或轨道的变更需 Hardware、Software 两团队 review；改 `format` 版本号需记录 ADR）
- 生产者：[`integration/detailed/execution_trace.js`](../../../integration/detailed/execution_trace.js)，由
  [`integration/pipelines/generate_execution_trace.js`](../../../integration/pipelines/generate_execution_trace.js)（`npm run trace:published`）写出
- 消费者：架构评审（Perfetto / `chrome://tracing` 查看）、[`tests/regression/test_execution_trace.js`](../../../tests/regression/test_execution_trace.js)；
  将来的 Palladium / RTL 回放对照（[`TILE_IR.md`](TILE_IR.md) §3 "golden trace 格式"的模型侧版本）
- 来源：[`24_TRACE_AND_CHARON_ADOPTION_PLAN.md`](../../../teams/council/docs/24_TRACE_AND_CHARON_ADOPTION_PLAN.md) 阶段一（ARCH-TR-01、VV-TR-01、ARCH-TR-02、HW-TR-01）
- 版本：`k3-execution-trace/1`（2026-10-10）

## 1. 定位

trace 是详细模拟器（`k3_operator_sram_sim.js#simulate`）对一个 Batch=1 decode step 的**调度视图**，
时长全部来自 `mappedPlan` 的解析式和模拟器的资源模型。

- 证据等级固定为 `MODEL`：文件头、`otherData` 和每个切片的 `args.evidence` 都写 `MODEL`。
- 它**不是**观测时间线，不满足 `VALIDATED_EVENT_TIMING`（`integration/governance/evaluate_gates.js`），
  不改变任何 D-Gate / Q-Gate 结论，不进任何基线数字。
- 只描述 TP32 中的**一个 rank**。393 次集合通信在 trace 里是本 rank 看到的时长，不展开其余 31 个 rank。

## 2. 文件

| 产物 | 位置 | 是否提交 |
|---|---|---|
| 发布点时间线 | `out/trace/k3_published_point.trace.json` | 提交；sha256 由回归测试按重新生成的内容核对，并纳入 `test_regeneration_reproducible.js` |
| 机制回退对比 | `scratch/trace/diff_<label>.json` | 不提交（`scratch/` 已在 `.gitignore`） |
| 对比双方的时间线 | `scratch/trace/diff_<label>.{base,variant}.trace.json`（`--traces`） | 不提交 |

文件是标准 Chrome Trace Event JSON（对象形式）：`traceEvents` 数组之外的顶层键会被查看器忽略，
本契约用它们携带元数据。时间单位是**微秒**（格式自身的单位），`ts` 从 step 开始计。

## 3. 顶层元数据 `k3Trace`

| 字段 | 含义 |
|---|---|
| `format` | `k3-execution-trace/1` |
| `status` / `evidenceClass` | 定位声明；`MODEL` |
| `contract` | 本文件路径 |
| `provenance.baseline` / `baselineSha256` | 设计点来源 `teams/hardware/inputs/k3_mc_baseline.json` 及其 sha256 |
| `provenance.sources` | 决定时间线的源文件（`execution_trace.js` 的 `SOURCE_FILES`）→ sha256 |
| `provenance.x` / `xSha256` / `opt` | 回放的设计点、其指纹、回放时的完整 `OPT` |
| `ledger` | 模拟器自己的时间账：`rawUs`、`computeUs`、`tmaHiddenUs`、`commUs`、`waitUs`、`overlapUs`、`tmaFillUs`、`tmaExposedUs`、`e2eUs`、`tpsPerUser` |
| `reconciliation` | 由 `traceEvents` 反算的各项（§5） |
| `publishedPoint` | 基线文件里的 `tpsDesign.point`，供对照 |
| `counts` | 算子数、集合通信数、模拟器事件数、占用采样数、trace 事件数 |
| `protocol` | HW-TR-01 每类集合通信抽样实例的拆解（§4.3） |

provenance 只记文件内容的 sha256，不记 git commit：这样 trace 只随输入变化，换提交不会让产物漂移。

## 4. 轨道与事件

进程 `pid = 1`。`tid` 即轨道在查看器中的顺序。

| tid | 轨道 | 事件 | `cat` |
|---|---|---|---|
| 1 | Layers | 每层一个 `X` 切片，`L<n> <kind>` | `layer` |
| 2 | Compute slot (L / H / V) | 每个非 COMM 算子一个 `X` 切片（kernel 本体）；以及算子在计算槽上等自己 TMA fill 的时间 | `op`、`tma-exposed` |
| 3 | Collective (TP32) | 每个 COMM 算子一个 `X` 切片；抽样实例下嵌套协议切片和逐 peer 异步切片 | `comm`、`protocol`、`rdma-peer` |
| 4 | Idle (wait) | 计算槽和集合通信都空闲的时间，记在队首算子名下；全部算子发出后的收尾记为 `wait: drain` | `wait` |
| 5 | DMA (MC <-> shared SRAM) | 每段 DMA 一个 `X` 切片；被抢占的预取分成多段（`segment` = `start`/`resume`，`endedBy` = `park`/`end`） | `dma` |
| 6 | TMA-L (shared -> L local) | L 域每次 fill 一个 `X` 切片 | `tma` |
| 7 | TMA-H (shared -> H local) | H 域每次 fill 一个 `X` 切片 | `tma` |
| — | SRAM occupancy (MiB) | `C` 计数器：`allocated`（已分配 + scratch 预留）、`live`（含运行中算子的 arena）；同一时刻只保留最后一个采样 | — |

元数据事件（`ph: 'M'`）给出进程名、轨道名和排序。

### 4.1 必填 args

所有 `X` 切片都带 `evidence: 'MODEL'`。除 `layer` 切片和 `wait: drain` 外，都带 `operator_id`（`mappedPlan` 的算子下标）
和 `layer`，且 `layer` 等于该算子所在层：

- `op` / `comm`：`unit`、`flops`、`readBytes`、`writeBytes`、`linkBytes`、`durationUs`（算子服务时间）、`timing`（`mappedPlan` 的时长拆解，含
  `kernel`/`localTma`/`tmaFill`/`launch`/`assumedGain`，COMM 为 `memoryTransport`/`tpReduce`/`cardLocal`/`portTail`/`tauFloor`）；
  可选 `detail`（如 `weight tile 1/2`）、`overlapComm`、`tma`。`op` 另有 `bodyUs`（切片时长）与 `tmaPrefilled`；`comm` 另有 `async`。
  另有 `costSource`（`measured` / `fitted` / `analytical`）和 `costEvidence`（`SILICON_OBSERVED` / `EMULATION_OBSERVED` / `MODEL`）：
  `timing.kernel` 来自哪一级（ARCH-CH-02，`cost_provider.js`）；非解析时还有 `costObservations`（引用的实测条目 id）。
  集合通信恒为 `analytical` / `MODEL`。`evidence` 仍是 `MODEL`：它描述整个调度视图，`costEvidence` 只描述 kernel 一项。
- `dma`：`operator_id` 对读取是消费它的算子，对写回是产生它的算子；另有 `job`、`kind`、`category`、`bytes`、`segment`、`endedBy`。
- `tma`：`bytes`、`nominalUs`（无争用时的 fill 时长）、`halves`。

### 4.2 计算槽的口径

模拟器把算子的完整服务时间计入 `computeUs`，但已预取 fill 的算子在计算槽上只占 `duration − tma.us`（切片时长 `bodyUs`）。
fill 没跑完时队首算子占着计算槽等待，这段是 `tma-exposed` 切片。因此计算槽轨道的总时长是
`computeUs − tmaHiddenUs`，即 kernel 本体加暴露的 fill。

### 4.3 集合通信内部（HW-TR-01）

每类集合通信（当前 5 类）取程序顺序上的第一个实例，用 `k3_sram_memory_rdma_model.js#collective(..., trace=true)` 重跑，
重跑结果加上 `tauFloor` 必须等于该算子的时长，否则生成器报错。嵌套在 COMM 切片下的 `protocol` 切片依次是：

1. `RDMA phase k/n`：每个单边写入阶段，args 有 `requests`、`wireBytes`、`readyUs`、`drainedUs`；
2. `TP reduce`、`card-local merge (8 dies)`、`shared-port tail`：时长为 0 的项不画；
3. `tau floor (ADR-0004)`：协议时长低于 τ = 1.15 µs 时补齐的部分。

这是模型**相加**各项的顺序，不代表硬件按这个顺序串行执行。每个 RDMA 阶段下还有 31 个 peer 的异步切片
（`ph: 'b'/'e'`，`cat: 'rdma-peer'`，`id` = `<operator_id>.<phase>.<peer>`），依次嵌套 `wire`、`commit + notify`、`ACK return`。

## 5. 守恒（验收条件）

生成器在写文件前检查以下各项，差值都必须 < 1e-6 µs；测试在已提交的文件上再查一遍：

| 由 trace 反算 | 等于 |
|---|---|
| 计算槽轨道切片时长之和 | `computeUs − tmaHiddenUs` |
| `tma-exposed` 切片之和 | `tmaExposedUs` |
| `comm` 切片之和 | `commUs` |
| `wait` 切片之和 | `waitUs` |
| 计算槽与 `comm` 的时间交集 | `overlapUs` |
| 计算槽、`comm`、`wait` 三者并集的长度 | `rawUs` |
| 最后一个切片的结束时刻 | `rawUs` |

由此 `raw = compute − tmaHidden + comm + wait − overlap` 在时间轴上逐段成立。此外：同一轨道上的顶层切片互不重叠；
协议切片落在其 COMM 切片之内且时长之和等于它；每个算子在计算槽或集合通信轨道上恰好出现一次；
打开 trace 不改变模拟器的任何数值（测试比较 `{trace:true}` 与默认调用的全部标量结果）。

## 6. 对比（ARCH-TR-02）

`--diff` 在同一 x 下回放两次（基线与打了 OPT 补丁的变体），按 `(layer, name, 层内序号)` 对齐算子。

- 每个算子的 **advance** = 从它发出到下一个算子发出的时间，最后一个算子拥有 step 剩余部分。advance 之和恰为 `rawUs`，
  所以逐算子、逐层的 `advanceDeltaUs` 之和等于 `delta.rawUs`，重叠和等待的变化都归到被推迟的那个算子上。
- 另给出 `startShiftUs`（发出时刻偏移）和 `durationDeltaUs`（服务时间差）。补丁改变算子清单时，未对齐的算子以 `only: 'base' | 'variant'` 列出。
- 预设：`k3_tps_design_baseline.js` 的 `MECHANISMS`，每个机制单独退回到它的 `off` 值，与
  [`21_TPS_DESIGN_BASELINE.md`](../21_TPS_DESIGN_BASELINE.md) §5 的逐项回退同口径。

## 7. 版本规则

- 新增轨道、新增 args 字段：`format` 不变，更新本文件。
- 改变已有字段的含义或单位、删除字段、改变守恒口径：`format` 升版本，记录 ADR。
- 模拟器只允许在 `if(trace)` 分支里补事件；任何改变计时路径的修改都不属于本契约。
