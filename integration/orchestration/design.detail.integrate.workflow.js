export const meta = {
  name: 'design-detail-integrate',
  description: 'K3 设计 detail.integrate 阶段（B4）：integrator 逐槽位对账 18 个观察位并把粗估-细估 delta 归位，architect 对无法归因的 delta 做方向级裁决，verifier 独立验证落盘产物，invariant-checker 检点后落盘',
  whenToUse: 'D 组第五格，只做合并。需要 args.brief（stage=detail.integrate 的 DesignBrief）、args.detailRunArtifact（out/detailed/detailed_architecture_run.json）、args.observationArtifact（out/workload/tps_observation_matrix.json）、args.directionArtifact（out/direction/directional_tps_scorecard.json，粗估侧）与 args.registerArtifact。均由主循环生成。本 workflow 不跑 stage_b.js、不写既有产物。',
  phases: [
    { title: 'Merge', detail: 'integrator 逐槽位对账 18 个观察位，粗估-细估 delta 逐条归位' },
    { title: 'Delta attribution', detail: 'architect 只对无法归因的 delta 做裁决；解释权在这里，不在合并者' },
    { title: 'Independent verification', detail: 'verifier 只拿落盘产物，独立验证 schema/守恒/provenance/可回放性' },
    { title: 'Invariant check', detail: 'invariant-checker 强制检点；不通过则不落盘' },
  ],
}

// ---------------------------------------------------------------------------
// D 组第五格：B4（19 号文档 §7）。**只做合并，不产生新设计。**
//
// 这一格是 S6 的验收落点："粗估-细估 delta 有归因"。
//
// 它要输出的东西不多，但每一条都必须齐：
//   · 18 个观察位（3 模型 × TP8/16/32 × MC320/MC640）
//   · 单一硬件规格检查（ADR-0021）
//   · 逐位拆分（memory / compute / comm / TMA / fixed）
//   · P50 / P95 / P99
//   · 每一个槽位的**粗估-细估 TPS delta 百分比与原因**
//   · 观察状态：MODEL_OBSERVED / PENDING_MODEL_RUN / BLOCKED_CONFIG / SILICON_OBSERVED
//
// 关于 delta 的分工，这一格有一条硬规矩：
//
//   **delta 的数值由本文件算，delta 的原因由 architect 给。**
//
// 粗估与细估两个数由 integrator 逐字转抄（它只能转抄，不能重算），
// 百分比由本文件的第一行算术得出——它是一个决定性的数，
// 因此不得由任何 agent 产生，包括"顺手算一下"。
// 而"为什么差这么多"是对**已存在的两个数**的解释，那才是判断，
// 属于 architect。把这两件事分开，是为了让 delta 的值永远可复核：
// 只要两个裸值在，任何人都能重算出同一个百分比。
//
// 本格的 18 位由脚本对账，不由 agent 自律保证：少一位、多一位、
// 或者某个槽位换了一份硬件规格，都在这里被抓住。
//
// 关于 verifier：B0 那一格我刻意没有给它（冻结清单没有可回放的物理量）。
// B4 正相反——它产出的是 18 个槽位的数值产物，schema、守恒、provenance、
// golden trace、可回放性全都有对象。所以它在这里名正言顺，
// 而且必须**只拿落盘产物**，不拿 agent 的申报散文：知道申报怎么写的
// 验证者，会去验证申报，而不是验证产物。
// ---------------------------------------------------------------------------

const REPO = args.repo || '.'
const STAGE = 'detail.integrate'
const BRIEF = args.brief
const RUN_ID = args.runId || 'detail-integrate-run'
const DETAIL_RUN_ARTIFACT = args.detailRunArtifact
const OBSERVATION_ARTIFACT = args.observationArtifact
const DIRECTION_ARTIFACT = args.directionArtifact
const REGISTER_ARTIFACT = args.registerArtifact
const STAGE_COMMAND_FOR_RECORD = args.stageCommand || 'UNVERIFIED'

if (!BRIEF) throw new Error('design.detail.integrate 需要 args.brief（intake 阶段产出的 DesignBrief）')
if (!DETAIL_RUN_ARTIFACT || !OBSERVATION_ARTIFACT || !DIRECTION_ARTIFACT || !REGISTER_ARTIFACT) {
  throw new Error('design.detail.integrate 需要 args.detailRunArtifact / args.observationArtifact / '
    + 'args.directionArtifact / args.registerArtifact（已由主循环生成）；本 workflow 不跑 Stage B')
}
if (BRIEF.stage !== STAGE) {
  throw new Error(`brief.stage=${BRIEF.stage}，与 design.${STAGE} 不符；契约串了`)
}

// 18 个观察位 = 3 模型 × TP 三档 × MC 两档。这不是"大概这些"，
// 是这一格的输出定义本身：少一位，那个组合就没人看过。
const OBSERVATION_MODELS = ['GLM-5.2', 'DeepSeek-V4-Pro', 'Kimi-K3']
const OBSERVATION_TP = [8, 16, 32]
const OBSERVATION_MC = ['MC320', 'MC640']
const OBSERVATION_COUNT = OBSERVATION_MODELS.length * OBSERVATION_TP.length * OBSERVATION_MC.length

const slotKey = (modelId, tp, mcProfile) => `${modelId}|TP${tp}|${mcProfile}`

// 观察状态。四个取值之外的第五个不是"更细的状态"，是没人定义过的状态。
const OBSERVATION_STATES = ['MODEL_OBSERVED', 'PENDING_MODEL_RUN', 'BLOCKED_CONFIG', 'SILICON_OBSERVED']

// 逐位拆分必须覆盖的口径。它们是"这个数是怎么来的"的最小分解，
// 少一项总时间就有一块无名的来源。
const BREAKDOWN_FIELDS = ['memoryUs', 'computeUs', 'commUs', 'tmaExposedUs', 'fixedUs']

// 尾延迟分位。缺一个，尾部就没有被描述——而设计里的门控正是卡在尾部的。
const TAIL_PERCENTILES = ['p50', 'p95', 'p99']

const HEAD = [
  `仓库根目录：${REPO}`,
  `本 workflow：design.detail.integrate（stage=${STAGE}，runId=${RUN_ID}）`,
  `你是一个策略实例。先读你的策略正文：${REPO}/teams/council/strategies/__AGENT__.md`,
  '那份文件是本角色的判断规则、正确性判据、证据规则、取舍规则与禁止事项，逐条遵守。',
  '以下运行时上下文由 workflow 注入；注入内容与策略正文冲突时，注入内容优先（它承载本 stage 的事实）。',
  '你没有文件系统写权限。把该写的东西作为返回值交回，由 workflow 落盘。',
  '所有数字必须带出处（文件路径:行号 或 ADR 编号）；没有出处的写 UNVERIFIED 并说明缺什么，不得静默补齐。',
  '不得输出 TPS/usr 或任何全局性能指标；不得输出 PASS / D_GATE_PASSED 字面量。',
  '本格**只做合并**：不得产生新的设计选项、不得重算任何数值、不得改写产物里的任何字段。',
  '粗估与细估的数逐字转抄即可；delta 的百分比由 workflow 算，你不得自己算它。',
].join('\n')

const head = (agentId) => HEAD.replace('__AGENT__', agentId)

const BRIEF_JSON = JSON.stringify(BRIEF, null, 2)

// 逐槽位登记。粗估与细估两个裸值 + 出处是 integrator 的唯一工作；
// 它不解释、不算差、不判断——那些分别属于 architect 与本文件。
const SLOT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['slotKey', 'modelId', 'tp', 'mcProfile', 'coarseTps', 'fineTps', 'coarseSource', 'fineSource', 'status'],
  properties: {
    slotKey: { type: 'string', description: '格式：modelId|TP<8|16|32>|MC<320|640>，逐字按 workflow 给出的键写' },
    modelId: { type: 'string' },
    tp: { type: 'number' },
    mcProfile: { type: 'string' },
    coarseTps: { type: 'number', description: '粗估侧的裸值，逐字转抄，不得重算' },
    fineTps: { type: 'number', description: '细估侧的裸值，逐字转抄，不得重算' },
    coarseSource: { type: 'string', description: '粗估数的出处：文件#字段' },
    fineSource: { type: 'string', description: '细估数的出处：文件#字段' },
    status: { type: 'string', enum: OBSERVATION_STATES },
    breakdown: {
      type: 'object',
      description: `逐位拆分；缺一项总时间就有一块无名的来源`,
      additionalProperties: true,
    },
    tail: {
      type: 'object',
      description: `尾延迟分位：${TAIL_PERCENTILES.join(' / ')}；产物里没有就写 UNVERIFIED`,
      additionalProperties: true,
    },
  },
}

const MERGE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['slots', 'singleHardwareSpec', 'unattributedDelta', 'rejectedOptions', 'verdict'],
  properties: {
    slots: {
      type: 'array',
      description: `恰好 ${OBSERVATION_COUNT} 个观察位；键必须取自 workflow 给出的清单`,
      items: SLOT_SCHEMA,
    },
    singleHardwareSpec: {
      type: 'string',
      description: '这一轮的资源来自哪一份规格；出现第二份即违规，如实写出',
    },
    // 这一格的核心产物：哪些 delta 归不了因。
    // integrator 在这里只**标记**归不了因的，不解释它们——解释权归 architect。
    unattributedDelta: {
      type: 'array',
      description: '无法归因的 delta；只标记事实，不解释',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['slotKey', 'deltaPct', 'observation'],
        properties: {
          slotKey: { type: 'string' },
          deltaPct: { type: 'number', description: '由 workflow 算出的百分比，逐字转抄' },
          observation: { type: 'string', description: '观察到什么（例如某一侧的数与其它位不成比例），不解释原因' },
        },
      },
    },
    // 能归因的 delta 逐条归因。归因不是"解释得通"，
    // 是指出**具体是哪一项拆分**造成了这个差。
    attributions: {
      type: 'array',
      description: '已归因的 delta：每一条必须指到具体的拆分项或口径差',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['slotKey', 'deltaPct', 'attributedTo', 'evidence'],
        properties: {
          slotKey: { type: 'string' },
          deltaPct: { type: 'number' },
          attributedTo: { type: 'string', description: '具体是哪一项（memoryUs / commUs / 口径 / …）' },
          evidence: { type: 'string', description: '文件路径:行号 或 hash；引用不到写 UNVERIFIED' },
        },
      },
    },
    rejectedOptions: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['optionId', 'reason', 'rejectedBy'],
        properties: {
          optionId: { type: 'string' }, reason: { type: 'string' }, rejectedBy: { type: 'string' },
        },
      },
    },
    verdict: { type: 'string', enum: ['INTEGRATION_OK', 'DELTA_UNEXPLAINED'] },
  },
}

// architect 的裁决。它在 roster 里只有三个值，而这三个正好覆盖
// "这次细化到此为止"（ARCH_FREEZE）、"差得太多要重定方向"（DIRECTION_BACKFLOW）、
// "证据够了，送 D-Gate"（D_GATE_PROPOSAL）三种结局。它不是在这里重新设计的。
const ATTRIBUTION_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['attributions', 'unexplained', 'verdict'],
  properties: {
    attributions: {
      type: 'array',
      description: '对 integrator 标记的每一个未归因 delta 给出归因；指到具体拆分项',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['slotKey', 'attributedTo', 'evidence', 'directionLevel'],
        properties: {
          slotKey: { type: 'string' },
          attributedTo: { type: 'string', description: '具体拆分项或口径差' },
          evidence: { type: 'string', description: '文件路径:行号 或 hash' },
          directionLevel: { type: 'boolean',
            description: 'true 表示这个 delta 动摇了方向级假设（不是细节问题）' },
        },
      },
    },
    unexplained: {
      type: 'array',
      description: '**仍归不了因**的槽位。这些必须留空上不去，不得用"综合因素"糊过去',
      items: { type: 'string', description: 'slotKey' },
    },
    directionLevelFindings: {
      type: 'array',
      description: '动摇方向级假设的发现，逐条列出',
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

const VERIFY_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['checks', 'failures', 'verdict'],
  properties: {
    checks: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['name', 'result', 'detail'],
        properties: {
          name: { type: 'string', description: 'schema / 守恒 / provenance / golden trace / 可回放性' },
          result: { type: 'string', enum: ['pass', 'fail'] },
          detail: { type: 'string', description: '裸值；不得只写结论' },
        },
      },
    },
    failures: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['check', 'file', 'field', 'detail'],
        properties: {
          check: { type: 'string' }, file: { type: 'string' },
          field: { type: 'string' }, detail: { type: 'string' },
        },
      },
    },
    verdict: { type: 'string', enum: ['VERIFIED', 'VERIFY_FAILED'] },
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

phase('Merge')

const merged = await agent(
  `${head('integrator')}\n\n`
  + `brief：\n${BRIEF_JSON}\n\n`
  + `细化产物（只读，细估侧）：${DETAIL_RUN_ARTIFACT}\n`
  + `观察矩阵（只读）：${OBSERVATION_ARTIFACT}\n`
  + `方向记分卡（只读，粗估侧）：${DIRECTION_ARTIFACT}\n`
  + `候选寄存器（只读）：${REGISTER_ARTIFACT}\n\n`
  + `本次必须覆盖的 ${OBSERVATION_COUNT} 个观察位（键格式 modelId|TP<8|16|32>|MC<320|640>）：\n`
  + `${OBSERVATION_MODELS.flatMap((m) => OBSERVATION_TP.flatMap((tp) => OBSERVATION_MC.map((mc) => slotKey(m, tp, mc)))).join('\n')}\n\n`
  + `任务：逐槽位对账并合并。规则：\n`
  + `1. **逐字转抄**粗估与细估两个裸值，各带出处。不得重算、不得取近似值、不得改写。\n`
  + `   你**不得自己算 delta 的百分比**——那是 workflow 的算术，不是你的判断。\n`
  + `2. 每个槽位给出 status，取值必须是 ${OBSERVATION_STATES.join(' / ')} 之一。\n`
  + `   某一位的产品里没有事件级重放，就是 PENDING_MODEL_RUN——不得当成已观测。\n`
  + `3. 每个槽位给出逐位拆分（${BREAKDOWN_FIELDS.join('、')}）与尾延迟分位（${TAIL_PERCENTILES.join('、')}）。`
  + `   产物里没有的写 UNVERIFIED 并说明缺什么，不得补一个看起来合理的数。\n`
  + `4. 粗估与细估差异较大的槽位，如果你能指出**具体是哪一项拆分或哪一个口径**造成的，`
  + `   写进 attributions；指不出来就写进 unattributedDelta，**只描述观察到的事实，不要解释原因**。\n`
  + `5. 明确写出这一轮的资源来自哪一份硬件规格；出现第二份就是违规，如实写出。\n`
  + `6. 被排除的口径进 rejectedOptions。\n`
  + `全部 ${OBSERVATION_COUNT} 位齐备且每一位都归了位写 INTEGRATION_OK；`
  + `有槽位归不了位写 DELTA_UNEXPLAINED。`,
  {label: 'integrator', phase: 'Merge', effort: 'high', schema: MERGE_SCHEMA})

if (!merged) {
  return {
    stage: STAGE, runId: RUN_ID, verdict: 'BLOCKED_CONFIG',
    reason: '合并未返回；18 个观察位无法对账',
    nextActions: ['检查 args.detailRunArtifact / args.observationArtifact / args.directionArtifact 是否可读，补产物后重跑本格'],
    files: [],
  }
}

// --- 脚本侧对账之一：18 位的覆盖与形态 -------------------------------------
// 这一格的输出定义就是"18 位"，所以它以数据的形式被核对。
// 少一位、多一位、键写错、同一模型出现两次——都在这里被抓住。
const expectedKeys = OBSERVATION_MODELS.flatMap((m) => OBSERVATION_TP.flatMap((tp) => OBSERVATION_MC.map((mc) => slotKey(m, tp, mc))))
const seenKeys = merged.slots.map((s) => s.slotKey)
const missingSlots = expectedKeys.filter((k) => !seenKeys.includes(k))
const extraSlots = seenKeys.filter((k) => !expectedKeys.includes(k))
const duplicatedSlots = seenKeys.filter((k, i) => seenKeys.indexOf(k) !== i)

const badStates = merged.slots.filter((s) => !OBSERVATION_STATES.includes(s.status)).map((s) => `${s.slotKey}=${s.status}`)

// 拆分与尾延迟：产物里没有是允许的（写 UNVERIFIED），
// 但**整块缺失**不是——它意味着这一位没有被真正分解过。
const slotsMissingBreakdown = merged.slots
  .filter((s) => !s.breakdown || BREAKDOWN_FIELDS.filter((f) => typeof s.breakdown[f] === 'number').length === 0)
  .map((s) => s.slotKey)
const slotsMissingTail = merged.slots
  .filter((s) => !s.tail || typeof s.tail !== 'object' || TAIL_PERCENTILES.some((p) => s.tail[p] === undefined))
  .map((s) => s.slotKey)

// 单一硬件规格：18 位必须来自同一份规格。这里只看物理规格的取值集合，
// "是不是唯一一份 ADR-0021 规格"是检点者的判断，脚本只负责把事实摆出来。
const physicalProfiles = [...new Set(merged.slots.map((s) => s.mcProfile).filter(Boolean))]

const coverageGaps = [
  ...missingSlots.map((k) => `缺观察位：${k}`),
  ...extraSlots.map((k) => `多出未定义的观察位：${k}`),
  ...duplicatedSlots.map((k) => `观察位重复：${k}`),
  ...badStates.map((s) => `观察状态未定义：${s}`),
  ...slotsMissingBreakdown.map((k) => `${k}: 无逐位拆分`),
  ...slotsMissingTail.map((k) => `${k}: 尾延迟分位不全（需 ${TAIL_PERCENTILES.join('/')}）`),
]

if (coverageGaps.length) {
  return {
    stage: STAGE, runId: RUN_ID, verdict: 'BLOCKED_CONFIG',
    reason: `B4 观察位不齐：${coverageGaps.slice(0, 12).join('；')}${coverageGaps.length > 12 ? ` …共 ${coverageGaps.length} 项` : ''}`,
    nextActions: coverageGaps.slice(0, 12).map((g) => `补齐/更正：${g}`),
    coverageGaps,
    files: [],
  }
}

// --- 脚本侧对账之二：delta 由本文件算 ---------------------------------------
// 这是边界 4 在这一格最具体的落点：TPS 的差是**决定性的数**，
// 只由确定性算术产生。integrator 转抄了两个裸值，本文件相减——
// 任何一个读者拿这两个裸值都能重算出同一个百分比。
const DELTA_EPS = 1e-9
const deltaBySlot = new Map(merged.slots.map((s) => {
  const coarse = s.coarseTps
  const fine = s.fineTps
  const deltaPct = Math.abs(coarse) <= DELTA_EPS
    ? null
    : ((fine - coarse) / coarse) * 100
  return [s.slotKey, {
    slotKey: s.slotKey,
    coarseTps: coarse,
    fineTps: fine,
    deltaPct: deltaPct === null ? null : Math.round(deltaPct * 1e4) / 1e4,
  }]
}))

const nonzeroDelta = [...deltaBySlot.values()].filter((d) => d.deltaPct !== null && Math.abs(d.deltaPct) > DELTA_EPS)

// 归因齐备性：**每一个非零 delta 都必须有归因**。
// 不设"小于 x% 可以不解释"的宽容线——那正是 delta 悄悄溜走的方式。
// 归不了因是允许的结果（它会让本格以 DELTA_UNEXPLAINED 收场），
// 但"没提这件事"不是。
const attributedKeys = new Set([
  ...(merged.attributions || []).map((a) => a.slotKey),
  ...(merged.unattributedDelta || []).map((a) => a.slotKey),
])
const silentDeltas = nonzeroDelta.filter((d) => !attributedKeys.has(d.slotKey)).map((d) => `${d.slotKey}: delta ${d.deltaPct}% 未被提及`)

if (silentDeltas.length) {
  return {
    stage: STAGE, runId: RUN_ID, verdict: 'BLOCKED_CONFIG',
    reason: `有 delta 被静默略过（每一个非零 delta 都必须归位或有明确记录）：${silentDeltas.join('；')}`,
    nextActions: silentDeltas.map((d) => `对 ${d} 给出归因，或明确记为归不了因`),
    silentDeltas,
    files: [],
  }
}

phase('Delta attribution')

// 解释权归 architect。integrator 刚把归不了因的点标出来，
// 让它自己解释，它会把"归不了因"重新叙述成"综合因素"——那是把缺口
// 换个说法留下来。architect 的判断依据是**产品的数**，不是 integrator 的叙述。
const unexplainedInput = [
  ...(merged.unattributedDelta || []),
  ...nonzeroDelta
    .filter((d) => !(merged.attributions || []).some((a) => a.slotKey === d.slotKey))
    .map((d) => ({slotKey: d.slotKey, deltaPct: d.deltaPct, observation: 'workflow 计算：该位 delta 非零但未给出归因项'})),
]

const attribution = await agent(
  `${head('architect')}\n\n`
  + `brief：\n${BRIEF_JSON}\n\n`
  + `细化产物（只读）：${DETAIL_RUN_ARTIFACT}\n`
  + `观察矩阵（只读）：${OBSERVATION_ARTIFACT}\n`
  + `方向记分卡（只读，粗估侧）：${DIRECTION_ARTIFACT}\n`
  + `候选寄存器（只读）：${REGISTER_ARTIFACT}\n\n`
  + `workflow 算出的逐位 delta（粗估 → 细估的百分比，已由脚本相减得出）：\n`
  + `${JSON.stringify([...deltaBySlot.values()], null, 2)}\n\n`
  + `integrator 已给出的归因：\n${JSON.stringify(merged.attributions || [], null, 2)}\n\n`
  + `**尚未归因**的 delta（需要你裁决的）：\n${JSON.stringify(unexplainedInput, null, 2)}\n\n`
  + `单一硬件规格（integrator 登记）：${merged.singleHardwareSpec}\n`
  + `逐位物理/存储档位：${physicalProfiles.join(', ')}\n\n`
  + `任务：对每一个尚未归因的 delta 给出归因，并给出本格的方向级裁决。规则：\n`
  + `1. 归因必须指到**具体的拆分项或口径差**（memoryUs / computeUs / commUs / tmaExposedUs / fixedUs / `
  + `   粗估与细估的口径差 / 观察位的状态）。\n`
  + `2. **不得用"综合因素""多个原因共同作用"类措辞糊过去**。`
  + `   归不了因就写进 unexplained——那是允许的结果，它会让本格以 DELTA_UNEXPLAINED 收场，`
  + `   而一条假归因会让一个真缺口永远消失。\n`
  + `3. 逐条标注 directionLevel：这个 delta 是细节问题，还是动摇了方向级假设。\n`
  + `4. 两套卡功耗口径（memory 域不计共享端口项、physical 域计它，相差 45.5141376 W）`
  + `   若出现在同一次比较里，按方向级问题对待。\n`
  + `本格裁决（roster 里你的三个取值，各自对应一种结局）：\n`
  + `  ARCH_FREEZE：delta 全部归因、18 位与单一硬件规格对齐，本次细化结论到此冻结。\n`
  + `  DIRECTION_BACKFLOW：有 delta 是方向级的——当前的形态下细估与粗估的差不是细节能解释的，`
  + `   必须回到 direction 重定。用这个裁决时在 directionLevelFindings 里逐条写明动摇了哪条假设。\n`
  + `  D_GATE_PROPOSAL：证据已足够，建议送 D-Gate 评审。\n`
  + `注意：你不判本格是否通过——门控结论不由 agent 给出；你只给裁决。`,
  {label: 'architect', phase: 'Delta attribution', effort: 'high', schema: ATTRIBUTION_SCHEMA})

if (!attribution) {
  return {
    stage: STAGE, runId: RUN_ID, verdict: 'BLOCKED_CONFIG',
    reason: '归因裁决未返回；delta 无法归位',
    nextActions: ['重跑 architect 归因步；若产物缺字段，先补产物'],
    files: [],
  }
}

// 裁决枚举由 workflow 消费。方向回流是终止性的：B4 之后就是 A0，
// 拿着一个方向级矛盾进入收敛，收敛出来的会是一份建立在错前提上的结论。
if (attribution.verdict === 'DIRECTION_BACKFLOW') {
  return {
    stage: STAGE, runId: RUN_ID, verdict: 'DIRECTION_BACKFLOW',
    reason: `B4 归因裁决报方向回流：${(attribution.directionLevelFindings || []).map((f) => `${f.subject}(${f.description})`).join('；') || '未说明'}；未落盘`,
    nextActions: ['把 architect 的方向级发现交给 A0（design.converge）重定方向；本格结论不落盘'],
    directionLevelFindings: attribution.directionLevelFindings || [],
    // 归因结果仍然回传：即使本格不落盘，下一轮重定方向时它是输入。
    deltaBySlot: [...deltaBySlot.values()],
    files: [],
  }
}

// 仍归不了因的 delta：本格的验收点正是"delta 有归因"，
// 因此它是 DELTA_UNEXPLAINED 而不是"落盘 + 标注一下"。
// integrator 的裁决枚举里有 DELTA_UNEXPLAINED 这个取值，就是为它准备的。
const stillUnexplained = attribution.unexplained || []

phase('Independent verification')

// verifier 只拿落盘产物。给它 agent 的申报散文，它就会去验证叙述的
// 自洽性，而不是验证产物的可回放性——那正是 B4 需要被独立看的地方。
const artifactDraft = {
  schemaVersion: 'design-detail-integrate-v0.1',
  stage: STAGE, runId: RUN_ID, sourceCommit: BRIEF.sourceCommit,
  detailRunArtifact: DETAIL_RUN_ARTIFACT,
  observationArtifact: OBSERVATION_ARTIFACT,
  directionArtifact: DIRECTION_ARTIFACT,
  registerArtifact: REGISTER_ARTIFACT,
  observationCount: merged.slots.length,
  slots: merged.slots,
  deltaBySlot: [...deltaBySlot.values()],
  singleHardwareSpec: merged.singleHardwareSpec,
  physicalProfiles,
  attributions: [
    ...(merged.attributions || []).map((a) => ({...a, source: 'integrator'})),
    ...(attribution.attributions || []).map((a) => ({...a, source: 'architect'})),
  ],
  unexplained: stillUnexplained,
  rejectedOptions: merged.rejectedOptions || [],
  verdict: stillUnexplained.length ? 'DELTA_UNEXPLAINED' : 'INTEGRATION_OK',
}

const verification = await agent(
  `${head('verifier')}\n\n`
  + `拟落盘的细化合并产物（这是你要验证的对象；你**不**看任何 agent 的申报过程）：\n`
  + `${JSON.stringify(artifactDraft, null, 2)}\n\n`
  + `源产物（只读）：\n`
  + `  细化产物：${DETAIL_RUN_ARTIFACT}\n`
  + `  观察矩阵：${OBSERVATION_ARTIFACT}\n`
  + `  方向记分卡：${DIRECTION_ARTIFACT}\n`
  + `  候选寄存器：${REGISTER_ARTIFACT}\n\n`
  + `任务：对这份产物做独立验证，逐项给出 pass/fail 与裸值：\n`
  + `  1. schema：字段齐备性与取值域（观察状态必须落在 ${OBSERVATION_STATES.join(' / ')} 内）。\n`
  + `  2. 守恒：18 位是否恰好覆盖 ${OBSERVATION_COUNT} 个组合；有没有多出或重复的位。\n`
  + `  3. provenance：粗估与细估的数是否真的能在源产物里找到，字段是否对得上。\n`
  + `  4. golden trace：抽查若干位的和 —— 粗估与细估的 delta 百分比能否由两个裸值重算出来`
  + `     （重算结果必须与产物里的 deltaPct 一致）。\n`
  + `  5. 可回放性：同一个 runId 下，重跑能否得到同一组裸值。\n`
  + `任一项不合，给出具体的文件与字段。\n`
  + `全部通过写 VERIFIED，任一不通过写 VERIFY_FAILED。`,
  {label: 'verifier', phase: 'Independent verification', effort: 'high', schema: VERIFY_SCHEMA})

const okVerified = verification && verification.verdict === 'VERIFIED'

phase('Invariant check')

const check = await agent(
  `${head('invariant-checker')}\n\n`
  + `细化产物（只读）：${DETAIL_RUN_ARTIFACT}\n`
  + `观察矩阵（只读）：${OBSERVATION_ARTIFACT}\n`
  + `候选寄存器（只读）：${REGISTER_ARTIFACT}\n`
  + `拟落盘的合并产物：\n${JSON.stringify(artifactDraft, null, 2)}\n`
  + `architect 的裁决：\n${JSON.stringify(attribution, null, 2)}\n`
  + `verifier 的结论：\n${JSON.stringify(verification, null, 2)}\n\n`
  + `任务：对这份产物做全局不变量检点，逐条给出 pass/fail 与裸值：\n`
  + `7-reticle 面积守恒、单一硬件规格（ADR-0021）、MC320/MC640 分离、peak 与 sustained 分离、`
  + `单位一致、证据等级齐全。B4 还要专门核本格的四条：\n`
  + `  (a) 18 个观察位（${OBSERVATION_MODELS.length} 模型 × ${OBSERVATION_TP.join('/')} × ${OBSERVATION_MC.join('/')}）齐备；\n`
  + `  (b) **单一硬件规格**：18 位是不是真的来自同一份 ADR-0021 规格，物理档位集合 `
  + `      ${physicalProfiles.join(', ')} 是否与候选寄存器里的正式选中候选一致；\n`
  + `  (c) 每一个非零的粗估-细估 delta 都有归因，且归因指到了具体拆分项`
  + `      （"综合因素"类措辞不算归因）；\n`
  + `  (d) 观察状态没有把 PENDING_MODEL_RUN 当成已观测。\n`
  + `另外核一条：architect 的裁决与它给出的归因是否自洽——`
  + `判了 ARCH_FREEZE 却留着未归因的 delta，这两件事不能同时成立。\n`
  + `违规项必须给出违反的具体文件与字段。\n`
  + `不得把违规项解释掉（解释权归 architect）；不得以文档措辞为依据，只以数值和来源为依据。\n`
  + `全部通过写 INVARIANT_OK，任一不通过写 INVARIANT_VIOLATED。`,
  {label: 'invariant-checker', phase: 'Invariant check', effort: 'high', schema: CHECK_SCHEMA})

const okInvariants = check && check.verdict === 'INVARIANT_OK'
// 三件都成立才落盘：检点通过、独立验证通过、delta 全部归因。
// 任何一件不成立，本格以对应的终局收场，不落盘。
const ok = okInvariants && okVerified && stillUnexplained.length === 0

const ledgerPatch = {
  currentStage: STAGE,
  strategyVersions: {
    integrator: '1.0', architect: '1.0', verifier: '1.0', 'invariant-checker': '1.0',
  },
  rejectedOptions: (merged.rejectedOptions || []).map((r) => ({
    stage: STAGE, optionId: r.optionId, reason: r.reason, rejectedBy: r.rejectedBy,
  })),
  openBlockers: stillUnexplained.map((k, i) => ({
    id: `DELTA-${String(i + 1).padStart(2, '0')}`,
    owner: 'architect',
    unblockCondition: `${k}: 粗估与细估的差需要归到具体拆分项或口径差`,
  })),
}

const runRecord = {
  schemaVersion: 'design-run-record-v0.1',
  stage: STAGE,
  runId: RUN_ID,
  sourceCommit: BRIEF.sourceCommit,
  detailRunArtifact: DETAIL_RUN_ARTIFACT,
  observationArtifact: OBSERVATION_ARTIFACT,
  directionArtifact: DIRECTION_ARTIFACT,
  registerArtifact: REGISTER_ARTIFACT,
  stageCommand: STAGE_COMMAND_FOR_RECORD,
  observationCount: merged.slots.length,
  expectedObservationCount: OBSERVATION_COUNT,
  observationStates: Object.fromEntries(
    OBSERVATION_STATES.map((s) => [s, merged.slots.filter((x) => x.status === s).length])),
  singleHardwareSpec: merged.singleHardwareSpec,
  physicalProfiles: physicalProfiles.slice().sort(),
  deltaBySlot: [...deltaBySlot.values()],
  nonzeroDeltaCount: nonzeroDelta.length,
  attributedCount: attributedKeys.size,
  unexplainedCount: stillUnexplained.length,
  architectVerdict: attribution.verdict,
  verifierVerdict: verification ? verification.verdict : 'UNVERIFIED',
  declarants: ['integrator', 'architect', 'verifier', 'invariant-checker'],
  caliber: 'delta 百分比由 workflow 对两个裸值做减法得出，不由任何 agent 产生；'
    + 'TPS 裸值一律取自 stage_b.js 与 Stage A 的产物',
}

return {
  stage: STAGE,
  runId: RUN_ID,
  verdict: ok
    ? 'INTEGRATION_OK'
    : (stillUnexplained.length ? 'DELTA_UNEXPLAINED'
      : (!okVerified ? 'VERIFY_FAILED' : 'INVARIANT_VIOLATED')),
  slots: ok ? merged.slots : null,
  deltaBySlot: [...deltaBySlot.values()],
  attributions: artifactDraft.attributions,
  unexplained: stillUnexplained,
  architectVerdict: attribution.verdict,
  violations: okInvariants ? [] : ((check && check.violations) || ['检点未完成']),
  verifyFailures: okVerified ? [] : ((verification && verification.failures) || ['独立验证未完成']),
  nextActions: ok ? [] : [
    ...stillUnexplained.map((k) => `${k}: 归因粗估-细估的差，或交 architect 重定方向`),
    ...(!okVerified && verification ? (verification.failures || []).map((f) => `修 ${f.check}：${f.file}#${f.field}`) : []),
  ],
  ledgerPatch,
  runRecord,
  files: ok ? [
    {
      path: `${REPO}/out/detailed/detail_integrate.json`,
      content: JSON.stringify(artifactDraft, null, 2) + '\n',
    },
    {
      path: `${REPO}/out/detailed/detail_integrate_run_record.json`,
      content: JSON.stringify(runRecord, null, 2) + '\n',
    },
  ] : [],
}
