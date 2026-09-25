# Agent Catalog and Interaction Protocol

版本：2026-09-21  
状态：`BASELINE / AGENT CONTRACT v0.1`

## 1. 目的

本文是项目的 Agent 总目录和交互协议。它把架构设计拆成两个有明确输入、输出、约束和交互关系的阶段：

```text
方向级架构设计（Direction Stage）
  -> 选择少量可行架构候选
  -> D-Gate

详细级架构设计（Quantification Stage）
  -> 将候选展开到 operator/tile/transaction/cycle
  -> Q-Gate
```

原则：

- Stage A 决定架构方向，不追求算子级精确；
- Stage B 验证方向是否能在具体硬件资源上兑现；
- Stage B 不能绕过 D-Gate 对无限候选进行细化；
- 每个结果都必须能回溯到 `candidate_id`、`model_id`、profile、版本和 run_id；
- Agent 之间通过机器可读 contract 和结构化 handoff 交互，而不是通过隐含假设。
详细架构设计的分层工作包、反馈路由和 handoff packet 由 [`19_DETAILED_ARCHITECTURE_OPERATING_MODEL.md`](19_DETAILED_ARCHITECTURE_OPERATING_MODEL.md) 与 `teams/council/inputs/detailed_architecture_operating_model.json` 定义。Q0 是控制面角色，和 A0 协作完成候选绑定；Q1-Q2 先完成工作负载/算术强度/sizing 判断，再启动 Q3-Q5 的并行事件建模。

## 2. 共享对象和生命周期

### 2.1 共享对象

| 对象 | Producer | Consumer | 生命周期 |
|---|---|---|---|
| Workload Profile | D1 | D2/D3/D4/D6/D7/Q1 | draft → reviewed → frozen/blocked |
| Resource Envelope | D2/D3/D4/D5 | D7/Q2/Q3/Q4/Q5/Q7 | draft → bounded → selected |
| Software Gain Budget | D6 | D7/Q6/Q8 | estimate → bounded → measured |
| Architecture Candidate | D7 | A0/Q1–Q9 | proposed → selected/rejected |
| Operator Manifest | Q1 | Q2–Q6/Q8/Q9 | draft → validated → frozen/blocked |
| Arithmetic Ledger | Q2 | Q3/Q4/Q5/Q8/Q9 | generated → checked → accepted |
| Event Trace | Q3–Q6 | Q8/Q9 | partial → replayable → accepted |
| PPA/RAS Result | Q7 | Q8/Q9/A0 | estimate → constrained → accepted |
| Gate Decision | A0/Q9 | all agents | open → pass/fail/blocked |

### 2.2 统一结果 envelope

所有 Agent 的机器可读输出都必须包含：

```json
{
  "schemaVersion": "...",
  "runId": "...",
  "stage": "direction | quantification",
  "agentId": "D1 | ... | Q9 | A0",
  "candidateId": "...",
  "modelId": "K3 | GLM-5.2 | DeepSeek-V4-Pro",
  "phase": "decode | prefill | both",
  "tp": 8,
  "cp": 1,
  "ep": 1,
  "physicalProfile": "P1",
  "mcProfile": "MC320 | MC640",
  "confidence": "E0 | E1 | E2 | E3",
  "status": "...",
  "inputs": [],
  "outputs": [],
  "assumptions": [],
  "constraintsChecked": [],
  "blockers": [],
  "nextActions": []
}
```

## 3. Agent 角色定义

## 3.1 A0：Chief Architect / Integrator

**职责**

- 维护目标、架构原则、候选注册表、D-Gate/Q-Gate；
- 管理跨 Agent 冲突和 ADR；
- 选择进入 Stage B 的候选，最多 3 个；
- 防止出现第二份硬件规格，防止 MC320/MC640、粗 TPS/细 TPS 混用；
- 将验证结果写入当前状态和签核文档。

**输入**

- 方向 Agent 报告；
- 详细 Agent 报告；
- 7-reticle baseline；
- TPS、PPA、RAS 和风险状态；
- Q9 gate report。

**输出**

- `architecture_candidates.json` 的选择状态；
- ADR；
- `gate_status.json`；
- 当前架构状态、blocker 和下一轮任务。

**约束**

- 不直接替代专业 Agent 的模型实现；
- 不得以单一最高 TPS 代替三模型判断；
- 不得把 planning estimate 写成 silicon claim；
- 所有跨模块决策必须有 ADR 和证据等级。

**交互**

```text
D1–D7 -> A0 -> D-Gate -> Q1–Q9 -> Q9 -> A0
A0 -> ADR/新候选 -> D1–D7 或 Q1–Q9
```

## 3.2 D1：Workload Direction

**职责**

- 形成三模型的粗粒度 workload envelope；
- 估算 decode/prefill 的 FLOP、weight/KV/index/expert/collective bytes 区间；
- 标记模型字段的 E0/E1/E2/E3 证据等级；
- 判断 workload 的主要算术强度和数据流特征。

**输入**

- `teams/model/inputs/model_profiles.json`；
- 公开模型资料和 K3 工程 preset；
- context、batch、TP/CP/EP 候选；
- 方向级目标。

**输出**

- `out/direction/workload_direction.json`；
- 每模型 decode/prefill 的粗 FLOP/byte 区间；
- attention/MoE/indexer/MTP 分类；
- 需要 Q1 冻结的字段列表。

**约束**

- 不得静默填补未知层数、dtype、expert 参数；
- GLM-5.2/DeepSeek-V4-Pro 未确认字段必须标为 pending；
- 输出是方向级区间，不得伪装成 operator 精确结果。

**交互**

```text
D1 -> D2,D3,D4,D6,D7
D1 -> Q1（候选选定后）
```

## 3.3 D2：Memory / Bandwidth Direction

**职责**

- 建立 MC、SRAM、TMA 和数据复用的粗资源墙；
- 区分 raw/sustained/effective bandwidth；
- 给出容量、带宽、队列和热预算的可行区间；
- 识别 memory-bound 候选和需要软件复用的方向。

**输入**

- D1 workload bytes 区间；
- 7R package/MC 数量与容量；
- 唯一硬件规格的 SRAM（`k3_mc_baseline.json#computeDieCandidate`、`#sramAccounting`）；
- MC320/MC640 profile；
- D5 的物理/热约束。

**输出**

- `out/direction/memory_bandwidth_envelope.json`；
- MC/SRAM bandwidth wall；
- capacity wall；
- weight/KV/index/expert/collective bytes budget；
- 对 D7 的 bandwidth-bound 结论和对 Q2/Q3 的细化问题。

**约束**

- raw 不得直接当 sustained；
- MC640 默认只能是 stretch，除非有明确证据；
- 不得将 SRAM aggregate 与 per-die 容量混用。

**交互**

```text
D2 <- D1,D5
D2 -> D7,Q2,Q3,Q7
```

## 3.4 D3：Compute / Core Direction

**职责**

- 规划通常 AI Core 的组成和数量级；
- 确定 L/H/Vector/Indexer/Reduce 的候选比例、频率和 peak 区间；
- 评估多核扩展方式：core pod、die、package、TP rank；
- 输出粗 compute roofline 和面积/功耗约束下的 core envelope。

**输入**

- D1 FLOP/intensity 区间；
- D2 bandwidth wall；
- D5 面积/功耗/热 envelope；
- AI Core 常见结构假设；
- TP8/16/32 目标。

**输出**

- `out/direction/compute_core_envelope.json`；
- L/H/Vector/Indexer/Reduce 数量区间；
- effective/peak FLOPS 区间；
- core pod/die/package 扩展方案；
- 对 Q5/Q7 的细化约束。

**约束**

- 数学 peak 不得直接视为 sustained peak；
- 不得把 Vector/Indexer/Reduce 隐藏到 Tensor peak；
- Core 数量必须受 7R 面积、SRAM、NoC、MC 和功耗约束；
- 不得仅以 K3 的算力需求决定三模型公共架构。

**交互**

```text
D3 <- D1,D2,D5
D3 -> D7,Q2,Q5,Q7
```

## 3.5 D4：Communication Direction

**职责**

- 规划 TP/CP/EP 的通信域和集合通信路径；
- 建立 package-local、cross-package、expert dispatch 的粗延迟/带宽 envelope；
- 比较 all-reduce、reduce-scatter、all-gather、all-to-all 的架构代价；
- 判断 communication-bound 候选。

**输入**

- D1 token/attention/MoE traffic；
- D5 package topology；
- MC/NoC 带宽 envelope；
- TP8/16/32 和 CP/EP 候选。

**输出**

- `out/direction/communication_envelope.json`；
- topology/algorithm 候选；
- hop、payload、latency、bandwidth 区间；
- D7 的通信瓶颈结论；
- Q4 的 packet/collective 细化问题。

**约束**

- 不得用单一 `log2(TP)` 代替真实 topology 方案；
- 需区分 package-local 与 cross-package；
- FFN/MoE 为 TP-only（ADR-0020），不建 expert all-to-all、dispatch/combine；
- 不能以理论带宽代替 sustained payload。

**交互**

```text
D4 <- D1,D5,D2
D4 -> D7,Q4,Q6
```

## 3.6 D5：Package / 7-Reticle Direction

**职责**

- 约束 7-reticle package 的计算 die、MC、PHY、interposer/RDL 和 thermal；
- 形成 8 Compute Die + 16 MC 的面积守恒与坐标级粗预算；
- 规划 die/package/core 的扩展层次；
- 输出封装可行性和 PPA 上限。

**输入**

- 7-reticle baseline；
- 计算 die、MC、PHY、RDL 面积估计；
- D2/D3 的资源候选；
- cooling、power envelope。

**输出**

- `out/direction/package_7r_envelope.json`；
- area budget、thermal/power budget；
- die/core/MC/PHY 数量和扩展约束；
- D7 的可行性过滤条件；
- Q7 的 floorplan/PPA 约束。

**约束**

- 必须满足 reticle/placement/area 守恒；
- 不能把 400 mm² die 上限当作实际已实现面积；
- 必须显式保留 PHY、RDL、DFT、clock、power、thermal keep-out；
- 面积取自规格文件（`estimatedAreaMm2`），不另写手工面积。

**交互**

```text
D5 -> D2,D3,D4,D7,Q3,Q4,Q7
```

## 3.7 D6：Software Direction

**职责**

- 只评估简单且可解释的软件优化收益上限；
- 覆盖 persistent decode、kernel fusion、prefetch、weight reuse、quantization、MTP/speculative decode、launch batching；
- 区分改变架构方向的收益和只改善常数项的收益。

**输入**

- D1 workload characteristics；
- D2 bandwidth wall；
- D3 core mapping；
- D4 communication pattern；
- 当前 scheduler/software assumptions。

**输出**

- `out/direction/software_gain_budget.json`；
- 每项优化的 best/expected/worst gain；
- 适用模型、风险、实现前提；
- D7 的软件修正项；
- Q6 的事件级实现清单。

**约束**

- 不能把未经验证的收益直接写入硬件能力；
- 每项收益必须标记 overlap、适用范围和证据等级；
- MTP 必须记录 acceptance/rollback；
- 量化收益必须记录精度、dequant 和累加代价。

**交互**

```text
D6 -> D7,Q6,Q8
D6 <- D1,D2,D3,D4
```

## 3.8 D7：Directional TPS Integrator

**职责**

- 汇总 D1–D6，生成 6–12 个架构候选；
- 使用粗粒度 roofline/带宽/通信/软件模型估算 TPS/usr；
- 输出 bottleneck、敏感性、候选排序和需要细化的问题；
- 选出最多 3 个进入 Stage B 的候选。

**输入**

- D1 workload envelope；
- D2 memory envelope；
- D3 compute envelope；
- D4 communication envelope；
- D5 package envelope；
- D6 software gain budget。

**输出**

- `out/direction/architecture_candidates.json`；
- `out/direction/directional_tps_scorecard.json`；
- 候选间 TPS/面积/功耗/风险对比；
- D-Gate 建议；
- 每个选中候选的 top-10 detail questions。

**约束**

- 必须覆盖三模型、TP8/16/32 和至少一个 MC baseline；
- 必须区分 compute-bound、memory-bound、communication-bound；
- 粗略 TPS 不得声称为最终可实现 TPS；
- 候选数量 D-Gate 后不得超过 3 个。

**交互**

```text
D1,D2,D3,D4,D5,D6 -> D7 -> A0
D7 -> D1–D6（敏感性补充）或 Q1–Q9（通过 D-Gate）
```

## 3.9 Q1：Manifest / Operator

**职责**

- 将选中候选绑定到三模型的逐层 manifest；
- 生成统一 operator DAG、shape、dtype、layout、KV/state、routing 描述；
- 处理未知配置并输出 blocked，而不是静默补齐。

**输入**

- D-Gate 选中的候选；
- D1 workload envelope；
- `model_profiles.json`；
- 模型版本和配置证据。

**输出**

- `out/detailed/model_manifests/`；
- operator inventory 和 DAG；
- manifest validation report；
- blocked field list；
- Q2–Q6 的统一输入版本。

**约束**

- 同一 run 的 Q2–Q8 必须使用同一 manifest hash；
- 未确认字段不能填成 final；
- 每个 operator 必须有单位、dtype、shape、layout 和来源；
- K3、GLM、DeepSeek 不得共用错误的层级假设。

**交互**

```text
D-Gate/A0 -> Q1 -> Q2,Q3,Q4,Q5,Q6,Q8,Q9
```

## 3.10 Q2：Arithmetic Intensity / Roofline

**职责**

- 计算 operator FLOP、bytes、I_MC、I_network；
- 输出 L/H/Vector/Indexer/Reduce Roofline；
- 反推 required effective/peak FLOPS 和 core sizing；
- 给 D3/Q5/Q8 提供瓶颈和 sizing 约束。

**输入**

- Q1 manifest/DAG；
- D2 memory envelope；
- D3 compute envelope；
- D4 communication envelope；
- 唯一硬件规格与 MC320/MC640 profile。

**输出**

- `out/detailed/operator_ledgers/`；
- `out/detailed/roofline/`；
- arithmetic intensity report；
- required/available peak ratio；
- sizing recommendation 和 blocked conditions。

**约束**

- 不得用单一 `2 × parameter_count` 代替注意力/MoE/通信建模；
- 不得把 raw bandwidth 当 sustained；
- 不得把 MC640 的模型内 sizing 当作可制造结论；
- Vector/Indexer/Reduce 必须独立建模。

**交互**

```text
Q1 -> Q2
Q2 -> Q3,Q5,Q8,Q9
Q2 -> D3（若 sizing 证明方向需要调整）
```

## 3.11 Q3：Tile / Memory Events

**职责**

- 将 operator DAG 切成 tile；
- 建模 Local/Shared SRAM、TMA、MC transaction、buffer lifetime 和 backpressure；
- 输出实际 memory service time 和 occupancy。

**输入**

- Q1 manifest/DAG；
- Q2 arithmetic ledger；
- D2 memory envelope；
- D5 package/NUMA mapping；
- 候选 Tile IR。

**输出**

- `out/detailed/tile_events/`；
- SRAM/TMA/MC 事件 trace；
- occupancy、queue wait、read/write bytes；
- Q4/Q5/Q8 的 memory timing 输入。

**约束**

- 必须分离 per-core、per-die、per-package SRAM；
- 必须显式 bank/port/queue/ECC 代价；
- 不能以总 TB/s 替代 bank-level service；
- event trace 必须守恒。

**交互**

```text
Q1,Q2,D2,D5 -> Q3 -> Q4,Q5,Q8,Q9
```

## 3.12 Q4：NoC / Collective Events

**职责**

- 将通信映射为 packet/flit/VC/credit/hop 事件；
- 建模 TP/CP/EP、all-reduce、all-gather、reduce-scatter、all-to-all、dispatch/combine；
- 输出拥塞、P50/P95/P99、重试和故障绕行代价。

**输入**

- Q1 DAG；
- Q2 collective bytes；
- D4 communication envelope；
- D5 topology；
- Q3 memory events。

**输出**

- `out/detailed/packet_events/`；
- packet trace、collective timing、queue/congestion；
- P50/P95/P99 communication latency；
- Q8/Q9 的通信输入。

**约束**

- 不得用单一 `log2(TP)` 代替真实拓扑事件；
- package-local 与 cross-package 必须分离；
- expert dispatch/combine 和 MTP control 必须显式出现；
- 必须验证 deadlock、credit、timeout、replay、stale epoch。

**交互**

```text
Q2,Q3,D4,D5 -> Q4 -> Q6,Q8,Q9
```

## 3.13 Q5：Kernel Cycle / AI Core

**职责**

- 将算术强度和 tile 映射到具体 L/H/Vector/Indexer/Reduce kernel cycle；
- 计算 issue、pipeline、occupancy、utilization、dequant 和 reduction 代价；
- 区分数学 peak、effective peak 和 measured/calibrated peak。

**输入**

- Q1 operator shapes；
- Q2 Roofline；
- Q3 SRAM/TMA timing；
- D3 core envelope；
- Q4 communication stall。

**输出**

- `out/detailed/kernel_cycles/`；
- kernel cycle report；
- per-core utilization；
- compute service time；
- Q8 的 compute input和 D3 的 sizing feedback。

**约束**

- utilization 必须有来源；
- FP8/FP4 dequant/accumulation 不能隐藏；
- padding/effective/sparse FLOP 必须分账；
- L/H/Vector/Indexer/Reduce 不得混为一个 peak。

**交互**

```text
Q2,Q3,Q4,D3 -> Q5 -> Q8,Q9
Q5 -> D3（发现 core direction 不可行时反馈）
```

## 3.14 Q6：Scheduler / Software Events

**职责**

- 将软件优化转成可执行的 schedule/event；
- 建模 persistent decode、launch count、fusion、prefetch、MTP acceptance/rollback、reservation/deadline；
- 计算 firmware/compiler/host overhead。

**输入**

- Q1 DAG；
- D6 software gain budget；
- Q3 memory events；
- Q4 communication events；
- Q5 kernel cycles。

**输出**

- `out/detailed/schedule_events/`；
- scheduler trace；
- launch/firmware/synchronization overhead；
- overlap/critical path；
- Q8 的 software timing 输入。

**约束**

- 软件收益必须可回放；
- host-independent decode 必须记录 host launch count；
- MTP 必须有 acceptance、rollback、commit bytes；
- 不得把软件优化直接当作硬件带宽或 peak。

**交互**

```text
D6,Q1,Q3,Q4,Q5 -> Q6 -> Q8,Q9
```

## 3.15 Q7：PPA / Thermal / RAS

**职责**

- 将候选和事件流映射到面积、功耗、温度、IR drop、DVFS、RAS；
- 计算正常、P95、peak、throttle 和 degraded-mode TPS 的约束；
- 输出与规格文件一致的 PPA 结果。

**输入**

- D5 package envelope；
- D2/D3 resource sizing；
- Q3 memory activity；
- Q4 communication activity；
- Q5 core activity；
- Q8 TPS candidate。

**输出**

- `out/detailed/ppa/`；
- area/power/thermal/RAS report；
- thermal throttle/DVFS curves；
- single-die/MC/link failure TPS；
- Q8/Q9/A0 的约束。

**约束**

- Die 与卡的功耗上限分开核算；
- peak/average/P95 power 必须分离；
- 预算值不能冒充 physical measurement；
- 故障降级模式必须有明确 route 和性能结果。

**交互**

```text
D5,D2,D3,Q3,Q4,Q5 -> Q7 -> Q8,Q9,A0
```

## 3.16 Q8：Fine TPS Integrator

**职责**

- 合并 Q2–Q7 的结果；
- 生成详细 token critical path 和 18-slot TPS matrix；
- 输出粗 TPS 与细 TPS 差异及归因；
- 判断模型、TP、MC 的独立结果。

**输入**

- Q1 manifest；
- Q2 ledger/Roofline；
- Q3 memory events；
- Q4 packet events；
- Q5 kernel cycles；
- Q6 schedule events；
- Q7 PPA/RAS。

**输出**

- `out/detailed/performance_results/`；
- `out/detailed/fine_tps_matrix.*`；
- latency breakdown；
- P50/P95/P99；
- bottleneck attribution；
- Q9/A0 的签核输入。

**约束**

- 不得静默覆盖 Stage A 粗估；
- 18 槽位必须有结果或 blocker；
- TPS 必须与 e2e latency 一致；
- 不得把 MC640 结果标成 MC320 或可制造默认结论。

**交互**

```text
Q2,Q3,Q4,Q5,Q6,Q7 -> Q8 -> Q9,A0
```

## 3.17 Q9：Verification / Report / Gate

**职责**

- 验证 schema、单位、守恒、版本、链接、profile 分离和结果 provenance；
- 维护 golden trace、回归矩阵和 D/Q gate；
- 生成可审阅报告，不改变模型语义。

**输入**

- 所有 Agent 的 machine-readable outputs；
- contract/schema；
- golden traces；
- test results。

**输出**

- `teams/vv/direction/` 和 `teams/vv/detailed/`；
- gate report；
- regression report；
- report index；
- blocker list。

**约束**

- schema 失败必须阻止 gate 通过；
- pending/blocked 结果不得有伪造 TPS；
- source commit、manifest hash、run_id 缺失时不得签核；
- 不得只验证 JSON 结构而跳过物理/时间守恒。

**交互**

```text
D1–D7 -> Q9（方向检查）
Q1–Q8 -> Q9 -> A0
Q9 -> A0 -> gate decision
```

## 4. 高层设计流程：Agent 交互时序

```text
A0 初始化目标/约束/版本
  |
  +--> D1：工作负载 envelope
  |       |
  |       +--> D2：带宽/容量墙
  |       +--> D3：粗算力/Core envelope
  |       +--> D4：通信 envelope
  |       +--> D6：软件收益预算
  |
  +--> D5：7R 面积/封装/热/电 envelope
          |
          +--> D2/D3/D4/D7

D1 + D2 + D3 + D4 + D5 + D6
  |
  v
D7：生成 6–12 个候选，估算粗 TPS，做敏感性分析
  |
  v
Q9：验证方向数据
  |
  v
A0：D-Gate
  |\
  | +--> 失败：退回 D1–D6，补假设/改候选
  |
  +--> 通过：选择 1–3 个 candidate_id
             |
             v
          Q1：冻结 manifest/operator DAG
             |
             +--> Q2：算术强度/Roofline/sizing
             |       +--> Q5：kernel cycle
             |       +--> D3：必要时反馈 core sizing
             |
             +--> Q3：tile/SRAM/TMA/MC events
             |       +--> Q4：NoC/collective events
             |
             +--> Q4：packet/collective
             |
             +--> Q6：scheduler/software events
             |
             +--> Q7：PPA/thermal/RAS
             |
             +--> Q8：细粒度 TPS
                         |
                         v
                      Q9：验证 Q-Gate
                         |
              +----------+----------+
              |                     |
          失败/不确定              通过
              |                     |
              v                     v
       返回 Q1–Q7 或 D 级       A0 架构签核/ADR
```

## 5. 高层 Agent 之间的交互规则

1. Agent 只能消费已发布版本的输入，不读取其他 Agent 的未提交工作区。
2. 交互必须通过 schema、JSON、报告或 ADR；不通过聊天上下文传递关键数字。
3. 每个 Agent 输出必须标明：输入版本、输出版本、假设、约束检查和 blocker。
4. Stage A 的输出以区间、敏感性和方向判断为主；Stage B 的输出以事件、守恒和可复现为主。
5. 若 Q2/Q5/Q8 发现 Stage A 的粗略假设改变架构方向，必须通过 A0 新建 ADR，回到 D 阶段，而不是直接在 Q 阶段偷偷改硬件 profile。
6. 若某 Agent 发现输入不足，输出 `BLOCKED_CONFIG` 和 `nextActions`，不得静默补全。

## 6. 详细设计流程：数据依赖和交互

### 6.1 Q1 → Q2：模型到算术强度

Q1 发布 manifest hash，Q2 只消费该 hash。Q2 输出每个 operator 的：

```text
FLOP
weight/KV/index/expert/collective bytes
I_MC
I_network
roofline bound
required effective/peak FLOPS
```

### 6.2 Q2 → Q3/Q4/Q5：算术强度到资源事件

- Q3 使用 Q2 的 bytes ledger 生成 tile 和 memory events；
- Q4 使用 Q2 的 collective bytes 生成 packet/collective events；
- Q5 使用 Q2 的 FLOP、shape、core class 生成 kernel cycle；
- 三者必须保留相同的 operator_id 和 manifest hash。

### 6.3 Q3/Q4/Q5 → Q6：硬件事件到软件调度

Q6 根据 memory、communication 和 kernel event 的 ready/deadline 生成 schedule，明确：

- reservation；
- launch count；
- overlap；
- backpressure；
- persistent decode；
- MTP commit/rollback。

### 6.4 Q6/Q7 → Q8：事件到 TPS

Q8 构建 critical path：

```text
T_e2e = warmup + steady_state_critical_path + drain + margin
TPS/usr = 1e6 / e2e_latency_us_per_token
```

Q8 必须同时输出：

- compute time；
- SRAM/TMA time；
- MC wait；
- NoC/collective time；
- scheduler/firmware overhead；
- thermal/DVFS adjustment；
- P50/P95/P99。

### 6.5 Q8 → Q9 → A0：结果到决策

Q9 验证守恒与 provenance，A0 根据 Q-Gate 做决策：

- 通过：冻结架构方向并进入详细 spec；
- 性能不足：定位 bottleneck，指定 D/Q Agent 重新建模；
- 配置不足：保持 blocker，不得给出最终结论；
- PPA 不足：退回 D5/D2/D3/Q7 重新分配面积、带宽和算力。

## 7. Agent 任务卡模板

```text
Agent ID:
Stage: Direction | Quantification
Owner:
Objective:

Inputs:
- artifact:
- schema/version:
- assumptions:

Outputs:
- document:
- machine-readable result:
- executable model:
- tests:

Constraints:
- allowed paths:
- forbidden paths:
- units:
- evidence level:
- profile separation:

Interactions:
- upstream:
- downstream:
- feedback path:

Acceptance:
- invariants:
- coverage:
- gate:

Handoff:
Scope:
Decision:
Assumptions:
Files:
Validation:
Risks:
Next:
```

## 8. 当前项目下一轮建议

### Batch D0：先做方向级

1. D1 输出三模型 workload direction envelope；
2. D2 输出 MC/SRAM bandwidth/capacity envelope；
3. D3 输出 L/H/Vector/Indexer/Reduce core envelope；
4. D4 输出 TP8/16/32 communication envelope；
5. D5 输出 7R package feasibility envelope；
6. D6 输出软件优化收益上限；
7. D7 输出候选和粗 TPS ranking；
8. A0/Q9 执行 D-Gate。

### Batch Q0：D-Gate 通过后

1. Q1 冻结 manifest；
2. Q2 完成 arithmetic intensity/Roofline/sizing；
3. Q3/Q4/Q5 并行生成硬件事件；
4. Q6 合并调度；
5. Q7 并行评估 PPA；
6. Q8 输出细 TPS；
7. Q9 执行 Q-Gate。

## 9. 结论

Agent 不再只是按“模块名称”排列，而是按“架构阶段”和“信息流”组织：

```text
方向 Agent 决定候选
  -> 门控
详细 Agent 验证候选
  -> 反馈
架构 Agent 决策
```

这样既保留并行开发效率，又避免在架构方向没有确定前过早进入过细的算子级实现。
