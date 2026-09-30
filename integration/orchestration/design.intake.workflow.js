export const meta = {
  name: 'design-intake',
  description: 'K3 设计 intake：从需求段落产出填满约束/预算/形态意图的 brief，交 framing-critic 对抗审查后定稿',
  whenToUse: '设计流程的第一格。输入一段需求文本与可选预算，输出可下发的 DesignBrief 与 ledger 种子。',
  phases: [
    { title: 'Constraint collection', detail: '六个领域专家各自提出本域硬约束' },
    { title: 'Reject recall', detail: '读 ledger.rejectedOptions，避免重新发明已否方案' },
    { title: 'Brief assembly', detail: 'architect 合并约束、分配预算、给出形态意图' },
    { title: 'Framing review', detail: 'framing-critic 只查框架完整性、口径一致性、设计空间是否被写窄' },
    { title: 'Revision', detail: '带缺口清单重写，最多两轮' },
  ],
}

// ---------------------------------------------------------------------------
// 契约
//
// 脚本不读文件、不写文件。策略正文由 agent 自己按 agentId 读取——
// workflow 传 agentId，agent 按仓库约定读 teams/council/strategies/<agentId>.md。
// 这样策略只有一份来源，脚本保持薄。
//
// 裁决枚举逐字消费：专家报 BLOCKED_CONFIG / DIRECTION_BACKFLOW / LOCAL_DETAIL_FIX / PPA_DIRECTION_BACKFLOW，
// architect 报 ARCH_FREEZE / DIRECTION_BACKFLOW / D_GATE_PROPOSAL，framing-critic 报 FRAMING_OK / FRAMING_INSUFFICIENT。
// 这些值是数据，不是结论：下面的 switch 拿它们决定走哪条边。
// 没有任何 agent 能在这里宣布门控通过——门控由确定性脚本计算。
// ---------------------------------------------------------------------------

const REPO = args.repo || '.'
const STAGE = 'intake'
const RUN_ID = args.runId || `intake-${String(args.objective || '').length}`
const SOURCE_COMMIT = args.sourceCommit
const OBJECTIVE = args.objective
const REQUIREMENTS = args.requirements || args.objective
const SHAPE_SEED = args.shapeIntent || '(架构师未给出初始形态意图，请由你提出一版待验证的形态假设)'
const MC_PROFILE = args.mcProfile || 'MC320'
const BUDGET = args.budget || {}
const EXPERTS = ['compute-expert', 'memory-expert', 'comm-expert', 'physical-expert', 'software-expert', 'model-expert']
const MAX_ROUNDS = 2

if (!OBJECTIVE || !SOURCE_COMMIT) {
  throw new Error('design-intake 需要 args.objective 与 args.sourceCommit')
}

// 每个 agent 的 prompt 头部统一自述：去哪读策略、返回什么。缺了它 agent 会以为 brief 就在 prompt 里。
const HEAD = [
  `仓库根目录：${REPO}`,
  `本 workflow：design.intake（stage=${STAGE}，runId=${RUN_ID}，sourceCommit=${SOURCE_COMMIT}）`,
  `你是一个策略实例。先读你的策略正文：${REPO}/teams/council/strategies/__AGENT__.md`,
  '那份文件是本角色的判断规则、正确性判据、证据规则、取舍规则与禁止事项，逐条遵守。',
  '以下运行时上下文由 workflow 注入；注入内容与策略正文冲突时，注入内容优先（它承载本 stage 的事实）。',
  '你没有文件系统写权限。把该写的东西作为返回值交回，由 workflow 落盘。',
  '所有数字必须带出处（文件路径:行号 或 ADR 编号）；没有出处的写 UNVERIFIED 并说明缺什么，不得静默补齐。',
  '不得输出 TPS/usr 或任何全局性能指标；不得输出 PASS / D_GATE_PASSED 字面量。',
].join('\n')

const head = (agentId) => HEAD.replace('__AGENT__', agentId)

const CONSTRAINTS_CONTRACT = [
  '本 stage 只做一件事：把需求转成一份 brief。不做任何领域设计。',
  `唯一的 stage 问题：${OBJECTIVE}`,
  '',
  '需求原文：',
  REQUIREMENTS,
  '',
  `形态意图（待验证的假设，可以被你反驳，但反驳必须给理由）：${SHAPE_SEED}`,
  `本次硬件规格绑定：physicalProfile=P1（ADR-0021，唯一一份规格），mcProfile=${MC_PROFILE}`,
  '',
  `预算（已知的填，未知的必须是 null，不得猜）：${JSON.stringify(BUDGET)}`,
  '',
  '硬约束格式：id 形如 C-<域>-<序>，source 必须写规格文件路径或 ADR 编号，不得写 TBD。',
  '你只提本域约束。跨域冲突不要在这里裁决，写进 unresolved 交给 architect。',
].join('\n')

const PROPOSAL_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['agentId', 'constraints', 'rejectedOptions', 'unresolved', 'verdict'],
  properties: {
    agentId: { type: 'string' },
    constraints: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['id', 'text', 'source', 'value'],
        properties: {
          id: { type: 'string', pattern: '^C-[A-Z0-9-]+$' },
          text: { type: 'string' },
          source: { type: 'string' },
          value: { type: ['number', 'string', 'null'] },
        },
      },
    },
    rejectedOptions: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['optionId', 'reason'],
        properties: {
          optionId: { type: 'string' },
          reason: { type: 'string' },
          evidence: { type: 'string' },
        },
      },
    },
    unresolved: { type: 'array', items: { type: 'string' } },
    verdict: { type: 'string', enum: ['LOCAL_DETAIL_FIX', 'DIRECTION_BACKFLOW', 'BLOCKED_CONFIG'] },
    note: { type: 'string' },
  },
}

phase('Constraint collection')

// 六个领域专家并发提约束。这里用 parallel() 而非 pipeline()：architect 需要全部六份才可能合并。
const proposals = await parallel(
  EXPERTS.map((expert) => () =>
    agent(`${head(expert)}\n\n${CONSTRAINTS_CONTRACT}`, {
      label: `constraint:${expert}`,
      phase: 'Constraint collection',
      schema: PROPOSAL_SCHEMA,
      effort: 'medium',
    }),
  ),
)

const live = proposals.filter(Boolean)
const absent = EXPERTS.filter((_, i) => !proposals[i])
const blocked = live.filter((p) => p.verdict === 'BLOCKED_CONFIG')
const constraints = live.flatMap((p) => p.constraints || [])
const unresolved = live.flatMap((p) => p.unresolved || [])

// 缺专家不静默：缺谁写进 ledger，architect 必须据此声明覆盖不完整。
if (absent.length) log(`缺 ${absent.length} 个专家的约束：${absent.join(', ')}`)
if (blocked.length) log(`BLOCKED_CONFIG：${blocked.map((p) => p.agentId).join(', ')}`)

phase('Reject recall')

// 已否方案必须回灌。没有这一步，重跑会重新发明上一轮已经否掉的方案。
const rejectLedger = await agent(
  `${head('architect')}

上一轮 ledger 里已经否掉的方案（可能为空）：
${JSON.stringify(args.rejectedOptions || [])}

任务：判断这些已否方案里，有哪几条会在本次 intake 的约束收集阶段被重新提出。
每条给出 optionId 与一句为什么它仍然不该被采纳。没有就返回空数组。
不要新增否定结论，只做回灌。`,
  {
    label: 'reject-recall',
    phase: 'Reject recall',
    effort: 'low',
    schema: {
      type: 'object',
      additionalProperties: false,
      required: ['stillRejected'],
      properties: {
        stillRejected: {
          type: 'array',
          items: {
            type: 'object',
            additionalProperties: false,
            required: ['optionId', 'reason'],
            properties: { optionId: { type: 'string' }, reason: { type: 'string' } },
          },
        },
      },
    },
  },
)

const rejectedOptions = (rejectLedger && rejectLedger.stillRejected ? rejectLedger.stillRejected : []).concat(
  live.flatMap((p) => (p.rejectedOptions || []).map((r) => ({ ...r, by: p.agentId }))),
)

phase('Brief assembly')

const BRIEF_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['brief', 'verdict', 'unresolved'],
  properties: {
    brief: {
      type: 'object',
      additionalProperties: false,
      // 字段集与 teams/council/inputs/design_brief.schema.json 的 required 一一对应。
      // 多一个字段 brief 就通不过校验，所以这里刻意保持与那份 schema 同形。
      required: [
        'schemaVersion',
        'stage',
        'runId',
        'sourceCommit',
        'objective',
        'hardConstraints',
        'budget',
        'shapeIntent',
        'allowedDesignSpace',
        'forbidden',
        'exitCriteria',
        'evidenceLevelFloor',
        'profileBinding',
      ],
      properties: {
        schemaVersion: { type: 'string', enum: ['1.0'] },
        stage: { type: 'string', enum: ['intake'] },
        runId: { type: 'string' },
        sourceCommit: { type: 'string' },
        objective: { type: 'string' },
        hardConstraints: {
          type: 'array',
          items: {
            type: 'object',
            additionalProperties: false,
            required: ['id', 'text', 'source'],
            properties: {
              id: { type: 'string', pattern: '^C-[A-Z0-9-]+$' },
              text: { type: 'string' },
              source: { type: 'string' },
              value: { type: ['number', 'string', 'null'] },
            },
          },
        },
        budget: {
          type: 'object',
          additionalProperties: false,
          required: ['areaMm2', 'powerW', 'bandwidthGBs'],
          properties: {
            areaMm2: { type: ['number', 'null'] },
            powerW: { type: ['number', 'null'] },
            bandwidthGBs: { type: ['number', 'null'] },
          },
        },
        shapeIntent: { type: 'string' },
        allowedDesignSpace: {
          oneOf: [
            { type: 'string' },
            {
              type: 'array',
              items: {
                type: 'object',
                additionalProperties: false,
                required: ['optionId'],
                properties: { optionId: { type: 'string' }, description: { type: 'string' } },
              },
            },
          ],
        },
        forbidden: { type: 'array', items: { type: 'string' } },
        exitCriteria: { type: 'array', items: { type: 'string' } },
        evidenceLevelFloor: { type: 'string', enum: ['E0', 'E1', 'E2', 'E3'] },
        profileBinding: {
          type: 'object',
          additionalProperties: false,
          required: ['physicalProfile', 'mcProfile'],
          properties: {
            physicalProfile: { type: 'string', enum: ['P1'] },
            mcProfile: { type: 'string', enum: ['MC320', 'MC640'] },
          },
        },
      },
    },
    verdict: { type: 'string', enum: ['ARCH_FREEZE', 'DIRECTION_BACKFLOW', 'D_GATE_PROPOSAL'] },
    unresolved: { type: 'array', items: { type: 'string' } },
  },
}

const CRITIQUE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['verdict', 'gaps'],
  properties: {
    verdict: { type: 'string', enum: ['FRAMING_OK', 'FRAMING_INSUFFICIENT'] },
    gaps: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['field', 'gap', 'fix', 'consequence'],
        properties: {
          field: { type: 'string' },
          gap: { type: 'string' },
          fix: { type: 'string' },
          consequence: { type: 'string' },
        },
      },
    },
  },
}

function assemblePrompt(proposalJson, gaps) {
  const lines = [
    head('architect'),
    '',
    CONSTRAINTS_CONTRACT,
    '',
    '六个领域专家提出的本域硬约束与未决项：',
    proposalJson,
    '',
    `缺位专家（其覆盖不完整，必须在 brief 里体现，不得用现有材料推断代替）：${JSON.stringify(absent)}`,
    `BLOCKED_CONFIG 的专家：${JSON.stringify(blocked.map((p) => p.agentId))}`,
    `回灌的已否方案：${JSON.stringify(rejectedOptions.map((r) => r.optionId || r.reason))}`,
    '',
    '你的任务：合并成一份完整的 brief。',
    '- hardConstraints 只收有来源的；source 写规格文件路径或 ADR 编号，不得写 TBD。',
    '- budget 各分项之和必须等于总量；未分配的分项写 null，不得填猜测值。',
    '- allowedDesignSpace 只收到足以让下游开工为止；收窄它是控制成本的唯一手段。',
    '- exitCriteria 是下游判断"做完没有"的依据，必须可判定，不得写"设计合理"这类话。',
    '- shapeIntent 是你想验证的形态假设，不是命令。',
    '- 跨域矛盾未解决时不要在这里打赢它：写进 unresolved，并把 verdict 定为 DIRECTION_BACKFLOW。',
    '- 框架成立且可下发时 verdict 为 ARCH_FREEZE；产生候选集需要裁定才为 D_GATE_PROPOSAL。',
  ]
  if (gaps && gaps.length) {
    lines.push('', '上一轮 framing-critic 指出的框架缺口，必须逐条修正（gaps 数组逐条对应）：', JSON.stringify(gaps))
  }
  return lines.join('\n')
}

phase('Framing review')

// 有界重写：审查不通过就带缺口重写，最多 MAX_ROUNDS 轮。
// 轮次上限是刻意写死的——不设上限，框架问题会在两格之间来回振荡，成本不可控。
const rounds = []
let finalBrief = null
let finalGaps = []
let verdict = null

for (let round = 1; round <= MAX_ROUNDS; round++) {
  const label = round === 1 ? 'architect' : `architect:rev${round}`

  const assembled = await agent(assemblePrompt(JSON.stringify({ constraints, unresolved }), finalGaps), {
    label,
    phase: round === 1 ? 'Brief assembly' : 'Revision',
    schema: BRIEF_SCHEMA,
    effort: 'high',
  })

  verdict = assembled && assembled.verdict
  finalBrief = assembled && assembled.brief
  rounds.push({ round, verdict })

  // DIRECTION_BACKFLOW 就地终止：方向问题不在 intake 解决，继续走只会产出一份错的 brief。
  if (verdict === 'DIRECTION_BACKFLOW') {
    log(`第 ${round} 轮 architect 报 DIRECTION_BACKFLOW，交回 direction 阶段流程`)
    break
  }

  if (!finalBrief) {
    log(`第 ${round} 轮 architect 未产出 brief，重试`)
    continue
  }

  const critique = await agent(
    `${head('framing-critic')}

只审查框架，不审查具体设计数值。逐条回答三个反问：约束是否完整、口径是否混用、allowedDesignSpace 是否把正确解排除在外。

口径混用清单，出现即指名到字段：粗估/细估、MC320/MC640、peak/sustained、raw/sustained/effective、理论/sustained payload、预算值/实测值、planning estimate/silicon claim。

待审 brief：
${JSON.stringify(finalBrief)}

缺位专家：${JSON.stringify(absent)}。${absent.length ? '覆盖不完整本身是否构成缺口，由你判断。' : ''}

规则：必须给出至少一处实质缺口，否则视为未起作用。给不出就说明你已经查过哪几个字段、为什么它们都成立——
但结论仍必须是 FRAMING_OK。每条缺口必须指向具体字段，并给出可执行的修正动作，以及不改会改变哪个结论。`,
    { label: `framing-critic:r${round}`, phase: 'Framing review', schema: CRITIQUE_SCHEMA, effort: 'high' },
  )

  finalGaps = (critique && critique.gaps) || []
  rounds.push({ round, framing: critique && critique.verdict, gaps: finalGaps.length })

  if (critique && critique.verdict === 'FRAMING_OK') {
    log(`第 ${round} 轮框架通过`)
    break
  }
  if (round === MAX_ROUNDS) {
    log(`重写 ${MAX_ROUNDS} 轮仍有 ${finalGaps.length} 条框架缺口，不落盘 winner`)
  }
}

// ---------------------------------------------------------------------------
// 返回值即落盘清单：脚本无写权限，由主循环写入 teams/council/inputs/ 后提交。
// 未经 framing-critic 通过的 brief 不落盘——宁可停在原地，也不要一份框架有缺口的契约往下流。
// ---------------------------------------------------------------------------
const framingOk = rounds.some((r) => r.framing === 'FRAMING_OK')

const ledgerSeed = {
  schemaVersion: '1.0',
  currentStage: STAGE,
  strategyVersions: EXPERTS.concat(['architect', 'framing-critic']).reduce((acc, id) => {
    acc[id] = '1.0'
    return acc
  }, {}),
  frozenDecisions: [],
  rejectedOptions: rejectedOptions.map((r) => ({
    stage: STAGE,
    optionId: r.optionId || 'unnamed',
    reason: r.reason,
    rejectedBy: r.by || 'architect',
    ...(r.evidence ? { evidence: r.evidence } : {}),
  })),
  budgetBalance: finalBrief
    ? {
        areaMm2: { total: finalBrief.budget.areaMm2, committed: null, free: finalBrief.budget.areaMm2 },
        powerW: { total: finalBrief.budget.powerW, committed: null, free: finalBrief.budget.powerW },
        bandwidthGBs: { total: finalBrief.budget.bandwidthGBs, committed: null, free: finalBrief.budget.bandwidthGBs },
      }
    : {},
  openBlockers: finalGaps.map((g, i) => ({
    id: `FRAME-${String(i + 1).padStart(2, '0')}`,
    owner: 'architect',
    unblockCondition: g.fix,
  })),
  evidenceIndex: finalBrief
    ? finalBrief.hardConstraints.map((c, i) => ({
        claimId: c.id || `C-INTAKE-${String(i + 1).padStart(2, '0')}`,
        evidence: c.source,
        level: /^ADR-\d{4}$/.test(c.source) ? 'E1' : 'E2',
      }))
    : [],
}

return {
  stage: STAGE,
  runId: RUN_ID,
  sourceCommit: SOURCE_COMMIT,
  verdict,
  framingOk,
  rounds,
  absentExperts: absent,
  blockedExperts: blocked.map((p) => p.agentId),
  brief: framingOk ? finalBrief : null,
  // 未通过时也保留草稿，供人看差在哪，但标注了未被采纳
  draftBrief: framingOk ? null : finalBrief,
  openGaps: finalGaps,
  ledgerSeed,
  files: framingOk
    ? [{ path: `${REPO}/teams/council/inputs/design_brief.intake.json`, content: JSON.stringify(finalBrief, null, 2) }]
    : [],
}
