# Orchestration

多 agent 跨团队评审的 workflow 脚本，由 Architecture Council 拥有。它按 `AGENTS.md` 的团队划分派 agent，把各团队结论汇成一份可审计的 ledger，交给 Council 集成。

这里的脚本**不是** Node 入口，不能用 `node` 运行。它们是 Claude Code Workflow 脚本（`export const meta` + `agent()` / `parallel()` / `phase()`），不被任何 `require`，也不写 `out/`。

共三个脚本：`k3_multiteam_review.workflow.js`（主流程，内部对账）、`k3_external_references.workflow.js`（旁路，外部参照系）、`k3_agent_learning.workflow.js`（一次性，领域知识沉淀）。三者**不串联**：旁路与知识库的产物都不进 ledger，只作为判断"假设是否偏离行业常规"的参照。

## `k3_multiteam_review.workflow.js`

议题：K3 P1 候选（TP32 / PP1 / B=1 / Context=1M）距 1050 TPS/usr 冻结门槛差多少、归因到哪个团队、哪些前提记为 blocker。

运行：在 Claude Code 中让 Claude 以该文件为 `scriptPath` 调用 Workflow 工具。全程只读。

### 流程

| 阶段 | agent | 作用 |
|---|---|---|
| Probe | 7 个，按团队（HW-MC、HW-A、HW-P、SW-A、MODEL-A、VV-A、ARCH-A） | 每个探针只回答一个窄问题，输出原子 claim（evidence 为 `path:line` 或 `UNVERIFIED`，带 `flip_evidence` 与 severity）。每个探针声明覆盖 `AGENTS.md` 中的哪些 ownership，脚本算出 `uncovered_responsibilities`。HW-MC 单独拆出：MC 档位是唯一能翻转 1050 结论的变量，不与余量项（AI Core/SRAM）共用 claim 额度；**集合通信并入该探针**（τ 的 hop/PHY/协议拆分、TP32 allreduce 的拓扑与链路账、overlap 能力），因为它的带宽账与 MC sustained 是同一笔账——但 ownership 归 HW-05 NoC/Die-to-Die，不新设探针 |
| Team merge | 5 个 lead | 合并去重、从严重评 severity（只有单独能翻转 1050 或被 ADR 禁止的才算 blocker）。脚本统一编号为 `CLM-<TEAM>-NN`，与仓库工作项 `HW-*`/`MODEL-*` 等分开 |
| Interface pairs | 每个有 ≥2 个团队 claim 的接口一个 | 6 个接口按声明双方配对（hw-sw-abi、workload-operator、k3-shape、sw-model-precision、ppa-gap、gate-governance），核对 peak/sustained、1000/1050 口径与未回应的需求 |
| Premises | 1 | 质疑结论依赖的前提本身：MC 效率 0.7、UCIe 0.8、margin 1.17、matrix density 3.2、τ=1.15 等。每条给双向敏感度、翻转临界值和取证方向，并正面回答"1050 挡住的差距主要是能力差距还是系数不确定性" |
| Adversarial | blocker × 3 视角，外加最多 6 条仅被接口判 blocker 的 claim | 视角为 arithmetic、evidence-chain、basis-consistency，默认判反驳。≥2 票反驳 killed，1 票 split，缺票 incomplete |
| Evidence requests | 1 | 把各条 blocker 的 `flip_evidence` 聚合成可派发的取证清单（要什么、找谁要、拿到后哪个数字变、没有它卡在哪），按关键路径排序 |
| Council | 1 | 只吃 ledger。ledger 外的新结论必须放进 `new_items`，报告中只能以 PENDING 引用 |
| Council recheck | new_items × 3 视角，必要时 1 个增补 | 回核 Council 新增项；有未存活项时 Council 出增补并修订 blocker 清单 |
| Critic | 1 | 查未核验 claim、单边接口、被写成定论的假设、余量重复分配、下一轮派发清单 |

### 阶段串接与 effort

Probe 与 Team merge 合成**一条按团队串接的 pipeline**：每团队的探针并行跑完，该团队 lead 立即合并，不等其他团队。任一团队卡住不会阻塞其余团队，跑完的 agent 会写入 journal，中途被打断可用 `resumeFromRunId` 命中缓存。
effort 分级：探针 / lead 为 `medium`，接口配对 / 对抗核验 / Council / Critic 为 `high`，增补为 `medium`。接口配对决定哪些 claim 进入对抗核验，所以与核验同级，不再降档。

### 覆盖与失败记账

- 探针失败的团队仍进 lead，但 lead 的输入里会显式声明缺了哪个探针，必须据此声明覆盖不完整，不能用现有材料推断代替。
- `stage_failures.lead` 记录**所有**没有产出立场的团队（含探针全失败、以及 pipeline 阶段抛错），不再只记"有探针但 lead 失败"。
- `args.teams` 里的未知团队名直接抛错，不会静默跑出 0 个 agent。

### 护栏

- 所有 agent 只读；数字必须带出处，否则写 `UNVERIFIED`。
- 不写 gate 字面量结论；gate 由 `integration/governance/evaluate_gates.js` 计算。
- 1000 目标与 1050 门槛、peak 与 sustained、detailed 与 planning 必须分开引用。
- 失败的 agent 不静默丢弃：`stage_failures`、`absent_teams`、`unpaired_interfaces`、`unverified_contested` 全部进入 ledger。

### 运行记录与已知问题

2026-09-26 一次完整运行：112 个 agent，0 失败，约 4.05M subagent tokens，约 45 分钟。Council 报告、增补与 critic 漏项清单见 [`teams/council/docs/reviews/2026-09-26_K3_P1_FREEZE_GAP_REVIEW.md`](../../teams/council/docs/reviews/2026-09-26_K3_P1_FREEZE_GAP_REVIEW.md)。

该次运行暴露、尚未修复的问题：

1. 既非 blocker、也未被接口判 blocker 的 claim 完全不经对抗核验，但 Council 仍可能引用其中的数字。ledger 应给每条 claim 标核验状态，Council 引用时必须带上。
2. "只出一套验收线"与"split 不得单票改写"只写在 prompt 里，Council 仍违反。需要在 Critic 前加报告自洽性检查，违规则退回重写。
3. 复合 claim 一处出错即整条 killed，站得住的部分随之丢失。核验输出应增加可保留部分并回填 ledger。
4. 接口 finding 中"对方未回应"的需求没有转成带 owner 的未决项。
5. 所有扫描与重搜（MC480/560 约束内重搜、档位/mcUtil/τ 扫描、联合回退）都是 agent 在只读模式下临时算的，没有入库，因此在 ledger 里一直是 UNVERIFIED。需要由 `integration/pipelines/` 下的脚本生成到 `out/`。

## `k3_external_references.workflow.js`

主流程的旁路。主流程能回答"哪个系数没有出处"，回答不了"这个系数是否偏离行业常规"——后者决定值不值得花力气去要实测数据，只能靠外部资料。

输入：主流程返回值里的 `premises`（或其 `premises` 数组），经 `args.premises` 传入；也可用 `args.questions = ["系数叫什么", ...]` 单独试跑。

```js
Workflow({scriptPath: '.../k3_external_references.workflow.js', args: {premises: mainRun.premises}})
```

流程：按领域路由前提（memory / ppa / model / method / other），每个领域一个 agent 联网调研，再合成一份按主题重组的文档 + 结构化条目。3–6 个 agent。

### 隔离规则（这个 workflow 成立的前提）

外部数字只是**参照系**，不是**证据**。两者不能混：

- 证据（主流程）能指向 `文件路径:行号`，可被三视角核验、可改判。
- 参照系（本脚本）说明"同类系统的取值区间"，用来判断假设是否异常、该不该取证。它不证明本项目任何数字。

因此本脚本的产物放在独立的 `external_references` 命名空间，`not_evidence: true`，**不进 ledger，不得作为任何 claim 的 evidence**。三条护栏写进每个 agent 的 prompt：

1. 不得用外部数字覆盖、修正或重算仓库基线。
2. 每条必须带来源（名称 + 年份 + 链接）；没有可核查来源的标 `evidence_kind=model_memory`，合成阶段列入 `unusable` 并从正文剔除。
3. 每条必须写 `not_comparable_when`（拓扑/规模/精度/负载差异），写不出边界的不收——没有边界的参照系会被当成万能类比。

`relation` 字段是关键输出：`outside_range` / `at_edge` 是"该去要实测数据"的信号，合成时置顶。

## `k3_agent_learning.workflow.js`

**一次性**脚本：让各领域的 agent 各学一遍本领域的 SOTA 与经典方案，沉淀到 `references/sota/`，之后每轮评审直接读档，不再联网。

它和上面那个旁路的分工：

| | 输入 | 频次 | 回答 |
|---|---|---|---|
| `k3_external_references` | 某轮的 `premises` | 每轮可能重跑 | "这个系数偏离常规吗" |
| `k3_agent_learning` | 学习单元（7 个领域） | 一次，按需刷新 | "这个领域通常怎么做" |

学习单元按**探针的问题域**划分（memory-subsystem、interconnect-collective、compute-core、model-workload、sustained-tps、evidence-governance、package-ppa），不按 25 个 agent 角色拆——角色粒度太细会得到 25 份互相重复的文档，而探针粒度正好是主流程真正会来查的知识。

```js
Workflow({scriptPath: '.../k3_agent_learning.workflow.js', args: {as_of: '2026-10-01'}})
// 只刷新部分领域：
Workflow({scriptPath: '.../k3_agent_learning.workflow.js', args: {as_of: '2026-10-01', units: ['memory-subsystem']}})
```

`as_of` 必须由 `args` 传入。脚本里取不到当前时间（`Date.now()` 会破坏 resume），拿不到就写 `UNVERIFIED`，不猜。

### 落盘方式

脚本**没有文件系统权限**，workflow agent 也全程只读。它返回 `files: [{path, content}, ...]`，由主循环写入 `references/sota/` 后再提交。这是刻意的：知识入库是一次不可逆的写操作，应当由人在环上确认，而不是由 7 个联网 agent 直接落盘。

### 边界

同三条护栏，字段名换成知识卡的：`confidence=model_memory` 的条目隔离进 `quarantined` 并从正文剔除；每条必填 `not_applicable_when`；`project_premises` 里的取值原样引用、不得改写。

知识库的定位、刷新方式与可信度标记见 [`references/sota/README.md`](../../references/sota/README.md)。
