export const meta = {
  name: 'design-dgate',
  description: 'K3 设计 dgate 阶段：8 条 D-Gate 门槛各一个独立 gate-keeper 实例核验证据，architect 汇总证据包，invariant-checker 检点后落盘；门控结论由 evaluate_gates.js 计算，本 workflow 不判、不写字面量',
  whenToUse: 'B 组。需要 args.brief（stage=dgate 的 DesignBrief）、args.gateStatusArtifact（主循环已用 evaluate_gates.js 算好的门控结论）与 args.scorecardArtifact。本 workflow 不判门控、不写文件。',
  phases: [
    { title: 'Threshold evidence', detail: '8 条门槛各一个独立 gate-keeper 实例核验证据与 blocker' },
    { title: 'Evidence assembly', detail: 'architect 汇总证据包；结论引用脚本，不自行判定' },
    { title: 'Invariant check', detail: 'invariant-checker 强制检点；不通过则不落盘' },
  ],
}

// ---------------------------------------------------------------------------
// B 组 dgate。要回答的唯一问题是"候选能否进细化"。
//
// 这个 workflow 的全部意义在于**不产生门控结论**。
// 门控由 integration/governance/evaluate_gates.js#evaluateDirectionGate 计算：
// 它重算 8 项检查（areaConservation / threeModelComparable / bottleneckClassification /
// sensitivitySweep / candidateCountLe3 / formalSelectionRecorded / selectionResolvable /
// selectionMeetsTarget），得出 decision 与期望的 register 状态。
//
// 因此：
//   * 8 个 gate-keeper 实例**逐条**核验门槛**证据**，产出 GATE_EVIDENCE_COMPLETE 或 GATE_BLOCKED；
//     它们不产出 decision，也不产出 PASS——roster 与 AGENTS.md §2 都明文禁止这个字面量。
//   * architect 汇总的是证据包，结论字段直接引用脚本产物；
//     它不重算、不覆盖、不"根据证据推断门控应该通过"。
//   * 8 条门槛来自 teams/council/docs/17_TWO_STAGE_ARCHITECTURE_OPERATING_MODEL.md §4.4，
//     与脚本里的 8 项检查**不是**同一个坐标——门槛是人在文档里写的验收条件，
//     检查是脚本算的布尔量。两者必须都齐全，但只有后者决定 decision。
//     这个区别是本 workflow 的核心：agent 能核验"证据齐不齐"，不能核验"算不算通过"。
//
// 与 C 组骨架相同的点：末步是检点、裁决枚举由 workflow 消费、检点不过不落盘。
// 不同的点：没有搜索、没有候选枚举——输入是已经算好的门控结论。
// ---------------------------------------------------------------------------

const REPO = args.repo || '.'
const STAGE = 'dgate'
const BRIEF = args.brief
const RUN_ID = args.runId || 'dgate-run'
// 门槛条数固定为 8（17 号文档 §4.4）。它必须是常量而不是从产物里读——
// 用产物里的条数去决定开几个实例，等于让被测数据决定被测范围。
const THRESHOLDS = args.thresholds || 8
// 门控结论由主循环调用 evaluate_gates.js 算好，路径经 args 传入。
// 本 workflow 不接收命令、不让 agent 执行命令：脚本会写 out/，而 agent 全程只读。
const GATE_STATUS_ARTIFACT = args.gateStatusArtifact
const SCORECARD_ARTIFACT = args.scorecardArtifact
const ENVELOPE_ARTIFACT = args.envelopeArtifact
const GATE_COMMAND_FOR_RECORD = args.gateCommand || 'UNVERIFIED'

if (!BRIEF) throw new Error('design.dgate 需要 args.brief（intake 阶段产出的 DesignBrief）')
if (!GATE_STATUS_ARTIFACT) {
  throw new Error('design.dgate 需要 args.gateStatusArtifact（已由主循环用 integration/governance/evaluate_gates.js 算好的门控结论）；本 workflow 不判门控')
}
if (!SCORECARD_ARTIFACT) {
  throw new Error('design.dgate 需要 args.scorecardArtifact（stage_a.js 的打分卡）；没有它 8 条门槛无从核验')
}
if (BRIEF.stage !== 'dgate') {
  // brief 的 stage 与 workflow 名称必须一致，否则会把别的阶段的契约拿来用
  throw new Error(`brief.stage=${BRIEF.stage}，与 design.dgate 不符；契约串了`)
}

const HEAD = [
  `仓库根目录：${REPO}`,
  `本 workflow：design.dgate（stage=${STAGE}，runId=${RUN_ID}）`,
  `你是一个策略实例。先读你的策略正文：${REPO}/teams/council/strategies/__AGENT__.md`,
  '那份文件是本角色的判断规则、正确性判据、证据规则、取舍规则与禁止事项，逐条遵守。',
  '以下运行时上下文由 workflow 注入；注入内容与策略正文冲突时，注入内容优先（它承载本 stage 的事实）。',
  '你没有文件系统写权限。把该写的东西作为返回值交回，由 workflow 落盘。',
  '所有数字必须带出处（文件路径:行号 或 ADR 编号）；没有出处的写 UNVERIFIED 并说明缺什么，不得静默补齐。',
  '不得输出 TPS/usr 或任何全局性能指标；不得输出 PASS / D_GATE_PASSED 字面量。',
].join('\n')

// 领域知识注入（知识不是证据）—— 见 design.compute 里的同名说明。
// 这一格按门槛领域给对应专家注入：8 条门槛各自问的是哪个域，就给哪个域的参照系。
// gate-keeper 不注入——它核的是证据完备性，不是取值是否偏离常规。
const KNOWLEDGE = {
  'memory-expert': 'references/sota/memory-subsystem.md',
  'comm-expert': 'references/sota/interconnect-collective.md',
  'compute-expert': 'references/sota/compute-core.md',
  'model-expert': 'references/sota/model-workload.md',
  'physical-expert': 'references/sota/package-ppa.md',
}
const knowledgeHead = (agentId) => {
  const p = KNOWLEDGE[agentId]
  if (!p) return []
  return [
    `本领域的行业参照（**知识，不是证据**）：${REPO}/${p}`,
    '它用来判断本项目的假设是否偏离行业常规、值不值得花力气去要实测数据，不能证明本项目任何数字。',
    '它没有仓库出处：不得作为任何 claim 的 evidence，不得覆盖、修正或重算仓库里的任何基线数字；有冲突时以仓库文件为准。',
    '若该文件不存在或读不到，跳过这一段按没有参照系继续——不要凭印象补出"行业通常怎么做"。',
  ]
}
const head = (agentId) => [HEAD.replace('__AGENT__', agentId), ...knowledgeHead(agentId)].join('\n')

const BRIEF_JSON = JSON.stringify(BRIEF, null, 2)

// 17 号文档 §4.4 的 8 条 D-Gate 门槛。门槛**正文**必须由 workflow 注入，
// 不能写进策略正文——策略是跨 stage 复用的，把某一条门槛写死进 gate-keeper 策略
// 会让它换个 stage 就带着别人的门槛去核验。
const D_GATE_THRESHOLDS = [
  {id: 'DG-1', requirement: '7-reticle area 守恒'},
  {id: 'DG-2', requirement: '计算 die、MC、PHY、interposer、thermal 都有预算'},
  {id: 'DG-3', requirement: '三模型均能生成粗略 TPS，不允许只优化 K3'},
  {id: 'DG-4', requirement: '每个候选有明确 bottleneck'},
  {id: 'DG-5', requirement: '至少一个候选在 baseline 资源下达标，或已形成明确的带宽/通信/算力替代方案'},
  {id: 'DG-6', requirement: '所有结论标明 E0/E1 证据等级'},
  {id: 'DG-7', requirement: '完成 top-10 sensitivity sweep'},
  {id: 'DG-8', requirement: '选出不超过 3 个候选进入 Stage B'},
]

if (THRESHOLDS !== D_GATE_THRESHOLDS.length) {
  // 门槛条数变了，8 个实例与 17 号文档就对不上了。宁可抛错也不静默跑少几条。
  throw new Error(`design.dgate 的门槛条数=${THRESHOLDS}，与 17 号文档 §4.4 的 ${D_GATE_THRESHOLDS.length} 条不符；先对齐文档再跑`)
}

// 单条门槛的核验结果。与 evaluate_gates.js 的检查项**不是**同一个坐标：
// 这里核验的是"证据在不在、出处能不能引"，脚本算的是"条件成不成立"。
const THRESHOLD_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['thresholdId', 'requirement', 'status', 'evidenceLevel', 'evidence', 'blocker', 'verdict'],
  properties: {
    thresholdId: { type: 'string', description: '就是这个门槛的 id，不得改写' },
    requirement: { type: 'string', description: '这条门槛要求什么；照抄注入的正文' },
    status: { type: 'string', enum: ['evidence_complete', 'blocked'], description: '证据齐了还是被挡住了，二选一' },
    evidenceLevel: { type: 'string', enum: ['E0', 'E1', 'E2', 'E3', 'UNVERIFIED'] },
    evidence: {
      type: 'array',
      description: '支撑本条门槛的证据，逐条带出处；引用不到就留空并说明，不得留一条没有出处的记录',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['locator', 'value'],
        properties: {
          locator: { type: 'string', description: '文件路径:行号 或 ADR 编号；必须是机器可读的定位，不是文档叙述' },
          value: { type: 'string', description: '那一处的裸值' },
        },
      },
    },
    blocker: {
      type: 'object',
      additionalProperties: false,
      required: ['id', 'owner', 'unblockCondition'],
      properties: {
        id: { type: 'string' },
        owner: { type: 'string' },
        unblockCondition: { type: 'string', description: '解除它需要什么；不确定写 UNVERIFIED' },
      },
      description: 'status=blocked 时必填，且每条门槛必须有 owner 与 unblockCondition；evidence_complete 时填 null',
    },
    verdict: { type: 'string', enum: ['GATE_EVIDENCE_COMPLETE', 'GATE_BLOCKED'] },
  },
}

// 证据包。architect 汇总，结论**引用**脚本。
const PACKAGE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['thresholds', 'gateDecision', 'gateDecisionSource', 'registerConsistent', 'unresolved', 'verdict'],
  properties: {
    thresholds: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['thresholdId', 'status', 'evidenceLevel', 'blockerId'],
        properties: {
          thresholdId: { type: 'string' },
          status: { type: 'string', enum: ['evidence_complete', 'blocked'] },
          evidenceLevel: { type: 'string' },
          blockerId: { type: 'string', description: '对应 blocker 的 id；无则写 none' },
        },
      },
    },
    gateDecision: {
      type: 'string',
      description: '直接抄脚本算出来的 decision 原文，不得改写、不得推断。抄不到就写 UNVERIFIED',
    },
    gateDecisionSource: {
      type: 'string',
      description: '结论的出处，必须是 integration/governance/evaluate_gates.js#evaluateDirectionGate 及其产物路径',
    },
    registerConsistent: {
      type: 'boolean',
      description: '脚本报告的 registerConsistent 原值；不得自行重算',
    },
    unresolved: {
      type: 'array',
      items: { type: 'string' },
      description: '仍然悬空、无法归入任何一条门槛的问题；没有就给空数组',
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

phase('Threshold evidence')

// 8 个**独立实例**，一个门槛一个。不是 8 个 agent 分工查同一件事：
// 每条门槛的核验互不依赖，合并会让一条的宽松传染给另一条
// （roster：`gate-keeper`×8（独立实例））。
const thresholdChecks = (await parallel(D_GATE_THRESHOLDS.map((t) => () => agent(
  `${head('gate-keeper')}\n\n`
  + `brief：\n${BRIEF_JSON}\n\n`
  + `方向包络（只读）：${ENVELOPE_ARTIFACT}\n`
  + `打分卡（只读）：${SCORECARD_ARTIFACT}\n\n`
  + `你本次**只负责一条**门槛：\n`
  + `  id：${t.id}\n`
  + `  要求：${t.requirement}\n\n`
  + `任务：核验这一条的**证据**，不核验它成不成立、更不核验整体门控。\n`
  + `1. 找出支撑它的证据，逐条给机器可读的定位（文件路径:行号 或 ADR 编号）与那一处的裸值。\n`
  + `2. 引用不到就写 status=blocked，并给出 blocker（id / owner / unblockCondition）。\n`
  + `   每条门槛必须有 owner 与 unblockCondition，不得留空。\n`
  + `3. 证据等级按出处判定；出处缺失的写 UNVERIFIED。\n`
  + `**你不判 PASS**：门控结论由 integration/governance/evaluate_gates.js 计算。\n`
  + `你的裁决只有"这条的证据齐了"或"这条被 blocker 挡住"两种。\n`
  + `证据不足与进度冲突时，证据不足优先，记为 blocker 而不是放行。\n`
  + `不得以文档叙述代替机器可读证据；不得修改被测数据或结论；不得输出 TPS/usr。`,
  {label: `threshold:${t.id}`, phase: 'Threshold evidence', effort: 'high', schema: THRESHOLD_SCHEMA})
))).filter(Boolean)

if (thresholdChecks.length < D_GATE_THRESHOLDS.length) {
  const missing = D_GATE_THRESHOLDS.filter((t) => !thresholdChecks.some((c) => c.thresholdId === t.id)).map((t) => t.id)
  return {
    stage: STAGE, runId: RUN_ID, verdict: 'BLOCKED_CONFIG',
    reason: `门槛核验不完整，缺：${missing.join(', ')}；不落盘`,
    absentThresholds: missing,
    files: [],
  }
}

phase('Evidence assembly')

// architect 汇总。它**不重算**门控——结论字段是脚本产物里的原文。
// 让汇总者"根据证据推断门控应该通过"就是把 evaluator 架空，
// 而 evaluator 存在的全部理由就是没人能靠证据堆推断出结论。
const packed = await agent(
  `${head('architect')}\n\n`
  + `brief：\n${BRIEF_JSON}\n\n`
  + `门控结论产物（只读，由 evaluate_gates.js 算出）：${GATE_STATUS_ARTIFACT}\n`
  + `打分卡（只读）：${SCORECARD_ARTIFACT}\n`
  + `8 条门槛各自的核验结果：\n${JSON.stringify(thresholdChecks, null, 2)}\n\n`
  + `任务：汇总成一份证据包。规则：\n`
  + `1. gateDecision **照抄**门控结论产物里的 decision 原文，不得改写、不得推断、`
  + `   不得因"8 条证据都齐"就把它写成通过。抄不到就写 UNVERIFIED。\n`
  + `2. gateDecisionSource 写 integration/governance/evaluate_gates.js#evaluateDirectionGate 与产物路径。\n`
  + `3. registerConsistent 照抄产物里的原值，不得自行重算。\n`
  + `4. 无主的悬空问题进 unresolved，不得为了收口而塞进某条门槛。\n`
  + `8 条门槛证据都齐写 GATE_EVIDENCE_COMPLETE；任一条被 blocker 挡住写 GATE_BLOCKED。`
  + `注意：这个裁决说的是**证据**，不是门控结论本身。`,
  {label: 'architect', phase: 'Evidence assembly', effort: 'high', schema: PACKAGE_SCHEMA})

if (!packed) {
  return {
    stage: STAGE, runId: RUN_ID, verdict: 'BLOCKED_CONFIG',
    reason: '证据包未产出；不落盘',
    files: [],
  }
}

phase('Invariant check')

// 末步是检点，不是总结。这一步专门查一件最容易出错的事：
// 汇总出来的证据包里有没有混进一个自行判定的门控结论。
// 那正是本次重构要防的"以总结代替核验"的变体——不是编造数字，是编造结论。
const check = await agent(
  `${head('invariant-checker')}\n\n`
  + `门控结论产物（只读）：${GATE_STATUS_ARTIFACT}\n`
  + `8 条门槛的核验：\n${JSON.stringify(thresholdChecks, null, 2)}\n`
  + `architect 的证据包：\n${JSON.stringify(packed, null, 2)}\n\n`
  + `任务：对这份证据包做全局不变量检点，逐条给出 pass/fail 与裸值：\n`
  + `7-reticle 面积守恒、单一硬件规格（ADR-0021）、MC320/MC640 分离、peak 与 sustained 分离、`
  + `单位一致、证据等级齐全。违规项必须给出违反的具体文件与字段。\n`
  + `此外必须专门核验两件事，它们不是普通不变量：\n`
  + `  (a) 证据包里的 gateDecision 与门控结论产物里的 decision **逐字一致**；`
  + `      不一致即为违规，无论哪个看起来更合理。\n`
  + `  (b) 证据包与 8 条核验里不得出现自行判定的门控结论（任何形式的 PASS / D_GATE_PASSED 字面量）。\n`
  + `不得把违规项解释掉（解释权归 architect）；不得以文档措辞为依据，只以数值和来源为依据。\n`
  + `全部通过写 INVARIANT_OK，任一不通过写 INVARIANT_VIOLATED。`,
  {label: 'invariant-checker', phase: 'Invariant check', effort: 'high', schema: CHECK_SCHEMA})

const okInvariants = check && check.verdict === 'INVARIANT_OK'

// 裁决枚举由 workflow 消费。gateDecision 原样透传——workflow 不解释它，
// 只负责把它和证据包一起交回主循环落盘。
const ledgerPatch = {
  currentStage: STAGE,
  strategyVersions: {'gate-keeper': '1.0', architect: '1.0', 'invariant-checker': '1.0'},
  // 被挡住的门槛就是本阶段的"被否选项"：不记下来，重跑会重新发明同一个 blocker。
  rejectedOptions: thresholdChecks
    .filter((t) => t.status === 'blocked')
    .map((t) => ({
      stage: STAGE, optionId: t.thresholdId,
      reason: t.blocker ? `${t.blocker.owner}: ${t.blocker.unblockCondition}` : '证据不足',
      rejectedBy: 'gate-keeper',
    })),
  openBlockers: [
    ...thresholdChecks.filter((t) => t.blocker).map((t) => ({
      id: t.blocker.id, owner: t.blocker.owner, unblockCondition: t.blocker.unblockCondition,
    })),
    ...(packed.unresolved || []).map((u, i) => ({
      id: `DGATE-UNRESOLVED-${String(i + 1).padStart(2, '0')}`,
      owner: 'architect', unblockCondition: u,
    })),
  ],
}

const runRecord = {
  schemaVersion: 'design-run-record-v0.1',
  stage: STAGE,
  runId: RUN_ID,
  sourceCommit: BRIEF.sourceCommit,
  gateStatusArtifact: GATE_STATUS_ARTIFACT,
  scorecardArtifact: SCORECARD_ARTIFACT,
  envelopeArtifact: ENVELOPE_ARTIFACT,
  gateCommand: GATE_COMMAND_FOR_RECORD,
  thresholdsChecked: thresholdChecks.map((t) => t.thresholdId).sort(),
  evidenceCompleteCount: thresholdChecks.filter((t) => t.status === 'evidence_complete').length,
  blockedCount: thresholdChecks.filter((t) => t.status === 'blocked').length,
  caliber: '门控结论取自 integration/governance/evaluate_gates.js 的产物，workflow 与任何 agent 均不判定；本阶段只汇总门槛证据',
}

return {
  stage: STAGE,
  runId: RUN_ID,
  verdict: okInvariants ? packed.verdict : 'INVARIANT_VIOLATED',
  evidencePackage: okInvariants ? packed : null,
  rejectedPackage: okInvariants ? null : packed,
  violations: okInvariants ? [] : (check && check.violations) || ['检点未完成'],
  gateDecision: packed.gateDecision,
  ledgerPatch,
  runRecord,
  files: okInvariants ? [
    {
      path: `${REPO}/out/governance/${STAGE}_evidence_package.json`,
      content: JSON.stringify({
        schemaVersion: 'design-dgate-evidence-package-v0.1',
        stage: STAGE, runId: RUN_ID, sourceCommit: BRIEF.sourceCommit,
        gateStatusArtifact: GATE_STATUS_ARTIFACT,
        gateDecision: packed.gateDecision,
        gateDecisionSource: packed.gateDecisionSource,
        registerConsistent: packed.registerConsistent,
        thresholds: packed.thresholds,
        unresolved: packed.unresolved || [],
      }, null, 2) + '\n',
    },
    {
      path: `${REPO}/out/governance/${STAGE}_run_record.json`,
      content: JSON.stringify(runRecord, null, 2) + '\n',
    },
  ] : [],
}
