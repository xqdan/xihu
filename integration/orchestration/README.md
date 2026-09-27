# Orchestration

多 agent 跨团队评审的 workflow 脚本，由 Architecture Council 拥有。它按 `AGENTS.md` 的团队划分派 agent，把各团队结论汇成一份可审计的 ledger，交给 Council 集成。

这里的脚本**不是** Node 入口，不能用 `node` 运行。它们是 Claude Code Workflow 脚本（`export const meta` + `agent()` / `parallel()` / `phase()`），不被任何 `require`，也不写 `out/`。

## `k3_multiteam_review.workflow.js`

议题：K3 P1 候选（TP32 / PP1 / B=1 / Context=1M）距 1050 TPS/usr 冻结门槛差多少、归因到哪个团队、哪些前提记为 blocker。

运行：在 Claude Code 中让 Claude 以该文件为 `scriptPath` 调用 Workflow 工具。全程只读。

### 流程

| 阶段 | agent | 作用 |
|---|---|---|
| Probe | 6 个，按团队（HW-A/P、SW-A、MODEL-A、VV-A、ARCH-A） | 每个探针只回答一个窄问题，输出原子 claim（evidence 为 `path:line` 或 `UNVERIFIED`，带 `flip_evidence` 与 severity）。每个探针声明覆盖 `AGENTS.md` 中的哪些 ownership，脚本算出 `uncovered_responsibilities` |
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
