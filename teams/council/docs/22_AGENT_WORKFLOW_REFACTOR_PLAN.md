# Agent / Workflow 重构设计与计划

版本：2026-09-30
状态：`PROPOSED / REFACTOR PLAN v0.2`
前置文档：[`17_TWO_STAGE_ARCHITECTURE_OPERATING_MODEL.md`](17_TWO_STAGE_ARCHITECTURE_OPERATING_MODEL.md)、[`18_AGENT_CATALOG_AND_INTERACTION_PROTOCOL.md`](18_AGENT_CATALOG_AND_INTERACTION_PROTOCOL.md)、[`19_DETAILED_ARCHITECTURE_OPERATING_MODEL.md`](19_DETAILED_ARCHITECTURE_OPERATING_MODEL.md)

> v0.2 变更：把核心抽象从"三层职责分工"改为**策略 / 运行时分离**——agent 定义退化为纯策略集合（只含判断规则、禁止项、裁决枚举），一切上下文由 workflow 在运行时注入；agent 只在 workflow 内参与设计、计算和文档产出。v0.1 的 roster 表（含"知识输入""输出 schema"两列）已按此原则重写，见 §3。

## 0. 本文要解决的问题

当前仓库把设计流程写成两层：`17/18/19` 三份文档定义的 **D1–D7 / Q1–Q9 / A0** 角色，以及 `integration/orchestration/*.workflow.js` 里的 **3 个 workflow 脚本**。两层都在描述"谁在什么时候做什么"，但互不引用，改一个不会改另一个。

重构目标：

1. **编排归 workflow**：顺序、并行、门控、路由、产物路径全部由 workflow 脚本持有；
2. **agent 定义退化为纯策略**：只含本领域判断规则、禁止项、裁决枚举；不含输入路径、不含输出 schema、不含流程；
3. **agent 只在 workflow 内实例化**：不搭 workflow 就没有 agent 运行，也就没有设计产出；
4. **新增架构师角色**：输入需求、约束和架构形态意图，输出 brief 与全局预算账本；
5. **用 brief + 设计账本串联**：跨 stage 信息只走文件，不走脚本 import，也不走对话上下文。

## 1. 现状诊断

### 1.1 三层职责错位

| 层 | 当前载体 | 实际在做的事 | 问题 |
|---|---|---|---|
| 编排层 | `17/18/19` 文档 + `integration/orchestration/*.js` + `integration/pipelines/*.js` | 顺序、门控、合并 | 流程有两个来源，会漂移 |
| Agent 层 | D1–D7、Q1–Q9、A0 | 既做编排又做设计 | 按**阶段**切，不是按**领域**切 |
| 领域层 | `references/sota/*`、`teams/hardware/docs/02–10` | 领域知识 | 已存在，但没有和 agent 绑定 |

D2 一个人管 MC + SRAM + TMA 三件事，Q1 是"阶段"而不是"专家"。这些角色干的工作，很大一部分是编排工作——**而编排工作写进 agent 定义，正是双套流程的成因**。

### 1.2 必须保留的既有资产

重构不是推倒重来。以下机制是当前仓库最值钱的部分，重构后必须原样保留：

- **证据等级 E0–E3** 与 `UNVERIFIED` 显式标记；
- **门控由脚本计算**：`integration/governance/evaluate_gates.js`，runner 不得写 `PASS` / `D_GATE_PASSED` 字面量（`AGENTS.md` §2）；
- **唯一硬件规格**（ADR-0021）、MC320/MC640 分离、peak ≠ sustained；
- **`out/` 只放生成物**、`archive/` 只读、单一 owner；
- **知识不是证据**：`references/sota/` 只能用来判断"假设是否偏离常规"，不得作为 claim 的 evidence，不得覆盖仓库基线；
- **结构约束**由 `tests/structure/test_project_structure.js` 强制。

### 1.3 现有编排脚本盘点

下表的"重构后归属"已全部落地（S7 完成时删除）：`integration/orchestration/` 下现在只有 `design.*.workflow.js` 一套流程，旧脚本一个不留。本表保留，是为了让后来的人知道那些脚本去哪了——**两套流程并行时，同一件事有两个说法，谁也说不清哪个算数**。

| 脚本 | 当前作用 | 重构后归属 |
|---|---|---|
| `k3_multiteam_review.workflow.js` | 五团队 probe+lead、六接口配对、blocker 三视角核验 | → `design.verify` 的骨架；"按 ownership 覆盖 + 三视角对抗核验"保留在 `design.verify` / `design.audit` |
| `k3_external_references.workflow.js` | 为 premises 找外部参照系 | → `design.audit` 的一个可选阶段（传 `args.premises` 时启用），产物落 `references/external/` |
| `k3_agent_learning.workflow.js` | 一次性沉淀 `references/sota/` | → `design.learn.workflow.js`，仍是一次性；产物按领域登记注入点（见下） |
| `integration/pipelines/stage_a.js` | Stage A 方向级运行 | → `design.direction` 的确定性内核 |
| `integration/pipelines/stage_b.js` | Stage B 详细运行 | → D 组 5 个 workflow 的确定性内核 |
| `generate_matrix_vector_design.js` | AI Core 设计空间搜索 | → `design.compute` 的确定性内核 |
| `generate_comm_core_design.js` | Comm Core 设计空间搜索 | → `design.comm` 的确定性内核 |
| `generate_team_contracts.js` | 合成本团队 contract | → `design.contract` 的确定性内核 |
| `generate_direction_feedback.js` | 方向反馈 | → `design.backflow` 的确定性内核 |
| `integration/pipelines/generate_review_ledger.js` | 把 `k3_multiteam_review` 的返回值落成 `out/reviews/` ledger | 保留并改向：读 `out/verification/` 下 `design.verify` / `design.audit` 落盘的报告，照抄门控结论而不判定它 |

**知识库的注入点**（上面第三行的"按领域绑定到策略输入"）登记在 `design.learn.workflow.js` 的 `UNITS[].consumedBy` 与返回值的 `binding` 字段里，实际注入在各领域 workflow 的 prompt 头部——注入的是**路径**不是正文，理由与策略正文相同：一份来源，各自自读。

**关键区分**：`integration/pipelines/*` 和 `integration/detailed/*` 是**确定性模型**。workflow 调用它们，策略 agent 不得替代它们。

## 2. 核心抽象：策略 / 运行时分离

### 2.1 一句话定义

> **Agent 是一份无状态的策略；workflow 是携带上下文的运行时。**
> 策略可替换、可单测、可复用；上下文每次运行才实例化。

```text
Workflow（运行时）            管"顺序"：跑谁、并行还是串行、门控在哪里、失败退到哪、产物落哪个文件
Architect（策略 + 决策权）    管"意义"：需求、约束、全局预算账本、要探索什么形态、谁越界了
Expert（纯策略）              管"一格"：本领域的判断规则、禁止项、裁决枚举
```

### 2.2 四条硬边界

这四条必须同时写进 agent 定义规范和结构测试，缺一条抽象就会退化：

1. **agent 定义里不得出现任何"我要输出什么"的描述**。"输出什么"是当次运行的契约，由 workflow 注入。
2. **agent 定义里不得出现任何文件路径**（读的、写的都不行）。读什么由 brief 决定，写哪里由 workflow 决定。
3. **路由必须是数据，不是行为**。agent 只产出裁决枚举（`DIRECTION_BACKFLOW` / `LOCAL_DETAIL_FIX` / `BLOCKED_CONFIG`），由 workflow 脚本 `switch` 决定去哪。裁决可断言、可审计；藏在 prompt 里的一句"如果发现不成立就返回 D 阶段"不可审计。
4. **LLM 不产出决定性数字**。TPS、PASS/FAIL、门控结论只能由 `integration/pipelines/*` 或 `integration/detailed/*` 的确定性模型计算。

### 2.3 什么算"策略"

"策略"必须切开成两半，否则会退化成"把 prompt 复制 14 遍"：

| 属于 agent 策略（判断规则） | 属于 workflow 运行时（执行规则） |
|---|---|
| 领域启发式：什么时候考虑哪种结构、什么参数区间是常规 | 读哪些文件、版本/hash 校验 |
| 本领域的正确性定义：什么算守恒、什么必须先拆账 | 这次跑哪个 stage、给什么输入 |
| 证据分级规则：哪类结论只能到 MODEL，哪类必须有 `path:line` | 输出落到哪个 `out/` 路径 |
| 取舍规则：与别的域冲突时让什么、不让什么 | schema 的具体字段（schema 是契约，不是策略） |
| **禁止项**：绝对不许说、不许补的内容 | 并行/串行、门控位置、失败退到哪 |
| 路由*规则*：什么条件下该回流上游 | 路由*执行*：谁来接这个回流 |

右边任何一项写进 agent 定义，就会变成 14 份副本，改一处要改 14 处——**这正是 `17/18/19` 三份文档互相漂移的同一类错误，只是从"文档漂移"变成"prompt 漂移"**。

### 2.4 Agent 定义规范（每个策略只剩这些字段）

| 字段 | 含义 | 示例 |
|---|---|---|
| `agentId` | 唯一标识 | `compute-expert` |
| `domain` | 领域边界 | `AI Core 微架构` |
| `strategyVersion` | 策略版本，写入设计账本 | `1.0` |
| `judgmentRules[]` | 本领域的判断规则 | "L/H/Vector/Indexer/Reduce 必须分开记账" |
| `correctnessDef[]` | 本领域什么算守恒/正确 | "issued bytes = return bytes + poison" |
| `evidenceRules[]` | 本领域证据分级规则 | "利用率必须有 trace 来源，否则只能标 MODEL" |
| `tradeoffRules[]` | 跨域冲突时的让/不让 | "面积与 MC 数量冲突时，优先保 MC 数量" |
| `prohibitions[]` | 禁止项 | "不得输出 TPS/usr" |
| `verdictEnum[]` | 可输出的裁决枚举 | `["LOCAL_DETAIL_FIX","DIRECTION_BACKFLOW","BLOCKED_CONFIG"]` |

**没有的字段**（这些一律由 workflow 注入或在契约层定义）：
`inputs`、`outputs`、`schema`、`allowedPaths`、`readPaths`、`upstream`、`downstream`、`knowledgeInputs`。

### 2.5 运行时注入契约（workflow 侧）

**workflow 脚本没有文件系统权限**：不能读 brief，不能读策略文件，不能写任何东西。
它只能把字符串拼进 prompt、拿返回值、把 `files` 交回主循环落盘。
所以"注入"这件事的物理形态是**一段 prompt**，不是一个对象：

```js
const HEAD = [
  `仓库根目录：${REPO}`,
  `本 workflow：design.compute（stage=${STAGE}，runId=${RUN_ID}）`,
  `你是一个策略实例。先读你的策略正文：${REPO}/teams/council/strategies/__AGENT__.md`,
  '那份文件是本角色的判断规则、正确性判据、证据规则、取舍规则与禁止事项，逐条遵守。',
  '以下运行时上下文由 workflow 注入；注入内容与策略正文冲突时，注入内容优先（它承载本 stage 的事实）。',
  '你没有文件系统写权限。把该写的东西作为返回值交回，由 workflow 落盘。',
  '所有数字必须带出处（文件路径:行号 或 ADR 编号）；没有出处的写 UNVERIFIED 并说明缺什么，不得静默补齐。',
  '不得输出 TPS/usr 或任何全局性能指标；不得输出 PASS / D_GATE_PASSED 字面量。',
].join('\n')
const head = agentId => HEAD.replace('__AGENT__', agentId)
```

每次实例化一个策略，prompt 里必须出现：

| 注入项 | 形态 | 说明 |
|---|---|---|
| 策略位置 | `strategies/<agentId>.md` 的路径 | agent 在运行时自己读策略正文；不内联进脚本 |
| brief | `JSON.stringify(BRIEF, null, 2)` | 架构师下发的 DesignBrief，逐字段遵守 |
| ledger 切片 | JSON 片段 | 冻结决策、已否方案、预算余额、open blockers |
| task | 自然语言 | 本次具体问题，由 workflow 生成，不是策略自带 |
| 输出契约 | `schema` 选项 | 由 workflow 传入调用参数，**不得写进策略文件**（§2.2 硬边界 1） |

三件**不能**通过注入实现的事：

1. **`outputPath` 不存在。** 落盘位置是返回值里的 `files: [{path, content}]`，由主循环写。
   agent 侧没有"写到某路径"这个动作，写权限只在主循环。
2. **`agentType` 不是策略名。** agentType 从 agent 注册表解析
   （`claude` / `general-purpose` / `Explore` …），策略不是注册项。
   传 `agentType: 'compute-expert'` 会解析失败——策略靠 prompt 里的路径找正文，不靠 agentType。
3. **`knowledge` 不是一个白名单参数。** 允许读什么写在策略正文与注入的 HEAD 里，
   约束靠 prompt 陈述，不靠运行时强制。真正的强制只有一条：没有写权限。

**确定性数字不由 agent 产生**，因此也不由注入决定。枚举与打分在仓库内的脚本里跑，
产物带设计空间 sha256；agent 只解释取舍。搜索脚本会写 `out/`，
所以它**由主循环在调用 workflow 之前运行**——
不能让 workflow 里的 agent 去执行它，否则"agent 全程只读"这条硬护栏为了拿候选集就破了。

C 组四域读取产物这一步同样**不由 agent 做**：agent 转写候选数值，等于让 LLM 产出了后面所有裁决
唯一依据的数字，且没有东西核对"转写 = 原文"。主循环先跑 `integration/pipelines/search_brief.js brief <域>`
（读产物、核对设计空间哈希、重跑搜索复核指纹、取前 N 个候选），结果经 `args.searchBrief` 传入；
`args.searchArtifact` 只作溯源记录。workflow 返回、文件落盘之后，再跑 `search_brief.js verify <域>`，
核对落盘的 winner 是不是产物里的一行（逐字段一致）、是否可行、run record 指纹是否一致。

## 3. Agent Roster（12 个策略）

`× n` = 单次 workflow 内的实例数。所有策略均遵守 §2.2 四条硬边界，不再重复列禁止项。

### 3.1 领域专家策略（6）

| Agent | domain | judgmentRules 要点 | 可输出裁决 |
|---|---|---|---|
| `compute-expert` | AI Core 微架构：L/H/Vector/Indexer/Reduce 比例、频率/电压、issue/pipeline/occupancy | "数学 peak ≠ effective peak ≠ measured"；"utilization 必须有 trace 来源"；"FP8/FP4 dequant 不得隐藏" | `LOCAL_DETAIL_FIX` / `DIRECTION_BACKFLOW` / `BLOCKED_CONFIG` |
| `memory-expert` | SRAM 层级与 buffer lifetime、MC 控制器、TMA 描述符、带宽/容量墙 | "raw ≠ sustained ≠ effective"；"per-core/per-die/per-package SRAM 必须分离"；"bank/port/queue/ECC 代价必须显式" | 同上 |
| `comm-expert` | NoC 拓扑、die-to-die、collective 算法、RDMA、Comm Core | "不得用单一 log2(TP) 代替真实拓扑"；"package-local 与 cross-package 分离"；"FFN/MoE 为 TP-only（ADR-0020）" | 同上 |
| `physical-expert` | 封装/floorplan、7-reticle 面积守恒、热、电、RAS | "面积取自规格文件，不写手工面积"；"PHY/RDL/DFT/clock/power keep-out 必须显式保留"；"die 与卡功耗分开核算" | `PPA_DIRECTION_BACKFLOW` / `BLOCKED_CONFIG` / `LOCAL_DETAIL_FIX` |
| `software-expert` | 编译/运行时/固件、fusion、overlap、launch/scheduler 开销 | "每项收益必须带实现前提"；"未验证收益不得写入硬件能力"；"MTP 必须记 acceptance/rollback" | 同上 |
| `model-expert` | 模型 manifest、逐层 workload、MoE routing、KV/精度策略、MTP | "K3 形状唯一来源是 `design_engine.js#MODEL_PRESETS`"；"未确认字段标 `UNVERIFIED_PLANNING_MANIFEST`"；"不得静默补齐未知配置" | `BLOCKED_CONFIG` / `LOCAL_DETAIL_FIX` |

**6 个策略共享的禁止项**：不得输出 TPS/usr 或任何全局性能指标；不得断言其他领域是否可行；不得用知识卡数字覆盖仓库基线；不得在输入不足时静默补齐。

### 3.2 固定职能策略（6）

| Agent | domain | judgmentRules 要点 | 可输出裁决 |
|---|---|---|---|
| `architect` | 需求、约束、全局预算、候选选择 | "不得替代专家做领域设计"；"单一最高 TPS 不代表三模型结论"；跨域取舍；唯一可签 ADR | `D_GATE_PROPOSAL` / `DIRECTION_BACKFLOW` / `ARCH_FREEZE` |
| `framing-critic` | 对抗式框架审查 | "约束完整吗、口径对吗、shape 空间是不是被写窄了"；**只在 workflow 头尾出现** | `FRAMING_INSUFFICIENT` / `FRAMING_OK` |
| `integrator` | 只做合并，不重新发明模型 | "不得同时担任检点"；"粗估与细估差异必须归因，不得静默覆盖" | `INTEGRATION_OK` / `DELTA_UNEXPLAINED` |
| `invariant-checker` | 全局不变量 | 面积守恒、单一硬件规格、MC320/MC640 分离、peak≠sustained、单位、证据等级 | `INVARIANT_OK` / `INVARIANT_VIOLATED` |
| `gate-keeper` | 逐条门槛核验 | "不判 PASS"（由脚本算）；每条门槛输出证据等级或 blocker | `GATE_EVIDENCE` / `GATE_BLOCKED` |
| `verifier` | 独立验证 | "不得读设计过程的中间产物"；schema、守恒、provenance、golden trace | `VERIFIED` / `VERIFY_FAILED` |

> `invariant-checker` 与 `integrator` 必须分开定义：合并的人同时当检点，会把违规项"解释掉"。

## 4. Workflow 清单与 Agent 使用（14 个）

### 4.1 清单

| 组 | Workflow | 核心问题 | 并行体 | 串行收敛点 | 复用 |
|---|---|---|---|---|---|
| A | `design.contract` | 接口长什么样 | 4 专家各申报接口 | 架构师定契约 | `generate_team_contracts.js` |
| B | `design.intake` | 需求+约束能否变成可计算输入 | 4 专家各报所需约束 | 架构师合并 brief | 新建 |
| B | `design.direction` | 走哪条路线 | 6–12 候选各一 agent | 排序+敏感性 → 只留 winner | `stage_a.js`、`directional_envelope.js` |
| B | `design.dgate` | 候选能否进细化 | 8 条门槛各一独立 agent | **脚本**算门控 | `evaluate_gates.js` |
| C | `design.compute` | AI Core 设计空间 | N 个选项各一 agent | 收敛到 winner | `generate_matrix_vector_design.js` |
| C | `design.memory` | SRAM/MC/TMA 设计空间 | N | 同上 | `k3_mc_baseline.json` |
| C | `design.comm` | NoC/collective 设计空间 | N | 同上 | `generate_comm_core_design.js` |
| C | `design.physical` | 封装/面积/功耗/热 | N | 同上 | 7R baseline |
| D | `design.detail.freeze` | 冻结 manifest 与 provenance | — | 串行 | `stage_b.js` 的 B0 |
| D | `design.detail.workload` | 算术强度/Roofline/sizing | 2 | 串行 | B1 |
| D | `design.detail.events` | tile/packet/kernel 事件 | 3 | 串行 | B2 |
| D | `design.detail.execute` | schedule/PPA | 2 | 串行 | B3 |
| D | `design.detail.integrate` | fine TPS + delta 归因 | — | 串行 | B4 |
| D | `design.converge` | 架构定型 + ADR | — | 串行 | A0 扩权 |
| E | `design.verify` | 独立门控 | 每类检查一 agent（≥6） | verifier 汇总 | 原 `k3_multiteam_review`（已并入本格） |
| E | `design.backflow` | 不达标回流 | — | 串行 | `generate_direction_feedback.js` |
| E | `design.audit` | 证据/口径复核 | 4 视角 | verifier 汇总 | 原 `k3_external_references`（已并入本格的可选阶段） |
| X | `design.explore` | 单 agent 探索（**受控逃生口**，见 §5.3） | 1 | — | 新建 |

### 4.2 每个 Workflow 的策略实例

| Workflow | 策略使用 |
|---|---|
| `design.contract` | `architect`×1 · 4 专家×各1 · `invariant-checker`×1 · `verifier`×1 |
| `design.intake` | 4 专家×各1 · `architect`×1 · `framing-critic`×1 · `invariant-checker`×1 |
| `design.direction` | `architect`×1 · `integrator`×1 · 候选 agent×6–12 · `framing-critic`×1 · `invariant-checker`×1 · `gate-keeper`×1 |
| `design.dgate` | `gate-keeper`×8（独立实例）· `invariant-checker`×1 · `architect`×1 |
| `design.compute` | `compute-expert`×N · 旁证 `memory-expert`/`physical-expert`×各1 · `integrator`×1 · `invariant-checker`×1 · `gate-keeper`×1 |
| `design.memory` | `memory-expert`×N · 旁证 `compute-expert`/`software-expert`×各1 · 同上 |
| `design.comm` | `comm-expert`×N · 旁证 `memory-expert`/`physical-expert`×各1 · 同上 |
| `design.physical` | `physical-expert`×N · 旁证 `compute`/`memory`/`comm`×各1 · 同上 |
| `design.detail.freeze` | `model-expert`×1 · `memory-expert`×1 · `invariant-checker`×1（**无 integrator**） |
| `design.detail.workload` | `model-expert`×1 · `compute-expert`×1 · `memory-expert`×1 · `integrator`×1 · `invariant-checker`×1 |
| `design.detail.events` | `memory-expert`×1 · `comm-expert`×1 · `compute-expert`×1（三路并行，共享 manifest hash）· `invariant-checker`×1 |
| `design.detail.execute` | `software-expert`×1 · `physical-expert`×1（两路并行）· `integrator`×1 · `invariant-checker`×1 |
| `design.detail.integrate` | `integrator`×1 · `architect`×1（delta 归因裁决）· `verifier`×1 |
| `design.converge` | `architect`×1 · `gate-keeper`×1 · `invariant-checker`×1 · `framing-critic`×1 · 相关专家×1–3 |
| `design.verify` | `verifier`×≥6（独立实例）· `gate-keeper`×1 · `architect`×1 |
| `design.backflow` | `integrator`×1 · 被归因专家×1–3 · `architect`×1 · `framing-critic`×1 |
| `design.audit` | `evidence-chain`/`basis-consistency`/`arithmetic`/`coverage` 各×1 · `verifier`×1 汇总 |

### 4.3 C 组标准骨架（四域同构）

骨架已实现于 `integration/orchestration/design.compute.workflow.js`。下面是与实际 API 一致的形态——
注意与最初设计的三处出入，它们不是风格问题，都是脚本 API 强制的：

1. 没有 `readBrief()`。脚本读不了文件，brief 由主循环经 `args.brief` 传入。
2. 没有 `outputPath`。落盘是返回值里的 `files`，由主循环写。
3. 没有 `agentType: '<策略名>'`。策略靠 prompt 里的路径自读正文；agentType 只用于切换
   内建 agent 类型，绝大多数情况应当省略（继承主循环模型）。

还有一处**顺序**修正：旁证约束串在**确定性搜索之后**，不是串在"初稿"之后。
约束针对的是具体候选——见不到候选就提不出可执行的约束（"说不出否掉谁的约束不要提"）。

```js
export const meta = { name: 'design-compute', description: '...', phases: [...] }

const BRIEF = args.brief                    // 主循环传入，脚本不读文件
const SEARCH_ARTIFACT = args.searchArtifact // 搜索产物路径，仅作溯源记录；本 workflow 不读它、不跑搜索
const SEARCH_BRIEF = args.searchBrief       // search_brief.js 读取并核验过的候选集；数值的唯一来源
if (!BRIEF) throw new Error('design.compute 需要 args.brief')
if (BRIEF.stage !== 'compute') throw new Error('brief.stage 与 workflow 不符；契约串了')

// 1 主策略只产出搜索策略，不产出数字（枚举与打分由脚本做）
const policy = await agent(`${head('compute-expert')}\n\nbrief：\n${BRIEF_JSON}\n\n任务：给出本域的搜索策略…`,
  { label: 'search-policy', phase: 'Search policy', effort: 'high', schema: POLICY_SCHEMA })
if (policy.verdict === 'DIRECTION_BACKFLOW') return { verdict: 'DIRECTION_BACKFLOW', files: [] }
if (policy.verdict === 'BLOCKED_CONFIG')   return { verdict: 'BLOCKED_CONFIG', blockedFields: policy.blockedFields, files: [] }

// 2 确定性取数 —— 没有 agent：候选集已由脚本核验，ok=false 时退回，不用估算代替
const search = { ...SEARCH_BRIEF, candidates: SEARCH_BRIEF.candidates || [] }
if (!search.ok) return { verdict: 'BLOCKED_CONFIG', reason: '搜索产物不可用', files: [] }

const candidateBrief = { ...search, candidates: search.candidates.slice(0, MAX_CANDIDATES) }

// 3 旁证给约束 —— 串在候选集之后：约束针对具体候选，见不到候选提不出可执行的约束
const [memC, physC] = await parallel([
  () => agent(`${head('memory-expert')}\n\n候选集：\n${JSON.stringify(candidateBrief)}…`,
    { label: 'constraint:memory', phase: 'Constraint recall', effort: 'high', schema: CONSTRAINT_SCHEMA }),
  () => agent(`${head('physical-expert')}\n\n候选集：\n${JSON.stringify(candidateBrief)}…`,
    { label: 'constraint:physical', phase: 'Constraint recall', effort: 'high', schema: CONSTRAINT_SCHEMA }),
])
if (constraints.some(c => /BACKFLOW$/.test(c.verdict))) return { verdict: 'DIRECTION_BACKFLOW', files: [] }

// 4 合并（integrator 只合并，不重新发明）
const merged = await agent(`${head('integrator')}\n\n候选集：\n${…}\n\n旁证约束：\n${…}`,
  { label: 'integrator', phase: 'Merge', effort: 'high', schema: MERGE_SCHEMA })
if (merged.verdict !== 'INTEGRATION_OK') return { verdict: 'DELTA_UNEXPLAINED', merge: merged, files: [] }

// 5 强制检点 —— 最后一步必须是检点，不是总结；合并者与检点者必须是两次调用
const check = await agent(`${head('invariant-checker')}\n\nwinner：\n${…}\n\n检点清单：\n${…}`,
  { label: 'invariant-checker', phase: 'Invariant check', effort: 'high', schema: CHECK_SCHEMA })
const ok = check && check.verdict === 'INVARIANT_OK'

// 6 返回值即落盘清单：检点不通过时 files 为空（退回，不写 winner）
return { verdict: ok ? 'INVARIANT_OK' : 'INVARIANT_VIOLATED', winner: ok ? merged.winner : null,
  rejectedWinner: ok ? null : merged.winner, ledgerPatch, runRecord,
  files: ok ? [{ path: `out/compute/${STAGE}_winner.json`, content: … },
               { path: `out/compute/${STAGE}_run_record.json`, content: … }] : [] }
```

`ledgerPatch` 必须带 `rejectedOptions`（否则重跑会重新发明已否方案）与 `strategyVersions`
（否则同输入两次跑出不同结果无法解释）。`runRecord` 必须带候选集指纹与口径标注，
否则"这批候选是从哪份空间搜出来的"事后不可复核。

## 5. 强制机制

### 5.1 两个新机制：Brief 与设计账本

**`design_brief.json`**（架构师下发，每个 stage 一份）

```json
{
  "schemaVersion": "1.0",
  "stage": "compute",
  "runId": "...", "sourceCommit": "...",
  "objective": "本阶段要回答的唯一问题",
  "hardConstraints": [{ "id": "C-AREA-7R", "text": "7-reticle 面积守恒", "source": "ADR-0018" }],
  "budget": { "areaMm2": null, "powerW": null, "bandwidthGBs": null },
  "shapeIntent": "架构师大致想要的形态（允许被专家反驳，但必须给出理由）",
  "allowedDesignSpace": "指向 teams/hardware/inputs/*.json 或内联选项",
  "forbidden": ["第二份硬件规格", "MC640 当作可制造默认值"],
  "exitCriteria": [], "evidenceLevelFloor": "E1",
  "profileBinding": { "physicalProfile": "P1", "mcProfile": "MC320" }
}
```

**`design_ledger.json`**（跨 workflow 的唯一串联机制；每个 workflow 第一步读、最后一步回写）

```json
{
  "schemaVersion": "1.0",
  "currentStage": "...",
  "strategyVersions": { "compute-expert": "1.0", "memory-expert": "1.0" },
  "frozenDecisions": [{ "id": "ADR-0022", "decision": "...", "lockedAt": "..." }],
  "rejectedOptions": [{ "stage": "comm", "optionId": "comm-03", "reason": "...", "rejectedBy": "invariant-checker" }],
  "budgetBalance": { "areaMm2": { "total": null, "committed": null, "free": null } },
  "openBlockers": [{ "id": "...", "owner": "...", "unblockCondition": "..." }],
  "evidenceIndex": [{ "claimId": "...", "evidence": "path:line", "level": "E1" }]
}
```

两个字段是新增的关键项：

- **`rejectedOptions`**：现在 `candidate_register.json` 只记候选状态，不记"为什么否决"。没有它，重跑一个 stage 会重新发明已否方案。
- **`strategyVersions`**：策略变了，历史结论的可复现性就变了。记录本次运行用的策略版本，"同一输入两次跑出不同结果"才是可解释的。

### 5.2 结构测试（把抽象固化下来）

扩展现有 `tests/structure/test_project_structure.js`：

| 检查 | 目的 |
|---|---|
| 每个 agent 定义文件只含 §2.4 的字段 | 防止编排逻辑回流到策略 |
| agent 定义中不得出现文件路径字面量 | 强制 §2.2 边界 2 |
| agent 定义中不得出现 schema 定义 | 强制 §2.2 边界 1 |
| 每个 workflow 的最后一个 agent 调用是检点类策略 | 防止"以总结代替检点" |
| `out/` 里的 TPS 字面量必须能追溯到 `integration/pipelines/*` 或 `integration/detailed/*` | 强制 §2.2 边界 4 |
| agent 定义里的 `verdictEnum` 必须被某个 workflow 的 `switch` 消费 | 防止裁决枚举写了没人接 |
| `design_ledger.strategyVersions` 与实际使用的策略版本一致 | 保证可复现 |

**可替换性测试**：把 `compute-expert` 的策略换成另一份（例如"面积优先"换"频率优先"），整套 workflow 不改一行仍能跑通。跑不通说明有逻辑泄漏到了 workflow 之外的地方。

### 5.3 受控逃生口：`design.explore`

策略只能在 workflow 内运行会带来一个副作用：**"我就想问问这个域通常怎么做"也必须先搭一个 workflow**，摩擦很大。不设出口，实际结果会是大家绕过制度直接在对话里设计——那更糟，产出完全无法追溯。

因此保留一个最小 workflow：

- 单个策略实例，无并行、无检点；
- **明文规定只许写 `scratch/`**，不许写 `out/`、不许进 ledger、不许作为任何 claim 的证据；
- 每次运行必须落盘一份 `scratch/explore_<runId>.md` 记录读了什么、判断了什么。

## 6. 五个必须防的坑

| 坑 | 表现 | 机制 |
|---|---|---|
| 局部最优陷阱 | 专家说"本单元最优"，但不知道别处预算被砍 | 每个 C/D workflow 末尾强制 `invariant-checker` |
| 并行抢预算 | 4 个领域策略在同一上下文里争面积 | 拆成 4 个独立 workflow，收敛点外置（`design.converge`） |
| 并行化设计深度 | 用 workflow 并行细化同一条链的 5 个环节 | D 组严格串行；只有 B/C 组的独立候选并行 |
| 无记忆漂移 | 重跑 stage 重新发明已否方案 | `design_ledger.rejectedOptions` + `strategyVersions` |
| 候选工厂 | `out/` 堆满没有收敛的方案 | 每个 stage 一个 winner；检点不通过就不落盘 |
| **跨域知识掉落** | 有些判断天然跨域（"带宽受限的架构不该堆 tensor core"） | 只放在 `architect` 策略或 workflow 检点规则里，**不塞进专家策略**，否则破坏"专家不输出跨域结论" |

## 7. 与既有机制的对接

| 既有机制 | 重构后如何处理 |
|---|---|
| `integration/pipelines/evaluate_gates.js` | 不变。`design.dgate` / `design.verify` 只调用它，不出判据 |
| `tests/structure/test_project_structure.js` | 按 §5.2 扩展 |
| `teams/<team>/contract.json` | 由 `design.contract` 维护，`generate_team_contracts.js` 仍是生成器 |
| `references/sota/*` | 从"主 workflow 公共读区"改为**按领域作为注入参数**传给对应策略；"知识不是证据"的隔离规则原样保留 |
| `AGENTS.md` §2 的 `PASS` 字面量禁令 | 扩展到 LLM：任何 agent 不得输出 `PASS` / `D_GATE_PASSED` |
| `17/18/19` 三份文档 | 降级为**阶段定义**（Stage A/B 的方法论），D\*/Q\* 保留为阶段别名，不再是"agent" |

## 8. 明确不做的

- **不给每个 D1–Q9 建一个 workflow**（16 个）。那只是把文档翻译成 JS，双套流程的问题没解决，反而多一层。
- **不做"总 workflow 调子 workflow"的嵌套**。脚本层面不支持把 workflow 当函数调，靠文件传递等于没嵌套。分层交给设计账本。
- **不给 reviewer 建平行 workflow**。审查必须独立于设计；`design.verify` / `design.audit` 的策略注入里不得包含设计阶段的中间产物。
- **不保留 D\*/Q\* 与领域专家两套角色**。两套角色 = 两套职责边界 = 迟早冲突。
- **不把 schema、路径、流程写进策略**。这是本次抽象的全部意义所在。

## 9. 重构计划

### 9.1 切片与顺序

| 切片 | 内容 | 交付物 | 依赖 | 完成判据 |
|---|---|---|---|---|
| **S1** | 定规范：agent 定义规范（§2.4 字段表 + §2.2 硬边界）+ `design_brief` / `design_ledger` schema + `agent_roster.json`（12 策略） | `teams/council/inputs/agent_roster.json`、`design_brief.schema.json`、`design_ledger.schema.json`；§5.2 的校验脚本 | 无 | schema 通过 governance 测试；校验脚本能在**故意注入一个含路径字面量的假策略**时报错 |
| **S2** | 架构师策略：A0 扩权为"输入需求+约束+形态意图 → 输出 brief" | `design.intake` workflow 骨架 + `architect` 策略 + `framing-critic` 策略 | S1 | 能从一段需求文本产出填满 `hardConstraints`/`budget`/`shapeIntent` 的 brief，且 `framing-critic` 反问有实质内容 |
| **S3** | **样板 workflow**：`design.compute` | `integration/orchestration/design.compute.workflow.js` | S1、S2 | 跑通 §4.3 六步闭环；检点不通过时返回 `{blocked}` 且不写 winner；回写 `rejectedOptions` + `strategyVersions` |
| **S4** | 复制到 `design.memory` / `design.comm` / `design.physical` | 3 个 workflow | S3 | 复用骨架，仅换主策略与设计空间；4 域共享同一 `design_ledger` |
| **S5** | B 组：`design.contract` / `design.direction` / `design.dgate` | 3 个 workflow | S3 | `design.direction` 从 6–12 候选收敛到 ≤3；`design.dgate` 结论与 `evaluate_gates.js` 一致，且不含 `PASS` 字面量 |
| **S6** | D 组 5 个串行 workflow + `design.converge` | 6 个 workflow | S4、S5 | 粗估-细估 delta 有归因；`DIRECTION_BACKFLOW` / `LOCAL_DETAIL_FIX` 分支可执行 |
| **S7** | E 组 3 个横切 workflow + `design.explore` | 4 个 workflow | S6 | 原 `k3_multiteam_review` 已并入 `design.verify` 并删除；verify/audit 的策略注入里确认不含设计中间产物 |
| **S8** | 文档与结构测试收口 | 改 `17/18/19`、`AGENTS.md`、`docs/README.md`、`docs/architecture/README.md`、`test_project_structure.js` | S7 | `npm test` 全绿；`17/18/19` 里 D\*/Q\* 已明确标注为"阶段名，非 agent" |

**S3 是关键切片**：只有它跑通，才知道策略颗粒度、N 该取多少、旁证约束的传递方式对不对。S1/S2 是它的前置，S4–S7 是它的复制。

### 9.2 每切片验收

- **S1–S2**：`framing-critic` 能在 brief 上找到至少一处实质缺口（否则说明它没起作用）；校验脚本对假策略报错。
- **S3–S4**：每个域产出 winner + `rejectedOptions`；检点不通过时不落盘。
- **S5**：候选从 6–12 收敛到 ≤3；`design.dgate` 不产生 `PASS` 字面量。
- **S6**：D 组任一步骤缺输入时必须输出 `BLOCKED_CONFIG` + `nextActions`，不得静默补全。
- **S7**：verify/audit 的策略无法读到设计阶段产物（prompt 约束 + 抽查验证）；`design.explore` 产物全部落在 `scratch/`。
- **S8**：`npm test`、`npm run check:structure` 通过；`AGENTS.md` §5 的完成定义在新流程下仍成立。

### 9.3 成本预算

- C 组单轮约 4×(N + 5) 个策略实例。**第一轮 N 取 6**，看哪种 shape 活下来，第二轮只对赢家邻域展开。
- 全量 15 个 workflow 单次完整跑约 300+ 实例。**不应每次全量跑**：S3–S4 的域搜索按需触发，D 组串行链在方向冻结后才跑。
- 策略：**先窄后宽**，收窄 `allowedDesignSpace` 以避免 4 域 × N 选项的乘积爆炸。

### 9.4 风险与回滚

| 风险 | 等级 | 缓解 | 回滚 |
|---|---|---|---|
| 领域策略的局部最优累积成错误架构 | 高 | 强制 `invariant-checker` + 全局预算账本 | 检点不通过 → `design.backflow` 重下 brief |
| 策略定义被逐渐塞回编排逻辑 | 高 | §5.2 结构测试 + 可替换性测试 | 该策略打回，逻辑移回 workflow |
| `design_ledger` 成为新的一致性瓶颈 | 中 | schema 化 + governance 测试；只记决策和否决，不记过程 | 拆成 per-stage 账本 + 一份索引 |
| 双套流程漂移加剧（新 workflow 与 17/18/19 并存） | 中 | S8 必须完成；S1–S7 期间在 17/18/19 顶部加"已被 22 号文档取代"的指引 | 冻结新 workflow，先改文档 |
| 探索性工作被制度卡死、绕道对话 | 中 | §5.3 的 `design.explore` 逃生口 | 放宽 explore 的写入范围到 `out/scratch/` |
| N 过大导致成本失控 | 中 | 第一轮 N=6，先窄后宽 | 缩小 `allowedDesignSpace` |

### 9.5 里程碑

```text
M1（S1+S2）  规范与架构师就位          —— 其他 13 个 workflow 的公共依赖
M2（S3）     样板域跑通完整闭环        —— 颗粒度验证点，此时应重新评估设计
M3（S4+S5）  四域 + 方向组就位         —— 高层设计全面 workflow 化
M4（S6+S7）  详细设计链 + 横切就位     —— 端到端可跑
M5（S8）     单一流程，文档收口        —— 双套流程消除
```

**M2 之后必须停下来重新评估一次**：如果 `design.compute` 的骨架在真实空间上不成立（例如策略在 N 个选项间做不出可信取舍），S4–S7 的复制就是放大错误，此时应改设计而不是继续复制。

## 10. 完成定义

重构完成时：

- **agent 只有一处定义**：`teams/council/inputs/agent_roster.json`，且每个 agent 只含 §2.4 的九个字段；
- **agent 里没有任何路径、schema、流程**；结构测试可证明这一点；
- **编排只有一处定义**：`integration/orchestration/design.*.workflow.js`；
- **agent 只在 workflow 内运行**；唯一例外是 `design.explore`，且产物限定在 `scratch/`；
- 跨 stage 信息只通过 `design_brief.json` / `design_ledger.json` 流动；
- 决定性数字只来自 `integration/pipelines/*` 和 `integration/detailed/*`；
- `17/18/19` 只描述阶段方法论，D\*/Q\* 明确标注为阶段名；
- `npm test`、`npm run check:structure` 全绿；
- 每个 stage 的产物可回溯到 `runId` / `sourceCommit` / 输入 hash / `strategyVersions`，且带被否方案及理由。
