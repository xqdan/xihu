export const meta = {
  name: 'design-direction',
  description: 'K3 设计 direction 阶段：6–12 个候选各一 agent 独立评估，integrator 合并，framing-critic 对抗式审查框架，gate-keeper 逐条核验门槛证据，invariant-checker 检点后落盘',
  whenToUse: 'B 组。需要 args.brief（stage=direction 的 DesignBrief）、args.envelopeArtifact 与 args.scorecardArtifact（主循环已用 stage_a.js 生成好的方向包络与打分卡）。本 workflow 不跑搜索、不判门控、不写文件。',
  phases: [
    { title: 'Candidate evaluation', detail: '6–12 个候选各一 agent 独立评估，互相看不见' },
    { title: 'Convergence', detail: 'integrator 合并候选、记录冲突与排除依据' },
    { title: 'Framing review', detail: 'framing-critic 对抗式审查：约束完整吗、口径对吗、shape 空间是不是被写窄了' },
    { title: 'Gate evidence', detail: 'gate-keeper 逐条核验门槛证据与 blocker；不判结论' },
    { title: 'Invariant check', detail: 'invariant-checker 强制检点；不通过则不落盘' },
  ],
}

// ---------------------------------------------------------------------------
// B 组 direction。要回答的唯一问题是"走哪条路线"。
//
// 与 C 组骨架的关键区别：候选是**架构路线**（TP/档位/形态），不是某个域的设计空间取值。
// 因此这里没有"搜索策略 → 确定性搜索"两步——搜索由 stage_a.js 在主循环侧跑完，
// 候选集与包络作为产物传进来，本 workflow 只做评估、收敛与核验。
//
// 四条硬边界在此的落点：
//   边界 1：输出什么由本 workflow 注入，候选 agent 的策略正文里没有输出契约。
//   边界 2：路径只出现在本文件里，不进策略正文；候选 agent 靠 prompt 里的 agentId
//           自读策略，而不是靠 agentType 指名（agentType 只用于切内建 agent 类型）。
//   边界 3：评估裁决（INTEGRATION_OK / DELTA_UNEXPLAINED）、框架裁决
//           （FRAMING_OK / FRAMING_INSUFFICIENT）、门槛裁决（GATE_EVIDENCE_COMPLETE /
//           GATE_BLOCKED）、检点裁决（INVARIANT_OK / INVARIANT_VIOLATED）都是枚举，
//           由本 workflow 的 switch 消费来决定落不落盘。
//   边界 4：**门控结论不在这里产生**。selection 与 dGate 由
//           integration/governance/evaluate_gates.js 算好并绑在打分卡上；
//           本文件与任何 agent 都不得写 PASS / D_GATE_PASSED 字面量。
//
// 收敛口径（验收判据）：6–12 候选收敛到 **≤3**。这不是风格选择——
// evaluate_gates.js 的 candidateCountLe3 检查就是 ≤3（超出即 BLOCKED_TOO_MANY_CANDIDATES），
// stage_a.js 的 selectCandidates 也是"至多三个正式候选 + 一个 MC320 非正式参照"。
// 所以候选 agent 的产出是**评估意见**，收敛是数据（selectCandidates 的结果 + integrator 的取舍记录），
// 不是让某个 agent 自己挑三个。
// ---------------------------------------------------------------------------

const REPO = args.repo || '.'
const STAGE = 'direction'
const BRIEF = args.brief
const RUN_ID = args.runId || 'direction-run'
const MAX_CANDIDATES = args.maxCandidates || 12
// 方向包络与打分卡由主循环用 stage_a.js 生成（它读 out/workload/ 与 teams/ 下的规格文件）。
// 本 workflow 不接收命令、不让 agent 执行命令：搜索脚本写 out/，而 workflow agent 全程只读。
const ENVELOPE_ARTIFACT = args.envelopeArtifact
const SCORECARD_ARTIFACT = args.scorecardArtifact
const DIRECTION_COMMAND_FOR_RECORD = args.directionCommand || 'UNVERIFIED'

if (!BRIEF) throw new Error('design.direction 需要 args.brief（intake 阶段产出的 DesignBrief）')
if (!ENVELOPE_ARTIFACT || !SCORECARD_ARTIFACT) {
  throw new Error('design.direction 需要 args.envelopeArtifact 与 args.scorecardArtifact（已由主循环用 stage_a.js 生成）；本 workflow 不跑搜索')
}
if (BRIEF.stage !== 'direction') {
  // brief 的 stage 与 workflow 名称必须一致，否则会把别的阶段的契约拿来用
  throw new Error(`brief.stage=${BRIEF.stage}，与 design.direction 不符；契约串了`)
}

const HEAD = [
  `仓库根目录：${REPO}`,
  `本 workflow：design.direction（stage=${STAGE}，runId=${RUN_ID}）`,
  `你是一个策略实例。先读你的策略正文：${REPO}/teams/council/strategies/__AGENT__.md`,
  '那份文件是本角色的判断规则、正确性判据、证据规则、取舍规则与禁止事项，逐条遵守。',
  '以下运行时上下文由 workflow 注入；注入内容与策略正文冲突时，注入内容优先（它承载本 stage 的事实）。',
  '你没有文件系统写权限。把该写的东西作为返回值交回，由 workflow 落盘。',
  '所有数字必须带出处（文件路径:行号 或 ADR 编号）；没有出处的写 UNVERIFIED 并说明缺什么，不得静默补齐。',
  '不得输出 TPS/usr 或任何全局性能指标；不得输出 PASS / D_GATE_PASSED 字面量。',
].join('\n')

const head = (agentId) => HEAD.replace('__AGENT__', agentId)

const BRIEF_JSON = JSON.stringify(BRIEF, null, 2)

// 候选评估。候选 agent 拿到的是**一个**候选的裸值，产出的是这个候选的
// bottleneck 归因与它自己的可辩护性判断——不是 TPS，也不是"选谁"。
// 每个候选 agent 互相看不见：互相看得见就会对齐措辞，评估就变成一份结论被抄 N 遍。
const CANDIDATE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['candidateId', 'bottleneck', 'bottleneckClass', 'blockingAssumptions', 'defensible', 'evidence', 'verdict'],
  properties: {
    candidateId: { type: 'string', description: '就是这个候选的 id，不得改写成别的' },
    bottleneck: { type: 'string', description: '本候选的瓶颈落在哪条 lane 上；不得只写"带宽受限"这类无出处的话' },
    bottleneckClass: { type: 'string', enum: ['memory', 'compute', 'communication', 'area', 'power', 'none'] },
    blockingAssumptions: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['assumption', 'flipsWhen', 'evidence'],
        properties: {
          assumption: { type: 'string', description: '这个候选成立所依赖的前提' },
          flipsWhen: { type: 'string', description: '这个前提在什么条件下翻转，翻转到什么值候选就不成立' },
          evidence: { type: 'string', description: '规格文件路径:行号、ADR 编号，或 UNVERIFIED' },
        },
      },
    },
    defensible: { type: 'boolean', description: '在给定资源包络下这个候选是否站得住；站不住要说清是缺什么' },
    evidence: { type: 'string', description: '本评估的关键出处；无法出处的写 UNVERIFIED' },
    verdict: { type: 'string', enum: ['INTEGRATION_OK', 'DELTA_UNEXPLAINED'] },
  },
}

// 合并产物。integrator 只合并，不重新发明：候选评估是输入，不是草稿。
const MERGE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['ranked', 'rejectedOptions', 'conflicts', 'framingQuestions', 'verdict'],
  properties: {
    ranked: {
      type: 'array',
      description: '按可辩护性排序的候选；不给出 TPS',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['candidateId', 'rank', 'bottleneckClass', 'reason'],
        properties: {
          candidateId: { type: 'string' },
          rank: { type: 'number' },
          bottleneckClass: { type: 'string' },
          reason: { type: 'string', description: '这个名次凭什么；不得引用评估者的措辞，只引裸值' },
        },
      },
    },
    rejectedOptions: {
      type: 'array',
      description: '被排除的候选与排除理由。必须登记，否则重跑会重新发明已否方案',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['candidateId', 'reason', 'rejectedBy'],
        properties: {
          candidateId: { type: 'string' },
          reason: { type: 'string' },
          rejectedBy: { type: 'string', description: '哪条约束/哪个检查否掉了它' },
        },
      },
    },
    conflicts: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['between', 'description', 'resolution'],
        properties: {
          between: { type: 'array', items: { type: 'string' } },
          description: { type: 'string' },
          resolution: { type: 'string', description: '解除冲突需要什么；不确定写 UNVERIFIED' },
        },
      },
    },
    framingQuestions: {
      type: 'array',
      items: { type: 'string' },
      description: '本域答不了、必须交给 framing-critic 的问题（约束是否完整、口径是否正确、shape 空间是否被写窄）',
    },
    verdict: { type: 'string', enum: ['INTEGRATION_OK', 'DELTA_UNEXPLAINED'] },
  },
}

// 框架审查裁决。framing-critic 只在 workflow 头尾出现，这里在尾。
const FRAMING_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['gaps', 'verdict'],
  properties: {
    gaps: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['kind', 'detail', 'impact'],
        properties: {
          kind: { type: 'string', enum: ['constraint_incomplete', 'caliber_wrong', 'shape_space_narrowed', 'three_model_framing'] },
          detail: { type: 'string' },
          impact: { type: 'string', description: '它会让哪个结论站不住' },
        },
      },
      description: '实质缺口。找不到缺口时给空数组——不要为了交差编一条',
    },
    verdict: { type: 'string', enum: ['FRAMING_OK', 'FRAMING_INSUFFICIENT'] },
  },
}

// 门槛核验。gate-keeper 逐条给证据等级或 blocker，**不判结论**。
const GATE_EVIDENCE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['thresholds', 'verdict'],
  properties: {
    thresholds: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['id', 'requirement', 'status', 'evidenceLevel', 'evidence'],
        properties: {
          id: { type: 'string', description: '门槛条目 id，与 17 号文档 §4.4 逐条对齐' },
          requirement: { type: 'string', description: '这一条门槛要求什么' },
          status: { type: 'string', enum: ['evidence_complete', 'blocked'] },
          evidenceLevel: { type: 'string', enum: ['E0', 'E1', 'E2', 'E3', 'UNVERIFIED'] },
          evidence: { type: 'string', description: '文件与行号；引用不到就写 UNVERIFIED，不得留空' },
        },
      },
    },
    verdict: { type: 'string', enum: ['GATE_EVIDENCE_COMPLETE', 'GATE_BLOCKED'] },
  },
}

const CHECK_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['invariants', 'violations', 'verdict'],
  properties: {
    invariants: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['name', 'result', 'detail'],
        properties: {
          name: { type: 'string' },
          result: { type: 'string', enum: ['met', 'violated'] },
          detail: { type: 'string', description: '裸值；不得只写结论' },
        },
      },
    },
    violations: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['invariant', 'file', 'field', 'detail'],
        properties: {
          invariant: { type: 'string' },
          file: { type: 'string' },
          field: { type: 'string' },
          detail: { type: 'string' },
        },
      },
    },
    verdict: { type: 'string', enum: ['INVARIANT_OK', 'INVARIANT_VIOLATED'] },
  },
}

phase('Candidate evaluation')

// 候选集由主循环侧 stage_a.js 枚举，这里只取前 MAX_CANDIDATES 个。
// 切片是刻意的：候选再多也不该让本次运行无界地长出 agent。
const CANDIDATES = args.candidates || []
if (!CANDIDATES.length) {
  return {
    stage: STAGE, runId: RUN_ID, verdict: 'BLOCKED_CONFIG',
    reason: 'args.candidates 为空：stage_a.js 的候选集没传进来，本 workflow 不自己枚举候选',
    files: [],
  }
}
const sliced = CANDIDATES.slice(0, MAX_CANDIDATES)

const evaluations = (await parallel(sliced.map((c, i) => () => agent(
  `${head('architect')}\n\n`
  + `brief：\n${BRIEF_JSON}\n\n`
  + `方向包络（主循环已生成，只读）：${ENVELOPE_ARTIFACT}\n`
  + `打分卡（主循环已生成，只读）：${SCORECARD_ARTIFACT}\n\n`
  + `你本次负责的候选（只评估这一个，不得评价其他候选，也不得给出 TPS）：\n`
  + `${JSON.stringify(c, null, 2)}\n\n`
  + `任务：给出这个候选的 bottleneck 与 bottleneck 分类、它成立所依赖的前提`
  + `（每条前提必须写清"翻转到什么值这个候选就不成立"）、以及在给定资源包络下它是否站得住。\n`
  + `你拿不到其他候选的结论，也不得推测它们——独立评估要的就是互相看不见。\n`
  + `所有数字必须带出处；没有出处的写 UNVERIFIED。`,
  {label: `candidate:${c.candidateId || i + 1}`, phase: 'Candidate evaluation', effort: 'high', schema: CANDIDATE_SCHEMA})
))).filter(Boolean)

if (evaluations.length < sliced.length) {
  const missing = sliced.filter((c, i) => !evaluations.some((e) => e.candidateId === (c.candidateId || String(i + 1))))
    .map((c) => c.candidateId || 'unknown')
  return {
    stage: STAGE, runId: RUN_ID, verdict: 'BLOCKED_CONFIG',
    reason: `候选评估不完整，缺：${missing.join(', ')}；不落盘`,
    absentCandidates: missing,
    files: [],
  }
}

phase('Convergence')

const merged = await agent(
  `${head('integrator')}\n\n`
  + `brief：\n${BRIEF_JSON}\n\n`
  + `方向包络（只读）：${ENVELOPE_ARTIFACT}\n`
  + `打分卡（只读）：${SCORECARD_ARTIFACT}\n\n`
  + `各候选的独立评估：\n${JSON.stringify(evaluations, null, 2)}\n\n`
  + `任务：合并成一份排序。规则：\n`
  + `1. 只合并，不重新发明模型。评估是输入，不是草稿；不得改写评估里的裸值与出处。\n`
  + `2. 排序凭裸值，不凭评估者的措辞；理由里引用的必须是数字或 ADR 编号。\n`
  + `3. 被排除的候选必须逐条进 rejectedOptions，写清是哪条约束/哪个检查否掉的。\n`
  + `4. 两个候选的评估互相矛盾时不下折中值——进 conflicts，保留双方。\n`
  + `5. 把"本域答不了"的问题放进 framingQuestions（约束是否完整、口径是否正确、shape 空间是否被写窄）。\n`
  + `合并成立写 INTEGRATION_OK；有评估无法归位到任何名次时写 DELTA_UNEXPLAINED。`,
  {label: 'integrator', phase: 'Convergence', effort: 'high', schema: MERGE_SCHEMA})

if (!merged || merged.verdict !== 'INTEGRATION_OK') {
  return {
    stage: STAGE, runId: RUN_ID, verdict: 'DELTA_UNEXPLAINED',
    merge: merged || null,
    reason: '候选评估无法合并成一份排序；不落盘',
    files: [],
  }
}

phase('Framing review')

const framing = await agent(
  `${head('framing-critic')}\n\n`
  + `brief：\n${BRIEF_JSON}\n\n`
  + `方向包络（只读）：${ENVELOPE_ARTIFACT}\n`
  + `合并后的排序与取舍：\n${JSON.stringify(merged, null, 2)}\n\n`
  + `任务：对抗式审查这个框架，而不是审查候选。只问四件事：\n`
  + `1. hardConstraints 完整吗——有没有一条约束被整个方向讨论了却没进 brief？\n`
  + `2. 口径对吗——planning 与 detailed、peak 与 sustained、MC320 与 MC640、`
  + `   1000 目标与 1050 门槛有没有被混用？\n`
  + `3. shape 空间是不是被写窄了——候选集是否只覆盖了一种形态，导致"选出来的赢家"`
  + `   其实是唯一被考虑过的东西？\n`
  + `4. 三模型框架：有没有只优化 K3 就把另外两个模型的口径略过？\n`
  + `找不到实质缺口就写 FRAMING_OK 并给空数组——不要为了交差编一条。`
  + `有实质缺口写 FRAMING_INSUFFICIENT。`,
  {label: 'framing-critic', phase: 'Framing review', effort: 'high', schema: FRAMING_SCHEMA})

phase('Gate evidence')

// gate-keeper 落在这里，正是 roster 里 design.direction 的 consumers 声明。
// 它逐条核验 17 号文档 §4.4 的 8 条 D-Gate 门槛**证据**，
// 结论由 evaluate_gates.js 算好并绑在打分卡上——本 agent 不判、也不能判。
const gate = await agent(
  `${head('gate-keeper')}\n\n`
  + `brief：\n${BRIEF_JSON}\n\n`
  + `打分卡（只读，含 script 算好的 dGate 与 selection）：${SCORECARD_ARTIFACT}\n`
  + `合并后的排序：\n${JSON.stringify(merged.ranked, null, 2)}\n\n`
  + `任务：逐条核验 D-Gate 的 8 条门槛（见 ${REPO}/teams/council/docs/17_TWO_STAGE_ARCHITECTURE_OPERATING_MODEL.md 第 4.4 节），`
  + `每条给出证据等级或 blocker，不得留空：\n`
  + `1. 7-reticle area 守恒；2. 计算 die/MC/PHY/interposer/thermal 都有预算；`
  + `3. 三模型均能生成粗略 TPS，不允许只优化 K3；4. 每个候选有明确 bottleneck；`
  + `5. 至少一个候选在 baseline 资源下达标，或已形成明确的替代方案；`
  + `6. 所有结论标明 E0/E1 证据等级；7. 完成 sensitivity sweep；8. 选出不超过 3 个候选。\n`
  + `**你不判 PASS**：门控结论由 integration/governance/evaluate_gates.js 计算，`
  + `本阶段只负责"证据齐不齐"，所以你的裁决只有"证据完整"或"被 blocker 挡住"两种。\n`
  + `证据不足与进度冲突时，证据不足优先，记为 blocker 而不是放行。\n`
  + `不得输出 PASS / D_GATE_PASSED 字面量；不得输出 TPS/usr；不得修改被测数据。`,
  {label: 'gate-keeper', phase: 'Gate evidence', effort: 'high', schema: GATE_EVIDENCE_SCHEMA})

phase('Invariant check')

// 末步是检点，不是总结。gate-keeper 与 invariant-checker 查的是两件事：
// gate-keeper 查证据齐不齐，invariant-checker 查候选集与全局不变量冲突不冲突。
const check = await agent(
  `${head('invariant-checker')}\n\n`
  + `方向包络（只读）：${ENVELOPE_ARTIFACT}\n`
  + `打分卡（只读）：${SCORECARD_ARTIFACT}\n`
  + `合并后的排序与取舍：\n${JSON.stringify(merged, null, 2)}\n`
  + `framing-critic 的审查：\n${JSON.stringify(framing, null, 2)}\n`
  + `gate-keeper 的门槛核验：\n${JSON.stringify(gate, null, 2)}\n\n`
  + `任务：对这份排序与候选集做全局不变量检点，逐条给出 pass/fail 与裸值：\n`
  + `7-reticle 面积守恒、单一硬件规格（ADR-0021）、MC320/MC640 分离、peak 与 sustained 分离、`
  + `单位一致、证据等级齐全。违规项必须给出违反的具体文件与字段。\n`
  + `不得把违规项解释掉（解释权归 architect）；不得以文档措辞为依据，只以数值和来源为依据。\n`
  + `全部通过写 INVARIANT_OK，任一不通过写 INVARIANT_VIOLATED。`,
  {label: 'invariant-checker', phase: 'Invariant check', effort: 'high', schema: CHECK_SCHEMA})

const okInvariants = check && check.verdict === 'INVARIANT_OK'
const okGate = gate && gate.verdict === 'GATE_EVIDENCE_COMPLETE'

// 三个裁决枚举各自决定一个方向的放行，全部由这里消费。
const blocked = !okInvariants
  ? {verdict: 'INVARIANT_VIOLATED', violations: (check && check.violations) || ['检点未完成']}
  : (!okGate
    ? {verdict: 'GATE_BLOCKED', violations: (gate && gate.thresholds.filter((t) => t.status === 'blocked')) || ['门槛证据未完成']}
    : null)

// 收敛口径由数据保证，不由 agent 自律保证：正式候选只取 selectCandidates 的结果。
// 打分卡里的 dGate.candidateCountLe3 就是 evaluate_gates.js 对同一份 selection 算的，
// 所以这里再截一次是冗余的——但冗余是刻意的，它是"≤3"这条验收判据的落地位置。
const formal = (merged.ranked || []).filter((r) => r.rank <= 3).map((r) => r.candidateId)

const ledgerPatch = {
  currentStage: STAGE,
  strategyVersions: {
    architect: '1.0', integrator: '1.0', 'framing-critic': '1.0',
    'gate-keeper': '1.0', 'invariant-checker': '1.0',
  },
  // rejectedOptions 必须带：否则重跑会重新发明已否方案。
  rejectedOptions: (merged.rejectedOptions || []).map((r) => ({
    stage: STAGE, optionId: r.candidateId, reason: r.reason, rejectedBy: r.rejectedBy,
  })),
  openBlockers: [
    ...(merged.conflicts || []).map((c, i) => ({
      id: `CONFLICT-${STAGE.toUpperCase()}-${String(i + 1).padStart(2, '0')}`,
      owner: (c.between && c.between[0]) || 'integrator',
      unblockCondition: c.resolution,
    })),
    ...(framing && framing.gaps ? framing.gaps.map((g, i) => ({
      id: `FRAMING-${STAGE.toUpperCase()}-${String(i + 1).padStart(2, '0')}`,
      owner: 'architect',
      unblockCondition: `补齐框架缺口（${g.kind}）：${g.detail}`,
    })) : []),
  ],
}

const runRecord = {
  schemaVersion: 'design-run-record-v0.1',
  stage: STAGE,
  runId: RUN_ID,
  sourceCommit: BRIEF.sourceCommit,
  envelopeArtifact: ENVELOPE_ARTIFACT,
  scorecardArtifact: SCORECARD_ARTIFACT,
  directionCommand: DIRECTION_COMMAND_FOR_RECORD,
  // 候选集指纹：收敛结果必须能追到"这批候选是从哪次搜索来的"，
  // 否则事后无法复核"6–12 收敛到 ≤3"里的 6–12 具体是什么。
  candidateSet: sliced.map((c) => c.candidateId || JSON.stringify(c)).sort(),
  candidateCount: sliced.length,
  formalCandidateIds: formal,
  convergence: {
    from: sliced.length,
    to: formal.length,
    basis: 'maxCandidates 切片 + integrator 排序 + evaluate_gates.js 的 candidateCountLe3',
  },
  caliber: '候选为 PLANNING 口径的方向候选；TPS 与门控结论一律取自打分卡，workflow 不产生任何数字',
}

return {
  stage: STAGE,
  runId: RUN_ID,
  verdict: blocked ? blocked.verdict : 'FRAMING_OK',
  winner: blocked ? null : {ranked: merged.ranked, formalCandidateIds: formal},
  rejectedWinner: blocked ? merged.ranked : null,
  violations: blocked ? blocked.violations : [],
  framing: framing || null,
  gateEvidence: gate || null,
  ledgerPatch,
  runRecord,
  files: blocked ? [] : [
    {
      path: `${REPO}/out/direction/${STAGE}_selected.json`,
      content: JSON.stringify({
        schemaVersion: 'design-direction-selection-v0.1',
        stage: STAGE, runId: RUN_ID, sourceCommit: BRIEF.sourceCommit,
        scorecardArtifact: SCORECARD_ARTIFACT,
        ranked: merged.ranked,
        formalCandidateIds: formal,
        rejectedOptions: merged.rejectedOptions || [],
        conflicts: merged.conflicts || [],
        framingGaps: (framing && framing.gaps) || [],
      }, null, 2) + '\n',
    },
    {
      path: `${REPO}/out/direction/${STAGE}_run_record.json`,
      content: JSON.stringify(runRecord, null, 2) + '\n',
    },
  ],
}
