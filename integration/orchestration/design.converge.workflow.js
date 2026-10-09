export const meta = {
  name: 'design-converge',
  description: 'K3 设计 A0 收敛（design.converge）：相关专家回报残余缺口，framing-critic 审视收敛问题本身立得住，gate-keeper 汇总证据完备性，architect 给出 ARCH_FREEZE / DIRECTION_BACKFLOW / D_GATE_PROPOSAL 裁决，invariant-checker 检点后落盘为**提案**（门控结论由 evaluate_gates.js 计算，不由本 workflow 给出）',
  whenToUse: 'D 组收官格，也是 A0 的扩权节点。需要 args.brief（stage=converge 的 DesignBrief）、args.detailArtifacts（D 组各格落盘产物路径的清单，至少含 detail.integrate 的产物）、args.designPoint（主循环由 design_point.js 解析的设计点；它与基线不是同一个点时本格不召集 agent，返回 BLOCKED_CONFIG）与可选 args.priorVerdicts（上游各格的裁决汇总）。本 workflow 不跑 stage_b.js、不写既有产物、不改候选寄存器。',
  phases: [
    { title: 'Backflow intake', detail: '相关专家各自回报本域残余缺口，互不可见；拒不归因的残留被显式登记' },
    { title: 'Framing review', detail: 'framing-critic 审视收敛问题本身：问的是不是该问的' },
    { title: 'Gate evidence', detail: 'gate-keeper 汇总证据完备性；它不判门控通过与否' },
    { title: 'Architect convergence', detail: 'architect 给出收敛裁决：冻结 / 回流 / 送评审' },
    { title: 'Invariant check', detail: 'invariant-checker 强制检点；不通过则不落盘' },
  ],
}

// ---------------------------------------------------------------------------
// A0 收敛（19 号文档 §8，B5 的 Q-Gate 9 条最低条件）。
//
// 这一格与 D 组前五格的根本区别：前五格都有一份确定的输入要处理，
// 而这一格处理的是**它们全部**——18 个观察位、五份产物、以及一路上
// 每一格登记的 openBlockers。它的产物不是数据，是一份**裁决提案**。
//
// 为什么这一步需要"扩权"：D 组各格的自检是分域的，每一格只看本域。
// 一个缺口完全可以做到"每一格都合规，合起来不成立"——例如 B2 说事件流
// 自洽（它确实自洽），B3 说 PPA 在容差内（它确实在），但两者用的
// 卡功耗口径不同，合起来那个裕量是假的。收敛格存在的理由就是看这种缺口。
//
// 关于门控，有一条不可越线的规矩：
//
//   **本 workflow 的输出是提案，不是门控结论。**
//
// 本文件不得把 `PASS` / `D_GATE_PASSED` / `Q_GATE_PASSED` 当作自己的产出：
// 它们只由 `integration/governance/evaluate_gates.js` 计算。gate-keeper 在这里的
// 职责是"证据完备性"——够不够送评审，而不是"过不过"。它的枚举
// GATE_EVIDENCE_COMPLETE / GATE_BLOCKED 说的正是这件事。
// 把"证据齐了"读成"通过了"，是这条链上最贵的一次误读：
// 它会跳过一次评审，而跳过的那次评审恰好是为了发现证据齐但不成立。
//
// architect 的裁决是本格的核心，也是 ARCH_FREEZE 在 roster 里被声明的用途：
// 它的三个取值正好覆盖三种结局——本轮到此为止（ARCH_FREEZE）、
// 回 direction 重定（DIRECTION_BACKFLOW）、送 D-Gate 评审（D_GATE_PROPOSAL）。
// ---------------------------------------------------------------------------

const REPO = args.repo || '.'
const STAGE = 'converge'
const BRIEF = args.brief
const RUN_ID = args.runId || 'converge-run'
const DETAIL_ARTIFACTS = args.detailArtifacts
const PRIOR_VERDICTS = args.priorVerdicts || null
const STAGE_COMMAND_FOR_RECORD = args.stageCommand || 'UNVERIFIED'

if (!BRIEF) throw new Error('design.converge 需要 args.brief（intake 阶段产出的 DesignBrief）')
if (!Array.isArray(DETAIL_ARTIFACTS) || DETAIL_ARTIFACTS.length === 0) {
  throw new Error('design.converge 需要 args.detailArtifacts（D 组各格落盘产物路径清单，数组）')
}
if (BRIEF.stage !== STAGE) {
  throw new Error(`brief.stage=${BRIEF.stage}，与 design.${STAGE} 不符；契约串了`)
}

// D 组必须到齐的格子。收敛格看的就是"合起来成不成立"，
// 少一格就等于少看一个切面，而缺口正好可能藏在没到的那一格。
const REQUIRED_STAGES = [
  'detail.freeze', 'detail.workload', 'detail.events', 'detail.execute', 'detail.integrate',
]
const missingStages = REQUIRED_STAGES.filter(
  (s) => !DETAIL_ARTIFACTS.some((p) => String(p).includes(s.replace('.', '_'))))

// 相关专家的候选池。收敛格按需召集 1–3 位，因为需要谁来补缺
// 取决于前面各格留下的是什么缺口——固定召集会浪费，
// 全召集则等于把收敛变成一次全员会议，而全员会议不产生裁决。
const EXPERT_POOL = [
  'model-expert', 'compute-expert', 'memory-expert', 'comm-expert',
  'software-expert', 'physical-expert',
]
const RELEVANT_EXPERTS = args.relevantExperts || []
if (!Array.isArray(RELEVANT_EXPERTS) || RELEVANT_EXPERTS.length < 1 || RELEVANT_EXPERTS.length > 3) {
  throw new Error('design.converge 需要 args.relevantExperts（1–3 位相关专家），'
    + '由主循环依据前面各格登记的开缺口确定')
}
const unknownExperts = RELEVANT_EXPERTS.filter((a) => !EXPERT_POOL.includes(a))
if (unknownExperts.length) {
  throw new Error(`args.relevantExperts 含非专家角色：${unknownExperts.join(', ')}`)
}

// 设计点（23 号文档 §7.3）：L3 之后各格读联合点，而 D 组的产物是 stage_b.js 在基线
// （k3_mc_baseline.json）上算的。两者不是同一个点时，D 组审的是另一个设计——
// 在它上面给出的任何收敛裁决都不成立。这条由脚本拦，不交给 agent 判断；
// 点由主循环（integration/pipelines/design_point.js）解析并核对后注入，脚本不读文件。
const DESIGN_POINT = args.designPoint
if (!DESIGN_POINT || !['published', 'joint'].includes(DESIGN_POINT.kind)) {
  throw new Error('design.converge 需要 args.designPoint（主循环由 integration/pipelines/design_point.js 解析：'
    + '联合点已落盘时为 out/coupling/joint_point.json，否则为基线发布点）')
}
const POINT_RECORD = {
  kind: DESIGN_POINT.kind, source: DESIGN_POINT.source, optionId: DESIGN_POINT.optionId || null,
  sha256: DESIGN_POINT.sha256 || 'UNVERIFIED', departsFromPublished: Boolean(DESIGN_POINT.departsFromPublished),
}
if (DESIGN_POINT.departsFromPublished) {
  const d = DESIGN_POINT.departures || {}
  const fields = ['x', 'opt', 'model'].flatMap((part) => (d[part] || []).map((f) => `${part}.${f.key}`))
  return {
    stage: STAGE, runId: RUN_ID, verdict: 'BLOCKED_CONFIG',
    reason: `设计点是联合点 ${POINT_RECORD.optionId}（${POINT_RECORD.source}），与基线发布点在 ${fields.length} 个字段上不同`
      + `（${fields.join(', ')}）；D 组产物由 stage_b.js 在基线上算出，审的不是这个点，收敛格不得在它上面给出裁决`,
    nextActions: [
      '以 ADR 把联合点并入基线（x、OPT 补丁与模型补丁：计算域的 unpack / softmax、通信域的控制路径），经 npm run baseline:sync 同步，不手改基线',
      '基线同步后重跑 npm run model:planning（stage_b.js）与 D 组 design.detail.freeze → design.detail.integrate',
      '再跑本格；args.designPoint 的 departsFromPublished 为 false 之前本格不会召集任何 agent',
    ],
    designPoint: POINT_RECORD,
    departures: d,
    files: [],
  }
}

const HEAD = [
  `仓库根目录：${REPO}`,
  `本 workflow：design.converge（stage=${STAGE}，runId=${RUN_ID}）`,
  `你是一个策略实例。先读你的策略正文：${REPO}/teams/council/strategies/__AGENT__.md`,
  '那份文件是本角色的判断规则、正确性判据、证据规则、取舍规则与禁止事项，逐条遵守。',
  '以下运行时上下文由 workflow 注入；注入内容与策略正文冲突时，注入内容优先（它承载本 stage 的事实）。',
  '你没有文件系统写权限。把该写的东西作为返回值交回，由 workflow 落盘。',
  '所有数字必须带出处（文件路径:行号 或 ADR 编号）；没有出处的写 UNVERIFIED 并说明缺什么，不得静默补齐。',
  '不得输出 TPS/usr 或任何全局性能指标；不得输出 PASS / D_GATE_PASSED 字面量。',
  '本格产出的是**提案**：门控结论由 integration/governance/evaluate_gates.js 计算，不由你给出。',
  '证据齐备不等于通过评审——把前者读成后者，是这条链上最贵的一次误读。',
].join('\n')

const head = (agentId) => HEAD.replace('__AGENT__', agentId)

const BRIEF_JSON = JSON.stringify(BRIEF, null, 2)

// 专家的残余缺口回报。收敛格召集他们不是要新的结论，
// 是要他们回答"本域还有什么没落地"——这个问题只有分域的人答得了。
const RESIDUAL_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['from', 'residuals', 'verdict'],
  properties: {
    from: { type: 'string', description: '给出回报的 agentId' },
    residuals: {
      type: 'array',
      description: '本域尚未落地的缺口；每条带出处与阻塞条件',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['item', 'severity', 'evidence', 'unblockCondition'],
        properties: {
          item: { type: 'string', description: '具体是什么缺口，不得写"部分细节待完善"' },
          severity: { type: 'string', enum: ['blocking', 'nonBlocking'] },
          evidence: { type: 'string', description: '文件路径:行号 或 hash；引用不到写 UNVERIFIED' },
          unblockCondition: { type: 'string', description: '解除它需要什么' },
          domainLevel: { type: 'boolean', description: 'true 表示它是方向级的，不是本域细节' },
        },
      },
    },
    verdict: { type: 'string', enum: ['LOCAL_DETAIL_FIX', 'DIRECTION_BACKFLOW', 'BLOCKED_CONFIG'] },
    backflowReason: { type: 'string', description: 'DIRECTION_BACKFLOW 时必填：动摇了哪条方向级假设' },
    blockedFields: { type: 'array', items: { type: 'string' }, description: 'BLOCKED_CONFIG 时必填' },
  },
}

// framing-critic 的判据是**问题本身**：收敛格问的是不是该问的。
// 它在 roster 里只有两个取值，因为它的工作是一个二值判断——
// framing 立得住，或者立不住。
const FRAMING_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['questions', 'gaps', 'verdict'],
  properties: {
    questions: {
      type: 'array',
      description: '收敛格当前在回答的问题，逐条列出并检查它是不是该问的',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['question', 'isRelevant', 'note'],
        properties: {
          question: { type: 'string' },
          isRelevant: { type: 'boolean' },
          note: { type: 'string' },
        },
      },
    },
    gaps: {
      type: 'array',
      description: '没有被任何一格问到的切面——缺口最常藏在这里',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['gap', 'why'],
        properties: { gap: { type: 'string' }, why: { type: 'string' } },
      },
    },
    verdict: { type: 'string', enum: ['FRAMING_OK', 'FRAMING_INSUFFICIENT'] },
  },
}

// gate-keeper 汇总**证据完备性**。它不是门控结论。
const GATE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['thresholds', 'verdict'],
  properties: {
    thresholds: {
      type: 'array',
      description: 'Q-Gate 9 条最低条件逐条给出证据状态',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['name', 'status', 'evidence'],
        properties: {
          name: { type: 'string' },
          status: { type: 'string', enum: ['complete', 'blocked'] },
          evidence: { type: 'string', description: '文件路径:行号 或 hash；引用不到写 UNVERIFIED' },
          note: { type: 'string' },
        },
      },
    },
    openBlockers: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['id', 'owner', 'unblockCondition'],
        properties: {
          id: { type: 'string' }, owner: { type: 'string' }, unblockCondition: { type: 'string' },
        },
      },
    },
    verdict: { type: 'string', enum: ['GATE_EVIDENCE_COMPLETE', 'GATE_BLOCKED'] },
  },
}

// architect 的收敛裁决。它是本格唯一的终局决定，
// 三个取值对应三种结局，没有第四种。
const CONVERGENCE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['assessment', 'openItems', 'verdict'],
  properties: {
    assessment: {
      type: 'array',
      description: '对 D 组五格合起来是否成立的判断，逐条带出处',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['claim', 'holds', 'evidence'],
        properties: {
          claim: { type: 'string' },
          holds: { type: 'boolean' },
          evidence: { type: 'string' },
        },
      },
    },
    openItems: {
      type: 'array',
      description: '收敛后仍然开着的项；ARCH_FREEZE 时它必须为空',
      items: { type: 'string' },
    },
    directionLevelFindings: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['subject', 'description'],
        properties: { subject: { type: 'string' }, description: { type: 'string' } },
      },
    },
    verdict: { type: 'string', enum: ['ARCH_FREEZE', 'DIRECTION_BACKFLOW', 'D_GATE_PROPOSAL'] },
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
          detail: { type: 'string' },
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
          invariant: { type: 'string' }, file: { type: 'string' },
          field: { type: 'string' }, detail: { type: 'string' },
        },
      },
    },
    verdict: { type: 'string', enum: ['INVARIANT_OK', 'INVARIANT_VIOLATED'] },
  },
}

phase('Backflow intake')

const residuals = (await parallel(RELEVANT_EXPERTS.map((agentId) => () => agent(
  `${head(agentId)}\n\n`
  + `brief：\n${BRIEF_JSON}\n\n`
  + `D 组各格落盘产物（只读）：\n${DETAIL_ARTIFACTS.map((p) => `  ${p}`).join('\n')}\n\n`
  + `任务：你是本域在 A0 收敛格上的代表。回答一个问题：**本域还有什么没落地**。\n`
  + `规则：\n`
  + `1. 逐条写清缺口是什么、卡在哪、解除它需要什么、有什么证据。`
  + `   不得写"部分细节待完善""后续可优化"这类话——那不是缺口，是措辞。\n`
  + `2. 每条标注 severity：blocking（挡住收敛）或 nonBlocking。`
  + `3. 每条标注 domainLevel：它是本域细节，还是动摇了方向级假设。\n`
  + `4. 你没有缺口就写空数组——那是允许的答案。凑一条出来比空着更坏。\n`
  + `回报完成后给出本域裁决：\n`
  + `  LOCAL_DETAIL_FIX：本域没有方向级缺口，剩下的都是本域能修的细节。\n`
  + `  DIRECTION_BACKFLOW：本域缺口是方向级的，必须回 direction 重定。\n`
  + `  BLOCKED_CONFIG：产物缺字段，本域结论无法归位。\n`
  + `注意：你不判门控是否通过——那是 evaluate_gates.js 的事。`,
  {label: `residual:${agentId}`, phase: 'Backflow intake', effort: 'high', schema: RESIDUAL_SCHEMA})
))).filter(Boolean)

if (residuals.length < RELEVANT_EXPERTS.length) {
  const absent = RELEVANT_EXPERTS.filter((a) => !residuals.some((r) => r.from === a))
  return {
    stage: STAGE, runId: RUN_ID, verdict: 'BLOCKED_CONFIG',
    reason: `残余缺口回报不完整，缺：${absent.join(', ')}`,
    nextActions: absent.map((a) => `补齐 ${a} 的残余缺口回报`),
    absentDeclarants: absent,
    files: [],
  }
}

// D 组的五格必须到齐。少一格，收敛格看的就是一个残缺的切面——
// 而"每一格都合规、合起来不成立"的缺口，正好可能藏在没到的那一格。
if (missingStages.length) {
  return {
    stage: STAGE, runId: RUN_ID, verdict: 'BLOCKED_CONFIG',
    reason: `D 组未到齐，缺：${missingStages.join(', ')}；收敛格不得在缺格的情况下给出裁决`,
    nextActions: missingStages.map((s) => `先跑完 design.${s} 并把产物路径放进 args.detailArtifacts`),
    missingStages,
    files: [],
  }
}

// 裁决枚举由 workflow 消费。专家的方向级缺口在这里先拦：
// 有专家报方向级缺口时，收敛出来的任何裁决都建在它上面。
const expertBackflow = residuals.filter((r) => r.verdict === 'DIRECTION_BACKFLOW')
const expertBlocked = residuals.filter((r) => r.verdict === 'BLOCKED_CONFIG')

if (expertBackflow.length || expertBlocked.length) {
  const all = expertBackflow.concat(expertBlocked)
  return {
    stage: STAGE, runId: RUN_ID,
    verdict: expertBackflow.length ? 'DIRECTION_BACKFLOW' : 'BLOCKED_CONFIG',
    reason: expertBackflow.length
      ? `收敛前专家报方向回流：${expertBackflow.map((r) => `${r.from}(${r.backflowReason || '未说明'})`).join('；')}；未收敛`
      : `收敛前专家报配置缺口：${expertBlocked.map((r) => r.from).join(', ')}；未收敛`,
    nextActions: [
      ...all.flatMap((r) => (r.residuals || []).filter((x) => x.severity === 'blocking')
        .map((x) => `${r.from}: ${x.item} —— ${x.unblockCondition}`)),
      ...all.flatMap((r) => (r.blockedFields || []).map((f) => `补齐被配置挡住的字段：${f}`)),
    ],
    blockedFields: all.flatMap((r) => r.blockedFields || []),
    declarants: all.map((r) => ({from: r.from, verdict: r.verdict})),
    files: [],
  }
}

// 残余缺口的形态由脚本对账，不由 agent 自律保证：
// 报了 blocking 却给不出解除条件，等于报了一个不可行动的问题。
const malformedResiduals = residuals.flatMap((r) => (r.residuals || [])
  .filter((x) => !x.item || !x.evidence || (x.severity === 'blocking' && !x.unblockCondition))
  .map((x) => `${r.from}: ${x.item || '(无名缺口)'} 缺 evidence 或解除条件`))
const blockingResiduals = residuals.flatMap((r) => (r.residuals || [])
  .filter((x) => x.severity === 'blocking')
  .map((x) => ({from: r.from, item: x.item, evidence: x.evidence, unblockCondition: x.unblockCondition})))

phase('Framing review')

// framing-critic 在最后一步之前跑，检的是**问题本身**。
// 它必须看见各域的残余缺口，否则它会去审一个别人已经处理过的问题；
// 但它**看不到** gate-keeper 的结论——gate-keeper 还没跑。
// 这是刻意的：如果它先知道"证据齐不齐"，framing 的判断就会被那个结论带跑。
const framing = await agent(
  `${head('framing-critic')}\n\n`
  + `brief：\n${BRIEF_JSON}\n\n`
  + `D 组各格落盘产物（只读）：\n${DETAIL_ARTIFACTS.map((p) => `  ${p}`).join('\n')}\n`
  + `上游各格的裁决（只读）：\n${JSON.stringify(PRIOR_VERDICTS, null, 2)}\n\n`
  + `各相关专家回报的残余缺口：\n${JSON.stringify(residuals, null, 2)}\n\n`
  + `任务：审视**收敛格当前在回答的问题本身**，而不是回答它。规则：\n`
  + `1. 逐条列出这个 stage 正在回答的问题，判断它是不是该问的问题。\n`
  + `2. 找出**没有被任何一格问到的切面**——缺口最常藏在这里，`
  + `   因为每一格都合规、每一格都答了自己答的问题。\n`
  + `   特别检查这一类跨格缺口：某一格的结论单独成立，但与另一格合起来不成立`
  + `   （例如两格用了不同的卡功耗口径、两格的事件来自不同的 manifest hash）。\n`
  + `3. 不得把"问题问得不完整"说成"细节待完善"——那是两件事，前者是 framing 的失败。\n`
  + `framing 立得住写 FRAMING_OK；有切面没被问到、或问题本身问错了写 FRAMING_INSUFFICIENT。`,
  {label: 'framing-critic', phase: 'Framing review', effort: 'high', schema: FRAMING_SCHEMA})

const okFraming = framing && framing.verdict === 'FRAMING_OK'

phase('Gate evidence')

// gate-keeper 汇总**证据完备性**——够不够送评审，不是过不过。
// 它拿得到 framing 的结论：framing 说问题问得不完整时，
// "证据完备"这件事本身就不成立（没被问到的切面不可能是完备的）。
const gate = await agent(
  `${head('gate-keeper')}\n\n`
  + `brief：\n${BRIEF_JSON}\n\n`
  + `D 组各格落盘产物（只读）：\n${DETAIL_ARTIFACTS.map((p) => `  ${p}`).join('\n')}\n`
  + `上游各格的裁决（只读）：\n${JSON.stringify(PRIOR_VERDICTS, null, 2)}\n\n`
  + `各域残余缺口：\n${JSON.stringify(residuals, null, 2)}\n`
  + `framing 的结论：\n${JSON.stringify(framing, null, 2)}\n\n`
  + `任务：对 Q-Gate 的最低条件逐条给出**证据状态**。规则：\n`
  + `1. 每一条给 complete 或 blocked，并给出证据出处。`
  + `   证据引用不到就写 blocked——"应该有"不是证据。\n`
  + `2. 你的枚举说的是**证据完备性**：GATE_EVIDENCE_COMPLETE 意思是`
  + `   "可以送评审了"，**不是**"评审会通过"。`
  + `   你不得输出 PASS / D_GATE_PASSED——它们只由 integration/governance/evaluate_gates.js 计算。\n`
  + `3. framing 判了 FRAMING_INSUFFICIENT 时，`
  + `   有切面没被问到的状态下证据不可能完备——如实反映在结论上。\n`
  + `4. blocking 的残余缺口一律记进 openBlockers，写清 owner 与解除条件。\n`
  + `全部条件有证据写 GATE_EVIDENCE_COMPLETE；有任一条拿不出证据写 GATE_BLOCKED。`,
  {label: 'gate-keeper', phase: 'Gate evidence', effort: 'high', schema: GATE_SCHEMA})

const okGate = gate && gate.verdict === 'GATE_EVIDENCE_COMPLETE'

phase('Architect convergence')

// architect 是本格唯一的终局裁决者。它看见全部材料：各域残余、
// framing 的结论、证据完备性、上游裁决。它给出三种结局之一。
//
// 它拿得到 gate，但 gate 只说证据齐不齐——ARCH_FREEZE 与 D_GATE_PROPOSAL
// 的区别恰恰在于：前者是"本轮到此为止"（不送评审），
// 后者是"证据够了，送评审"。一个证据完备的轮次仍然可以以 ARCH_FREEZE 收场。
const convergence = await agent(
  `${head('architect')}\n\n`
  + `brief：\n${BRIEF_JSON}\n\n`
  + `D 组各格落盘产物（只读）：\n${DETAIL_ARTIFACTS.map((p) => `  ${p}`).join('\n')}\n`
  + `上游各格的裁决（只读）：\n${JSON.stringify(PRIOR_VERDICTS, null, 2)}\n\n`
  + `各域残余缺口：\n${JSON.stringify(residuals, null, 2)}\n`
  + `framing 的结论：\n${JSON.stringify(framing, null, 2)}\n`
  + `证据完备性：\n${JSON.stringify(gate, null, 2)}\n\n`
  + `任务：给出本轮的收敛裁决。规则：\n`
  + `1. 逐条判断 D 组五格**合起来**是否成立，每条带出处。`
  + `   单格成立不等于合起来成立——跨格口径不一致（功耗、manifest hash、`
  + `   硬件规格）是这一格最需要抓的东西。\n`
  + `2. openItems 列出收敛后仍然开着的项；**判 ARCH_FREEZE 时它必须为空**——`
  + `   "冻结了但还有点东西开着"不是冻结。\n`
  + `3. 不得把"证据齐备"读成"通过评审"。门控结论由 evaluate_gates.js 计算，`
  + `   你的 D_GATE_PROPOSAL 只是一个**提案**。\n`
  + `本格裁决（roster 里你的三个取值，各自对应一种结局）：\n`
  + `  ARCH_FREEZE：本轮细化结论到此冻结。要求 openItems 为空、`
  + `    证据完备、framing 立得住、无方向级发现。\n`
  + `  DIRECTION_BACKFLOW：跨格出现了方向级不成立的地方，必须回 direction 重定。`
  + `    用这个裁决时在 directionLevelFindings 里逐条写明动摇了哪条假设。\n`
  + `  D_GATE_PROPOSAL：证据已足够，建议送 D-Gate 评审。`
  + `    证据不完备（GATE_BLOCKED）时不得用它。\n`
  + `注意：你不判门控是否通过。`,
  {label: 'architect', phase: 'Architect convergence', effort: 'high', schema: CONVERGENCE_SCHEMA})

if (!convergence) {
  return {
    stage: STAGE, runId: RUN_ID, verdict: 'BLOCKED_CONFIG',
    reason: '收敛裁决未返回',
    nextActions: ['重跑 architect 收敛步；若产物缺字段，先补产物'],
    files: [],
  }
}

// 裁决枚举由 workflow 消费，并在这里做**一致性夹取**：
// 让"裁决"与"证据状态"互相矛盾的情况不可能被落盘。
// 这不是替代 architect 的判断，是拒绝一份自相矛盾的提案。
const CONVERGENCE_ROUTE = {
  ARCH_FREEZE: {proceed: true, requiresEvidence: true, requiresEmptyOpenItems: true},
  D_GATE_PROPOSAL: {proceed: true, requiresEvidence: true, requiresEmptyOpenItems: false},
  DIRECTION_BACKFLOW: {proceed: false, requiresEvidence: false, requiresEmptyOpenItems: false},
}
const route = CONVERGENCE_ROUTE[convergence.verdict]

const routeContradictions = []
if (!route) {
  routeContradictions.push(`裁决取值不在 roster 枚举内：${convergence.verdict}`)
} else {
  if (convergence.verdict === 'ARCH_FREEZE' && (convergence.openItems || []).length) {
    routeContradictions.push(`判 ARCH_FREEZE 但 openItems 非空：${(convergence.openItems || []).join(', ')}`)
  }
  if (convergence.verdict === 'ARCH_FREEZE' && !okFraming) {
    routeContradictions.push('判 ARCH_FREEZE 但 framing 判了 FRAMING_INSUFFICIENT——问题本身立不住时不得冻结')
  }
  if (route.requiresEvidence && !okGate) {
    routeContradictions.push(`判 ${convergence.verdict} 但证据不完备（GATE_BLOCKED）`)
  }
  if (convergence.verdict === 'DIRECTION_BACKFLOW' && !(convergence.directionLevelFindings || []).length) {
    routeContradictions.push('判 DIRECTION_BACKFLOW 但未说明动摇了哪条方向级假设')
  }
}

if (routeContradictions.length) {
  return {
    stage: STAGE, runId: RUN_ID, verdict: 'BLOCKED_CONFIG',
    reason: `收敛裁决自相矛盾：${routeContradictions.join('；')}`,
    nextActions: routeContradictions.map((c) => `消解矛盾后重跑：(c) ${c}`),
    routeContradictions,
    files: [],
  }
}

// 方向回流：终止本格，不落盘。回流的路由是数据——
// 带上 architect 的方向级发现与各域的 blocking 残余，交给 A0/direction 重定。
if (!route.proceed) {
  return {
    stage: STAGE, runId: RUN_ID, verdict: 'DIRECTION_BACKFLOW',
    reason: `A0 收敛报方向回流：${(convergence.directionLevelFindings || []).map((f) => `${f.subject}(${f.description})`).join('；')}`,
    nextActions: [
      '把 architect 的方向级发现交给 direction 重定；本格结论不落盘',
      ...blockingResiduals.map((r) => `${r.from}: ${r.item} —— ${r.unblockCondition}`),
    ],
    directionLevelFindings: convergence.directionLevelFindings || [],
    framing: framing ? framing.gaps : [],
    files: [],
  }
}

phase('Invariant check')

// 末步是检点，不是总结。architect 刚给了裁决，让它自己检点，
// 它会把不一致的地方解释成"口径差异"——而那正是需要被看见的东西。
const check = await agent(
  `${head('invariant-checker')}\n\n`
  + `D 组各格落盘产物（只读）：\n${DETAIL_ARTIFACTS.map((p) => `  ${p}`).join('\n')}\n`
  + `各域残余缺口：\n${JSON.stringify(residuals, null, 2)}\n`
  + `framing 的结论：\n${JSON.stringify(framing, null, 2)}\n`
  + `证据完备性：\n${JSON.stringify(gate, null, 2)}\n`
  + `architect 的收敛裁决：\n${JSON.stringify(convergence, null, 2)}\n\n`
  + `任务：对这份收敛提案做全局不变量检点，逐条给出 pass/fail 与裸值：\n`
  + `7-reticle 面积守恒、单一硬件规格（ADR-0021）、MC320/MC640 分离、peak 与 sustained 分离、`
  + `单位一致、证据等级齐全。收敛格还要专门核这四条跨格不变量：\n`
  + `  (a) D 组五格是否真的到齐（${REQUIRED_STAGES.join('、')}）；\n`
  + `  (b) 跨格口径一致：尤其是卡功耗口径——memory 域是 8×die + MC + 固定 80 W、**不计**共享端口项，`
  + `      physical 域计它，两者相差 21.915648 W。同一次比较里混用即违规；\n`
  + `  (c) 跨格 manifest hash 一致：B2 的事件流与 B1 的算子账本必须来自同一份 manifest；\n`
  + `  (d) architect 的裁决与它的材料自洽——判 ARCH_FREEZE 却留着 openItems、`
  + `      或判 D_GATE_PROPOSAL 却证据不完备，这两件事不能同时成立。\n`
  + `另外核一条：提案里有没有把"证据齐备"写成"通过"——`
  + `门控结论只能是 evaluate_gates.js 的产出。\n`
  + `违规项必须给出违反的具体文件与字段。\n`
  + `不得把违规项解释掉（解释权归 architect）；不得以文档措辞为依据，只以数值和来源为依据。\n`
  + `全部通过写 INVARIANT_OK，任一不通过写 INVARIANT_VIOLATED。`,
  {label: 'invariant-checker', phase: 'Invariant check', effort: 'high', schema: CHECK_SCHEMA})

const okInvariants = check && check.verdict === 'INVARIANT_OK'

const ledgerPatch = {
  currentStage: STAGE,
  strategyVersions: {
    architect: '1.0', 'gate-keeper': '1.0', 'invariant-checker': '1.0', 'framing-critic': '1.0',
    ...Object.fromEntries(RELEVANT_EXPERTS.map((a) => [a, '1.0'])),
  },
  rejectedOptions: [],
  // 收敛后仍然开着的项，按 owner 登记。gate-keeper 的 openBlockers
  // 与 architect 的 openItems 都进这里——一个说"证据缺什么"，
  // 一个说"裁决留了什么"，两者都必须在下一轮开始时可见。
  openBlockers: [
    ...((gate && gate.openBlockers) || []).map((b) => ({
      id: b.id, owner: b.owner, unblockCondition: b.unblockCondition,
    })),
    ...(convergence.openItems || []).map((item, i) => ({
      id: `CONVERGE-${String(i + 1).padStart(2, '0')}`,
      owner: 'architect',
      unblockCondition: item,
    })),
  ],
}

// 提案的指纹：收敛裁决、framing 结论、证据状态三者的组合。
// 两次跑出来的提案是不是同一份，靠这个可复核。
const proposalFingerprint = [
  `verdict=${convergence.verdict}`,
  `framing=${framing ? framing.verdict : 'UNVERIFIED'}`,
  `gate=${gate ? gate.verdict : 'UNVERIFIED'}`,
  `experts=${RELEVANT_EXPERTS.slice().sort().join(',')}`,
  `blocking=${blockingResiduals.length}`,
].join('|')

const runRecord = {
  schemaVersion: 'design-run-record-v0.1',
  stage: STAGE,
  runId: RUN_ID,
  sourceCommit: BRIEF.sourceCommit,
  detailArtifacts: DETAIL_ARTIFACTS,
  designPoint: POINT_RECORD,
  stageCommand: STAGE_COMMAND_FOR_RECORD,
  requiredStages: REQUIRED_STAGES,
  relevantExperts: RELEVANT_EXPERTS.slice().sort(),
  architectVerdict: convergence.verdict,
  framingVerdict: framing ? framing.verdict : 'UNVERIFIED',
  gateVerdict: gate ? gate.verdict : 'UNVERIFIED',
  gateThresholds: Object.fromEntries(((gate && gate.thresholds) || []).map((t) => [t.name, t.status])),
  blockingResidualCount: blockingResiduals.length,
  nonBlockingResidualCount: residuals.reduce((n, r) => n + (r.residuals || []).filter((x) => x.severity === 'nonBlocking').length, 0),
  openItemCount: (convergence.openItems || []).length,
  proposalFingerprint,
  declarants: [...RELEVANT_EXPERTS, 'framing-critic', 'gate-keeper', 'architect', 'invariant-checker'].sort(),
  // 这一行是本格与门控之间唯一的那条线，写进产物里，
  // 免得下游读到这份文件时把提案当成结论。
  caliber: '本产物是**收敛提案**，不得当作门控结论。PASS / D_GATE_PASSED / Q_GATE_PASSED '
    + '只由 integration/governance/evaluate_gates.js 计算；'
    + 'gate-keeper 的 GATE_EVIDENCE_COMPLETE 只表示证据足够送评审。'
    + '本 workflow 不产生任何决定性数字。',
}

return {
  stage: STAGE,
  runId: RUN_ID,
  verdict: okInvariants ? convergence.verdict : 'INVARIANT_VIOLATED',
  // architectVerdict 与顶层 verdict 分开：顶层 verdict 还要过检点，
  // 而 architect 的裁决是它自己的判断，两者都保留，不互相覆盖。
  architectVerdict: convergence.verdict,
  proposal: okInvariants ? {
    convergence,
    framing,
    gate,
    residuals,
    blockingResiduals,
  } : null,
  violations: okInvariants ? [] : ((check && check.violations) || ['检点未完成']),
  nextActions: okInvariants ? [] : ['消解检点违规项后重跑本格'],
  // 给主循环的一句话：拿到提案之后该做什么。
  // 门控不是本 workflow 能算的，所以这里明确指向那个脚本。
  gateEvaluation: {
    note: '门控结论由 evaluate_gates.js 计算；本 workflow 只提交提案',
    proposedVerdict: convergence.verdict,
    evidenceComplete: okGate,
    readyForGateEvaluation: okGate && okFraming && okInvariants,
  },
  ledgerPatch,
  runRecord,
  files: okInvariants ? [
    {
      path: `${REPO}/out/detailed/converge_proposal.json`,
      content: JSON.stringify({
        schemaVersion: 'design-converge-proposal-v0.1',
        stage: STAGE, runId: RUN_ID, sourceCommit: BRIEF.sourceCommit,
        detailArtifacts: DETAIL_ARTIFACTS,
        proposalFingerprint,
        convergence: {
          verdict: convergence.verdict,
          assessment: convergence.assessment,
          openItems: convergence.openItems || [],
          directionLevelFindings: convergence.directionLevelFindings || [],
        },
        framing,
        gate,
        residuals,
        blockingResiduals,
        // 明写这不是门控结论。
        isGateConclusion: false,
        gateConclusionOwner: 'integration/governance/evaluate_gates.js',
      }, null, 2) + '\n',
    },
    {
      path: `${REPO}/out/detailed/converge_run_record.json`,
      content: JSON.stringify(runRecord, null, 2) + '\n',
    },
  ] : [],
}
