# 建模 Review：按 Agent 视角的问题清单

版本：2026-09-21  
Review 范围：`k3-architecture-repo` 当前 baseline；目标是 K3、GLM-5.2、DeepSeek-V4-Pro，在 7-reticle 单芯片假设下，以 TP8/TP16/TP32、MC320/MC640 为观测维度，评估 1000 tokens/s/user。

## 1. Review 结论

**当前不具备架构签核条件。** 现有仓库已经有清晰的模块划分、18 个 TPS 观测槽位、P0/P1 物理 profile 和 K3 事件级模拟雏形；但三模型尚未共享同一份可执行 workload manifest，P0 尚未进入事件级回放，TP8/TP16 仍被模拟器硬编码拒绝，算术强度/Roofline/算力 sizing 尚未形成闭环。因此现阶段的数字只能作为 architecture planning baseline，不能作为三模型达标或可制造性结论。

证据等级定义：

- **E0**：文档计划或人工假设；不能用于签核。
- **E1**：机器可读输入，但未完成事件级验证。
- **E2**：可重复的模型仿真结果，有 seed、版本和 breakdown。
- **E3**：原型/硅上实测并完成校准。

当前关键 TPS 证据是 E2 的 K3 TP32 两点：MC320 为 546.63，MC640 为 998.81 tokens/s/user；后者仍低于 1000 目标和 1050 架构门槛。其余 16 个观测槽位尚无事件级结果。

## 2. P0 阻塞问题

| ID | Owner | 问题 | 影响 | 必须完成的修复 | 验收条件 |
|---|---|---|---|---|---|
| MR-001 | A1 | GLM-5.2 缺少层级、专家和 dtype 配置；DeepSeek 仍是待授权/待确认 snapshot | 无法生成同粒度 DAG、FLOP 和 bytes | 为每个模型建立逐层 manifest，所有未确认字段显式 `UNKNOWN/BLOCKED` | 三模型每个 TP case 都能生成可追溯 DAG；未确认输入自动阻断签核 |
| MR-002 | A0/A2/A3/A4 | P0 的 8L+8H、96 MiB/Die、400 mm²/Die 尚未接入执行路径，当前结果主要是 P1 compact | P1 结果不能外推 P0 | simulator、floorplan、SRAM、NoC、PPA 全部接受 `physicalProfile=P0/P1` | 同一 case 可分别输出 P0/P1，报告严禁混用 |
| MR-003 | A10/A9 | `k3_operator_sram_sim.js` 明确 `c.tp!==32` 即报错 | TP8/TP16 只有结构测试，不是性能测试 | 把 TP、package count、跨 package fabric、collective algorithm 参数化 | K3 至少 TP8/16/32 均能生成 trace、latency 和 breakdown |
| MR-004 | A1/A3/A10 | 缺少三模型 FLOP/token、有效 bytes/token、各层算术强度和 Roofline | 无法决定 Tensor/Vector/Indexer/Reduce 的规模 | 新增 arithmetic-intensity pipeline，按 operator、memory tier、通信域输出 roofline | 每模型×TP 至少输出 FLOP、bytes、AI、required effective FLOPS、required peak FLOPS |
| MR-005 | A5 | MC320/640 作为 raw、payload、sustained、effective 的语义未彻底分离 | MC640 可能被误读成可制造 baseline | 设 `raw/sustained/effective` 三层字段，标明供应商/假设/校准来源 | 任一 TPS 结果没有 sustained payload 就不能进入 G4 |
| MR-006 | A0/A10 | P1 的 998.81 TPS 不能外推 P0 | 物理 profile 与性能结论失真 | 所有结果强制携带 physical profile；P0 未跑时报告状态为 pending | CI 检查 P1 结果不得写入 P0 签核摘要 |
| MR-007 | A8 | collective 使用 `log2(TP)` 缩放，未表达真实拓扑、payload、拥塞和算法 | TP8/16/32 趋势不可信 | 为 all-reduce/all-gather/all-to-all 建 packet/flit/VC/credit replay | 每 TP 输出 hops、payload、queue wait、P50/P95/P99；禁止单一 log2 结果替代 trace |
| MR-008 | A1/A7/A8 | Expert dispatch/combine、all-to-all、capacity overflow、热点和 reroute 未事件级建模 | DeepSeek/GLM 的主要瓶颈可能完全遗漏 | 增加 token routing trace、capacity factor、overflow、home mapping、combine protocol | P99 expert load/mean、overflow rate、remote bytes 和尾延迟均可复现 |
| MR-009 | A1/A4/A9 | index cache、MTP draft/verify、accept/rollback 只是概念接口 | 长上下文和 MTP TPS 无法解释 | 定义容量、命中、分支、rollback bytes、epoch/commit，并进入 Tile IR | 每模型输出 hit rate、accept rate、rollback rate/bytes 和对应时间 |
| MR-010 | A10 | 18 个 TPS 槽位仅 2 个有结果 | 三模型架构目标无法比较 | 先完成 9 case × MC profile × seed 的可执行回放，未完成项保持 blocked | 18 槽位均有 E1/E2/E3 结果或明确 blocker |
| MR-011 | A11 | TPS 与功耗、热、DVFS、throttle 没有联合仿真 | 可能“性能达标但物理失效” | 建 peak/average/P95 power、温度、功率封顶和降频状态 | 每模型×TP 有 TPS/W、TPS/mm²、thermal margin、throttle TPS |
| MR-012 | A0/A10/A12 | 缺少统一 model manifest、Tile IR、simulator、source commit、seed 的组合 ID | 结果不可复现、不可审计 | 引入 `run_id` 和完整 provenance schema | 任一非 pending 结果可一键定位所有输入版本 |
| MR-013 | A3/A4/A5/A8/A10 | `lUtil=.6`、`hUtil=.6`、`vectorUtil=.25`、`expertFill`、`collectiveFactor`、`margin=1.17` 等经验缩放尚未校准 | 结果可能由调参而非架构产生 | 将缩放因子分为测量、校准、假设；逐项替换为资源/事件模型 | 报告列出每个缩放因子来源，未来源项不得用于 G4 |
| MR-014 | A0/A10 | `TPS = 1e6/e2e_us` 目前接近单 token 公式，缺少 steady-state warmup、测量窗口、多用户公平性 | TPS 定义可能与实际服务指标不一致 | 明确 warmup、steady-state、token window、并发用户、P50/P95/P99 和 fairness | 单用户与多用户结果分开；每个结果带 window/seed |
| MR-015 | A12/A13 | CI/报告未强制 model、TP、MC、physical profile、status、provenance 字段 | 可能出现数字存在但上下文缺失 | JSON Schema + negative tests + report gate | 缺字段、单位错误、P1/P0 混写、pending 有数值均失败 |
| MR-016 | A3/A10 | 当前 176.95 TFLOPS/Die 是阵列预设的数学 peak，不是由三模型算术强度反推的 sizing | 芯片算力可能过配或欠配 | 用 operator roofline 反推 L/H/Vector/Indexer/Reduce 的 effective/peak 需求，并留 headroom | 形成 model×TP×operator 类别的 sizing 表，且可回溯到 FLOP/bytes |

## 3. P1/P2 问题

### A0 Architecture Integrator

- 三模型目标尚未定义“每个模型分别达标”还是加权产品目标；建议 G4 采用逐模型硬门槛，另设加权容量规划指标。
- P0/P1、MODEL/STRETCH、MODEL_OBSERVED/SILICON_OBSERVED 的状态虽已写入文档，但缺少统一 CI policy。
- 缺少单一事实源，数字散落在 JSON、文档和代码中；应由 manifest/schema 生成摘要。

### A1 Workload / Manifest

- 当前 profile 是高层概况，不是逐层 operator manifest；K3 也未冻结正式 dtype/layout/KV/state。
- 1M context 被统一固定，但三模型 attention/state 语义不同，不能只共享一个 context 数字。
- 未定义 prefill、continuous batching、并发用户、MTP draft/verify/acceptance、expert capacity/overflow。
- 需要明确 active parameter、resident weight、streamed weight 的区别，避免容量与带宽重复计算。

### A2 Package / Floorplan

- 7-reticle placement window、die/MC 面积仍是规划守恒，不是坐标级 floorplan；缺少 shoreline、bump、RDL、clock/power/thermal keep-out。
- 384 expert home、index cache home、MC home 尚无物理映射，无法约束远端通信。
- 400 mm²/Die 的 SRAM、PHY、NoC、DFT、spare 面积密度缺乏工艺证据。

### A3 Compute Die / AI Core

- Sparse indexer、expert GEMM/dispatch、MTP、FP8/FP4 dequant、rollback/commit 没有独立执行资源模型。
- Vector/SFU/reduction/indexer 未独立 roofline；逻辑 tensor shape 也未形成物理 PE、bank、pipeline 的证据链。
- padding FLOP、effective FLOP、sparsity FLOP 尚未分账。

### A4 SRAM / TMA

- P0 96 MiB/Die 与 P1 当前可执行容量语义混杂；per-die、per-core、card aggregate 必须在 schema 中分层。
- index cache、expert staging、MTP branch state 未有容量/port/bank/eviction 模型。
- TMA descriptor 尚不能表示 sparse gather、expert dispatch/combine 和 rollback buffer；SRAM 总 TB/s 不能替代 bank/port/arbiter/queue。

### A5 MC

- 仍缺 channel/bank/queue、read/write turnaround、ECC/retry、热点与地址映射；weight/KV/index/expert/metadata 应逐项拆账。
- 320 baseline 与 640 stretch 必须在报告中分层，且自动阻止把 stretch 写成默认制造路线。

### A6 Die-local NoC

- 尚无 packet/flit/VC/credit、QoS、deadlock、starvation 的可执行模型；新增 INDEXER、ROUTER、EXPERT、MTP 流量类未接入。
- endpoint 数量与 8L+8H、SRAM slice、MC gateway、PHY 的物理对应关系未闭合。

### A7 Package Fabric

- 4×2 mesh 仍为候选拓扑，未闭合 link width、lane、编码、时钟和 PPA；TP rank 与 package 数、跨 package collective 边界不清。
- fault reroute 和单 die/MC/link 降级路径只有目标，没有性能结果。

### A8 RDMA / Collective

- mailbox/epoch/replay 状态机没有三模型 golden trace；timeout、duplicate、stale epoch 和 recovery 需纳入测试。
- all-to-all 与 reduce-scatter 应使用真实 topology/algorithm 选择，而非一个统一 latency factor。

### A9 Tile IR / Scheduler

- Tile IR 尚未成为机器可读 schema；缺少 model_id、expert_id、precision_path、index_cache_key、candidate_token_group、accept_mask、rollback_epoch、deadline/reservation。
- 当前 K3 simulator 直接在代码中生成算子，尚未实现 manifest → Tile IR → transaction trace 的统一流水。
- host launch count、firmware/compiler/scheduler overhead 尚未计入 TPS。

### A10 Performance Integration

- 目前 K3 simulator 固定 93 层和 K3 结构，无法证明 GLM/DeepSeek 或不同层数的可执行性。
- P50/P95/P99 尚未覆盖三模型×TP×MC×seed；结果缺少 bottleneck attribution 自动化。
- 应将 per-user TPS、system throughput、package throughput、fairness 分开，避免指标混淆。

### A11 PPA / Thermal / RAS

- P0 的 250 W/Die、3200 W/package 是预算，不是热/电/封装联合结果；VRM、RDL、MC 功耗和冷却路径缺少闭环。
- single die/MC/link、power cap、thermal throttle 的 degraded TPS 尚未量化。

### A12 Verification

- 当前测试偏 JSON 结构和 K3 守恒；缺少三模型事件级 golden trace、非法 dtype/TP/PP、单位错误、模型字段缺失和版本漂移负测。
- TPS 检查尚未强制 `tps=1e6/e2e`、P50≤P95≤P99、seed 覆盖、source_commit 和 profile version。

### A13 Documentation / Reports

- 报告生成主要面向 K3，尚无三模型 operator breakdown、arithmetic intensity、Roofline、compute sizing 和 TPS trend 自动报告。
- 当前仓库出现 UTF-8 文档在 PowerShell 中乱码显示；应统一 UTF-8 读写与 CI 编码检查，避免协作维护风险。

## 4. 依赖关系与建议并行拆分

```text
MR-001/MR-009  ->  MR-004  ->  MR-016  ->  MR-002/MR-003
       |             |          |
       v             v          v
MR-008 ---------> MR-007 -> MR-010 -> MR-011
       \-------------------------------> MR-012/MR-015
```

建议并行 agent：

| Agent | 独立交付 | 量化出口 |
|---|---|---|
| A1 | 三模型逐层 manifest + operator DAG | 3×3 case 可生成；每层 FLOP/bytes/state |
| A2 | P0 floorplan coordinate schema | 8 die + 16 MC 坐标、shoreline/keep-out 守恒 |
| A3 | AI core roofline/sizing | L/H/Vector/Indexer/Reduce 的 required/effective/peak |
| A4 | SRAM/TMA transaction model | bank/port/occupancy/index/MTP 事件 |
| A5 | MC sustained bandwidth model | 6 类 bytes + queue/tail + MC320/640 |
| A6/A7 | NoC/package packet model | flit/hop/VC/credit/拥塞/P99 |
| A8 | collective/expert protocol | all-to-all、dispatch/combine、MTP trace |
| A9 | Tile IR + scheduler | manifest→IR→trace，host launch=0/steady-state |
| A10 | 18-slot performance runner | 18×5 seeds，P0/P1 分离，完整 provenance |
| A11 | PPA/thermal/RAS | TPS/W、thermal margin、degraded TPS |
| A12/A13 | schema/CI/report | negative tests、Roofline/TPS/PPA 报告和 gate |

## 5. 修复顺序与退出条件

### W0：输入冻结前的阻塞清理

- 完成三模型授权/配置状态和逐层 manifest。
- 定义 workload、Tile IR、transaction、result provenance schema。
- 冻结 TPS steady-state 口径和 G4 逐模型门槛。

退出：MR-001、009、012、014、015 关闭或显式 blocked。

### W1：算术强度和物理可执行性

- 输出 operator-level arithmetic intensity/Roofline。
- 将 TP、P0/P1、MC raw/sustained 参数化。
- 完成 P0 die/SRAM/NoC/floorplan 资源映射。

退出：MR-002、003、004、005、006、016 关闭。

### W2：通信与长上下文执行闭环

- 真实 collective/all-to-all/dispatch/combine/index/MTP 事件级回放。
- 完成 queue/VC/credit、cache hit/miss、rollback、P99。

退出：MR-007、008、009 关闭。

### W3：18 槽位与 PPA 联合验证

- 三模型×TP8/16/32×MC320/640×5 seeds。
- P0/P1 分离报告；输出 TPS、breakdown、PPA、tail latency、failure mode。

退出：MR-010、011、013 关闭。

### G4：架构签核

仅当以下条件全部满足：

1. 三模型均有可执行且版本锁定的 manifest；
2. P0 已完成事件级回放，P1 不得替代 P0；
3. 18 个观测槽位有结果或有明确、可审计的 blocker；
4. 每模型 TP8/16/32 均有可解释的 TPS、P50/P95/P99 和瓶颈分解；
5. MC320/MC640 语义分离，stretch 不冒充 baseline；
6. Roofline 推导的算力、SRAM、带宽、NoC 和集体通信资源全部满足；
7. 功耗、热、RAS 降级结果满足产品门槛；
8. 所有结论可由 run_id、source commit、manifest/IR/simulator 版本复现。

## 6. 当前是否允许签核

**不允许。** 建议将当前状态标记为：

```text
architecture_status = BLOCKED_BY_MODEL_AND_EXECUTION_CLOSURE
primary_blockers = [MR-001, MR-002, MR-003, MR-004, MR-010, MR-011, MR-016]
```

下一步应优先由 A1、A3、A9、A10 并行推进；A0 负责合并 contract，A12 在每个 contract 落地后补充负测和 gate。
