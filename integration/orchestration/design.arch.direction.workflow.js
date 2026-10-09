export const meta = {
  name: 'design-arch-direction',
  description: 'K3 设计 arch.direction 阶段：形态宏参数候选各一 agent 独立评估，integrator 合并，framing-critic 对抗式审查框架，单个 gate-keeper 一次核完 8 条 D-Gate 门槛证据，architect 汇总证据包，invariant-checker 检点后落盘；门控结论只由 evaluate_gates.js 计算',
  whenToUse: 'B 组唯一一格。需要 args.brief（stage=arch.direction 的 DesignBrief）、args.envelopeArtifact 与 args.scorecardArtifact（主循环已用 stage_a.js 生成好的方向包络与打分卡）、args.gateStatusArtifact（evaluate_gates.js 算好的门控结论）与 args.l2Budget（stage_a.js 算好的 L2 预算合同骨架）。本 workflow 不跑搜索、不判门控、不写文件。',
  phases: [
    { title: 'Candidate evaluation', detail: '形态宏参数候选各一 agent 独立评估，互相看不见' },
    { title: 'Convergence', detail: 'integrator 合并候选、记录冲突与排除依据' },
    { title: 'Framing review', detail: 'framing-critic 对抗式审查：约束完整吗、口径对吗、形态空间是不是被写窄了' },
    { title: 'Gate evidence', detail: '一个 gate-keeper 一次核完 8 条门槛的证据与 blocker；不判结论' },
    { title: 'Evidence assembly', detail: 'architect 汇总证据包；门控结论照抄脚本产物，不自行判定' },
    { title: 'Invariant check', detail: 'invariant-checker 强制检点；不通过则不落盘' },
  ],
}

// ---------------------------------------------------------------------------
// B 组 arch.direction。要回答的唯一问题是"走哪条路线、它能不能进细化"。
//
// 这一格是旧 design.direction 与 design.dgate 的合并体。拆成两格曾经的理由是
// "路线选择"与"门控放行"是两件事；但两格读的是同一份打分卡、同一份包络，
// 第二格除了把第一格刚核过的门槛再核一遍之外没有新输入——于是"两格"只是把
// 同一批证据分两次走一遍，还要靠 brief 的 stage 字段把它们接起来。
// 合并之后：路线与门控在一格里闭合，门槛证据只核一次。
//
// 与 C 组骨架的关键区别：候选是**架构路线的形态宏参数**（L/H 算力配比、片上 SRAM
// 总量与 local/shared 切分、MC 档位、die 数、TP），不是某个域的设计空间取值。
// 因此这里没有"搜索策略 → 确定性搜索"两步——搜索由 stage_a.js 在主循环侧跑完，
// 候选集、包络与 L2 预算骨架作为产物传进来，本 workflow 只做评估、收敛与核验。
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
//           integration/governance/evaluate_gates.js#evaluateDirectionGate 算好，
//           本文件与任何 agent 都不得写 PASS / D_GATE_PASSED 字面量。
//
// 收敛口径（验收判据）：6–12 候选收敛到 **≤3**。这不是风格选择——
// evaluate_gates.js 的 candidateCountLe3 检查就是 ≤3（超出即 BLOCKED_TOO_MANY_CANDIDATES），
// stage_a.js 的 selectCandidates 也是"至多三个正式候选 + 一个 MC320 非正式参照"。
// 所以候选 agent 的产出是**评估意见**，收敛是数据（selectCandidates 的结果 + integrator 的取舍记录），
// 不是让某个 agent 自己挑三个。
//
// 门槛核验为什么只开**一个** gate-keeper 实例：
// 8 条门槛读的是同一份打分卡与同一份包络，彼此之间没有信息屏障要维护
// （候选评估要互相看不见，是因为看得见就会对齐措辞；门槛核验没有这个问题——
// 一条门槛的证据齐不齐，不会因为知道另一条的结论而改变）。开 8 个实例换来的
// 不是独立性，是同一份产物被读 8 遍，以及"8 条之间的交叉引用没人负责"这个缺口。
// 收成一个实例、输出逐条数组，交叉引用就落在同一个实例里，而每条仍必须各自给
// status / evidenceLevel / evidence / blocker，宽松不会从一条传染到另一条。
// ---------------------------------------------------------------------------

const REPO = args.repo || '.'
const STAGE = 'arch.direction'
const BRIEF = args.brief
const RUN_ID = args.runId || 'arch-direction-run'
const MAX_CANDIDATES = args.maxCandidates || 12
// 门槛条数固定为 8（17 号文档 §4.4）。它必须是常量而不是从产物里读——
// 用产物里的条数去决定核几条，等于让被测数据决定被测范围。
const THRESHOLDS = args.thresholds || 8
// 方向包络、打分卡与 L2 预算骨架由主循环用 stage_a.js 生成（它读 out/workload/ 与 teams/ 下的规格文件）；
// 门控结论由主循环调用 evaluate_gates.js 算好。
// 本 workflow 不接收命令、不让 agent 执行命令：脚本写 out/，而 workflow agent 全程只读。
const ENVELOPE_ARTIFACT = args.envelopeArtifact
const SCORECARD_ARTIFACT = args.scorecardArtifact
const GATE_STATUS_ARTIFACT = args.gateStatusArtifact
const L2_BUDGET_ARTIFACT = args.l2BudgetArtifact
// L2 预算合同骨架：形态宏参数候选逐条对照 L1 合同算出来的"满足 / 差多少"。
// 它是**数据**，由 stage_a.js 算；本 workflow 只给它加归属标注再落盘，不改任何数字。
const L2_BUDGET = args.l2Budget || null
const DIRECTION_COMMAND_FOR_RECORD = args.directionCommand || 'UNVERIFIED'

if (!BRIEF) throw new Error('design.arch.direction 需要 args.brief（intake 阶段产出的 DesignBrief）')
if (!ENVELOPE_ARTIFACT || !SCORECARD_ARTIFACT) {
  throw new Error('design.arch.direction 需要 args.envelopeArtifact 与 args.scorecardArtifact（已由主循环用 stage_a.js 生成）；本 workflow 不跑搜索')
}
if (!GATE_STATUS_ARTIFACT) {
  throw new Error('design.arch.direction 需要 args.gateStatusArtifact（已由主循环用 integration/governance/evaluate_gates.js 算好的门控结论）；本 workflow 不判门控')
}
if (BRIEF.stage !== STAGE) {
  // brief 的 stage 与 workflow 名称必须一致，否则会把别的阶段的契约拿来用
  throw new Error(`brief.stage=${BRIEF.stage}，与 design.arch.direction 不符；契约串了`)
}

const HEAD = [
  `仓库根目录：${REPO}`,
  `本 workflow：design.arch.direction（stage=${STAGE}，runId=${RUN_ID}）`,
  `你是一个策略实例。先读你的策略正文：${REPO}/teams/council/strategies/__AGENT__.md`,
  '那份文件是本角色的判断规则、正确性判据、证据规则、取舍规则与禁止事项，逐条遵守。',
  '以下运行时上下文由 workflow 注入；注入内容与策略正文冲突时，注入内容优先（它承载本 stage 的事实）。',
  '你没有文件系统写权限。把该写的东西作为返回值交回，由 workflow 落盘。',
  '所有数字必须带出处（文件路径:行号 或 ADR 编号）；没有出处的写 UNVERIFIED 并说明缺什么，不得静默补齐。',
  '不得输出 TPS/usr 或任何全局性能指标；不得输出 PASS / D_GATE_PASSED 字面量。',
].join('\n')

// 领域知识注入（知识不是证据）—— 见 design.compute 里的同名说明。
// architect 注入 sustained-tps：方向级粗估最容易被"行业上大概是这个口径"带偏，
// 而 TPS/usr 的定义分歧正是那一单元要讲清楚的事。
// gate-keeper 不注入——它核的是证据完备性，不是取值是否偏离常规。
const KNOWLEDGE = {
  architect: 'references/sota/sustained-tps.md',
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
  // 门槛条数变了，注入的正文与 17 号文档就对不上了。宁可抛错也不静默少核几条。
  throw new Error(`design.arch.direction 的门槛条数=${THRESHOLDS}，与 17 号文档 §4.4 的 ${D_GATE_THRESHOLDS.length} 条不符；先对齐文档再跑`)
}

// 候选评估。候选 agent 拿到的是**一个**形态候选的裸值，产出的是这个候选的
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
      description: '本域答不了、必须交给 framing-critic 的问题（约束是否完整、口径是否正确、形态空间是否被写窄）',
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

// 门槛核验。一个 gate-keeper 实例一次核完 8 条，**逐条**给证据等级或 blocker，**不判结论**。
// 逐条数组是这里唯一允许的形状：给一个总体 status 就等于把 8 条合成 1 条，
// 一条的宽松会传染给其余 7 条。
const GATE_EVIDENCE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['thresholds', 'verdict'],
  properties: {
    thresholds: {
      type: 'array',
      description: `逐条核验结果，必须覆盖注入的全部 ${D_GATE_THRESHOLDS.length} 条门槛，一条一项，不得合并、不得省略`,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['id', 'requirement', 'status', 'evidenceLevel', 'evidence', 'blocker'],
        properties: {
          id: { type: 'string', description: '门槛条目 id，照抄注入的 id，与 17 号文档 §4.4 逐条对齐' },
          requirement: { type: 'string', description: '这一条门槛要求什么；照抄注入的正文' },
          status: { type: 'string', enum: ['evidence_complete', 'blocked'], description: '证据齐了还是被挡住了，二选一' },
          evidenceLevel: { type: 'string', enum: ['E0', 'E1', 'E2', 'E3', 'UNVERIFIED'] },
          evidence: {
            type: 'array',
            description: '支撑本条门槛的证据，逐条带出处；引用不到就留空并在 blocker 里说明，不得留一条没有出处的记录',
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
            description: 'status=blocked 时必填，且必须有 owner 与 unblockCondition；evidence_complete 时填 null',
          },
        },
      },
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

phase('Candidate evaluation')

// 候选集由主循环侧 stage_a.js 枚举（形态宏参数的确定性枚举），这里只取前 MAX_CANDIDATES 个。
// 切片是刻意的：候选再多也不该让本次运行无界地长出 agent。
const CANDIDATES = args.candidates || []
if (!CANDIDATES.length) {
  return {
    stage: STAGE, runId: RUN_ID, verdict: 'BLOCKED_CONFIG',
    reason: 'args.candidates 为空：stage_a.js 的形态候选集没传进来，本 workflow 不自己枚举候选',
    nextActions: ['先跑 npm run model:planning（stage_a.js 写打分卡的 morphology.rows），再由 run_workflow.js 注入 args.candidates'],
    files: [],
  }
}
const sliced = CANDIDATES.slice(0, MAX_CANDIDATES)

const evaluations = (await parallel(sliced.map((c, i) => () => agent(
  `${head('architect')}\n\n`
  + `brief：\n${BRIEF_JSON}\n\n`
  + `方向包络（主循环已生成，只读）：${ENVELOPE_ARTIFACT}\n`
  + `打分卡（主循环已生成，只读）：${SCORECARD_ARTIFACT}\n`
  + (L2_BUDGET_ARTIFACT ? `L2 预算合同骨架（主循环已生成，只读；含本候选对照 L1 合同的"满足 / 差多少"）：${L2_BUDGET_ARTIFACT}\n` : '')
  + `\n你本次负责的形态候选（只评估这一个，不得评价其他候选，也不得给出 TPS）：\n`
  + `${JSON.stringify(c, null, 2)}\n\n`
  + `这个候选是一组**形态宏参数**（L/H 算力配比、片上 SRAM 总量与 local/shared 切分、MC 档位、die 数、TP）。\n`
  + `面积/功耗由 integration/detailed/k3_architecture_search.js 的 physical() 算、TPS 由 token time 算，`
  + `对照 L1 预算合同的逐条"满足 / 差多少"已经在打分卡与 L2 骨架里——它们是**给定的裸值**，你不得重算、不得改写。\n\n`
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
  + `5. 把"本域答不了"的问题放进 framingQuestions（约束是否完整、口径是否正确、形态空间是否被写窄）。\n`
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
  + `3. 形态空间是不是被写窄了——候选集在 L/H 配比、SRAM 总量与 local/shared 切分、`
  + `   MC 档位、die 数、TP 这几个轴上是否只覆盖了一种形态，导致"选出来的赢家"`
  + `   其实是唯一被考虑过的东西？\n`
  + `4. 三模型框架：有没有只优化 K3 就把另外两个模型的口径略过？\n`
  + `找不到实质缺口就写 FRAMING_OK 并给空数组——不要为了交差编一条。`
  + `有实质缺口写 FRAMING_INSUFFICIENT。`,
  {label: 'framing-critic', phase: 'Framing review', effort: 'high', schema: FRAMING_SCHEMA})

phase('Gate evidence')

// gate-keeper 落在这里，正是 roster 里 design.arch.direction 的 consumers 声明。
// **一个**实例一次核完 17 号文档 §4.4 的 8 条 D-Gate 门槛**证据**，逐条输出；
// 结论由 evaluate_gates.js 算好并绑在打分卡上——本 agent 不判、也不能判。
const gate = await agent(
  `${head('gate-keeper')}\n\n`
  + `brief：\n${BRIEF_JSON}\n\n`
  + `方向包络（只读）：${ENVELOPE_ARTIFACT}\n`
  + `打分卡（只读，含 script 算好的 dGate 与 selection）：${SCORECARD_ARTIFACT}\n`
  + `合并后的排序：\n${JSON.stringify(merged.ranked, null, 2)}\n\n`
  + `你本次要核的 ${D_GATE_THRESHOLDS.length} 条门槛（见 ${REPO}/teams/council/docs/17_TWO_STAGE_ARCHITECTURE_OPERATING_MODEL.md 第 4.4 节）：\n`
  + D_GATE_THRESHOLDS.map((t) => `  ${t.id}：${t.requirement}`).join('\n') + '\n\n'
  + `任务：**逐条**核验每一条的**证据**，不核验它成不成立、更不核验整体门控。\n`
  + `1. thresholds 数组必须一条门槛一项、${D_GATE_THRESHOLDS.length} 条齐全，id 与 requirement 照抄上面注入的正文，`
  + `   不得合并成一条总体结论、不得省略任何一条。一条的宽松不得传染给另一条：`
  + `   每条各自给 status / evidenceLevel / evidence / blocker。\n`
  + `2. 找出支撑每条的证据，逐条给机器可读的定位（文件路径:行号 或 ADR 编号）与那一处的裸值。\n`
  + `3. 引用不到就把该条写 status=blocked，并给出 blocker（id / owner / unblockCondition）；`
  + `   被挡住的门槛必须有 owner 与 unblockCondition，不得留空。\n`
  + `4. 证据等级按出处判定；出处缺失的写 UNVERIFIED。\n`
  + `**你不判 PASS**：门控结论由 integration/governance/evaluate_gates.js 计算，`
  + `本阶段只负责"证据齐不齐"，所以你的裁决只有"全部条目证据完整"或"有条目被 blocker 挡住"两种。\n`
  + `证据不足与进度冲突时，证据不足优先，记为 blocker 而不是放行。\n`
  + `不得以文档叙述代替机器可读证据；不得修改被测数据或结论；`
  + `不得输出 PASS / D_GATE_PASSED 字面量；不得输出 TPS/usr。`,
  {label: 'gate-keeper', phase: 'Gate evidence', effort: 'high', schema: GATE_EVIDENCE_SCHEMA})

const thresholdChecks = (gate && gate.thresholds) || []
if (thresholdChecks.length < D_GATE_THRESHOLDS.length) {
  const missing = D_GATE_THRESHOLDS.filter((t) => !thresholdChecks.some((c) => c.id === t.id)).map((t) => t.id)
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
  + `${D_GATE_THRESHOLDS.length} 条门槛的逐条核验结果：\n${JSON.stringify(thresholdChecks, null, 2)}\n\n`
  + `任务：汇总成一份证据包。规则：\n`
  + `1. gateDecision **照抄**门控结论产物里的 decision 原文，不得改写、不得推断、`
  + `   不得因"${D_GATE_THRESHOLDS.length} 条证据都齐"就把它写成通过。抄不到就写 UNVERIFIED。\n`
  + `2. gateDecisionSource 写 integration/governance/evaluate_gates.js#evaluateDirectionGate 与产物路径。\n`
  + `3. registerConsistent 照抄产物里的原值，不得自行重算。\n`
  + `4. thresholds 逐条转写为 thresholdId / status / evidenceLevel / blockerId，不得改写任何一条的 status。\n`
  + `5. 无主的悬空问题进 unresolved，不得为了收口而塞进某条门槛。\n`
  + `${D_GATE_THRESHOLDS.length} 条门槛证据都齐写 GATE_EVIDENCE_COMPLETE；任一条被 blocker 挡住写 GATE_BLOCKED。`
  + `注意：这个裁决说的是**证据**，不是门控结论本身。`,
  {label: 'architect:assembly', phase: 'Evidence assembly', effort: 'high', schema: PACKAGE_SCHEMA})

if (!packed) {
  return {
    stage: STAGE, runId: RUN_ID, verdict: 'BLOCKED_CONFIG',
    reason: '证据包未产出；不落盘',
    files: [],
  }
}

phase('Invariant check')

// 末步是检点，不是总结。gate-keeper 与 invariant-checker 查的是两件事：
// gate-keeper 查证据齐不齐，invariant-checker 查候选集与全局不变量冲突不冲突，
// 并专门查一件最容易出错的事：汇总出来的证据包里有没有混进一个自行判定的门控结论。
// 那正是本次重构要防的"以总结代替核验"的变体——不是编造数字，是编造结论。
const check = await agent(
  `${head('invariant-checker')}\n\n`
  + `方向包络（只读）：${ENVELOPE_ARTIFACT}\n`
  + `打分卡（只读）：${SCORECARD_ARTIFACT}\n`
  + `门控结论产物（只读）：${GATE_STATUS_ARTIFACT}\n`
  + `合并后的排序与取舍：\n${JSON.stringify(merged, null, 2)}\n`
  + `framing-critic 的审查：\n${JSON.stringify(framing, null, 2)}\n`
  + `gate-keeper 的逐条门槛核验：\n${JSON.stringify(thresholdChecks, null, 2)}\n`
  + `architect 的证据包：\n${JSON.stringify(packed, null, 2)}\n\n`
  + `任务：对这份排序、候选集与证据包做全局不变量检点，逐条给出 pass/fail 与裸值：\n`
  + `7-reticle 面积守恒、单一硬件规格（ADR-0021）、MC320/MC640 分离、peak 与 sustained 分离、`
  + `单位一致、证据等级齐全。违规项必须给出违反的具体文件与字段。\n`
  + `此外必须专门核验两件事，它们不是普通不变量：\n`
  + `  (a) 证据包里的 gateDecision 与门控结论产物里的 decision **逐字一致**；`
  + `      不一致即为违规，无论哪个看起来更合理。\n`
  + `  (b) 证据包与逐条核验里不得出现自行判定的门控结论（任何形式的 PASS / D_GATE_PASSED 字面量）。\n`
  + `不得把违规项解释掉（解释权归 architect）；不得以文档措辞为依据，只以数值和来源为依据。\n`
  + `全部通过写 INVARIANT_OK，任一不通过写 INVARIANT_VIOLATED。`,
  {label: 'invariant-checker', phase: 'Invariant check', effort: 'high', schema: CHECK_SCHEMA})

const okInvariants = check && check.verdict === 'INVARIANT_OK'
const okGate = gate && gate.verdict === 'GATE_EVIDENCE_COMPLETE' && packed.verdict === 'GATE_EVIDENCE_COMPLETE'

// 四个裁决枚举各自决定一个方向的放行，全部由这里消费。
const blocked = !okInvariants
  ? {verdict: 'INVARIANT_VIOLATED', violations: (check && check.violations) || ['检点未完成']}
  : (!okGate
    ? {verdict: 'GATE_BLOCKED', violations: thresholdChecks.filter((t) => t.status === 'blocked')}
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
  // 被挡住的门槛同样是本阶段的"被否选项"——不记下来，重跑会重新发明同一个 blocker。
  rejectedOptions: [
    ...(merged.rejectedOptions || []).map((r) => ({
      stage: STAGE, optionId: r.candidateId, reason: r.reason, rejectedBy: r.rejectedBy,
    })),
    ...thresholdChecks.filter((t) => t.status === 'blocked').map((t) => ({
      stage: STAGE, optionId: t.id,
      reason: t.blocker ? `${t.blocker.owner}: ${t.blocker.unblockCondition}` : '证据不足',
      rejectedBy: 'gate-keeper',
    })),
  ],
  openBlockers: [
    ...(merged.conflicts || []).map((c, i) => ({
      id: `CONFLICT-ARCH-DIRECTION-${String(i + 1).padStart(2, '0')}`,
      owner: (c.between && c.between[0]) || 'integrator',
      unblockCondition: c.resolution,
    })),
    ...(framing && framing.gaps ? framing.gaps.map((g, i) => ({
      id: `FRAMING-ARCH-DIRECTION-${String(i + 1).padStart(2, '0')}`,
      owner: 'architect',
      unblockCondition: `补齐框架缺口（${g.kind}）：${g.detail}`,
    })) : []),
    ...thresholdChecks.filter((t) => t.blocker).map((t) => ({
      id: t.blocker.id, owner: t.blocker.owner, unblockCondition: t.blocker.unblockCondition,
    })),
    ...(packed.unresolved || []).map((u, i) => ({
      id: `ARCH-DIRECTION-UNRESOLVED-${String(i + 1).padStart(2, '0')}`,
      owner: 'architect', unblockCondition: u,
    })),
  ],
}

const runRecord = {
  schemaVersion: 'design-run-record-v0.1',
  stage: STAGE,
  runId: RUN_ID,
  sourceCommit: BRIEF.sourceCommit,
  envelopeArtifact: ENVELOPE_ARTIFACT,
  scorecardArtifact: SCORECARD_ARTIFACT,
  gateStatusArtifact: GATE_STATUS_ARTIFACT,
  l2BudgetArtifact: L2_BUDGET_ARTIFACT || 'UNVERIFIED',
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
  thresholdsChecked: thresholdChecks.map((t) => t.id).sort(),
  evidenceCompleteCount: thresholdChecks.filter((t) => t.status === 'evidence_complete').length,
  blockedCount: thresholdChecks.filter((t) => t.status === 'blocked').length,
  caliber: '候选为 PLANNING 口径的形态宏参数候选；TPS、面积/功耗与门控结论一律取自打分卡与 evaluate_gates.js 的产物，workflow 与任何 agent 均不产生数字',
}

// L2 预算合同：数字全部来自 stage_a.js 算好的骨架（args.l2Budget），
// 本 workflow 只接上"选中了哪些形态"与"门槛证据等级"，不改任何数值。
// 骨架没传进来就不落这份文件——宁可缺一份产物，也不要一份由 agent 填出来的预算。
const l2BudgetFile = L2_BUDGET
  ? [{
      path: `${REPO}/out/budget/L2_budget.json`,
      content: JSON.stringify({
        ...L2_BUDGET,
        schemaVersion: 'budget-contract-v0.1',
        layer: 'L2',
        stage: STAGE,
        runId: RUN_ID,
        sourceCommit: BRIEF.sourceCommit,
        basisArtifact: L2_BUDGET_ARTIFACT || 'UNVERIFIED',
        formalCandidateIds: formal,
        evidenceLevelByThreshold: Object.fromEntries(thresholdChecks.map((t) => [t.id, t.evidenceLevel])),
        caliber: '本文件的全部数值取自 stage_a.js 的形态枚举与 A.physical / token time，workflow 只接上候选选择与证据等级',
      }, null, 2) + '\n',
    }]
  : []

return {
  stage: STAGE,
  runId: RUN_ID,
  verdict: blocked ? blocked.verdict : 'FRAMING_OK',
  winner: blocked ? null : {ranked: merged.ranked, formalCandidateIds: formal},
  rejectedWinner: blocked ? merged.ranked : null,
  violations: blocked ? blocked.violations : [],
  framing: framing || null,
  gateEvidence: gate || null,
  evidencePackage: blocked ? null : packed,
  rejectedPackage: blocked ? packed : null,
  gateDecision: packed.gateDecision,
  ledgerPatch,
  runRecord,
  files: blocked ? [] : [
    {
      path: `${REPO}/out/direction/direction_selected.json`,
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
    ...l2BudgetFile,
    {
      path: `${REPO}/out/governance/arch_direction_evidence_package.json`,
      content: JSON.stringify({
        schemaVersion: 'design-arch-direction-evidence-package-v0.1',
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
      path: `${REPO}/out/direction/arch_direction_run_record.json`,
      content: JSON.stringify(runRecord, null, 2) + '\n',
    },
  ],
}
