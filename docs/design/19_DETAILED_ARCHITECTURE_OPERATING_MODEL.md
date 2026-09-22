# 详细架构设计 Operating Model

版本：2026-09-22  
状态：`BASELINE / DETAIL DESIGN FLOW v0.2`

## 1. 设计原则

详细架构设计不是把 Stage A 的粗略 TPS 直接拆成若干技术专题，也不是从某一个算子开始无限细化。它要沿着同一条证据链逐层回答：

```text
架构方向是否值得细化？
  -> 工作负载和资源墙是否闭合？
  -> 算子如何映射为 tile、buffer、transaction 和 cycle？
  -> 这些事件能否被调度、重叠并满足 PPA？
  -> 最终细粒度 TPS 是否仍支持原来的方向？
```

因此 Stage B 采用 **问题驱动的六个工作包**，而不是简单的 Q1→Q2→Q3→… 串行列表：

```text
B0 控制面与候选绑定
  -> B1 工作负载/算术强度/资源 sizing
  -> B2 物理映射与事件生成（Q3/Q4/Q5 并行）
  -> B3 执行实现与 PPA（Q6/Q7 并行）
  -> B4 细粒度 TPS 集成
  -> B5 验证、Q-Gate 与架构反馈
```

关键区别：

- **B1 先判断方向是否仍成立**，不能一开始就投入大量 tile 和 packet 细节；
- **B2 才把算子展开到物理资源**，Q3/Q4/Q5 共享同一个 manifest hash 和 operator_id；
- **B3 关注可执行性**，把软件 overlap、队列、PPA、热和故障纳入 critical path；
- **B4 不只输出一个 TPS**，还必须解释 Stage A 粗估与 Stage B 细估的差异；
- **B5 可以把问题退回 Stage A**。如果 Roofline、带宽、通信或 PPA 改变了架构方向，必须通过 A0 和 ADR 回流，不允许在 Q 阶段偷偷改 profile。

## 2. Stage B 的层级结构

| 层级 | 工作包 | 核心问题 | 主要 Agent | 主要输出 |
|---|---|---|---|---|
| L0 | B0 Control Plane | 本次到底量化哪个候选、哪个模型和哪个 profile？ | A0/Q0 | detail run manifest、provenance |
| L1 | B1 Quantification | 工作负载、算术强度、Roofline 和资源 sizing 是否支持方向？ | Q1/Q2 | manifest、DAG、operator ledger、sizing |
| L2 | B2 Physical Mapping | 算子如何使用 tile、SRAM、MC、NoC、collective 和 Core？ | Q3/Q4/Q5 | event traces、kernel cycles |
| L3 | B3 Execution Realization | 事件能否被调度、重叠，并满足 PPA/thermal/RAS？ | Q6/Q7 | schedule、critical path、PPA |
| L4 | B4 System Integration | 细粒度路径到底产生多少 TPS/usr？ | Q8 | fine TPS、percentiles、delta attribution |
| L5 | B5 Verification/Governance | 证据完整吗？应该签核、阻塞还是回流？ | Q9/A0 | Q-Gate、ADR、feedback packet |

机器可读定义位于：

```text
data/analysis/detailed_architecture_operating_model.json
```

## 3. B0：控制面与候选绑定

### 3.1 目标

在任何 Q Agent 开始工作前，先冻结本次 run 的边界：

- `candidate_id`：来自 `data/governance/candidate_register.json`；
- `runMode`：`FORMAL_QUANTIFICATION` 或 `EXPLORATORY_AFTER_BLOCKED_D_GATE`；
- `model_id`：K3、GLM-5.2、DeepSeek-V4-Pro 分开处理；
- `physicalProfile`：P0/P1；
- `mcProfile`：MC320/MC640；
- `tp/cp/ep`、phase、batch、context；
- source commit、input hashes、manifest hash、seed 或 deterministic replay。

Stage A D-Gate 没有通过时，B0 只能创建探索性 run。探索性 run 可以提前暴露 sizing 风险，但不能产生正式候选、fine TPS sign-off 或 silicon claim。

### 3.2 Q0/A0 输出

```text
detail_run_manifest
candidate_binding
provenance_bundle
blocked_configuration_list
```

### 3.3 B0 退出条件

- 候选来源唯一且可追溯；
- 所有模型都有明确的 `FROZEN`、`PLANNING` 或 `BLOCKED_CONFIG` 状态；
- P0/P1、MC320/MC640 没有混用；
- 后续所有产物共享同一 `run_id` 和输入 hash。

## 4. B1：工作负载、算术强度与资源 sizing

B1 是详细设计中的第一个实质性决策包。它不是 Q2 单独完成的数学报告，而是 Q1 和 Q2 共同判断“该方向是否值得继续细化”。

### 4.1 Q1：Manifest / Operator DAG

Q1 将模型描述转换为可执行的逐层输入：

```text
model manifest
  -> layer manifest
  -> operator DAG
  -> shape / dtype / layout
  -> KV/state / expert / index / MTP metadata
  -> TP/CP/EP placement contract
```

未知配置必须输出 `BLOCKED_CONFIG`，不得用经验值静默补全。Q1 的核心输出是 `manifest_hash`，Q2-Q8 都必须引用同一个 hash。

### 4.2 Q2：Arithmetic Intensity / Roofline / Sizing

Q2 按 operator 和 resource class 计算：

```text
FLOP/token
weight/KV/index/expert/collective bytes/token
I_MC = FLOP / memory_bytes
I_network = FLOP / (memory_bytes + collective_bytes)
ridge = effective_peak / sustained_bandwidth
roofline = min(effective_peak, intensity × sustained_bandwidth)
required_peak / available_peak
required_bandwidth / available_bandwidth
required_network / available_network
```

L、H、Vector、Indexer、Reduce 必须分开。对于 K3、GLM-5.2、DeepSeek-V4-Pro，MoE routing、indexer、KV/state、MTP 和 collective payload 也必须分开记账。

### 4.3 B1 的关键输出

```text
operator_dag
operator_ledger
roofline_ledger
sizing_summary
quantification_blockers
architecture_wall_classification
```

### 4.4 B1 退出条件

1. FLOP、byte、TP shard、网络字节和单位守恒；
2. 计算、内存、网络三个 sizing 比率都存在；
3. 每个 operator 有 `operator_id`、`core_class`、`status`、`confidence` 和 source；
4. 结论能区分：
   - `LOCAL_DETAIL_FIX`：只需改变 tile、buffer 或 schedule；
   - `DIRECTION_BACKFLOW`：需要返回 D2/D3/D4/D7；
   - `BLOCKED_CONFIG`：等待模型配置；
5. 如果 required/available 或 bandwidth wall 证明方向不成立，不得继续无限细化，应先回流 A0。

## 5. B2：物理映射与事件生成

B2 只在 B1 通过后展开，Q3/Q4/Q5 可以并行，但必须使用同一个 operator DAG、manifest hash 和 profile。

### 5.1 Q3：Tile / Memory Events

```text
operator
  -> tile shape
  -> local/shared SRAM buffer
  -> TMA descriptor
  -> MC transaction
  -> bank/port/queue/backpressure
  -> completion/poison
```

验收重点：实际 issued bytes、bank conflict、buffer lifetime、MC queue wait、SRAM/TMA service time 和事件守恒。

### 5.2 Q4：NoC / Collective Events

```text
collective intent
  -> packet/flit
  -> VC/credit
  -> hop/route
  -> congestion
  -> ready/ACK/replay
  -> P50/P95/P99 latency
```

必须区分 package-local、cross-package、TP、CP、EP、dispatch/combine 和 LSE `m/l/O` 语义。不能只用 `log2(TP)` 代替拓扑和队列事件。

### 5.3 Q5：Kernel Cycle / AI Core

```text
operator shape + tile
  -> L/H/Vector/Indexer/Reduce mapping
  -> issue/pipeline/occupancy
  -> dequant/accumulation/padding
  -> stall/utilization
  -> kernel cycle trace
```

数学 peak、effective peak 和实际 cycle 必须分开；利用率必须能够由 trace 重建。

### 5.4 B2 退出条件

- 每一个 event 能回到 `operator_id`、`layer_id`、`tile_id`、`manifest_hash`；
- bytes、flops、transaction count、buffer lifetime 和 credit 守恒；
- normal、backpressure、timeout、poison、replay 路径有事件表达；
- 不存在无来源的全局 speedup 或 utilization multiplier。

## 6. B3：执行实现与 PPA

B3 关注“能否实际跑起来”，不再把 event trace 当作最终性能。

### 6.1 Q6：Scheduler / Software Events

Q6 将软件优化转成可回放的 schedule：

- persistent decode step；
- fusion、prefetch、weight reuse；
- host launch、firmware、barrier、reservation；
- MTP acceptance/rollback；
- overlap、critical path、deadline 和 backpressure。

每一个软件收益都必须能反映为 event、launch count、bytes、queue wait 或 critical-path 改变。

### 6.2 Q7：PPA / Thermal / RAS

Q7 结合 activity trace 检查：

- area budget；
- average/P95/peak power；
- thermal hotspot、DVFS、throttle；
- MC/Die/link failure 和 degraded TPS；
- P0/P1 独立的物理约束。

Q7 如果发现面积、功耗或热约束需要改变 L/H/Core/MC/NoC 方向，必须通过 A0 建立 `PPA_DIRECTION_BACKFLOW`，不能只在 Q7 报告中缩小一个系数。

### 6.3 B3 退出条件

- 产生可回放的 schedule trace 和 critical path；
- P50/P95/P99 的输入样本或 deterministic replay 已准备；
- 功耗、热、故障和降级模式均有独立结果；
- 所有超预算项有 blocker、owner 和下一步。

## 7. B4：系统性能集成

Q8 不负责重新发明算子、通信或 PPA 模型，只合并上游证据：

```text
Q1 manifest
 + Q2 ledger/Roofline
 + Q3 memory events
 + Q4 packet events
 + Q5 kernel cycles
 + Q6 schedule
 + Q7 PPA/RAS
 -> critical path
 -> latency breakdown
 -> fine TPS matrix
```

必须输出：

- 三模型 × TP8/16/32 × MC320/MC640 的 18 slot 状态；
- P0/P1 分离；
- compute、memory、NoC、collective、scheduler、thermal breakdown；
- P50/P95/P99；
- Stage A 粗 TPS 与 Stage B 细 TPS 的差异百分比和原因；
- `MODEL_OBSERVED`、`PENDING_MODEL_RUN`、`BLOCKED_CONFIG`、`SILICON_OBSERVED` 状态。

如果只有 K3 能生成 operator ledger，GLM-5.2 和 DeepSeek-V4-Pro 必须在相应 slot 标记 blocker，不得伪造 fine TPS。

## 8. B5：验证、Q-Gate 与反馈

Q9 负责证据检查，A0 负责决策，不允许 Q8 自己宣布通过。

### 8.1 Q-Gate 最小条件

1. Q1 manifest 完整，或所有缺失配置都为可审计 blocker；
2. Q2-Q8 使用同一 manifest hash；
3. TP8/TP16/TP32 可执行，或每个槽位有明确 blocker；
4. P0/P1、MC320/MC640 完全分离；
5. 18 个 TPS slot 有结果或 terminal blocker；
6. source commit、input hashes、manifest hash、seed/replay、profile、unit contract 完整；
7. 算术、bytes、time、capacity、credit、transaction、epoch 守恒通过；
8. Stage A 与 Stage B 差异完成归因；
9. 细粒度结果满足 PPA、thermal、RAS 和 P99 约束。

### 8.2 决策分支

```text
Q-Gate
├── PASS
│   └── A0 冻结架构，并生成 ADR / Architecture Sign-off
├── BLOCKED_CONFIG
│   └── 回到 Q1，补齐模型、dtype、state、routing 或 license/config 证据
├── LOCAL_DETAIL_FIX
│   └── 回到 Q2/Q3/Q4/Q5/Q6/Q7，不改变 Stage A 候选
├── PPA_DIRECTION_BACKFLOW
│   └── 回到 D2/D3/D5/D6/D7，修改候选或资源 envelope
└── PERFORMANCE_MISS
    └── 先定位 memory/compute/network/scheduler/thermal，再决定局部修复或方向回流
```

## 9. 详细设计文档模块树

```text
docs/design/detailed/
├── README.md
├── 00_DETAILED_DESIGN_CONTROL_PLANE.md
├── 01_Q1_MANIFEST_OPERATOR_SPEC.md
├── 02_Q2_ARITHMETIC_INTENSITY_ROOFLINE_SPEC.md
├── 03_Q3_TILE_MEMORY_EVENT_SPEC.md
├── 04_Q4_NOC_COLLECTIVE_EVENT_SPEC.md
├── 05_Q5_KERNEL_CYCLE_SPEC.md
├── 06_Q6_SCHEDULER_EVENT_SPEC.md
├── 07_Q7_PPA_THERMAL_RAS_SPEC.md
├── 08_Q8_FINE_TPS_INTEGRATION_SPEC.md
├── 09_Q9_VERIFICATION_GATE_SPEC.md
└── templates/
    ├── DETAIL_AGENT_TASK_CARD.md
    └── DETAIL_HANDOFF_PACKET.md
```

每个详细设计文档必须采用同一模板：

```text
1. Decision question
2. Inputs and version/hash
3. Output contract
4. Operator/tile/resource mapping
5. Timing and conservation equations
6. Normal/backpressure/error/reset behavior
7. P50/P95/P99 and PPA impact
8. Evidence level and assumptions
9. Tests and golden trace
10. Exit criteria and open issues
```

## 10. 并行组织与合并顺序

### 第一批：B0/B1

```text
A0/Q0：candidate binding + provenance
Q1：manifest/operator DAG
Q2：arithmetic/Roofline/sizing
```

Q1 和 Q2 不应完全无依赖地并行：Q2 可以先准备公式和资源 profile，但正式 ledger 必须等待 Q1 的 manifest hash。

### 第二批：B2

```text
Q3：tile/memory
Q4：NoC/collective
Q5：kernel cycle
```

这三个 agent 并行，消费同一 B1 handoff packet。

### 第三批：B3

```text
Q6：scheduler/software
Q7：PPA/thermal/RAS
```

Q6 需要 Q3/Q4/Q5 的事件；Q7 可以在 B1 的资源预算和 B2 activity 草案基础上并行启动，但正式结果必须绑定 B2 trace。

### 第四批：B4/B5

```text
Q8：fine TPS integration
Q9：verification/gate
A0：decision and feedback
```

### 合并原则

- 先合并 schema/contract，再合并实现，再生成数据和报告；
- 同一 run 的产物必须有同一 `run_id`、profile、manifest hash 和 source commit；
- 任何跨模块变更必须先更新 handoff packet 或 ADR；
- 任何改变架构方向的反馈必须回到 D stage；
- 生成数据和报告不能手工修改，必须通过 runner 重建。

## 11. 当前状态映射

截至 2026-09-22：

| 工作包 | 当前状态 | 说明 |
|---|---|---|
| B0 | `PARTIAL` | 已有 candidate register、gate status、provenance 字段；正式 D-Gate 仍阻塞 |
| B1/Q1 | `PARTIAL` | K3 planning manifest；GLM-5.2、DeepSeek-V4-Pro 为 `BLOCKED_CONFIG` |
| B1/Q2 | `PLANNING_COMPLETE` | 已有 K3 arithmetic intensity、Roofline、compute/bandwidth/network sizing ledger |
| B2/Q3-Q5 | `BLOCKED_UPSTREAM` | 尚无共享 Tile/Packet/Kernel event replay |
| B3/Q6-Q7 | `BLOCKED_UPSTREAM` | 尚无可回放 schedule 和 activity-bound PPA |
| B4/Q8 | `BLOCKED_UPSTREAM` | 不输出 fine TPS sign-off |
| B5/Q9 | `Q_GATE_BLOCKED` | 独立 validator 保持 Q-Gate 阻塞 |

这不是把阻塞隐藏起来，而是把“先判断方向，再投入详细事件建模”的原则落实到工作流。
