# K3 7-Reticle 架构并行 Agent 计划

版本：2026-09-21
状态：`BASELINE / READY FOR PARALLEL EXECUTION`

> 配套量化验收矩阵：[`AGENT_METRICS_MATRIX.md`](AGENT_METRICS_MATRIX.md)。每个 Agent 的指标、单位、P0/P1 profile 和退出条件以该矩阵为准。

## 1. 目标

本计划用于把 K3 7-reticle 单芯片架构拆分成可并行、可合并、可验证的 agent workstream，目标是在不破坏公共架构契约的前提下，加速达到：

- K3 Decode inference；
- B=1、Context=1M、TP32、PP=1；
- 端到端目标 `1000 TPS/usr`；
- 架构冻结门槛 `>=1050 TPS/usr`；
- 7-reticle package：8 Compute Die + 16 MC；
- P0 physical primary：400 mm²/Die、8 L + 8 H、96 MiB data SRAM/Die；
- P1 compact executable：当前 4 L + 4 H、44 MiB/Die 模型，用于持续回归和对照。

## 1.1 多模型扩展

- A10维护TPS观测矩阵；任何性能优化必须更新对应model×TP×MC观测项，不能只更新最高TPS。

本计划同时服务三个模型 profile：`K3`、`GLM-5.2`、`DeepSeek-V4-Pro`。每个 Agent 的交付必须包含 `model_id` 维度，不能只验证 K3 后声称平台通用。

- A1 为三个模型维护独立 manifest、DAG、state、dtype 和 routing profile；
- A3–A9 必须支持 sparse index、MoE expert dispatch/combine、MTP 分支和 FP8/FP4 precision path 的可配置建模；
- A10 必须生成 `3 models × 2 physical profiles × 2 MC profiles` 的结果矩阵；
- A11 以三模型最坏功耗、热和带宽场景作为 P0 签核输入；
- A12 为每个模型提供 golden trace、fault trace 和 P0/P1 隔离测试；
- GLM-5.2 和 DeepSeek-V4-Pro 的正式部署配置、权重格式、dtype 和专家路由在确认前标记为 `MODEL_PENDING_CONFIG_CONFIRMATION`，不得伪造最终性能结论。
## 2. 并行设计原则

### 2.1 分支隔离

每个 agent 使用独立分支，不直接向 `main` 推送：

```text
agent/<id>-<workstream>
```

每个 agent 原则上只修改自己的 ownership 目录。跨模块接口只通过：

1. proposal 文件；
2. ADR；
3. 机器可读 schema；
4. 最小化测试；
5. 集成 agent 的受控合并。

### 2.2 不允许并发修改的公共文件

以下文件由 Architecture Integrator 独占维护，其他 agent 不直接修改：

```text
docs/design/00_CURRENT_STATE.md
docs/design/HIGH_LEVEL_ARCHITECTURE.md
docs/design/DECISIONS.md
docs/design/OPEN_ISSUES.md
docs/design/spec/k3_7r_package_baseline.json
package.json
AGENTS.md
```

agent 只能在自己的 branch 提交建议，由 Integrator 在合并时统一更新这些文件。

### 2.3 两套 profile 必须分离

所有 agent 的报告、模型和测试必须明确标注：

| Profile | 用途 | 规格 |
|---|---|---|
| `P0-7R-physical` | 封装、面积、SRAM、PPA 主规划 | 8 L + 8 H、96 MiB/Die、400 mm²/Die、16 MC/package |
| `P1-compact-executable` | 现有代码回归和可执行对照 | 4 L + 4 H、1.2 GHz、44 MiB/Die、面积见 `00_CURRENT_STATE.md` 第 2 节 |

禁止把 P1 的性能结果直接写成 P0 的最终签核结果。

## 3. Agent 角色总表

| ID | 角色 | 主要目录 | 是否关键路径 |
|---|---|---|---|
| A0 | Architecture Integrator / Chief Architect | ADR、状态、集成报告 | 是，串行控制 |
| A1 | Workload & Model Manifest | `docs/design/workload/`, `data/workload/` | 是 |
| A2 | 7R Package / Floorplan | `docs/design/package/`, `data/package/` | 是 |
| A3 | Compute Die / AI Core | `docs/design/ai_core/`, `src/core/` | 是 |
| A4 | SRAM / TMA / Memory Hierarchy | `docs/design/tma_sram/`, `src/simulation/` | 是 |
| A5 | Memory Cube / MC Controller | `docs/design/memory_mc/`, `src/` | 是 |
| A6 | Die-local NoC | `docs/design/noc/`, `models/noc_packet/` | 是 |
| A7 | Package Fabric / Die-to-Die | `docs/design/multidie/` | 是 |
| A8 | Scale-out / RDMA / Collective | `docs/design/scaleout/`, `src/rdma/` | 是 |
| A9 | Tile IR / Compiler / Scheduler | `docs/design/scheduler/`, `src/` | 是 |
| A10 | Performance Model Integration | `src/simulation/`, `models/tile/`, `data/` | 是，关键路径 |
| A11 | PPA / Power / Thermal / RAS | `docs/design/package/`, `models/ppa/` | 是 |
| A12 | Verification / Regression / Traceability | `tests/`, `verification/` | 是，合并闸门 |
| A13 | Documentation / Report Publisher | `scripts/`, `templates/`, `reports/` | 否，可并行 |

如果 agent 数量有限，建议合并为：

```text
A2 + A11：Package / PPA / Thermal
A3 + A4：Compute / SRAM / TMA
A6 + A7：NoC / Package Fabric
A8 + A9：Collective / Scheduler
A10 + A12：Performance / Verification
```

## 4. 串行闸门与并行批次

### G0：架构控制面初始化（A0，串行）

**目的**：建立所有 agent 共同遵守的契约、目录、状态和命名。

**输入**：当前 7R baseline、`HIGH_LEVEL_ARCHITECTURE.md`、`DECISIONS.md`、`OPEN_ISSUES.md`。

**交付**：

- `docs/design/WORKSTREAM_REGISTER.md`；
- 需求编号规则；
- P0/P1 profile schema；
- Tile IR 初版字段表；
- 公共单位规则；
- 每个 workstream 的 owner、分支和退出条件。

**退出条件**：所有 agent 知道自己可以修改哪些文件，公共文件 owner 唯一。

### W1：两个基础 workstream 并行

W1 只启动 A1 和 A2；其他 agent 等待接口草案。

#### A1：Workload & Model Manifest

**任务**：

- 冻结 K3 逐层 manifest；
- 明确 93 层、Attention、MoE、Router、KV/state；
- 明确 dtype、shape、layout、TP shard；
- 生成 operator DAG 的输入格式；
- 定义 B=1、1M Context、Decode KPI。

**建议目录**：

```text
docs/design/workload/
data/workload/
src/workload/
tests/test_workload_manifest.js
```

**必须交付**：

- `k3_layer_manifest.json`；
- `dtype_layout_manifest.json`；
- `kv_state_layout.md`；
- manifest loader；
- 逐层 byte/FLOP/capacity report。

**阻塞下游**：A3、A4、A5、A9、A10。

#### A2：7R Package / Floorplan

**任务**：

- 把 7R、82×64 mm、5,248 mm² placement window formalize；
- 规划 8×400 mm² Compute Die + 16×100 mm² MC；
- 定义 die 坐标、MC home、北/南 memory row；
- 定义 package edge、scale-out、host、management、clock 位置；
- 输出初版 bump/PHY beachfront 和 keep-out map。

**建议目录**：

```text
docs/design/package/
data/package/
implementation/floorplan/
```

**必须交付**：

- package coordinate JSON；
- floorplan SVG/HTML/Markdown；
- area budget；
- placement/routing reserve；
- package interface inventory。

**阻塞下游**：A6、A7、A8、A11。

### W2：核心子系统并行

W2 在 W1 的 schema 草案可用后并行启动 A3–A9。各 agent 不等待其他模块完全冻结，只能依赖已发布的字段和假设版本。

#### A3：Compute Die / AI Core

**任务**：

- P0 的 8 L + 8 H Core 划分；
- Tensor/Vector engine 能力和 dtype；
- Core command queue、RF、issue、preemption；
- 8 Core Pod / 16 Core Die 的物理映射；
- P0/P1 kernel cycle model 对比。

**交付**：

```text
docs/design/ai_core/AI_CORE_P0_SPEC.md
docs/design/ai_core/AI_CORE_P1_COMPATIBILITY.md
models/kernel_cycle/
tests/test_ai_core_contract.js
```

#### A4：SRAM / TMA / Memory Hierarchy

**任务**：

- P0：64 MiB L-local + 16 MiB H-local + 16 MiB Shared；
- bank/slice/port/ECC/scrub/repair；
- TMA descriptor 和 buffer lifecycle；
- P0/P1 tile-fit 统一接口；
- bank-cycle model。

**交付**：

```text
docs/design/tma_sram/
models/sram_bank_cycle/
tests/test_sram_tma_contract.js
```

#### A5：Memory Cube / MC Controller

**任务**：

- 16 MC/package、2 MC/Die；
- 8 GB/16 GB capacity profile；
- 320 GB/s baseline 与 640 GB/s Stretch；
- sustained payload、latency、queue、read/write mix；
- address mapping、NUMA、ECC、retry、lane repair；
- 320 GB/s 下达到 1050 TPS 的字节削减方案分析。

**交付**：

```text
docs/design/memory_mc/
models/mc_transaction/
data/memory_mc/
tests/test_mc_contract.js
```

**A5 是 1000 TPS 的首要瓶颈 owner。**

#### A6：Die-local NoC

**任务**：

- P0 的 16 Core + 16 SRAM slice + MC gateway endpoint；
- Data/Control/Collective 三层网络；
- 5×5 mesh 或多平面替代；
- flit、VC、credit、buffer、QoS、deadlock；
- 与 SRAM、MC、Core 的 traffic contract。

**交付**：

```text
docs/design/noc/
models/noc_packet/
tests/test_noc_contract.js
```

#### A7：Package Fabric / Die-to-Die

**任务**：

- 8 Die 的 4×2 package mesh；
- 两个四 Die reduce domain；
- route table、MC home、NUMA、故障绕行；
- die-to-die link width、lane、clock domain；
- package-level collective traffic。

**交付**：

```text
docs/design/multidie/
data/package/route_table.json
tests/test_package_fabric_contract.js
```

#### A8：Scale-out / RDMA / Collective

**任务**：

- 一个 package 到 TP32 的边界；
- 800 GB/s/package target；
- remote SRAM write、mailbox、epoch、commit/ready/ACK/release；
- All-Reduce、Reduce-Scatter、All-Gather、LSE m/l/O；
- replay、timeout、poison、failure。

**交付**：

```text
docs/design/scaleout/
docs/design/collective/
src/rdma/
tests/test_collective_contract.js
```

#### A9：Tile IR / Compiler / Scheduler

**任务**：

- Tile IR schema；
- operator → tile → core/die/package placement；
- TMA/MC/NoC/collective resource reservation；
- static schedule + dynamic credit/ready；
- host-independent persistent decode step；
- PMU event schema。

**交付**：

```text
docs/design/scheduler/
src/scheduler/
models/tile/
tests/test_tile_ir_contract.js
```

### W3：模型和验证并行

W3 在 W2 各模块交付接口草案后启动。

#### A10：Performance Model Integration

**任务**：

- 将 manifest 转为 operator DAG；
- 将 Tile IR 接入现有 simulator；
- 引入 P0 7R 参数；
- 保留 P1 compact regression；
- 替换经验缩放为 tile/resource/transaction 事件；
- 输出 320/640 MC 对比和 P50/P95/P99。

**交付**：

```text
models/tile/
src/simulation/
data/performance/
reports/performance/
tests/test_p0_p1_performance.js
```

**通过门槛**：选定可制造路线达到 `>=1050 TPS/usr`，否则只能报告 blocker。

#### A11：PPA / Power / Thermal / RAS

**任务**：

- 400 mm²/Die area budget；
- 250 W/Die、2.8–3.2 kW/package cooling envelope；
- 16 MC、PHY、RDL、VRM、冷板；
- IR drop、thermal hotspot、DVFS、降频；
- Die/MC/link failure and degraded mode。

**交付**：

```text
models/ppa/
data/ppa/
docs/design/package/
tests/test_ppa_budget.js
```

#### A12：Verification / Regression / Traceability

**任务**：

- 需求 ID → 设计文档 → 模型 → 测试 → 证据；
- golden trace；
- area/capacity/bandwidth/time conservation；
- P0/P1 profile separation checks；
- multi-seed、worst routing、fault、thermal、replay；
- CI 检查新增 schema 和链接。

**交付**：

```text
verification/
tests/
.github/workflows/
docs/design/REQUIREMENT_TRACEABILITY.md
```

#### A13：Documentation / Report Publisher

**任务**：

- 统一报告模板；
- P0/P1 标签和假设标识；
- 从 JSON 生成面积、SRAM、MC、PPA 和性能报告；
- 自动生成 architecture index；
- 不修改模型语义，只负责展示和可审阅性。

**交付**：

```text
scripts/
templates/
reports/
```

## 5. 推荐并行拓扑

```text
                         ┌── A3 AI Core ──────────┐
                         ├── A4 SRAM / TMA ───────┤
                         ├── A5 MC ───────────────┤
G0 A0 ── W1 A1/A2 ───────┼── A6 NoC ──────────────┼── W3 A10/A11/A12 ── G4
                         ├── A7 Package Fabric ───┤
                         ├── A8 RDMA Collective ──┤
                         └── A9 Tile IR Scheduler ┘
```

依赖关系：

```text
A1 → A3/A4/A5/A9/A10
A2 → A6/A7/A8/A11
A3 + A4 + A5 + A6 + A7 + A8 + A9 → A10
A10 + A11 + A12 → Architecture Sign-off
A13 可以在所有阶段并行，但必须只消费已版本化的 JSON/Markdown 输入
```

## 6. 每个 Agent 的标准任务卡

复制下面模板创建 issue 或任务：

```text
Agent ID: A__
Workstream:
Owner:
Branch: agent/<id>-<topic>
Milestone: G0 / W1 / W2 / W3 / G4

Objective:

Allowed paths:
- TBD

Forbidden paths:
- docs/design/00_CURRENT_STATE.md
- docs/design/HIGH_LEVEL_ARCHITECTURE.md
- docs/design/DECISIONS.md
- docs/design/OPEN_ISSUES.md
- docs/design/spec/k3_7r_package_baseline.json

Inputs:
- baseline commit: 5985785
- profile: P0 / P1 / both
- schema version:

Required outputs:
- design document:
- machine-readable artifact:
- executable model:
- tests:

Acceptance criteria:
- [ ] interfaces and units are explicit
- [ ] P0/P1 are not mixed
- [ ] normal/backpressure/error/reset behavior documented
- [ ] assumptions and evidence level recorded
- [ ] tests or invariant checks added
- [ ] npm test passes or known failure is documented

Handoff:
Scope:
Decision:
Assumptions:
Files:
Validation:
Risks:
Next:
```

## 7. 合并顺序

### 7.1 推荐 merge train

```text
1. A1 workload schema
2. A2 package coordinate schema
3. A3/A4/A5/A6/A7/A8/A9 contract PRs
4. A12 contract tests
5. A10 performance integration
6. A11 PPA/thermal integration
7. A13 reports
8. A0 updates baseline, ADR, open issues and final index
```

### 7.2 合并规则

- 每个 PR 只对应一个 agent workstream；
- contract PR 先于 implementation PR；
- 任何改变 Tile IR、MC payload、SRAM capacity、NoC width、package topology 的 PR 必须带 ADR；
- 任何改变 `data/` 或 `reports/` baseline 的 PR 必须带生成命令和前后差异；
- A10 性能合并前，A12 必须提供守恒和 profile separation tests；
- A0 最后才更新公共状态文件和 blocker 状态；
- 如果两个 agent 修改同一公共接口，优先保留 schema proposal，暂停其中一个实现 PR，不在 merge 时隐式解决。

## 8. 每日同步和状态板

每个 agent 每日更新一条状态：

```text
[ID] status=GREEN/YELLOW/RED
Done:
Next:
Blocked by:
Changed contracts:
TPS/PPA impact:
Evidence:
```

状态板至少跟踪：

| 字段 | 说明 |
|---|---|
| Workstream | A1–A13 |
| Owner | 人或 agent |
| Branch / PR | 可追踪入口 |
| Status | GREEN/YELLOW/RED |
| Dependency | 上游 workstream |
| Contract version | schema/ADR 版本 |
| Deliverable | 文档/代码/模型/测试 |
| KPI impact | TPS、latency、area、power、bandwidth |
| Evidence | 测试、trace、vendor data、floorplan |
| Next gate | 下一个合并闸门 |

## 9. 资源不足时的最小并行配置

### 3 个 agent

```text
A0/A12：架构整合 + 验证
A1/A9/A10：Workload + Tile IR + 性能模型
A2–A8/A11：7R package + Compute/Memory/Fabric/PPA
```

### 6 个 agent

```text
A0：Integrator
A1：Workload + Tile IR
A2：7R Package + PPA/Thermal
A3：AI Core + SRAM/TMA
A4：MC + NoC
A5：RDMA/Collective + Scheduler
A6：Performance + Verification
```

### 10 个以上 agent

使用 A1–A13 的完整拆分，但仍只允许一个 A0。A0 不应同时负责大量实现，
否则会成为新的串行瓶颈。

## 10. 第一周建议执行清单

### Day 1：G0

- A0 发布 schema、目录和 workstream register；
- A1/A2 建立独立 proposal 分支；
- A12 建立 requirement ID 和 CI 检查；
- 所有 agent 确认 P0/P1 profile。

### Day 2–3：W1

- A1 发布 layer/dtype/KV manifest 草案；
- A2 发布 package coordinate、area、bump 和 MC home 草案；
- A9 根据 A1 草案建立 Tile IR；
- A5 根据 A2 草案建立 MC interface；
- A11 建立 P0 area/power/thermal spreadsheet/model。

### Day 4–5：W2

- A3/A4/A6/A7/A8 完成单模块接口草案；
- A12 为每个接口增加最小 contract test；
- A10 接入一层 Attention、一层 Linear Attention、一层 MoE 的 trace；
- A13 生成第一版 P0/P1 对比报告。

### Week 2：W3

- A1 完成 93 层 manifest；
- A9 完成 Tile IR v0.1；
- A10 完成 P0/P1 双 profile 回放；
- A5 输出 320/640 GB/s MC 对比；
- A11 输出 package PPA v0.1；
- A0 更新 B-001、B-002、B-003、B-004、B-005、B-006 的证据状态。

## 11. 第一阶段退出条件

第一阶段不要求立即宣称达到 1000 TPS/usr，而要求建立可并行的可信设计基线：

- workload manifest 可生成 93 层 DAG；
- P0/P1 profile 能独立加载和报告；
- package area 守恒通过；
- SRAM/MC/NoC/RDMA/Tile IR schema 版本明确；
- 至少 3 个关键算子有 golden trace；
- 320/640 GB/s MC 结果可复现；
- 所有 BLOCKER 有 owner、next action 和 evidence type；
- `npm test` 通过。

## 12. 最终架构签核条件

并行设计完成后，只有在以下条件全部满足时才进入架构签核：

1. A1 的正式 workload manifest 冻结；
2. A2 的 7R floorplan、bump、RDL 和 keep-out 通过；
3. A3/A4 的 P0 Compute Die 与 SRAM/TMA 规格闭合；
4. A5 证明 MC 路线的持续 payload 和功耗；
5. A6/A7 证明 Die-local NoC 和 package fabric 的带宽、P99、拥塞和故障；
6. A8 证明 TP32 RDMA/Collective 的协议和尾延迟；
7. A9/A10 使用统一 Tile IR 完成精确回放；
8. A11 完成 area/power/thermal/RAS 预算并留有余量；
9. A12 提供需求追踪、golden trace 和完整回归；
10. 选定可制造路线达到 `>=1050 TPS/usr`，并且 P99、面积、功耗和热约束通过。
