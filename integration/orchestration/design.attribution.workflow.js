export const meta = {
  name: 'design-attribution',
  description: 'K3 设计 L4 维度归因：灵敏度卡（确定性内核）逐行交给本行 owner 专家判物理可信区间，integrator 合并承重项与回标计划，invariant-checker 检点后落盘',
  whenToUse: '按维度参数化（args.dimension = sram | comm | joint）。需要 args.card（主循环用 npm run attribution:cards 生成、run_workflow.js 读入的灵敏度卡）。本 workflow 不计算任何数值、不写卡；只落盘专家对卡的审读。',
  phases: [
    { title: 'Card', detail: '核对卡与维度一致，按行 owner 分派；卡由 tps_attribution.js 生成，workflow 内没有 agent 参与取数' },
    { title: 'Expert review', detail: '每个 owner 专家只审自己的行：分类是否成立、盈亏点是否落在物理可信区间、先测什么' },
    { title: 'Merge', detail: 'integrator 合并承重项、富余项与回标计划，记录专家间冲突' },
    { title: 'Invariant check', detail: 'invariant-checker 强制检点；不通过则不落盘' },
  ],
}

// ---------------------------------------------------------------------------
// L4 维度归因（teams/council/docs/23_DESIGN_QUESTION_WORKFLOW_PROPOSAL.md §4）。
//
// 回答"这个维度的每个参数怎么影响 TPS/usr、承重的是哪几个"。分工：
//
// 1. 数全部来自卡。dTps、盈亏点、关键路径占比、分类都由 integration/detailed/tps_attribution.js
//    在详细模型上重放得到，主循环生成、run_workflow.js 读入并核对基线指纹后经 args.card 传入。
//    agent 只按行名引用卡里的行，不转写、不重算、不补数。
//
// 2. 卡里的分类是机械的（不利移动是否打破 raw 预算），它回答不了"这个盈亏点在物理上会不会
//    被碰到"——例如 τ 盈亏点离通路估计有多远。这一判断交给该行的 owner 专家，依其策略与知识给出
//    可信区间和出处；这正是 agent 在本格的价值，也是它唯一的产出。
//
// 3. 每个专家只看自己的行。看到别的域的行就会去评价别的域，旁证与越权的界线就没了。
//    software-expert 例外地多看一份承重行名单：它要回答哪些硬件结论依赖软件机制成立。
//
// 4. 卡外数字由脚本比对，不靠检点者肉眼：审读与合并里每个卡外数字必须在某个 plausibleRange 里，
//    plausibleRange 里的卡外数字必须在 rangeEvidence 所引的行上（后者由主循环 check_citations.js 核对）。
//    不合规的回到同一个 agent 修正一次，仍不合规即不守恒。
// ---------------------------------------------------------------------------

const REPO = args.repo || '.'
const STAGE = 'attribution'
const DIM = args.dimension
const CARD = args.card
const CARD_PATH = args.cardPath || 'UNVERIFIED'
const CARD_SHA = args.cardSha256 || 'UNVERIFIED'
const RUN_ID = args.runId || `attribution-${DIM}-run`
const DIMENSIONS = ['sram', 'comm', 'joint']
// 本格可分派的专家。卡里出现别的 owner 即视为卡与本 workflow 的契约不一致。
const EXPERTS = ['compute-expert', 'memory-expert', 'comm-expert', 'software-expert']

if (!DIMENSIONS.includes(DIM)) throw new Error(`design.attribution 需要 args.dimension ∈ {${DIMENSIONS.join(', ')}}，收到 ${DIM}`)
if (!CARD) {
  throw new Error('design.attribution 需要 args.card（主循环先跑 npm run attribution:cards，再由 run_workflow.js 读入）；本 workflow 不生成卡')
}

const HEAD = [
  `仓库根目录：${REPO}`,
  `本 workflow：design.attribution（dimension=${DIM}，runId=${RUN_ID}）`,
  `你是一个策略实例。先读你的策略正文：${REPO}/teams/council/strategies/__AGENT__.md`,
  '那份文件是本角色的判断规则、正确性判据、证据规则、取舍规则与禁止事项，逐条遵守。',
  '以下运行时上下文由 workflow 注入；注入内容与策略正文冲突时，注入内容优先（它承载本 stage 的事实）。',
  '你没有文件系统写权限。把该写的东西作为返回值交回，由 workflow 落盘。',
  '灵敏度卡是本格数值的唯一来源：按行名（parameters[].name）与字段路径引用，不得转写、改写、重算或补出卡里没有的数。',
  '你自己给出的物理可信区间必须带出处（文件路径:行号 或 ADR / blocker 编号）；没有出处的写 UNVERIFIED 并说明缺什么，不得静默补齐。',
  '不得输出 TPS/usr 或任何全局性能指标；不得输出 PASS / D_GATE_PASSED 字面量。',
].join('\n')

// 领域知识注入（知识不是证据），与 C 组同一形状：只注入路径。
const KNOWLEDGE = {
  'compute-expert': 'references/sota/compute-core.md',
  'memory-expert': 'references/sota/memory-subsystem.md',
  'comm-expert': 'references/sota/interconnect-collective.md',
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

// 卡外数字的机械比对。规则与 integration/pipelines/check_citations.js 的 numberTokens 相同（workflow 脚本
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
const rangeNumbers = (rowsWithRange) => (rowsWithRange || []).flatMap((r) => numberTokens(r.plausibleRange).map(Number))
// 卡外、也不在许可的可信区间里的数字：[{where, number}]。
const looseIn = (where, texts, allowed) => texts.flatMap((s) => numberTokens(s))
  .filter((t) => !CARD_NUMBERS.some((n) => sameNumber(t, n)) && !allowed.some((n) => sameNumber(t, n)))
  .map((number) => ({ where, number }))
const looseInReview = (review) => {
  if (!review) return []
  const all = rangeNumbers(review.rows)
  return [
    ...(review.rows || []).flatMap((r) => looseIn(`rows[${r.name}].reason`, [r.reason], rangeNumbers([r]))),
    ...looseIn('note', [review.note], all),
    ...(review.softwareDependence || []).flatMap((d) => looseIn(`softwareDependence[${d.name}]`, [d.dependsOn, d.reason], all)),
  ]
}
const repairNote = (loose, previous) => `

---
你上一次交回的结果里，下列数字既不在卡里，也不在许可的 plausibleRange 里（脚本机械比对）：
${loose.map((l) => `- ${l.where}：${l.number}`).join('\n')}
只改这些地方：删掉这些数字，或把它写进对应行的 plausibleRange 并在 rangeEvidence 给出含这个数的那一行。其余内容原样交回。
上一次的结果：
${JSON.stringify(previous, null, 2)}`

phase('Card')

// 卡与维度对不上、行的 owner 不在本格专家里：都是契约问题，交回主循环，不让 agent 去猜。
const rows = CARD.parameters || []
const strangers = [...new Set(rows.map((r) => r.owner))].filter((o) => !EXPERTS.includes(o))
if (CARD.dimension !== DIM || !rows.length || strangers.length) {
  return {
    stage: STAGE,
    runId: RUN_ID,
    verdict: 'BLOCKED_CONFIG',
    reason: CARD.dimension !== DIM ? `卡的 dimension=${CARD.dimension} 与 args.dimension=${DIM} 不符`
      : !rows.length ? '卡没有参数行' : `卡里的 owner 不在本格可分派的专家中：${strangers.join(', ')}`,
    cardPath: CARD_PATH,
    files: [],
  }
}

// 卡头：所有专家共享的上下文（问题、设计点、预算、关键路径与占用、分类口径、维度内联合悲观、
// 约束墙、耦合移动、注意事项）。耦合移动回答"单行分不清代价归谁"，与行分类无关，但专家判区间时要看。
const cardHead = {
  dimension: CARD.dimension,
  question: CARD.question,
  status: CARD.status,
  cardPath: CARD_PATH,
  inputs: CARD.inputs,
  published: CARD.published,
  criticalPath: CARD.criticalPath,
  classes: CARD.classes,
  jointPessimistic: CARD.jointPessimistic,
  bindingConstraints: CARD.bindingConstraints,
  couplings: CARD.couplings,
  caveats: CARD.caveats,
}
const loadBearingNames = CARD.loadBearing || []
const CARD_NUMBERS = numbersIn(CARD)
const owners = [...new Set([...rows.map((r) => r.owner), 'software-expert'])]
const rowsOf = (agentId) => rows.filter((r) => r.owner === agentId)
log(`卡 ${CARD_PATH}：${rows.length} 行，承重 ${loadBearingNames.length} 行；分派给 ${owners.join(', ')}`)

phase('Expert review')

const REVIEW_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['from', 'rows', 'verdict'],
  properties: {
    from: { type: 'string', description: '审读者 agentId' },
    rows: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['name', 'classification', 'plausibleRange', 'rangeEvidence', 'breakEvenInsideRange', 'measurementPriority', 'reason'],
        properties: {
          name: { type: 'string', description: '卡里 parameters[].name，原样' },
          classification: { type: 'string', enum: ['agree', 'disagree'], description: '是否同意卡里的机械分类' },
          plausibleRange: { type: 'string', description: '该参数在目标工艺 / 通路下物理上可信的取值范围，或 UNVERIFIED' },
          rangeEvidence: { type: 'string', description: '可信区间的出处：文件路径:行号、ADR 或 blocker 编号，或 UNVERIFIED' },
          breakEvenInsideRange: {
            type: 'string',
            enum: ['yes', 'no', 'unknown', 'not_applicable'],
            description: '卡里该行的盈亏点（或打破预算的不利移动）是否落在可信区间内；行没有盈亏点也没有打破预算的移动时写 not_applicable',
          },
          measurementPriority: { type: 'string', enum: ['high', 'medium', 'low'], description: '先拿哪项实测；依据是承重程度与离盈亏点的距离' },
          reason: { type: 'string', description: '按行名与字段路径引用卡，不转写数值' },
        },
      },
    },
    softwareDependence: {
      type: 'array',
      description: '仅 software-expert：哪些承重行的结论依赖某个软件机制成立',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['name', 'dependsOn', 'reason'],
        properties: { name: { type: 'string' }, dependsOn: { type: 'string' }, reason: { type: 'string' } },
      },
    },
    verdict: { type: 'string', enum: ['LOCAL_DETAIL_FIX', 'DIRECTION_BACKFLOW', 'BLOCKED_CONFIG'] },
    blockedFields: { type: 'array', items: { type: 'string' } },
    note: { type: 'string' },
  },
}

const reviewPrompt = (agentId) => {
  const own = rowsOf(agentId)
  const extra = agentId === 'software-expert'
    ? `\n本卡的承重行名单（仅供判断软件依赖；这些行不由你审分类，除非它们也在你的行里）：\n${JSON.stringify(loadBearingNames)}\n`
    : ''
  return `${head(agentId)}

灵敏度卡头（共享上下文，数值的唯一来源）：
${JSON.stringify(cardHead, null, 2)}

你负责的行（parameters 中 owner=${agentId} 的 ${own.length} 行）：
${JSON.stringify(own, null, 2)}
${extra}
任务：逐行审读，rows 里必须恰好覆盖上面每一行，不多不少。
- classification：同意 / 不同意卡里的机械分类（classes 给出口径）。不同意时说明是哪一个 move 的哪一项让你不同意；
  分类本身由脚本算，你不同意不会改卡，只会作为冲突交给 integrator。
- plausibleRange + rangeEvidence：该参数在目标工艺 / 通路 / 软件栈下物理上可信的范围。这是卡里没有、
  只有你能给的东西；给不出出处就写 UNVERIFIED，不要凭印象给一个"行业通常值"。
- breakEvenInsideRange：卡里 breakEven 或打破预算的不利移动，是否落在你的可信区间内。落在区间内意味着
  这个参数在现实里可能碰到盈亏点，是真正承重的。
- measurementPriority 与 reason：先要哪项实测（卡里 measurementNeeded 给出了要什么数据）。
- 两个参数撞同一道约束、或一个机制在移动时被固定为发布值时，先看卡头 couplings 有没有这一对（按 name 引用）；
  卡里没有的耦合才写成"缺什么"，不要自己估联合效应。
- 引用仓库文件时写 文件路径:行号，行号必须指向写有该内容的那一行（主循环会机械核对：指向空行、表格边框 / 代码围栏这类没有文字的行或越界，即整次不落盘）。
  引用卡时写字段路径，不写卡的行号。
- 数字的规则（脚本逐个机械比对）：
  · plausibleRange 里每个卡外的数字，必须原样出现在 rangeEvidence 所引的某一行上（主循环核对，不过即不落盘）；
  · reason、note、softwareDependence 里只许出现卡里有的数字，或本行（note / softwareDependence 为你任一行）plausibleRange 里的数字。
    要用一个卡外的数（例如某个文档里的字节数、某个 MC 档位），先把它写进该行 plausibleRange 并给出含这个数的那一行作出处。
- 只审你的行，不评价别的域；不要提设计改动建议，那是 L3 的事。
${agentId === 'software-expert' ? '- softwareDependence：承重名单里哪些行的结论依赖某个软件机制（OPT 开关）成立；卡在每次移动时 OPT 保持发布值不重调（见 caveats）。\n' : ''}- verdict：LOCAL_DETAIL_FIX（审读完成）/ BLOCKED_CONFIG（卡缺什么才审得了，列在 blockedFields）。
  若审读结论动摇了方向级假设（例如承重参数的可信区间整体落在预算外），用 DIRECTION_BACKFLOW 并说明是哪一行。`
}

const firstReviews = await parallel(owners.map((agentId) => () =>
  agent(reviewPrompt(agentId), { label: `review:${agentId}`, phase: 'Expert review', effort: 'high', schema: REVIEW_SCHEMA })))

// 卡外数字只给一次修正机会：带着脚本列出的数字和上一次结果回到同一个专家。修正交不回来就沿用原结果，
// 剩下的卡外数字进入机械比对，由检点者确认、不落盘。
const reviews = await parallel(owners.map((agentId, i) => async () => {
  const first = firstReviews[i]
  const loose = first && first.verdict === 'LOCAL_DETAIL_FIX' ? looseInReview(first) : []
  if (!loose.length) return first
  log(`${agentId} 的审读有 ${loose.length} 个卡外数字：${loose.map((l) => l.number).join(', ')}；修正一次`)
  const again = await agent(reviewPrompt(agentId) + repairNote(loose, first),
    { label: `repair:${agentId}`, phase: 'Expert review', effort: 'high', schema: REVIEW_SCHEMA })
  return again && again.verdict === 'LOCAL_DETAIL_FIX' ? again : first
}))

// 缺席不是"没有意见"：缺一路，那一路的行就没有人判过可信区间，合并者会把它当成没问题。
const absent = owners.filter((_, i) => !reviews[i])
if (absent.length) {
  log(`专家审读缺 ${absent.length} 路：${absent.join(', ')}；退回，不合并`)
  return {
    stage: STAGE,
    runId: RUN_ID,
    verdict: 'BLOCKED_CONFIG',
    reason: `专家审读不完整，缺：${absent.join(', ')}；缺席一侧的行没有人判过可信区间`,
    absent,
    nextActions: absent.map((agentId) => `补齐 ${agentId} 对 ${CARD_PATH} 中其负责行的审读后重跑本格`),
    files: [],
  }
}
const backflow = reviews.find((r) => r.verdict === 'DIRECTION_BACKFLOW')
if (backflow) {
  return { stage: STAGE, runId: RUN_ID, verdict: 'DIRECTION_BACKFLOW', reason: `${backflow.from} 报方向回退：${backflow.note || ''}`, reviews, files: [] }
}
const blocked = reviews.filter((r) => r.verdict === 'BLOCKED_CONFIG')
if (blocked.length) {
  return {
    stage: STAGE,
    runId: RUN_ID,
    verdict: 'BLOCKED_CONFIG',
    reason: `审读输入不足：${blocked.map((r) => r.from).join(', ')}`,
    blockedFields: blocked.flatMap((r) => r.blockedFields || []),
    reviews,
    files: [],
  }
}

// 覆盖面是机械可核对的：每个专家交回的行名必须恰好等于派给它的行名。
// 不交给 agent 判断——漏审的行由脚本指出，检点者只确认，不解释。
const coverageGaps = owners.flatMap((agentId, i) => {
  const want = rowsOf(agentId).map((r) => r.name)
  const got = (reviews[i].rows || []).map((r) => r.name)
  return [
    ...want.filter((n) => !got.includes(n)).map((n) => `${agentId} 漏审 ${n}`),
    ...got.filter((n) => !want.includes(n)).map((n) => `${agentId} 审了不属于它的行 ${n}`),
  ]
})
if (coverageGaps.length) log(`审读覆盖缺口 ${coverageGaps.length} 处：${coverageGaps.join('; ')}`)

phase('Merge')

const MERGE_PROMPT = `${head('integrator')}

灵敏度卡头（数值的唯一来源）：
${JSON.stringify(cardHead, null, 2)}

卡里全部行的机械分类（行名 → 分类 / owner / evidence / measurementNeeded）：
${JSON.stringify(rows.map((r) => ({ name: r.name, owner: r.owner, classification: r.classification, evidence: r.evidence, measurementNeeded: r.measurementNeeded })), null, 2)}

各 owner 专家的审读：
${JSON.stringify(reviews, null, 2)}

任务：合并成本维度的归因结论。你不得新增行、不得修改或转写卡里的数值，只按行名引用。
- loadBearing：承重行。卡里分类为 loadBearing 的行，以及专家判 breakEvenInsideRange=yes 的行，都要逐一出现；
  每行写清依据来自卡（哪个字段）还是来自专家（哪个 agentId 的可信区间与出处）。
  卡判承重而专家不同意的，照样列入，并在 conflicts 里记录，不得自行裁掉。
- slack：卡里分类为 slack 且无专家异议的行，以及专家给出理由认为可让出面积 / 功耗的行。
- measurementPlan：每个承重行都要有一条：owner、要什么数据（取自卡的 measurementNeeded，可由专家补充）、优先级。
- conflicts：专家与卡的分类不一致、或专家之间对同一参数的判断不一致，逐条记录，不得抹平。
${DIM === 'joint' ? '- routing：卡里 jointPessimistic.routing 是脚本按"去掉哪一维恢复最多"算的回流目标；你只转述它的 routeTo 与 owner，若专家审读与之冲突，记入 conflicts，不得改写。\n' : ''}- 卡与基线之间、或专家引用的出处之间有无法归因的差异时，用 DELTA_UNEXPLAINED 交回，不要靠合并掩盖。
- 数字的规则（脚本逐个机械比对）：你写的每个字段里只许出现卡里有的数字，或某位专家 plausibleRange 里的数字；
  别的数一律不写，按行名、字段路径或专家 agentId 指过去。
- 不要判定检点是否成立——那是下一步的事。`

const MERGE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['loadBearing', 'slack', 'measurementPlan', 'conflicts', 'verdict'],
  properties: {
    loadBearing: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['name', 'owner', 'basis', 'source'],
        properties: {
          name: { type: 'string' },
          owner: { type: 'string' },
          basis: { type: 'string', enum: ['card', 'expert', 'card_and_expert'] },
          source: { type: 'string', description: '卡字段路径，或 agentId + 可信区间出处' },
        },
      },
    },
    slack: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['name', 'owner', 'source'],
        properties: { name: { type: 'string' }, owner: { type: 'string' }, source: { type: 'string' } },
      },
    },
    measurementPlan: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['name', 'owner', 'measurement', 'priority'],
        properties: {
          name: { type: 'string' },
          owner: { type: 'string' },
          measurement: { type: 'string' },
          priority: { type: 'string', enum: ['high', 'medium', 'low'] },
        },
      },
    },
    routing: {
      type: 'object',
      additionalProperties: false,
      required: ['routeTo', 'owner'],
      properties: { routeTo: { type: 'string' }, owner: { type: 'string' } },
    },
    conflicts: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['row', 'between', 'resolution'],
        properties: { row: { type: 'string' }, between: { type: 'string' }, resolution: { type: 'string' } },
      },
    },
    verdict: { type: 'string', enum: ['INTEGRATION_OK', 'DELTA_UNEXPLAINED'] },
    deltaNote: { type: 'string' },
  },
}

// 合并结果的数字许可：卡里的数，加上任一专家可信区间里的数（rangeEvidence 已在主循环逐行核对）。
const expertRangeNumbers = reviews.flatMap((r) => rangeNumbers(r.rows))
const looseInMerge = (m) => (m ? looseIn('merge', textsOf(m), expertRangeNumbers) : [])
const firstMerge = await agent(MERGE_PROMPT, { label: 'integrator', phase: 'Merge', effort: 'high', schema: MERGE_SCHEMA })
let merged = firstMerge
const mergeLoose = firstMerge && firstMerge.verdict === 'INTEGRATION_OK' ? looseInMerge(firstMerge) : []
if (mergeLoose.length) {
  log(`合并结果有 ${mergeLoose.length} 个卡外数字：${mergeLoose.map((l) => l.number).join(', ')}；修正一次`)
  const again = await agent(MERGE_PROMPT + repairNote(mergeLoose, firstMerge),
    { label: 'repair:integrator', phase: 'Merge', effort: 'high', schema: MERGE_SCHEMA })
  if (again && again.verdict === 'INTEGRATION_OK') merged = again
}

if (!merged || merged.verdict !== 'INTEGRATION_OK') {
  return {
    stage: STAGE,
    runId: RUN_ID,
    verdict: (merged && merged.verdict) || 'DELTA_UNEXPLAINED',
    reason: (merged && merged.deltaNote) || '合并未完成，交回上游归因',
    merge: merged,
    reviews,
    files: [],
  }
}

// 承重行名单的机械比对：卡判承重的行必须全部出现在合并结果里（专家不同意也要列）。
const droppedLoadBearing = loadBearingNames.filter((n) => !(merged.loadBearing || []).some((l) => l.name === n))
const unplanned = (merged.loadBearing || []).filter((l) => !(merged.measurementPlan || []).some((m) => m.name === l.name)).map((l) => l.name)
// 修正一次之后仍然卡外的数字。
const looseNumbers = [
  ...owners.flatMap((agentId, i) => looseInReview(reviews[i]).map((l) => ({ from: agentId, ...l }))),
  ...looseInMerge(merged).map((l) => ({ from: 'integrator', ...l })),
]
const mechanicalChecks = { coverageGaps, droppedLoadBearing, unplannedLoadBearing: unplanned, looseNumbers }

phase('Invariant check')

const check = await agent(
  `${head('invariant-checker')}

灵敏度卡头：
${JSON.stringify(cardHead, null, 2)}

卡里全部行（行名 → 分类 / owner / evidence / measurementNeeded）：
${JSON.stringify(rows.map((r) => ({ name: r.name, owner: r.owner, classification: r.classification, evidence: r.evidence, measurementNeeded: r.measurementNeeded })), null, 2)}

专家审读：
${JSON.stringify(reviews, null, 2)}

合并结果（待检点）：
${JSON.stringify(merged, null, 2)}

脚本已做的机械比对（你只确认，不得解释掉）：
${JSON.stringify(mechanicalChecks, null, 2)}

任务：逐条检点。只检点，不设计、不提改进建议。
- 每一行都被其 owner 审过（coverageGaps 非空即不守恒）。
- 卡判承重的行全部出现在 loadBearing 里（droppedLoadBearing 非空即不守恒）。
- 每个承重行都有 owner、卡里的 evidence 与一条 measurementPlan（unplannedLoadBearing 非空即不守恒）。
- 审读与合并里出现的每个数字，要么能在卡里按行名 / 字段路径找到，要么是专家可信区间并带出处；
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
  ...droppedLoadBearing.map((n) => `承重行 ${n} 未进入合并结果`),
  ...unplanned.map((n) => `承重行 ${n} 没有回标计划`),
  ...looseNumbers.map((l) => `${l.from} 的 ${l.where} 写了卡外数字 ${l.number}（不在卡里，也不在许可的 plausibleRange 里）`),
]
const okInvariants = Boolean(check && check.verdict === 'INVARIANT_OK' && !mechanical.length)

const ledgerPatch = {
  currentStage: STAGE,
  strategyVersions: Object.fromEntries([...owners, 'integrator', 'invariant-checker'].map((id) => [id, '1.0'])),
  // 本格不否决方案，只给承重判断；被否的东西由 L3 / L1-b 回流时写入。
  rejectedOptions: [],
  openBlockers: (merged.conflicts || []).map((c, i) => ({
    id: `CONFLICT-ATTRIBUTION-${DIM.toUpperCase()}-${String(i + 1).padStart(2, '0')}`,
    owner: 'integrator',
    unblockCondition: c.resolution,
  })),
}

const review = {
  schemaVersion: 'attribution-review-v0.1',
  dimension: DIM,
  runId: RUN_ID,
  card: { path: CARD_PATH, sha256: CARD_SHA, baselineSha256: (CARD.inputs || {}).baselineSha256 || 'UNVERIFIED', schemaVersion: CARD.schemaVersion },
  loadBearing: merged.loadBearing,
  slack: merged.slack,
  measurementPlan: merged.measurementPlan,
  routing: merged.routing || null,
  conflicts: merged.conflicts,
}

const runRecord = {
  stage: STAGE,
  dimension: DIM,
  runId: RUN_ID,
  card: review.card,
  owners,
  reviews,
  mechanicalChecks,
  merge: merged,
  invariantCheck: check,
}

return {
  stage: STAGE,
  runId: RUN_ID,
  verdict: okInvariants ? 'INVARIANT_OK' : 'INVARIANT_VIOLATED',
  review: okInvariants ? review : null,
  rejectedReview: okInvariants ? null : review,
  violations: okInvariants ? [] : [...mechanical, ...((check && check.violations) || (check ? [] : ['检点未完成']))],
  coverage: check && check.coverage,
  ledgerPatch,
  runRecord,
  files: okInvariants
    ? [
        { path: `${REPO}/out/attribution/reviews/${DIM}_review.json`, content: JSON.stringify(review, null, 2) },
        { path: `${REPO}/out/attribution/reviews/${DIM}_run_record.json`, content: JSON.stringify(runRecord, null, 2) },
      ]
    : [],
}
