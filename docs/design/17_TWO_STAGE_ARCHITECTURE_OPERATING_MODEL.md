# 两阶段架构设计 Operating Model

版本：2026-09-21  
状态：`PROPOSED / ARCHITECTURE OPERATING MODEL v0.1`
> 详细设计的工作包化组织见 [`19_DETAILED_ARCHITECTURE_OPERATING_MODEL.md`](19_DETAILED_ARCHITECTURE_OPERATING_MODEL.md)。Stage B 不再被视为 Q1-Q9 的无条件串行链，而是 B0 控制面、B1 量化闭环、B2 物理事件、B3 执行/PPA、B4 TPS 集成、B5 验证与反馈六个可门控工作包。

## 1. 核心设计思路

本项目不再把“算子级精确性能模型”作为架构设计的第一步，而采用两层闭环：

```text
Stage A：方向级架构探索（Architecture Direction）
  算术强度 + 带宽 + 集合通信延迟 + 粗算力 + 7-reticle 面积约束
  + 通常 AI Core 组织方式 + 多核扩展方式 + 简单软件优化
  -> 产生若干可行的架构候选和粗略 TPS/usr

Stage B：参数级架构验证（Architecture Quantification）
  选定候选架构
  -> 模型/算子级 FLOP、bytes、tile、queue、NoC、MC、collective、scheduler
  -> 事件级回放
  -> 细粒度 TPS/usr、P50/P95/P99、PPA、RAS
  -> 反馈 Stage A，淘汰或调整候选
```

Stage A 的目的不是给出最终 TPS，而是回答：

1. 架构方向是否明显受带宽、算力、通信或面积主导？
2. 7 个 reticle 下，计算 die、存储单元、PHY、互联和热预算是否存在可行组合？
3. L/H/Vector/Indexer/Reduce 的数量级应该如何分配？
4. TP8/16/32、package 数量和集合通信拓扑哪个方向值得进入细化？
5. 哪些“简单软件优化”能改变方向判断，哪些只能改善常数项？

Stage B 的目的才是回答：

1. 每个 operator 在具体 tile 和资源上的时间是多少？
2. 带宽、队列、拥塞和集合通信是否共同满足目标？
3. 粗略 TPS 是否在算子级回放中成立？
4. P0/P1、MC320/MC640 的结论是否可复现、可制造、可签核？

## 2. Agent 组织方式：从功能分组改为阶段+门控

### 2.1 Agent 层级

| 层级 | Agent | 责任 | 主要输出 |
|---|---|---|---|
| L0 | A0 Chief Architect / Integrator | 维护假设、候选、门控和架构决策 | candidate register、ADR、gate status |
| L1 | D1 Workload Direction | 模型族、decode/prefill、粗 FLOP/bytes、关键算术强度区间 | workload direction sheet |
| L1 | D2 Memory/Bandwidth Direction | MC、SRAM、带宽、容量、数据复用和带宽墙 | bandwidth budget |
| L1 | D3 Compute/Core Direction | 常见 AI core 构成、L/H/Vector/Indexer/Reduce、频率和粗 peak | compute envelope |
| L1 | D4 Communication Direction | TP/CP/EP、集合通信算法、hop、端到端通信延迟区间 | communication envelope |
| L1 | D5 Package/7R Direction | 7-reticle 面积、die 数量、存储集成、PHY/热/电 | package feasibility sheet |
| L1 | D6 Software Direction | fusion、persistent decode、prefetch、quantization、MTP 等常数项优化 | software optimization budget |
| L1 | D7 Directional TPS Integrator | 合并 D1–D6，输出粗略 TPS/usr 和候选排序 | candidate scorecard |
| L2 | Q1 Manifest/Operator | 冻结逐层输入，生成 operator DAG | model manifest、operator inventory |
| L2 | Q2 Arithmetic Intensity/Roofline | 算子 FLOP/bytes、I、Roofline、required FLOPS | arithmetic ledger、roofline |
| L2 | Q3 Tile/Memory Events | tile、SRAM、TMA、MC transaction | tile/event trace |
| L2 | Q4 NoC/Collective Events | flit、VC、credit、collective、all-to-all | packet trace、P99 communication |
| L2 | Q5 Kernel Cycle/AI Core | 具体 tensor/vector/indexer/reduce cycle | kernel cycle report |
| L2 | Q6 Scheduler/Software Events | reservation、launch、persistent step、firmware overhead | schedule trace |
| L2 | Q7 PPA/Thermal/RAS | 功耗、温度、降频、故障退化 | PPA/RAS report |
| L2 | Q8 Fine TPS Integrator | 汇总事件，输出细粒度 TPS/usr | detailed TPS matrix |
| L2 | Q9 Verification/Reports | schema、守恒、golden trace、报告和签核门控 | regression/gate report |

### 2.2 原 A0–A13 的调整

原来的 A1–A13 按子系统静态拆分，容易出现“每个模块局部完成，但架构方向没有先收敛”的问题。调整为：

- A0 保留为唯一架构集成 owner；
- 原 A1 workload 拆成 D1 + Q1；
- 原 A2 package 拆成 D5 + Q7；
- 原 A3 compute 拆成 D3 + Q5；
- 原 A4 SRAM/TMA、A5 MC 合并进入 D2 + Q3；
- 原 A6/A7/A8 拆成 D4 + Q4；
- 原 A9 scheduler 拆成 D6 + Q6；
- 原 A10 performance 拆成 D7 + Q8；
- 原 A11 PPA 拆成 D5/Q7；
- 原 A12/A13 合并为 Q9。

## 3. 两阶段交付目录

```text
docs/design/
  00_CURRENT_STATE.md
  01_HIGH_LEVEL_ARCHITECTURE.md
  02_OPERATING_MODEL.md                 # 本文档
  03_ARCHITECTURE_CANDIDATES.md         # Stage A 候选架构
  04_DIRECTIONAL_TPS_METHOD.md          # Stage A 粗略 TPS 方法
  05_DETAILED_QUANTIFICATION_METHOD.md  # Stage B 细粒度方法
  06_ARCHITECTURE_SIGNOFF.md
  decisions/
    ADR-*.md
  direction/
    D1_WORKLOAD_DIRECTION.md
    D2_MEMORY_BANDWIDTH_DIRECTION.md
    D3_COMPUTE_CORE_DIRECTION.md
    D4_COMMUNICATION_DIRECTION.md
    D5_PACKAGE_7R_DIRECTION.md
    D6_SOFTWARE_DIRECTION.md
    D7_DIRECTIONAL_TPS_SCORECARD.md
  detailed/
    Q1_MANIFEST_OPERATOR_SPEC.md
    Q2_ARITHMETIC_INTENSITY_ROOFLINE_SPEC.md
    Q3_TILE_MEMORY_EVENT_SPEC.md
    Q4_NOC_COLLECTIVE_EVENT_SPEC.md
    Q5_KERNEL_CYCLE_SPEC.md
    Q6_SCHEDULER_EVENT_SPEC.md
    Q7_PPA_THERMAL_RAS_SPEC.md
    Q8_FINE_TPS_INTEGRATION_SPEC.md
    Q9_VERIFICATION_REPORT_SPEC.md

data/
  direction/
    architecture_candidates.json
    directional_resource_envelope.json
    directional_tps_scorecard.json
  detailed/
    model_manifests/
    operator_ledgers/
    roofline/
    tile_events/
    packet_events/
    kernel_cycles/
    performance_results/

models/
  direction/
    roofline_sweep.js
    candidate_tps_estimator.js
  detailed/
    operator_to_tile.js
    event_replay.js
    sizing_engine.js

reports/
  direction/
  detailed/

verification/
  direction/
  detailed/
```

## 4. Stage A：方向级设计方法

### 4.1 输入

- 三模型的粗粒度模型族与配置状态；
- 目标 TPS/usr、context、batch、TP 候选；
- 7-reticle 面积窗口和 8 Compute Die + 16 MC 物理约束；
- MC raw/sustained/effective bandwidth 区间；
- SRAM 容量和层级区间；
- L/H/Vector/Indexer/Reduce 粗 peak 区间；
- package-local / cross-package collective latency 区间；
- 软件可获得的优化比例和风险等级。

### 4.2 最小公式

对每个候选架构 `c` 和模型 `m`：

```text
T_compute = FLOP_m / effective_compute_c
T_memory = bytes_m / sustained_bandwidth_c
T_collective = payload_m / effective_collective_bw_c + hops * link_latency_c
T_software = launch + scheduler + synchronization overhead
T_raw = max(T_compute, T_memory, T_collective) + T_software
T_e2e = T_raw * engineering_margin
TPS/usr = 1e6 / T_e2e_us
```

并行/流水化时允许保守地使用：

```text
T_raw = max(T_compute, T_memory, T_collective)
      + uncovered_stall
      + T_software
```

Stage A 不得把所有时间简单相加，也不得假设完全重叠；必须标注 overlap policy：`serial`、`max_overlap` 或 `partial_overlap`。

### 4.3 Stage A 输出

每个候选必须输出：

```text
candidate_id
model_id
phase
TP/CP/EP
physical_profile
MC profile
compute_time_us
memory_time_us
collective_time_us
software_overhead_us
uncovered_stall_us
e2e_estimate_us
tps_per_user
bottleneck
confidence
assumptions
next_detail_questions
```

额外输出：

- 资源墙：compute-bound / memory-bound / communication-bound；
- 7R area feasibility；
- 计算 die 面积/功耗粗预算；
- MC 容量/带宽可行性；
- core 数量区间；
- 下一阶段必须细化的 top-10 不确定项。

### 4.4 Stage A 的退出门槛 D-Gate

只有候选同时满足以下条件，才进入 Stage B：

1. 7-reticle area 守恒；
2. 计算 die、MC、PHY、interposer、thermal 都有预算；
3. 三模型均能生成粗略 TPS，不允许只优化 K3；
4. 每个候选有明确 bottleneck；
5. 至少一个候选在 baseline 资源下达到 `TPS >= 1000`，或已形成明确的带宽/通信/算力替代方案；
6. 所有结论标明 E0/E1 证据等级；
7. 完成 top-10 sensitivity sweep；
8. D7 选出不超过 3 个候选进入 Stage B。

## 5. Stage B：细粒度算子级方法

### 5.1 输入

- D-Gate 选定的 1–3 个架构候选；
- 逐层 manifest、dtype、layout、KV/state；
- Tile IR；
- AI core、SRAM/TMA、MC、NoC、package fabric、collective 和 scheduler 参数；
- P0/P1 和 MC320/MC640 独立 profile。

### 5.2 细粒度链路

```text
manifest
  -> operator DAG
  -> arithmetic ledger
  -> Tile IR
  -> SRAM/TMA events
  -> MC transactions
  -> NoC packets
  -> collective/RDMA events
  -> kernel cycles
  -> scheduler trace
  -> PPA/thermal
  -> fine TPS/usr
```

### 5.3 Stage B 输出

- operator-level FLOP/byte/arithmetic intensity；
- L/H/Vector/Indexer/Reduce Roofline；
- tile-level latency；
- memory/NoC/collective queue wait；
- P50/P95/P99；
- 18-slot TPS matrix；
- per-model bottleneck attribution；
- PPA/TPS/W/TPS/mm²；
- degraded mode TPS；
- run_id/provenance/golden trace。

### 5.4 Stage B 退出门槛 Q-Gate

1. 三模型逐层输入可生成 DAG 或明确 blocked；
2. TP8/16/32 可执行，不再硬编码 TP32；
3. 算术强度、Roofline、算力 sizing 与 event replay 使用同一 manifest；
4. P0/P1 分离；MC320/MC640 分离；
5. 18 个观测槽位都有结果或可审计 blocker；
6. 结果包含 P50/P95/P99、seed、source commit、profile；
7. 所有经验缩放因子均有来源或已替换为事件模型；
8. Q8 输出的 TPS 与 Stage A 粗估差异必须解释，不能静默覆盖。

## 6. 文档编写方式

每个方向级文档必须回答“为什么选择这个方向”，每个细节级文档必须回答“这个方向在具体资源上如何运行”。

### 方向级文档模板

```text
1. Decision question
2. Candidate options
3. Assumptions and evidence level
4. Resource envelope
5. Coarse formulas
6. Sensitivity table
7. Bottleneck classification
8. Architecture recommendation
9. What must be detailed next
10. Exit criteria
```

### 细节级文档模板

```text
1. Scope and input contract
2. Operator/tile mapping
3. Shapes, dtype, layout
4. FLOP and byte ledger
5. Resource reservation
6. Cycle/event model
7. Queue/backpressure/error behavior
8. P50/P95/P99 impact
9. PPA impact
10. Golden trace and tests
11. Assumptions/evidence
12. Open issues
```

### 决策记录模板

每次从 Stage A 进入 Stage B，必须创建 ADR：

```text
ADR ID
Decision
Options considered
Rejected options
Evidence
Coarse TPS impact
Area/bandwidth/latency impact
Detailed follow-up
Rollback condition
```

## 7. Agent 运作规则

1. Stage A Agent 只修改 `docs/design/direction/`、`data/direction/`、`models/direction/`、`reports/direction/`。
2. Stage B Agent 只修改 `docs/design/detailed/`、`data/detailed/`、`models/detailed/`、`reports/detailed/`。
3. A0 维护候选注册表和 Gate，不直接替代各 Agent 的模型实现。
4. Stage B 不得在没有 D-Gate 的情况下细化无限多个架构候选。
5. Q2 Arithmetic Intensity Agent 不单独决定架构；它必须向 D3、D2、D4 提供约束和 sizing 输入。
6. Stage A 的粗略 TPS 不能写成 silicon claim；Stage B 的模型 TPS 也不能写成 silicon claim。
7. 每一轮结果都必须携带 `candidate_id`、`model_id`、`profile`、`confidence`、`run_id`。
8. 方向级变更必须通过 ADR；算子级接口变更必须通过 schema version 和 contract test。
9. 任何方向候选被淘汰，保留其数据和原因，不删除历史结果。
10. 报告必须同时显示：粗估 TPS、细估 TPS、差异百分比和差异原因。

## 8. 建议的第一批并行任务

### Batch D0：架构方向

- D1：将三模型 profile 转成粗 FLOP/bytes 区间，并标出 pending 配置；
- D2：建立 MC/SRAM/带宽墙和容量墙 sweep；
- D3：建立 L/H/Vector/Indexer/Reduce core envelope；
- D4：建立 TP8/16/32 集合通信延迟 envelope；
- D5：建立 7-reticle area/floorplan/thermal envelope；
- D6：量化 persistent decode、fusion、prefetch、MTP、quantization 的软件收益上限；
- D7：合并候选并输出粗 TPS 排名，最多保留 3 个。

### Batch Q0：细化准备

- Q1：冻结选中候选的 manifest 和 operator inventory；
- Q2：执行 arithmetic intensity/Roofline/sizing；
- Q3：定义 Tile IR 到 memory event 的映射；
- Q4：定义 packet/collective event；
- Q5：定义 kernel cycle contract；
- Q6：定义 scheduler trace；
- Q7：定义 PPA/thermal/RAS 输入；
- Q8：准备 fine TPS runner；
- Q9：准备验证与报告。

## 9. 评价指标

### Stage A 指标

- 候选数：初始 6–12，D-Gate 后 ≤3；
- 每模型 TPS 粗估覆盖率：100%；
- sensitivity 维度：带宽、频率、core 数、通信 latency、软件收益、面积、功耗至少 7 个；
- 面积守恒误差：0；
- 方向级资源超限候选：全部标红并解释；
- 粗 TPS 与细 TPS 差异：进入 Stage B 后必须有归因，初始允许 ±30%。

### Stage B 指标

- operator ledger 完整率：100%；
- event trace 可回放率：100%；
- 18 个 TPS 槽位：全部有结果或 blocker；
- P50/P95/P99：全覆盖；
- arithmetic/byte/time conservation：100%；
- P0/P1、MC320/MC640 混用错误：0；
- 无来源经验缩放因子：0；
- 细 TPS 与粗 TPS 差异归因率：100%。

## 10. 最终原则

```text
先用少量高杠杆因素决定“走哪条架构路线”，
再用算子、tile、transaction 和 cycle 模型决定“这条路线是否真的能达到目标”。
```

没有 Stage A 的架构方向收敛，Stage B 会变成对错误架构的精确建模；没有 Stage B 的算子级回放，Stage A 的 TPS 只是数量级估计。
