export const meta = {
  name: 'design-req-budget',
  description: 'K3 设计 L1-b 预算切分：等 TPS 前沿与候选预算合同由确定性内核给出，owner 专家逐条判物理可达，architect 在可达切分里选一份，framing-critic 审口径，invariant-checker 检点后落盘为 L1 预算合同',
  whenToUse: '需要 args.frontier（主循环用 npm run budget:frontier 生成、run_workflow.js 读入并核对输入指纹的前沿）。本 workflow 不计算任何数值、不改合同；只决定哪一份候选合同下发、哪几份被否以及为什么。',
  phases: [
    { title: 'Frontier', detail: '核对前沿与合同 schema，按条目 owner 分派；前沿由 requirement_frontier.js 生成，workflow 内没有 agent 参与取数' },
    { title: 'Reachability', detail: '每个 owner 专家只判自己的预算条目：在目标工艺 / 通路下物理上够不够得着，给可信区间与出处' },
    { title: 'Selection', detail: 'architect 在全部条目可达的切分里选一份下发，说明取舍；不得改数、不得新造切分' },
    { title: 'Framing review', detail: 'framing-critic 对抗式审查：约束完整吗、口径对吗、切分空间是不是被写窄了' },
    { title: 'Invariant check', detail: 'invariant-checker 强制检点；不通过则不落盘' },
  ],
}

// ---------------------------------------------------------------------------
// L1-b 预算切分（teams/council/docs/23_DESIGN_QUESTION_WORKFLOW_PROPOSAL.md §3 L1-b）。
//
// 回答"要达到目标 TPS/usr，带宽、有效算力、单次集合通信 τ 各要多少，下发给谁"。分工：
//
// 1. 数全部来自前沿。等 TPS 线、单轴余量、SRAM × 预取深度网格、各切分的点与校核都由
//    integration/planning/requirement_frontier.js 在规划模型与详细 K3 模型上算出，主循环生成、
//    run_workflow.js 读入并核对输入指纹后经 args.frontier 传入。落盘的合同是前沿里某一份
//    切分的原样拷贝（主循环逐字段核对），agent 只决定选哪一份。
//
// 2. 模型能回答"这个点守不守得住预算"，回答不了"这个点在物理上够不够得着"——例如 τ 1.36 us
//    在当前通路上做不做得到、MC 持续带宽能不能到 MC640 的 payload。这一判断交给条目的 owner
//    专家，依其策略与知识给出可信区间和出处。有一条判不可达，该切分即被否，并写进 rejectedOptions。
//
// 3. 先由专家判全部切分、再由 architect 在可达的切分里选：选择是全局取舍（哪一维让出余量、
//    哪个 owner 交付最便宜），可达是领域判断，两者分开才不会让选择者替专家判物理。
//
// 4. 前沿外的数字由脚本比对，与 design.attribution 同一规则：plausibleRange 里的前沿外数字必须
//    在 rangeEvidence 所引的行上（主循环 check_citations.js 核对），其余字段里只许出现前沿里的数
//    或许可的 plausibleRange 里的数。不合规的回到同一个 agent 修正一次，仍不合规即不守恒。
// ---------------------------------------------------------------------------

const REPO = args.repo || '.'
const STAGE = 'req.budget'
const FRONTIER = args.frontier
const FRONTIER_PATH = args.frontierPath || 'UNVERIFIED'
const FRONTIER_SHA = args.frontierSha256 || 'UNVERIFIED'
const RUN_ID = args.runId || 'req-budget-run'
const FRONTIER_SCHEMA = 'budget-frontier-v0.1'
const CONTRACT_SCHEMA = 'budget-contract-v0.1'
// 本格可分派的专家。合同里出现别的 owner 即视为前沿与本 workflow 的契约不一致。
const EXPERTS = ['compute-expert', 'memory-expert', 'comm-expert', 'physical-expert']
// 方向级回退各用本策略的裁决名：physical-expert 的回退来源是 PPA。
const BACKFLOW = { 'physical-expert': 'PPA_DIRECTION_BACKFLOW' }
const backflowOf = (agentId) => BACKFLOW[agentId] || 'DIRECTION_BACKFLOW'

if (!FRONTIER) {
  throw new Error('design.req.budget 需要 args.frontier（主循环先跑 npm run budget:frontier，再由 run_workflow.js 读入）；本 workflow 不生成前沿')
}

const HEAD = [
  `仓库根目录：${REPO}`,
  `本 workflow：design.req.budget（L1-b 预算切分，runId=${RUN_ID}）`,
  `你是一个策略实例。先读你的策略正文：${REPO}/teams/council/strategies/__AGENT__.md`,
  '那份文件是本角色的判断规则、正确性判据、证据规则、取舍规则与禁止事项，逐条遵守。',
  '以下运行时上下文由 workflow 注入；注入内容与策略正文冲突时，注入内容优先（它承载本 stage 的事实）。',
  '你没有文件系统写权限。把该写的东西作为返回值交回，由 workflow 落盘。',
  `预算前沿（${FRONTIER_PATH}）是本格数值的唯一来源：按切分 id（splitId）、条目 id（B-…）与字段路径引用，不得转写、改写、重算或补出前沿里没有的数。`,
  '你自己给出的物理可信区间必须带出处（文件路径:行号 或 ADR / blocker 编号）；没有出处的写 UNVERIFIED 并说明缺什么，不得静默补齐。',
  '不得输出 TPS/usr 或任何全局性能指标；不得输出 PASS / D_GATE_PASSED 字面量。',
].join('\n')

// 领域知识注入（知识不是证据），与 C 组同一形状：只注入路径。
const KNOWLEDGE = {
  'compute-expert': 'references/sota/compute-core.md',
  'memory-expert': 'references/sota/memory-subsystem.md',
  'comm-expert': 'references/sota/interconnect-collective.md',
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

// 前沿外数字的机械比对。规则与 integration/pipelines/check_citations.js 的 numberTokens 相同（workflow 脚本
// 不 require 仓库模块，所以在这里重写一遍；tests/unit/test_check_citations.js 取出这一段与之逐样例核对）：
// 只看带小数点或至少三位的数；标识符（FP8、TP32、B-008）、文件:行号、日期、§ 与 # 编号不算；MC320 这类档位名算。
const CITE = /[A-Za-z0-9_][\w.\-/]*\.(?:js|cjs|mjs|ts|md|json|py|ya?ml|txt|csv):\d+(?:-\d+)?(?!\d|\.\d)(?:(?:,|\/:?|、:)\d+(?:-\d+)?(?!\d|\.\d))*/g
const NUMBER = /(?<![A-Za-z0-9_.])(?<![A-Za-z]-)\d+(?:\.\d+)?(?![A-Za-z0-9_]|\.\d)/g
const numberTokens = (text) => (String(text || '').replace(/\bMC(\d{3})\b/g, ' $1 ').replace(CITE, ' ')
  .replace(/\d{4}-\d{2}-\d{2}/g, ' ').replace(/:\s*\d+(?:\s*[-,/、]\s*:?\s*\d+)*/g, ' ')
  .replace(/§\s*\d+(?:\.\d+)*/g, ' ').replace(/#\d+/g, ' ')
  .match(NUMBER) || []).filter((t) => t.includes('.') || t.length >= 3)
const sameNumber = (t, n) => {
  const d = (t.split('.')[1] || '').length
  return d ? Math.abs(n - Number(t)) < 0.5 * 10 ** -d + 1e-12 : n === Number(t)
}
const numbersIn = (value, out = []) => {
  if (typeof value === 'number') out.push(value)
  else if (typeof value === 'string') (value.match(NUMBER) || []).forEach((t) => out.push(Number(t)))
  else if (Array.isArray(value)) value.forEach((v) => numbersIn(v, out))
  else if (value && typeof value === 'object') Object.entries(value).forEach(([k, v]) => { numbersIn(k, out); numbersIn(v, out) })
  return out
}
const textsOf = (value, out = []) => {
  if (typeof value === 'string') out.push(value)
  else if (Array.isArray(value)) value.forEach((v) => textsOf(v, out))
  else if (value && typeof value === 'object') Object.values(value).forEach((v) => textsOf(v, out))
  return out
}
const rangeNumbers = (withRange) => (withRange || []).flatMap((r) => numberTokens(r.plausibleRange).map(Number))
// 前沿外、也不在许可的可信区间里的数字：[{where, number}]。
const looseIn = (where, texts, allowed) => texts.flatMap((s) => numberTokens(s))
  .filter((t) => !FRONTIER_NUMBERS.some((n) => sameNumber(t, n)) && !allowed.some((n) => sameNumber(t, n)))
  .map((number) => ({ where, number }))
const looseInReview = (review) => {
  if (!review) return []
  const all = rangeNumbers(review.entries)
  return [
    ...(review.entries || []).flatMap((e) => looseIn(`entries[${e.splitId}/${e.id}].reason`, [e.reason], rangeNumbers([e]))),
    ...looseIn('note', [review.note], all),
  ]
}
const repairNote = (loose, previous) => `

---
你上一次交回的结果里，下列数字既不在前沿里，也不在许可的 plausibleRange 里（脚本机械比对）：
${loose.map((l) => `- ${l.where}：${l.number}`).join('\n')}
只改这些地方：删掉这些数字，或把它写进对应条目的 plausibleRange 并在 rangeEvidence 给出含这个数的那一行。其余内容原样交回。
上一次的结果：
${JSON.stringify(previous, null, 2)}`

phase('Frontier')

// 前沿 schema 不对、没有切分、条目 owner 不在本格专家里：都是契约问题，交回主循环，不让 agent 去猜。
const splits = FRONTIER.splits || []
const allEntries = splits.flatMap((s) => ((s.contract && s.contract.split) || []).map((e) => ({ splitId: s.splitId, ...e })))
const strangers = [...new Set(allEntries.map((e) => e.ownerAgent))].filter((o) => !EXPERTS.includes(o))
const badContracts = splits.filter((s) => !s.contract || s.contract.schemaVersion !== CONTRACT_SCHEMA || s.contract.splitId !== s.splitId).map((s) => s.splitId)
if (FRONTIER.schemaVersion !== FRONTIER_SCHEMA || !splits.length || strangers.length || badContracts.length) {
  return {
    stage: STAGE,
    runId: RUN_ID,
    verdict: 'BLOCKED_CONFIG',
    reason: FRONTIER.schemaVersion !== FRONTIER_SCHEMA ? `前沿 schemaVersion=${FRONTIER.schemaVersion}，本 workflow 读 ${FRONTIER_SCHEMA}`
      : !splits.length ? '前沿没有候选切分'
        : badContracts.length ? `切分的合同缺失或 schema 不是 ${CONTRACT_SCHEMA}：${badContracts.join(', ')}`
          : `合同条目的 owner 不在本格可分派的专家中：${strangers.join(', ')}`,
    frontierPath: FRONTIER_PATH,
    nextActions: ['核对 integration/planning/requirement_frontier.js 与本 workflow 的契约，重跑 npm run budget:frontier 后重跑本格'],
    files: [],
  }
}

// 内核校核不成立的切分不交给专家：模型已经说它守不住预算，没有可达性可判。
const kernelRuledOut = splits.filter((s) => !(s.contract.check && s.contract.check.holds)).map((s) => s.splitId)
const offered = splits.filter((s) => !kernelRuledOut.includes(s.splitId))
const TP = offered.length ? offered[0].contract.scope.tp : null

// 前沿头：所有专家共享的上下文（目标与预算、规划线的定义与 TP 槽、详细网格与车道耦合、单轴余量、
// 耦合关系、注意事项）。其余 TP 的规划槽在前沿文件里，按路径可读。
const frontierHead = {
  question: FRONTIER.question,
  status: FRONTIER.status,
  frontierPath: FRONTIER_PATH,
  inputs: FRONTIER.inputs,
  target: FRONTIER.target,
  gateBudgetUs: FRONTIER.gateBudgetUs,
  planning: {
    slot: FRONTIER.planning && FRONTIER.planning.slot,
    definitions: FRONTIER.planning && FRONTIER.planning.definitions,
    blocked: FRONTIER.planning && FRONTIER.planning.blocked,
    [`modelsAtTP${TP}`]: ((FRONTIER.planning && FRONTIER.planning.models) || []).map((m) => ({ model: m.model, status: m.status, slot: (m.slots || []).find((s) => s.tp === TP) })),
  },
  detailed: FRONTIER.detailed,
  singleAxis: FRONTIER.singleAxis,
  coupling: offered.length ? offered[0].contract.coupling : [],
  caveats: FRONTIER.caveats,
}
const FRONTIER_NUMBERS = numbersIn(FRONTIER)
const owners = EXPERTS.filter((agentId) => allEntries.some((e) => e.ownerAgent === agentId))
const entriesOf = (agentId) => offered.flatMap((s) => s.contract.split.filter((e) => e.ownerAgent === agentId).map((e) => ({ splitId: s.splitId, ...e })))
const splitView = (agentId) => offered.map((s) => ({
  splitId: s.splitId,
  relaxes: s.relaxes,
  intent: s.contract.intent,
  point: s.contract.point,
  check: s.contract.check,
  entries: s.contract.split.filter((e) => e.ownerAgent === agentId),
}))
log(`前沿 ${FRONTIER_PATH}：${splits.length} 份切分，内核否 ${kernelRuledOut.length} 份；${allEntries.length} 条预算条目分派给 ${owners.join(', ')}`)

if (!offered.length) {
  return {
    stage: STAGE,
    runId: RUN_ID,
    verdict: 'DIRECTION_BACKFLOW',
    reason: `前沿里没有一份切分在模型上守得住预算（${kernelRuledOut.join(', ')}）；预算切分无从谈起，回到方向`,
    routeTo: 'design.intake',
    nextActions: ['把前沿交给 design.intake（L0），由人决定目标或场景；本格不落盘合同'],
    files: [],
  }
}

phase('Reachability')

const reviewSchema = (agentId) => ({
  type: 'object',
  additionalProperties: false,
  required: ['from', 'entries', 'verdict'],
  properties: {
    from: { type: 'string', description: '审读者 agentId' },
    entries: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['splitId', 'id', 'reachability', 'plausibleRange', 'rangeEvidence', 'reason'],
        properties: {
          splitId: { type: 'string', description: '前沿里 splits[].splitId，原样' },
          id: { type: 'string', description: '合同条目 id（B-…），原样' },
          reachability: {
            type: 'string',
            enum: ['reachable', 'unreachable', 'unknown'],
            description: '该切分下这条预算在目标工艺 / 通路 / 软件栈下物理上够不够得着；给不出出处判断不了时写 unknown',
          },
          plausibleRange: { type: 'string', description: '该量在目标工艺 / 通路下物理上可信的取值范围，或 UNVERIFIED' },
          rangeEvidence: { type: 'string', description: '可信区间的出处：文件路径:行号、ADR 或 blocker 编号，或 UNVERIFIED' },
          reason: { type: 'string', description: '按切分 id、条目 id 与字段路径引用前沿，不转写数值' },
        },
      },
    },
    verdict: { type: 'string', enum: ['LOCAL_DETAIL_FIX', backflowOf(agentId), 'BLOCKED_CONFIG'] },
    blockedFields: { type: 'array', items: { type: 'string' } },
    note: { type: 'string' },
  },
})

const reviewPrompt = (agentId) => {
  const own = entriesOf(agentId)
  return `${head(agentId)}

预算前沿头（共享上下文，数值的唯一来源）：
${JSON.stringify(frontierHead, null, 2)}

候选切分（每份是一整套预算合同；这里只列 ownerAgent=${agentId} 的条目，共 ${own.length} 条）：
${JSON.stringify(splitView(agentId), null, 2)}

任务：逐条判物理可达性，entries 里必须恰好覆盖上面每一份切分的每一条你的条目（按 splitId + id），不多不少。
- reachability：这份切分要求的值（条目里的 min 或 max）在目标工艺 / 通路 / 软件栈下够不够得着。
  · min 条目（带宽、有效算力、SRAM 容量）问的是"能不能至少交付这么多"；max 条目（τ、面积）问的是"能不能压到这么低以内"。
  · set=fixed by split 的条目是发布点的值，同样要判：发布点本身够不着，所有保留它的切分都够不着。
  · 判不可达（unreachable）会让该切分整份被否；只有给得出出处时才这么判。给不出出处、判断不了，写 unknown 并说明缺什么——
    unknown 不否切分，但若该切分被选中，它会成为下游的 open blocker。
- plausibleRange + rangeEvidence：这个量在物理上可信的范围。这是前沿里没有、只有你能给的东西；
  给不出出处就写 UNVERIFIED，不要凭印象给一个"行业通常值"。
- 两条预算的耦合（前沿头 coupling）由模型给出：一条放宽会让另一条收紧时，按条目 id 指出，不要自己估联合效应。
- 前沿的 caveats 写明了模型口径（规划因子只在 K3 上拟合、软件开关不重调、MC 搜索止于 MC640 等）；
  口径问题不是你判可达性的理由，但你看到它让某条判断站不住时写进 note。
- 引用仓库文件时写 文件路径:行号，行号必须指向写有该内容的那一行（主循环会机械核对：指向空行、表格边框 / 代码围栏这类没有文字的行或越界，即整次不落盘）。
  引用前沿时写字段路径，不写前沿文件的行号。
- 数字的规则（脚本逐个机械比对）：
  · plausibleRange 里每个前沿外的数字，必须原样出现在 rangeEvidence 所引的某一行上（主循环核对，不过即不落盘）；
  · reason 里只许出现前沿里有的数字，或本条 plausibleRange 里的数字；note 里只许出现前沿里的数字或你任一条 plausibleRange 里的数字。
    要用一个前沿外的数（例如某个文档里的带宽、某个 τ 实测），先把它写进该条 plausibleRange 并给出含这个数的那一行作出处。
- 只判你的条目，不评价别的域；不要在切分之间做选择，那是 architect 的事；不要提设计改动建议，那是 L3 的事。
- verdict：LOCAL_DETAIL_FIX（审读完成）/ BLOCKED_CONFIG（前沿缺什么才判得了，列在 blockedFields）。
  若审读结论动摇了方向级假设（例如发布点本身的某条预算物理上够不着、所有切分都保留了它），用 ${backflowOf(agentId)} 并说明是哪一条。`
}

const firstReviews = await parallel(owners.map((agentId) => () =>
  agent(reviewPrompt(agentId), { label: `review:${agentId}`, phase: 'Reachability', effort: 'high', schema: reviewSchema(agentId) })))

// 前沿外数字只给一次修正机会：带着脚本列出的数字和上一次结果回到同一个专家。修正交不回来就沿用原结果，
// 剩下的前沿外数字进入机械比对，由检点者确认、不落盘。
const reviews = await parallel(owners.map((agentId, i) => async () => {
  const first = firstReviews[i]
  const loose = first && first.verdict === 'LOCAL_DETAIL_FIX' ? looseInReview(first) : []
  if (!loose.length) return first
  log(`${agentId} 的审读有 ${loose.length} 个前沿外数字：${loose.map((l) => l.number).join(', ')}；修正一次`)
  const again = await agent(reviewPrompt(agentId) + repairNote(loose, first),
    { label: `repair:${agentId}`, phase: 'Reachability', effort: 'high', schema: reviewSchema(agentId) })
  return again && again.verdict === 'LOCAL_DETAIL_FIX' ? again : first
}))

// 缺席不是"可达"：缺一路，那一路的条目就没有人判过，选择者会把它当成没问题。
const absent = owners.filter((_, i) => !reviews[i])
if (absent.length) {
  log(`专家审读缺 ${absent.length} 路：${absent.join(', ')}；退回，不选择`)
  return {
    stage: STAGE,
    runId: RUN_ID,
    verdict: 'BLOCKED_CONFIG',
    reason: `可达性审读不完整，缺：${absent.join(', ')}；缺席一侧的预算条目没有人判过`,
    absent,
    nextActions: absent.map((agentId) => `补齐 ${agentId} 对 ${FRONTIER_PATH} 中其负责条目的可达性审读后重跑本格`),
    files: [],
  }
}
// 回退按派出的身份认，不按审读里自报的 from：from 写错不该让一次方向回退漏过去。
const backflowAt = owners.findIndex((agentId, i) => reviews[i].verdict === backflowOf(agentId))
if (backflowAt >= 0) {
  const by = owners[backflowAt]
  return {
    stage: STAGE,
    runId: RUN_ID,
    verdict: reviews[backflowAt].verdict,
    reason: `${by} 报方向回退：${reviews[backflowAt].note || ''}`,
    routeTo: 'design.direction',
    reviews,
    nextActions: [`把 ${by} 的方向级发现交给 design.direction 重定方向；本格不落盘合同`],
    files: [],
  }
}
const blocked = reviews.filter((r) => r.verdict === 'BLOCKED_CONFIG')
if (blocked.length) {
  return {
    stage: STAGE,
    runId: RUN_ID,
    verdict: 'BLOCKED_CONFIG',
    reason: `可达性审读输入不足：${blocked.map((r) => r.from).join(', ')}`,
    blockedFields: blocked.flatMap((r) => r.blockedFields || []),
    reviews,
    nextActions: blocked.map((r) => `补齐 ${r.from} 要的字段（${(r.blockedFields || []).join(', ') || '见 note'}）后重跑 npm run budget:frontier 与本格`),
    files: [],
  }
}

// 覆盖面是机械可核对的：每个专家交回的 (splitId, id) 必须恰好等于派给它的条目。
// 不交给 agent 判断——漏判的条目由脚本指出，检点者只确认，不解释。
const keyOf = (e) => `${e.splitId}/${e.id}`
const coverageGaps = owners.flatMap((agentId, i) => {
  const want = entriesOf(agentId).map(keyOf)
  const got = (reviews[i].entries || []).map(keyOf)
  return [
    ...want.filter((k) => !got.includes(k)).map((k) => `${agentId} 漏判 ${k}`),
    ...got.filter((k) => !want.includes(k)).map((k) => `${agentId} 判了不属于它的条目 ${k}`),
  ]
})
if (coverageGaps.length) log(`可达性覆盖缺口 ${coverageGaps.length} 处：${coverageGaps.join('; ')}`)

// 被否的切分：内核校核不成立，或任一条目被其 owner 判不可达。理由逐条带上判的人与出处。
// 只认专家对自己条目的判断：越权判的条目已经记在 coverageGaps 里，不能借此否掉别人的切分。
const judged = reviews.flatMap((r, i) => {
  const own = entriesOf(owners[i]).map(keyOf)
  return (r.entries || []).filter((e) => own.includes(keyOf(e))).map((e) => ({ ...e, from: owners[i] }))
})
const ruledOut = [
  ...kernelRuledOut.map((splitId) => ({ splitId, rejectedBy: 'requirement_frontier.js', reason: 'contract.check.holds=false：模型上守不住预算' })),
  ...offered.map((s) => ({ s, bad: judged.filter((e) => e.splitId === s.splitId && e.reachability === 'unreachable') }))
    .filter(({ bad }) => bad.length)
    .map(({ s, bad }) => ({
      splitId: s.splitId,
      rejectedBy: [...new Set(bad.map((e) => e.from))].join(', '),
      reason: bad.map((e) => `${e.id} 不可达（${e.from}：${e.plausibleRange}，出处 ${e.rangeEvidence}）`).join('；'),
    })),
]
const allowed = offered.map((s) => s.splitId).filter((id) => !ruledOut.some((r) => r.splitId === id))
log(`可达切分 ${allowed.length} 份：${allowed.join(', ') || '无'}；被否 ${ruledOut.length} 份`)

const ledgerBase = {
  currentStage: STAGE,
  rejectedOptions: ruledOut.map((r) => ({ stage: STAGE, optionId: r.splitId, reason: r.reason, rejectedBy: r.rejectedBy })),
}

if (!allowed.length) {
  return {
    stage: STAGE,
    runId: RUN_ID,
    verdict: 'DIRECTION_BACKFLOW',
    reason: `每一份候选切分都有条目被判不可达（${ruledOut.map((r) => r.splitId).join(', ')}）；当前方向点在物理上交付不了目标预算`,
    routeTo: 'design.intake',
    ruledOut,
    reviews,
    ledgerPatch: { ...ledgerBase, strategyVersions: Object.fromEntries(owners.map((id) => [id, '1.0'])), openBlockers: [] },
    nextActions: ['把被否切分与理由交给 design.intake（L0），由人决定目标或场景；本格不落盘合同'],
    files: [],
  }
}

phase('Selection')

const candidateView = offered.filter((s) => allowed.includes(s.splitId)).map((s) => ({
  splitId: s.splitId,
  relaxes: s.relaxes,
  intent: s.contract.intent,
  point: s.contract.point,
  check: s.contract.check,
  entries: s.contract.split.map((e) => ({ id: e.id, quantity: e.quantity, min: e.min, max: e.max, set: e.set, ownerAgent: e.ownerAgent })),
  reachability: judged.filter((e) => e.splitId === s.splitId).map((e) => ({ id: e.id, from: e.from, reachability: e.reachability, plausibleRange: e.plausibleRange, rangeEvidence: e.rangeEvidence })),
}))

const SELECTION_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['splitId', 'verdict', 'reason', 'tradeoff'],
  properties: {
    splitId: { type: 'string', enum: allowed, description: '下发的切分，只能是可达切分之一' },
    verdict: { type: 'string', enum: ['ARCH_FREEZE', 'DIRECTION_BACKFLOW'] },
    reason: { type: 'string', description: '为什么选这一份；按切分 id、条目 id 与专家 agentId 引用' },
    tradeoff: { type: 'string', description: '这一份相对其他可达切分让出了哪一维的余量、交给哪个 owner 去扛' },
  },
}
const SELECTION_PROMPT = `${head('architect')}

预算前沿头（数值的唯一来源）：
${JSON.stringify(frontierHead, null, 2)}

可达的候选切分（每份是一整套预算合同，附各条目 owner 专家的可达性判断）：
${JSON.stringify(candidateView, null, 2)}

已被否的切分（不得选，也不得改头换面重新提出）：
${JSON.stringify(ruledOut, null, 2)}

任务：在可达切分里选一份作为 L1 预算合同下发给 L2（compute / memory / comm / physical）。
- 你只选，不改：合同由脚本从前沿原样拷贝落盘，你写的任何数都不会进合同；不得新造切分、不得调整某条预算。
- 取舍依据：哪一维让出余量（tradeoff）、承担它的 owner 交付起来是否最现实（看专家的 plausibleRange 离合同值多远、
  有几条是 unknown）、耦合关系（前沿头 coupling）会不会让下游一放宽就互相挤占。
- unknown 条目不否切分，但选中后会成为下游的 open blocker；选一份 unknown 多的切分要在 reason 里说明为什么值得。
- ARCH_FREEZE：选中的合同可以定稿，L2 可以据此开工。
  DIRECTION_BACKFLOW：可达切分都站不住（例如可达只因为关键条目都是 unknown），必须回到 direction 重定，不得就地绕过；
  这时 splitId 仍填你认为最接近可用的那一份，并在 reason 里写清缺什么。
- 数字的规则（脚本逐个机械比对）：reason 与 tradeoff 里只许出现前沿里的数字，或某位专家 plausibleRange 里的数字；
  别的数一律不写，按切分 id、条目 id 或专家 agentId 指过去。
- 不要判定检点是否成立——那是检点的事。`

const selectionAllowed = reviews.flatMap((r) => rangeNumbers(r.entries))
const looseInSelection = (s) => (s ? looseIn('selection', [s.reason, s.tradeoff], selectionAllowed) : [])
const firstSelection = await agent(SELECTION_PROMPT, { label: 'architect', phase: 'Selection', effort: 'high', schema: SELECTION_SCHEMA })
let selection = firstSelection
const selectionLoose = firstSelection && firstSelection.verdict === 'ARCH_FREEZE' ? looseInSelection(firstSelection) : []
if (selectionLoose.length) {
  log(`选择理由有 ${selectionLoose.length} 个前沿外数字：${selectionLoose.map((l) => l.number).join(', ')}；修正一次`)
  const again = await agent(SELECTION_PROMPT + repairNote(selectionLoose, firstSelection),
    { label: 'repair:architect', phase: 'Selection', effort: 'high', schema: SELECTION_SCHEMA })
  if (again && again.verdict === 'ARCH_FREEZE') selection = again
}

if (!selection || selection.verdict !== 'ARCH_FREEZE') {
  return {
    stage: STAGE,
    runId: RUN_ID,
    verdict: selection ? selection.verdict : 'BLOCKED_CONFIG',
    reason: selection ? `architect 判方向回退：${selection.reason}` : 'architect 未交回选择',
    routeTo: selection ? 'design.direction' : undefined,
    selection: selection || null,
    ruledOut,
    reviews,
    ledgerPatch: { ...ledgerBase, strategyVersions: Object.fromEntries([...owners, 'architect'].map((id) => [id, '1.0'])), openBlockers: [] },
    nextActions: selection
      ? ['把 architect 的方向级发现与被否切分交给 design.direction 重定方向；本格不落盘合同']
      : ['重跑本格的 Selection 步'],
    files: [],
  }
}

const chosen = offered.find((s) => s.splitId === selection.splitId)
// 选择必须落在可达切分里；schema 的 enum 已经约束了它，这里再比一次是因为宿主不一定强制 schema。
const chosenProblems = chosen && allowed.includes(chosen.splitId) ? [] : [`architect 选的 ${selection.splitId} 不在可达切分（${allowed.join(', ')}）里`]
const chosenUnknown = judged.filter((e) => chosen && e.splitId === chosen.splitId && e.reachability === 'unknown')

phase('Framing review')

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

const framing = await agent(
  `${head('framing-critic')}

预算前沿头：
${JSON.stringify(frontierHead, null, 2)}

选中的切分：${selection.splitId}
architect 的理由：${selection.reason}
取舍：${selection.tradeoff}
被否的切分：
${JSON.stringify(ruledOut, null, 2)}

任务：对抗式审查这个预算框架，而不是审查选择本身。只问四件事：
1. 约束完整吗——合同只有带宽、有效算力、τ、SRAM 容量、面积五条预算；有没有一条决定 TPS/usr 的约束
   （例如功耗、KV 容量、网络带宽、其余 TP）被整个前沿讨论了却没进合同？
2. 口径对吗——规划与详细模型的结论有没有被混用（SRAM 那条只来自详细 K3 TP${TP}）、peak 与 sustained、
   MC320 与 MC640、1000 目标的预算与 1050 门槛的预算（前沿的 target 与 gateBudgetUs）有没有被混用？
3. 切分空间是不是被写窄了——切分只在发布点附近放宽单轴或等比放宽，MC 搜索止于 MC640、软件开关不重调；
   有没有一种切分形态（例如加带宽换 τ）被这个框架整个排除了，导致"选出来的"其实是唯一被考虑过的形态？
4. 三模型框架：详细模型只覆盖 K3；另外两个模型只受规划线约束，这一点是否在合同里被如实标出？
找不到实质缺口就写 FRAMING_OK 并给空数组——不要为了交差编一条。有实质缺口写 FRAMING_INSUFFICIENT。
框架缺口不阻止落盘，它们作为 open blocker 交给 architect。`,
  { label: 'framing-critic', phase: 'Framing review', effort: 'high', schema: FRAMING_SCHEMA })

// 修正一次之后仍然前沿外的数字。
const looseNumbers = [
  ...owners.flatMap((agentId, i) => looseInReview(reviews[i]).map((l) => ({ from: agentId, ...l }))),
  ...looseInSelection(selection).map((l) => ({ from: 'architect', ...l })),
]
const mechanicalChecks = { coverageGaps, chosenProblems, looseNumbers }

phase('Invariant check')

const check = await agent(
  `${head('invariant-checker')}

预算前沿头：
${JSON.stringify(frontierHead, null, 2)}

选中的合同（将原样从前沿拷贝落盘）：
${JSON.stringify(chosen ? chosen.contract : null, null, 2)}

专家可达性审读：
${JSON.stringify(reviews, null, 2)}

被否的切分：
${JSON.stringify(ruledOut, null, 2)}

architect 的选择：
${JSON.stringify(selection, null, 2)}

framing-critic 的审查：
${JSON.stringify(framing, null, 2)}

脚本已做的机械比对（你只确认，不得解释掉）：
${JSON.stringify(mechanicalChecks, null, 2)}

任务：逐条检点。只检点，不设计、不提改进建议。
- 每一份候选切分的每一条预算都被其 owner 判过（coverageGaps 非空即不守恒）。
- 选中的切分不在被否之列（chosenProblems 非空即不守恒）。
- 选中合同的 check.holds 成立，且 check.planning 与 check.detailed 的 rawUs 都不超过 check.budgetUs。
- 合同的 target 是 1000 目标的预算，不得被当成 1050 门槛的结论；合同不构成门控通过。
- B-MEM-BW 是持续 payload（sustained），不得与 MC 档位的 peak 混用；MC320 与 MC640 分离。
- 审读与选择里出现的每个数字，要么能在前沿里按切分 id / 条目 id / 字段路径找到，要么是专家可信区间并带出处；
  两者都不是的即不守恒，逐条列出（looseNumbers 是脚本找到的那部分，非空即不守恒；脚本只比对带小数点或至少三位的数，
  更小的数仍由你检）。
- 专家给出的可信区间若出处写的是 references/sota 下的知识文件，视为没有出处。
- 检点覆盖面必须声明：本次检了哪几条，哪几条因输入不足没检。拿不到检点所需输入时判不通过。`,
  { label: 'invariant-checker', phase: 'Invariant check', effort: 'high', schema: {
    type: 'object',
    additionalProperties: false,
    required: ['verdict', 'checks', 'coverage', 'violations'],
    properties: {
      verdict: { type: 'string', enum: ['INVARIANT_OK', 'INVARIANT_VIOLATED'] },
      checks: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['what', 'result', 'evidence'],
          properties: {
            what: { type: 'string' },
            result: { type: 'string', enum: ['holds', 'violated', 'input_missing'] },
            evidence: { type: 'string' },
            gap: { type: 'string' },
          },
        },
      },
      coverage: {
        type: 'object',
        additionalProperties: false,
        required: ['checked', 'notChecked'],
        properties: {
          checked: { type: 'array', items: { type: 'string' } },
          notChecked: { type: 'array', items: { type: 'string' } },
        },
      },
      violations: { type: 'array', items: { type: 'string' } },
    },
  } },
)

// 机械比对不通过时，检点者说 INVARIANT_OK 也不采纳：这几条不是判断题。
const mechanical = [
  ...coverageGaps,
  ...chosenProblems,
  ...(chosen && !(chosen.contract.check && chosen.contract.check.holds) ? [`选中的 ${chosen.splitId} 在模型上守不住预算`] : []),
  ...looseNumbers.map((l) => `${l.from} 的 ${l.where} 写了前沿外数字 ${l.number}（不在前沿里，也不在许可的 plausibleRange 里）`),
]
const okInvariants = Boolean(chosen && check && check.verdict === 'INVARIANT_OK' && !mechanical.length)

const ledgerPatch = {
  ...ledgerBase,
  strategyVersions: Object.fromEntries([...owners, 'architect', 'framing-critic', 'invariant-checker'].map((id) => [id, '1.0'])),
  openBlockers: [
    // 选中合同里判不了可达的条目：下游开工前要补上出处。
    ...chosenUnknown.map((e, i) => ({
      id: `REACH-REQ-BUDGET-${String(i + 1).padStart(2, '0')}`,
      owner: e.from,
      unblockCondition: `给出 ${selection.splitId}/${e.id} 物理可达的出处（当前 ${e.rangeEvidence}）`,
    })),
    ...((framing && framing.gaps) || []).map((g, i) => ({
      id: `FRAMING-REQ-BUDGET-${String(i + 1).padStart(2, '0')}`,
      owner: 'architect',
      unblockCondition: `补齐框架缺口（${g.kind}）：${g.detail}`,
    })),
  ],
}

// 落盘的合同是前沿里那一份的原样拷贝，外加选择记录；主循环去掉 selection 后与前沿逐字段比对。
const budget = chosen ? {
  ...chosen.contract,
  selection: {
    runId: RUN_ID,
    frontierPath: FRONTIER_PATH,
    frontierSha256: FRONTIER_SHA,
    chosenBy: 'architect',
    reachable: allowed,
    ruledOut: ruledOut.map((r) => r.splitId),
    openBlockers: ledgerPatch.openBlockers.map((b) => b.id),
  },
} : null

const runRecord = {
  stage: STAGE,
  runId: RUN_ID,
  frontier: { path: FRONTIER_PATH, sha256: FRONTIER_SHA, schemaVersion: FRONTIER.schemaVersion, sourceArtifacts: (FRONTIER.inputs || {}).sourceArtifacts || 'UNVERIFIED' },
  offered: offered.map((s) => s.splitId),
  kernelRuledOut,
  owners,
  reviews,
  ruledOut,
  selection,
  framing: framing || null,
  mechanicalChecks,
  invariantCheck: check,
}

return {
  stage: STAGE,
  runId: RUN_ID,
  verdict: okInvariants ? 'INVARIANT_OK' : 'INVARIANT_VIOLATED',
  splitId: selection.splitId,
  budget: okInvariants ? budget : null,
  rejectedBudget: okInvariants ? null : budget,
  violations: okInvariants ? [] : [...mechanical, ...((check && check.violations) || (check ? [] : ['检点未完成']))],
  coverage: check && check.coverage,
  ledgerPatch,
  runRecord,
  files: okInvariants
    ? [
        { path: `${REPO}/out/budget/L1_budget.json`, content: JSON.stringify(budget, null, 2) },
        { path: `${REPO}/out/budget/L1_run_record.json`, content: JSON.stringify(runRecord, null, 2) },
      ]
    : [],
}
