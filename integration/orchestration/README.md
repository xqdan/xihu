# Orchestration

K3 设计流程的 workflow 脚本，由 Architecture Council 拥有。

这些脚本是**设计过程中的编排层**，不是评审工具，也不是 Node 入口——不能直接用 `node` 运行（要在哪里跑见下面的“在哪里运行”）。它们是 Claude Code Workflow 脚本（`export const meta` + `agent()` / `parallel()` / `phase()`），不被任何 `require`，也不直接写文件：产物作为返回值里的 `files: [{path, content}]` 交回主循环落盘。

设计本身怎么分工，见 [`teams/council/docs/22_AGENT_WORKFLOW_REFACTOR_PLAN.md`](../../teams/council/docs/22_AGENT_WORKFLOW_REFACTOR_PLAN.md)。那份文档定义每个格的契约；本文件只讲脚本在哪、怎么跑、哪些坑还没填。

## 在哪里运行

脚本源码只有一份（Claude Workflow 格式），宿主有两种：

| 宿主 | 怎么跑 | 谁回答 `agent()` |
|---|---|---|
| **Claude Code** | Workflow 工具原生执行，脚本零改动 | Claude Code 自己（`schema` 由它原生约束） |
| **其他环境（Cursor、CI、本地终端）** | `npm run workflow:run -- <workflow> --backend claude\|cursor\|exchange\|mock` | 可切换的后端，见下 |

第二种由 [`runtime/`](runtime/)（注入 `args` / `agent` / `parallel` / `phase` / `log`）加
[`../pipelines/run_workflow.js`](../pipelines/run_workflow.js)（主循环）实现。`runtime/` 不读写仓库文件，主循环做三件事：

1. **前置**：C 组先跑 `search_brief.js`，把核验过的候选集作为 `args.searchBrief` 注入；
2. **执行**：运行前后各取一次工作区快照（`runtime/guard.js`），agent 若改动了任何文件，本次不落盘（退出码 3）；
3. **后置**：C 组 winner 先与候选产物逐字段核对（不一致退出码 5，不落盘），再经 `runtime/land.js` 的路径与内容闸门落盘（拒绝退出码 4）。落盘是**可选的**：不加 `--land` 就是 dry run，闸门全跑、不写任何文件。
   一次运行若没有返回任何文件（旁证回退、输入不足），主循环改为落一份结果记录 `out/<域>/<workflow>_outcome.json`（`runtime/outcome.js`；候选明细折叠成 id 列表），让“谁在什么约束上停了这次运行”留在磁盘上而不只在终端里。`--result-file <path>` 另存完整返回值。

| 后端 | 实现 | schema | 只读 | 状态 |
|---|---|---|---|---|
| `mock` | 按 schema 生成固定回复 | 由 schema 生成 | — | 测试与冒烟用，不代表设计质量 |
| `claude` | `claude -p --output-format json --json-schema … --tools Read,Grep,Glob`，prompt 走 stdin | CLI 原生约束 + 运行时再校验 | 工具白名单 | 经假 CLI 测试；**本机的 claude 配置返回 403 Model disabled，未做过真实调用** |
| `exchange` | 把每次 `agent()` 调用写成 `<dir>/<运行号>/NNN.request.json`（prompt 已附 schema），轮询 `NNN.answer.txt` 作为回复；默认目录 `scratch/wf_exchange`（被 git 忽略），`--exchange-dir` 可改，`--timeout` 内无人应答是致命错误 | 运行时校验，失败带错误清单重试 | 取决于回答者；主循环的工作区快照照常检查 | 给没有 API key 但有 Cursor / Claude 会话的环境：由会话（例如派子 agent）读请求、写回复。已通过文件级测试；同一协议的一次性脚本版本曾用 Cursor 子 agent 跑通过 `compute` 的前三次调用，正式后端本身尚未做过真实会话运行 |
| `cursor` | `@cursor/sdk` 的 `Agent.prompt`，schema 放进 prompt | 运行时校验，失败带错误清单重试（最多 3 次） | 请求只读工具集 | 经假 SDK 测试；**未用真实 `CURSOR_API_KEY` 调用过**；`@cursor/sdk` 不是仓库依赖，用时 `npm install --no-save @cursor/sdk`（Node ≥ 22.13） |

两条在所有后端上一致的规则（`runtime/core.js`）：带 `schema` 的 `agent()` 要么返回通过校验的值，要么在重试用尽后返回 `null`
（脚本本来就把 `null` 当作“该实例没产出”并阻断）；**启动失败**（没有 key、没有 CLI、模型被禁用、认证失败）是致命错误，整次运行中止，
不会被当成 `null`，更不会变成一个设计裁决。


`design.*.workflow.js` 是唯一一套流程。历史上有过一套 `k3_*.workflow.js`（`k3_multiteam_review` / `k3_external_references` / `k3_agent_learning`），已全部并入下面这些格并删除——**两套流程并行时，同一件事有两个说法，谁也说不清哪个算数**。

| 旧脚本 | 去向 |
|---|---|
| `k3_multiteam_review.workflow.js` | → `design.verify` 的骨架；其"按 ownership 覆盖 + 三视角对抗核验"的做法保留在 verify/audit |
| `k3_external_references.workflow.js` | → `design.audit` 的一个可选阶段（传 `args.premises` 时启用），产物落 `references/external/` |
| `k3_agent_learning.workflow.js` | → `design.learn`（仍是一次性脚本），产物落 `references/sota/`，并按领域登记了注入点 |

## 19 个脚本

每个 workflow 对应的业务环节、产出和结局，见 [`WORKFLOWS.md`](WORKFLOWS.md)；下面按组列出契约与分工。

### 通用前提

每个脚本都遵守同一条契约，下面不再重复：

- **脚本不读文件、不写文件。** brief、ledger、搜索产物由主循环经 `args` 传入（C 组的搜索产物以 `args.searchBrief` 传入，由 `integration/pipelines/search_brief.js` 读取并核验，见下）；策略正文由 agent 自己按 `agentId` 读 `teams/council/strategies/<agentId>.md`。
- **agent 全程只读。** 搜索与确定性计算在主循环或 `integration/pipelines/` 下运行，绝不在 workflow 内运行。
- **裁决枚举是数据不是结论。** 专家报 `LOCAL_DETAIL_FIX` / `DIRECTION_BACKFLOW` / `BLOCKED_CONFIG` / `PPA_DIRECTION_BACKFLOW`，architect 报 `ARCH_FREEZE` / `D_GATE_PROPOSAL`，脚本用 `switch` 拿它们决定走哪条边。
- **没有任何 agent 能宣布门控通过。** 门控结论只由 [`integration/governance/evaluate_gates.js`](../governance/evaluate_gates.js) 计算；workflow 与策略里不得出现 `PASS` 字面量。
- **数字必须带出处**（`文件路径:行号` 或 ADR 编号），没有出处的写 `UNVERIFIED` 并说明缺什么，不得静默补齐。

### A 组 · 接口与契约

| 脚本 | 回答 | 策略实例 |
|---|---|---|
| `design.contract.workflow.js` | 接口长什么样 | `architect` · 4 专家 · `invariant-checker` · `verifier` |

### B 组 · 输入与方向

| 脚本 | 回答 | 策略实例 |
|---|---|---|
| `design.intake.workflow.js` | 需求+约束能否变成可计算输入 | 6 专家 · `architect` · `framing-critic` · `invariant-checker` |
| `design.direction.workflow.js` | 走哪条路线 | `architect` · `integrator` · 6–12 候选各一 agent · `framing-critic` · `invariant-checker` · `gate-keeper` |
| `design.dgate.workflow.js` | 候选能否进细化 | 8 条门槛各一独立 `gate-keeper` · `invariant-checker` · `architect`；结论由脚本算 |

`design.dgate` 是最容易写歪的一格：它做的是**把 8 条门槛的证据凑齐**，不是判门。判门是 `evaluate_gates.js` 的事，脚本对它的结论原样转述。

### C 组 · 四域设计空间（同构骨架）

| 脚本 | 域 | 主策略 |
|---|---|---|
| `design.compute.workflow.js` | AI Core | `compute-expert` |
| `design.memory.workflow.js` | SRAM/MC/TMA | `memory-expert` |
| `design.comm.workflow.js` | NoC/collective | `comm-expert` |
| `design.physical.workflow.js` | 封装/面积/功耗/热 | `physical-expert` |

四域共用一套骨架（`design.compute` 是样板，其余三格只换主策略与设计空间）与同一份 `design_ledger`。骨架的六步闭环与脚本 API 强制的三处出入，见计划文档 §4.3。

**顺序上有一处刻意的安排**：旁证约束串在**确定性搜索之后**，不是串在"初稿"之后。约束针对的是具体候选——见不到候选就提不出可执行的约束（"说不出否掉谁的约束不要提"）。

### D 组 · 细化（严格串行）

| 脚本 | 回答 |
|---|---|
| `design.detail.freeze.workflow.js` | 冻结 manifest 与 provenance（**无 integrator**，这一步只冻结不合并） |
| `design.detail.workload.workflow.js` | 算术强度 / Roofline / sizing |
| `design.detail.events.workflow.js` | tile / packet / kernel 事件（三路并行，共享 manifest hash） |
| `design.detail.execute.workflow.js` | schedule / PPA |
| `design.detail.integrate.workflow.js` | fine TPS + delta 归因 |
| `design.converge.workflow.js` | 架构定型 + ADR |

D 组**不得并行化**：这五个环节是同一条链上的前后依赖，用 workflow 并行它们只会把串行链拆碎，不会更快。

### E 组 · 横切

| 脚本 | 回答 | 与相邻格的分工 |
|---|---|---|
| `design.verify.workflow.js` | 这份产物本身能否独立站住 | 面向**产物**：schema、守恒、provenance、golden trace |
| `design.audit.workflow.js` | 支撑它的证据链与口径是否自洽 | 面向**依据**：沿证据链往回走，看出处本身是否支撑结论、同一个量在别处是否用了另一个口径。查的是关系，verify 查的是个体 |
| `design.backflow.workflow.js` | 不达标往回流 | 串行；按归因把问题退回给具体的格 |

两个脚本的策略注入里**不得包含设计阶段的中间产物**——审查必须独立于设计。可选的外部参照系阶段挂在 `design.audit` 上（见下）。

### X 组 · 受控逃生口

`design.explore.workflow.js`：单策略实例，无并行、无检点。策略只能在 workflow 内运行会带来一个副作用——"我就想问问这个域通常怎么做"也必须先搭一个 workflow，摩擦很大；不设出口，实际结果会是大家绕过制度直接在对话里设计，那更糟。

因此留了这一格，但**明文规定只许写 `scratch/`**，不许写 `out/`、不许进 ledger、不许作为任何 claim 的证据；每次运行必须落盘一份 `scratch/explore_<runId>.md`。

### L 组 · 一次性

`design.learn.workflow.js` 不参与常规阶段链，学完落 `references/sota/`，之后各领域 workflow 直接读档注入，不再联网。见 [`references/sota/README.md`](../../references/sota/README.md)。

## 外部参照系：`references/sota/` 与 `references/external/`

主流程能回答"哪个系数没有出处"，回答不了"这个系数**是否偏离行业常规**"——后者决定值不值得花力气去要实测数据。这两类产物补的是后半句，但入口不同：

| | `references/sota/` | `references/external/` |
|---|---|---|
| 生成者 | `design.learn`（一次性） | `design.audit` 的可选阶段 |
| 输入 | 学习单元（7 个领域） | 某轮的 `args.premises` |
| 频次 | 一次，按需刷新 | 每轮可能重跑 |
| 回答 | "这个领域通常怎么做" | "这个系数偏离常规吗" |

```js
// 按前提临时调研
Workflow({scriptPath: '.../design.audit.workflow.js', args: {brief, artifacts, premises: run.premises}})
```

**隔离规则（两者成立的前提）**：外部数字只是参照系，不是证据。证据能指向 `文件路径:行号`，可被核验、可改判；参照系说明"同类系统的取值区间"，不证明本项目任何数字。因此：

1. 不得用外部数字覆盖、修正或重算仓库基线。
2. 每条必须带来源（名称 + 年份 + 链接）；没有可核查来源的标 `model_memory` / `confidence=model_memory`，合成阶段列入 `unusable` / `quarantined` 并从正文剔除。
3. 每条必须写 `not_comparable_when` / `not_applicable_when`（拓扑/规模/精度/负载差异），写不出边界的不收——没有边界的参照系会被当成万能类比。

`design.audit` 的参照系阶段还有三条**结构性**隔离（不是靠 prompt 措辞）：

1. 它是第五个阶段，在四个视角与汇总全部结束之后才跑；结果不进 `lensResults`、不进 `consolidated`、不参与 `ok` 判定。
2. 它落 `references/external/` 而非 `out/`。`design.audit` 与 `design.verify` 的 intake 门只接受 `out/` 下的路径，参照系因此永远进不了下一轮的复核对象。
3. 它的结构里没有裁决、没有 severity、没有 findings，产不出可被消费的裁决。

参照系**不受 `ok` 门控**：即使四个视角判了失败，这一轮的参照系依然成立——它回答的是另一个问题。

## 策略边界（四条硬线）

`teams/council/inputs/agent_roster.json` 的 `boundaries` 是这套编排能成立的原因，任何新增或改动脚本都要先过这四条：

1. agent 定义里不得出现任何**输出契约**描述——输出什么由 workflow 注入。
2. agent 定义里不得出现任何**文件路径**。
3. **路由是数据不是行为**：agent 只产出裁决枚举，由 workflow 消费。
4. agent 不产出**决定性数字**：TPS、门控结论只由确定性模型计算。

`tests/governance/test_agent_strategy_boundary.js` 是这四条的执行者。它扫 `integration/orchestration/` 下所有 `design.*.workflow.js`，逐文件断言：有 `meta`、`name` 合规、`description` 非空、有 `phases`、无 `require(`、无 `fs.`、无 `Date.now(` / `Math.random(` / 无参 `new Date()`、无门控字面量（`不得|禁止|不判|严禁` 所在行除外）。它同时把 roster 钉死在 12 个策略，并要求每个策略有同名同版本的 `.md`。

新增一格 workflow 时，这份测试会自己兜住大部分错误。写之前值得先读一遍它。

## 已知未修问题

2026-09-26 一次完整评审运行（当时的 `k3_multiteam_review`，112 个 agent，0 失败，约 4.05M subagent tokens，约 45 分钟）暴露的问题。报告见 [`teams/council/docs/reviews/2026-09-26_K3_P1_FREEZE_GAP_REVIEW.md`](../../teams/council/docs/reviews/2026-09-26_K3_P1_FREEZE_GAP_REVIEW.md)。**这些问题描述的是流程本身，不是那份脚本——脚本换了，问题还在。**

1. 既非 blocker、也未被接口判 blocker 的 claim 完全不经对抗核验，但 Council 仍可能引用其中的数字。ledger 应给每条 claim 标核验状态，引用时必须带上。
2. "只出一套验收线"与"split 不得单票改写"只写在 prompt 里，Council 仍违反。需要在 Critic 前加报告自洽性检查，违规则退回重写。**这条是 prompt 约束不生效的实例：能靠结构解决的，不要靠措辞。**
3. 复合 claim 一处出错即整条 killed，站得住的部分随之丢失。核验输出应增加可保留部分并回填 ledger。
4. 接口 finding 中"对方未回应"的需求没有转成带 owner 的未决项。
5. **所有扫描与重搜**（MC480/560 约束内重搜、档位/mcUtil/τ 扫描、联合回退）都是 agent 在只读模式下临时算的，没有入库，因此在 ledger 里一直是 `UNVERIFIED`。需要由 `integration/pipelines/` 下的脚本生成到 `out/`。

第 5 条是新流程能否成立的关键：`design.verify` 要做产物级门控，就必须有机器可读的搜索结果可读。搜索留在 agent 的临时上下文里，verify 手里就只有结论没有依据，只能继续标 `UNVERIFIED`。

## C 组的取数与落盘核对

C 组四域读搜索产物这一步没有 agent：转写候选数值的若是 LLM，就没有任何东西核对"转写 = 原文"，而这些数值是合并、旁证、检点全部裁决的唯一数字来源。主循环的调用顺序：

```sh
npm run aicore:search                       # 先跑确定性搜索（compute；其余域见 integration/pipelines/README.md）
npm run -s workflow:brief -- compute > /tmp/compute.brief.json   # 读产物、核哈希、重跑搜索复核指纹，取前 N 个候选
# 调 design.compute，args.searchBrief = 上面的 JSON；落盘返回的 files
npm run -s workflow:verify-landed -- compute                     # 落盘后：winner 必须是产物里的一行
```

`brief` 在产物过期、指纹对不上、缺候选明细时给出 `ok:false`，workflow 据此退回 `BLOCKED_CONFIG`。`verify` 检查 winner 逐字段等于产物那一行、可行、run record 的指纹一致、被排除的 optionId 都在产物里；任何一项不成立都以非零退出。产物没有声明字段口径（目前只有 comm 的 `fieldCaliber` 声明了）时，`brief` 把口径字段一律记为 `UNVERIFIED`，不替产物推断。

另一条同类规则：旁证阶段（`constraint:*`）任何一路专家调用失败，workflow 退回 `BLOCKED_CONFIG` 并在 `absentLateral` 里点名——缺席的一侧不能当作"没有意见"。

`tests/regression/test_c_group_workflow_behavior.js` 用 mock 运行时真正执行这四个脚本，覆盖上述两条。

## 落盘方式

脚本没有文件系统权限，workflow agent 也全程只读。脚本返回 `files: [{path, content}]`，由主循环（Claude Code 的主 agent，或 `run_workflow.js --land`）写入后再提交。每个 workflow 只能落在它自己的目录下（`runtime/land.js` 的 `LANDING_POLICY`），`design.explore` 只能落 `scratch/`。这是刻意的：`out/` 与 `references/` 的写入是不可逆的，应当由人在环上确认，而不是由几十个 agent 直接落盘。

`out/` 只存放脚本生成的产物、已被 git 跟踪、不得手工编辑；`references/sota/` 与 `references/external/` 不是证据，不进 ledger。
