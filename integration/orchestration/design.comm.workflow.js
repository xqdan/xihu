export const meta = {
  name: 'design-comm',
  description: 'K3 设计 comm 域：专家提搜索策略与守恒判据，确定性脚本枚举打分，integrator 合并，invariant-checker 检点后落盘',
  whenToUse: 'C 组四域的标准骨架。需要 args.brief（intake 产出的 DesignBrief）args.searchArtifact（主循环已生成好的搜索结果路径，仅作记录）与 args.searchBrief（search_brief.js 核验过的候选集）。本 workflow 不执行搜索、不写文件。',
  phases: [
    { title: 'Search policy', detail: 'comm-expert 按搜索策略线程分头提搜哪些维度、哪些必须排除、按什么排序' },
    { title: 'Deterministic search', detail: '由脚本枚举并打分，并由 search_brief.js 读取核验；workflow 内没有 agent 参与取数' },
    { title: 'Constraint recall', detail: 'memory / physical 专家对候选集给出侧向约束' },
    { title: 'Merge', detail: 'integrator 合并候选，记录冲突与排除依据' },
    { title: 'Invariant check', detail: 'invariant-checker 强制检点；不通过则不落盘' },
  ],
}

// ---------------------------------------------------------------------------
// C 组骨架。与 intake 的两点关键区别：
//
// 1. 决定性的数字不由 agent 产生。搜索维度与排序判据由 comm-expert 给出，
//    但枚举与打分必须由集成在仓库里的确定性脚本执行——脚本产物里带设计空间 sha256，
//    用来证明"这批候选是从哪份空间搜出来的"。LLM 只在脚本产物之上做取舍解释。
//
// 2. 最后一步是检点，不是总结。检点不通过就退回且不落盘 winner——
//    integrator（合并者）与 invariant-checker（检点者）必须是两次 agent 调用，
//    合并者对自己拼出的结果有结构性偏好，让它兼任检点，违规项会被解释掉。
//
// 本文件是 design.compute 的 comm 域副本。骨架部分逐字保留：workflow 脚本没有文件系统
// 权限、不能 require，仓库里刻意不为骨架提供共享模块——四个域各持一份完整骨架，
// 这样任何一个域要改判据都不必先动另外三个域。改动只允许发生在域相关的常量与 prompt 正文。
// ---------------------------------------------------------------------------

const REPO = args.repo || '.'
const STAGE = 'comm'
const BRIEF = args.brief
const RUN_ID = args.runId || 'comm-run'
const MAX_CANDIDATES = args.maxCandidates || 12
// 搜索产物由**主循环**在调用本 workflow 之前产生，路径经 args 传入。
// 这里刻意不接收命令、也不让 agent 去执行命令：搜索脚本会写 out/，
// 而 workflow agent 全程只读是仓库的硬护栏。让 agent 跑脚本等于为了拿候选集
// 而开口子，口子一开，policy 里所有只读声明都会失效。
// 主循环侧的调用顺序：跑搜索 → 跑 workflow 并传入候选集 → 落盘 workflow 返回的 files。
const SEARCH_ARTIFACT = args.searchArtifact
const SEARCH_COMMAND_FOR_RECORD = args.searchCommand || 'UNVERIFIED'
// 已核验的候选集（search_brief.js brief 的输出）；workflow 不自己读产物，也不让 agent 转写数值。
const SEARCH_BRIEF = args.searchBrief

if (!BRIEF) throw new Error('design.comm 需要 args.brief（intake 阶段产出的 DesignBrief）')
if (!SEARCH_ARTIFACT) {
  throw new Error('design.comm 需要 args.searchArtifact（已由主循环生成好的搜索结果路径）；本 workflow 不执行搜索')
}
if (!SEARCH_BRIEF) {
  throw new Error('design.comm 需要 args.searchBrief（主循环用 node integration/pipelines/search_brief.js brief comm 生成）；本 workflow 不读搜索产物')
}
if (BRIEF.stage !== 'comm') {
  // brief 的 stage 与 workflow 名称必须一致，否则会把别的阶段的契约拿来用
  throw new Error(`brief.stage=${BRIEF.stage}，与 design.comm 不符；契约串了`)
}

const HEAD = [
  `仓库根目录：${REPO}`,
  `本 workflow：design.comm（stage=${STAGE}，runId=${RUN_ID}）`,
  `你是一个策略实例。先读你的策略正文：${REPO}/teams/council/strategies/__AGENT__.md`,
  '那份文件是本角色的判断规则、正确性判据、证据规则、取舍规则与禁止事项，逐条遵守。',
  '以下运行时上下文由 workflow 注入；注入内容与策略正文冲突时，注入内容优先（它承载本 stage 的事实）。',
  '你没有文件系统写权限。把该写的东西作为返回值交回，由 workflow 落盘。',
  '所有数字必须带出处（文件路径:行号 或 ADR 编号）；没有出处的写 UNVERIFIED 并说明缺什么，不得静默补齐。',
  '不得输出 TPS/usr 或任何全局性能指标；不得输出 PASS / D_GATE_PASSED 字面量。',
].join('\n')

// 领域知识注入（知识不是证据）—— 见 design.compute 里的同名说明。
// 注入的是**路径**不是正文：一份来源，各自自读；抄进 prompt 就多出一份会漂移的副本。
const KNOWLEDGE = {
  'comm-expert': 'references/sota/interconnect-collective.md',
  'memory-expert': 'references/sota/memory-subsystem.md',
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

// 旁证约束的标准契约。四个域共用同一形状，这样一条约束在不同域之间传递时
// 不需要翻译，也不会因为字段名不同而被当成两回事。
// 关键点是 constraintId 必须引用 brief 里已有的硬约束——旁证是**转述约束**，
// 不是发明约束；发明出来的约束没有出处，下游无法复核也就无法执行。
const CONSTRAINT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['from', 'constraints', 'verdict'],
  properties: {
    from: { type: 'string', description: '给出约束的 agentId' },
    constraints: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['text', 'rulesOut', 'constraintId', 'evidence'],
        properties: {
          text: { type: 'string', description: '这条约束是什么' },
          rulesOut: {
            type: 'string',
            description: '它否掉哪个 candidateId、哪种取值，或哪一类候选；必须具体到能被机械核对',
          },
          constraintId: {
            type: 'string',
            description: '对应 brief.hardConstraints 里的 id；若本域新增则写 NEW',
          },
          evidence: { type: 'string', description: '规格文件路径:行号、ADR 编号，或 UNVERIFIED' },
        },
      },
    },
    verdict: {
      type: 'string',
      enum: ['LOCAL_DETAIL_FIX', 'DIRECTION_BACKFLOW', 'PPA_DIRECTION_BACKFLOW', 'BLOCKED_CONFIG'],
    },
    blockedFields: { type: 'array', items: { type: 'string' } },
    note: { type: 'string' },
  },
}

// 搜索策略线程：主专家按线程分头出策略。线程名只标识**这一路的取证角度**，
// 不是设计空间里的维度名——维度名由脚本产物回答，这里写死等于让 workflow 替专家枚举。
// 数量由 MAX_CANDIDATES 封顶，逐个 agent 调用，互不串味。
const SEARCH_THREADS = [
  { threadId: 'T1', scope: 'placement / floorplan 落点：Comm Core 摆在 mesh 的哪个位置，以及它对 hop 数、对 gateway 与 Reduce 引擎邻近性的后果' },
  { threadId: 'T2', scope: 'trigger / doorbell：一次集合通信由谁触发、谁敲 NIC 的门，以及触发的等待语义' },
  { threadId: 'T3', scope: 'wqeGeneration / txLanes：谁写 RDMA 描述符、描述符从哪展开、发射通道要几条' },
  { threadId: 'T4', scope: 'commitCounting / 完成路径：入站 commit 怎么数、group ACK 与 timeout 怎么收口' },
  { threadId: 'T5', scope: 'graphStore / localSramKiB：collective graph 存哪、放几份、模板 SRAM 要多大' },
  { threadId: 'T6', scope: 'signal / 内存语义：信号怎么搭在 put 上、远端访问的口径、generation 与 stale epoch 的丢弃' },
  { threadId: 'T7', scope: 'managementCores / 固件位置：管理核要几个、固件作业落在关键路径上的代价' },
  { threadId: 'T8', scope: '代价口径：本域的面积与功耗分项怎么算、含不含通道缩放、证据等级到哪一档' },
]

const THREADS = Math.max(1, Math.min(MAX_CANDIDATES, SEARCH_THREADS.length))
const activeThreads = SEARCH_THREADS.slice(0, THREADS)

const POLICY_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['dims', 'excluded', 'ranking', 'invariants', 'verdict'],
  properties: {
    dims: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['name', 'why'],
        properties: { name: { type: 'string' }, why: { type: 'string' } },
      },
    },
    evaluationAxes: {
      type: 'array',
      description: '评估轴：每个候选都要逐项评估、但不是自由度的轴（例如逐模型、逐 kernel）。不进 dims，不参与“搜索未覆盖”的比对',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['name', 'why'],
        properties: { name: { type: 'string' }, why: { type: 'string' } },
      },
    },
    excluded: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['name', 'constraintId'],
        properties: { name: { type: 'string' }, constraintId: { type: 'string' } },
      },
    },
    ranking: { type: 'array', items: { type: 'string' } },
    invariants: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['what', 'compareAgainst', 'ifViolated'],
        properties: {
          what: { type: 'string' },
          compareAgainst: { type: 'string' },
          ifViolated: { type: 'string' },
        },
      },
    },
    verdict: { type: 'string', enum: ['LOCAL_DETAIL_FIX', 'DIRECTION_BACKFLOW', 'BLOCKED_CONFIG'] },
    blockedFields: { type: 'array', items: { type: 'string' } },
  },
}

phase('Search policy')

// 第一步：专家只产出搜索策略，不产出数字。
// 把维度收窄是控制成本的唯一手段，所以这一步的产出直接决定下一步跑多少组合。
// 分头出策略是刻意的：单个 agent 面对十个维度会给出一个笼统的排序，
// 而本域的取舍恰恰落在"哪两维必须一起搜"上（例如落点与 hop 数、触发与固件位置）。
const policyThreads = await parallel(
  activeThreads.map((t) => () =>
    agent(
      `${head('comm-expert')}

brief（本 stage 的注入契约，逐字段遵守）：
${BRIEF_JSON}

本次搜索策略线程：${t.threadId}
本线程的取证范围：${t.scope}

任务：给出本域这一路的搜索策略。你不要计算任何数值——枚举与打分由确定性脚本执行。

把设计空间收窄到可跑的范围：
- dims：本次要搜的维度，逐个说明为什么它在这次 brief 的约束下值得搜。
  只放真正可枚举、可取舍的自由度。“每个候选都要逐模型 / 逐 kernel 评估”这类评估轴不是自由度，写进 evaluationAxes，不要写进 dims。
- excluded：本次不搜的维度或取值，逐个说明被哪条硬约束排除（引用 brief 里 hardConstraints 的 id）。
  排除必须引用约束，不得写"影响不大"这类不可复核的理由。
- ranking：候选排序判据，按优先级排列。必须与 brief 的 objective 一致，不得自行引入新维度。
- invariants：本域在打分后必须成立的守恒关系与口径约束，作为检点清单交给下一步。
  每条写清：检什么、拿什么比、不成立意味着什么。这些是检点者的判据，所以要可机械核对。
- verdict：LOCAL_DETAIL_FIX（可继续）/ BLOCKED_CONFIG（输入不足，列出缺什么）。
  若本域结论动摇了方向级假设，用 DIRECTION_BACKFLOW 并说明动摇了哪条。

只回答本线程这一路的问题。别的线程会回答别的路，你越界给出的维度和判据会被 reducer 丢弃。`,
      { label: `search-policy:${t.threadId}`, phase: 'Search policy', effort: 'high', schema: POLICY_SCHEMA },
    ),
  ),
)

const liveThreads = policyThreads.filter(Boolean)
if (liveThreads.length < policyThreads.length) {
  log(`缺 ${policyThreads.length - liveThreads.length} 条策略线程的搜索策略；其余线程取并集，结论只对已返回的线程成立`)
}

// 线程之间只做并集：dims / excluded / ranking 取线程给出的并集，invariants 全部保留。
// 这里不做取舍判断——哪条判据更重要由专家说，脚本不替它排优先级。
const policyBackflow = liveThreads.find((p) => p.verdict === 'DIRECTION_BACKFLOW')

// 方向级问题不在本域解决：继续跑只会产出一份建立在错前提上的 winner。
if (!liveThreads.length || policyBackflow) {
  return {
    stage: STAGE,
    runId: RUN_ID,
    verdict: (policyBackflow && policyBackflow.verdict) || 'BLOCKED_CONFIG',
    reason: '搜索策略阶段报方向回退或无有效策略，未执行确定性搜索',
    blockedFields: (policyBackflow && policyBackflow.blockedFields) || [],
    files: [],
  }
}

const policy = {
  dims: liveThreads.flatMap((p) => p.dims || []),
  evaluationAxes: liveThreads.flatMap((p) => p.evaluationAxes || []),
  excluded: liveThreads.flatMap((p) => p.excluded || []),
  // ranking 是全局判据，多份排序拼起来没有意义：取第一条非空，其余留痕在 policyThreads 里
  ranking: (liveThreads.find((p) => (p.ranking || []).length) || { ranking: [] }).ranking,
  invariants: liveThreads.flatMap((p) => p.invariants || []),
  verdict: liveThreads.some((p) => p.verdict === 'LOCAL_DETAIL_FIX') ? 'LOCAL_DETAIL_FIX' : 'BLOCKED_CONFIG',
  blockedFields: liveThreads.flatMap((p) => p.blockedFields || []),
  threads: liveThreads.length,
}

if (policy.verdict === 'BLOCKED_CONFIG') {
  log(`BLOCKED_CONFIG：缺 ${(policy.blockedFields || []).length} 个字段，停止搜索`)
  return {
    stage: STAGE,
    runId: RUN_ID,
    verdict: 'BLOCKED_CONFIG',
    reason: '输入不足，未执行确定性搜索',
    blockedFields: policy.blockedFields || [],
    policy,
    files: [],
  }
}

log(`搜索策略：${policy.threads} 条线程，搜 ${policy.dims.length} 个维度，排除 ${policy.excluded.length} 项，检点 ${policy.invariants.length} 条`)

phase('Deterministic search')

// 第二步：读确定性搜索的产物。产物已由主循环生成，本 workflow 不执行任何写操作。
// 产物必须自带候选明细与设计空间 sha256——
// 只有 winner 的产物无法让 integrator 复核排除理由，所以缺候选明细即视为产物不合格。
// 这不是形式要求：上一轮 integrator 报出的候选集来自脚本 stdout，事后无法从任何
// 落盘产物复核，导致"每条排除理由都可追溯"这个声明本身不可验证。
// 第二步（确定性，没有 agent）：搜索产物由主循环用 integration/pipelines/search_brief.js 读取、
// 核验并取前 N 个候选，经 args.searchBrief 传入。这一步以前由一个 agent 把候选数值转写出来——
// 转写者是 LLM，而这些数值是后面合并、旁证、检点全部裁决唯一的数字来源，却没有任何东西
// 核对"转写 = 原文"。现在取回、指纹核对（设计空间哈希 + 重跑搜索）都在脚本里完成，
// workflow 只消费结果；落盘之后由 `search_brief.js verify` 再核对 winner 是否为产物里的一行。
//
// uncoveredDims 是机械比对：策略点名的维度，在产物的设计空间维度名里找不到（忽略大小写与符号、
// 允许子串）即记为未覆盖。它只用来在日志与 runRecord 里提示，不拦截流程。
const dimNorm = (s) => String(s).toLowerCase().replace(/[^\p{L}\p{N}]/gu, '')
const designDims = (SEARCH_BRIEF.dimensions || []).map(dimNorm)
const search = {
  ...SEARCH_BRIEF,
  candidates: SEARCH_BRIEF.candidates || [],
  uncoveredDims: policy.dims.map((d) => d.name).filter((name) => {
    const n = dimNorm(name)
    return n !== '' && !designDims.some((x) => x.includes(n) || n.includes(x))
  }),
}

if (!search || !search.ok) {
  return {
    stage: STAGE,
    runId: RUN_ID,
    verdict: 'BLOCKED_CONFIG',
    reason: '确定性搜索产物不可用（缺失、不可解析，或不含候选明细）；不以估算代替',
    searchNode: search,
    policy,
    files: [],
  }
}

// 覆盖缺口不静默：策略要求搜的维度脚本没搜，等于这批候选回答的不是同一个问题。
if (search.uncoveredDims && search.uncoveredDims.length) {
  log(`搜索未覆盖策略要求的维度：${search.uncoveredDims.join(', ')}；结论只对已覆盖维度成立`)
}
// 可行 0 个不等于候选表是空的：搜索产物会列出全部候选（含不可行的），
// 所以必须看 feasibleCandidates，而不是只看表有没有行。
if (!search.candidates.length || search.feasibleCandidates === 0) {
  log('可行候选为 0；交回上游，不在本域硬凑一个 winner')
  return {
    stage: STAGE,
    runId: RUN_ID,
    verdict: 'BLOCKED_CONFIG',
    reason: `确定性搜索没有可行候选（可行 ${search.feasibleCandidates} / 共 ${search.totalCandidates}）；不在本域选一个最不坏的当 winner`,
    infeasibleByCause: search.infeasibleByCause || null,
    nextActions: [
      '按 infeasibleByCause 逐项查是哪条限值把候选全部否掉；若是前提（例如 keep-out、口径）而不是设计本身，交给该前提的责任人，不要放宽限值取得 winner',
      '前提或设计空间改动后，重跑本域搜索并重新生成候选产物',
    ],
    searchNode: search,
    policy,
    files: [],
  }
}
if (search.candidates.length > MAX_CANDIDATES) {
  log(`候选 ${search.candidates.length} 个，只取前 ${MAX_CANDIDATES} 个进入合并；其余未评估`)
}

const candidateBrief = {
  candidateSetSha256: search.candidateSetSha256, designSpaceFileSha256: search.designSpaceFileSha256,
  totalCandidates: search.totalCandidates,
  feasibleCandidates: search.feasibleCandidates,
  // 口径随候选集一起下发。缺了它，下游无法判断某个字段能不能直接与规格限额比对，
  // 上一轮就是这么把"内部恒等式成立"误报成"面积满足规格"的。
  fieldCaliber: search.fieldCaliber,
  candidates: search.candidates.slice(0, MAX_CANDIDATES),
}

phase('Constraint recall')

// 第三步：旁证给约束，串在候选集之后而不是与候选并行。
// 顺序是刻意的——约束针对的是具体候选，见不到候选就提不出可执行的约束。
// 旁证取 memory-expert 与 physical-expert：comm-expert 是本域主策略，不是旁证；
// 本域的候选集能不能落地，取决于内存侧接不接得住图存储与 commit 计数、
// 物理侧接不接得住 PHY 岸线、管理核面积与 die 级功耗（roster 的 consumers 已载明
// design.comm 由这两个策略共担）。
const [memC, physC] = await parallel([
  () =>
    agent(
      `${head('memory-expert')}

brief：
${BRIEF_JSON}

comm 域已选出的候选集（来自确定性搜索）：
${JSON.stringify(candidateBrief, null, 2)}

任务：对这批候选给出**内存侧的约束**。只回答内存侧接不接得住，不要评价候选好坏、不要重算候选数值。
- 逐条给出：这条约束否掉哪个 candidateId 或哪种取值，依据是什么。
- 说不出否掉谁的约束不要提；只影响常数项、不改变取舍的也不要提。
- 若内存侧无法支持其中任一候选，直接判 BLOCKED_CONFIG 并说明缺什么。
- 若内存侧结论动摇了方向级假设，用 DIRECTION_BACKFLOW。`,
      { label: 'constraint:memory', phase: 'Constraint recall', effort: 'high', schema: CONSTRAINT_SCHEMA },
    ),
  () =>
    agent(
      `${head('physical-expert')}

brief：
${BRIEF_JSON}

comm 域已选出的候选集（来自确定性搜索）：
${JSON.stringify(candidateBrief, null, 2)}

任务：对这批候选给出**物理侧的约束**。只回答封装 / 面积 / 功耗 / 热接不接得住，
不要评价候选好坏、不要重算候选数值。
- 逐条给出：这条约束否掉哪个 candidateId 或哪种取值，依据是什么。
- 面积必须取自规格文件的 estimatedAreaMm2，不得另写手工面积。
- 说不出否掉谁的约束不要提；只影响常数项、不改变取舍的也不要提。
- 若物理侧无法支持其中任一候选，直接判 BLOCKED_CONFIG 并说明缺什么。
- 若物理侧结论动摇了方向级假设，用 PPA_DIRECTION_BACKFLOW。`,
      { label: 'constraint:physical', phase: 'Constraint recall', effort: 'high', schema: CONSTRAINT_SCHEMA },
    ),
])

// 旁证缺席不是"没有意见"：某一路侧向专家调用失败（返回空），它的约束就不存在，
// 而合并者会把"没人反对"当成通过。缺任何一路都退回，不合并、不落盘。
const lateral = [
  ['memory-expert', memC],
  ['physical-expert', physC],
]
const absentLateral = lateral.filter(([, c]) => !c).map(([agentId]) => agentId)
if (absentLateral.length) {
  log(`旁证约束缺 ${absentLateral.length} 路：${absentLateral.join(', ')}；退回，不合并`)
  return {
    stage: STAGE,
    runId: RUN_ID,
    verdict: 'BLOCKED_CONFIG',
    reason: `旁证约束不完整，缺：${absentLateral.join(', ')}；缺席的一侧不能当作"没有意见"，未合并 winner`,
    absentLateral,
    nextActions: absentLateral.map((agentId) => `补齐 ${agentId} 对本域候选集的约束后重跑本格`),
    searchNode: search,
    policy,
    files: [],
  }
}
const constraints = lateral.map(([, c]) => c)
const backflow = constraints.find((c) => c.verdict === 'DIRECTION_BACKFLOW' || c.verdict === 'PPA_DIRECTION_BACKFLOW')
if (backflow) {
  return {
    stage: STAGE,
    runId: RUN_ID,
    verdict: backflow.verdict,
    reason: '旁证阶段报方向回退，未合并 winner',
    constraints,
    searchNode: search,
    policy,
    files: [],
  }
}

phase('Merge')

// 第四步：合并。integrator 只合并，不重新发明——它不得新增候选、不得重算数值。
const merged = await agent(
  `${head('integrator')}

brief：
${BRIEF_JSON}

确定性搜索的候选集（数值的唯一来源；你不得修改、重算或新增任何候选）：
${JSON.stringify(candidateBrief, null, 2)}

旁证给出的侧向约束：
${JSON.stringify(constraints, null, 2)}

排序判据（来自 comm-expert，你不得引入新的排序维度）：
${JSON.stringify(policy.ranking)}

任务：合并出唯一 winner。
- 每个被排除的候选必须有明确排除依据：违反哪条约束、或未通过哪条判据。不得写"综合判断更优"。
- 候选之间数值不一致时显式记录冲突，不得取平均、不得抹平。
- winner 的每个字段都要能指回哪个候选、由谁给出。指不回去的字段不要出现在 winner 里。
- **必须单独做一节与规格文件的口径比对**：把 winner 的关键量与规格文件的对应值并列，
  逐项给出差额。只有产物内部的恒等式（分项之和 = 合计）不算做过这一节——
  那只证明产物自洽，不证明它与规格一致。口径不一致时给出差额，
  不得归为"一个常数加项"了事；归为常数之前必须先验证它确实是常数。
- 如果存在无法归因的差异（例如与既有基线的差找不到原因），用 DELTA_UNEXPLAINED 交回，不要靠合并掩盖。
- 不要判定候选是否满足约束——那是下一步检点的事。`,
  { label: 'integrator', phase: 'Merge', effort: 'high', schema: {
    type: 'object',
    additionalProperties: false,
    required: ['winner', 'excluded', 'conflicts', 'verdict'],
    properties: {
      winner: {
        type: 'object',
        additionalProperties: false,
        required: ['optionId', 'values', 'provenance'],
        properties: {
          optionId: { type: 'string' },
          values: { type: 'string', description: '原样取自候选集，不得改写' },
          provenance: { type: 'string', description: '每个字段来自哪个候选、哪个专家' },
        },
      },
      excluded: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['optionId', 'reason', 'source'],
          properties: {
            optionId: { type: 'string' },
            reason: { type: 'string' },
            source: { type: 'string', description: '给出该排除依据的约束 id、判据或确定性脚本' },
          },
        },
      },
      conflicts: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['field', 'between', 'resolution'],
          properties: {
            field: { type: 'string' },
            between: { type: 'string' },
            resolution: { type: 'string' },
          },
        },
      },
      verdict: { type: 'string', enum: ['INTEGRATION_OK', 'DELTA_UNEXPLAINED'] },
      deltaNote: { type: 'string' },
    },
  } },
)

if (!merged || merged.verdict !== 'INTEGRATION_OK') {
  return {
    stage: STAGE,
    runId: RUN_ID,
    verdict: (merged && merged.verdict) || 'DELTA_UNEXPLAINED',
    reason: (merged && merged.deltaNote) || '合并未完成，交回上游归因',
    merge: merged,
    constraints,
    searchNode: search,
    policy,
    files: [],
  }
}

phase('Invariant check')

// 第五步：强制检点。合并者与检点者必须是不同的 agent——见 integrator.md 的策略说明。
// 检点不通过就退回，且不落盘 winner：宁可重跑一次，也不要让违规结果往下流。
const check = await agent(
  `${head('invariant-checker')}

brief：
${BRIEF_JSON}

winner（待检点）：
${JSON.stringify(merged.winner, null, 2)}

被排除的候选与排除依据：
${JSON.stringify(merged.excluded, null, 2)}

未解决的冲突：
${JSON.stringify(merged.conflicts, null, 2)}

comm-expert 声明的守恒关系与口径约束（本 stage 的检点清单）：
${JSON.stringify(policy.invariants, null, 2)}

确定性搜索的元信息（候选来源指纹与计数）：
${JSON.stringify({ candidateSetSha256: candidateBrief.candidateSetSha256, designSpaceFileSha256: candidateBrief.designSpaceFileSha256, totalCandidates: candidateBrief.totalCandidates, feasibleCandidates: candidateBrief.feasibleCandidates }, null, 2)}

任务：逐条检点。只检点，不设计、不提改进建议。
- 每条守恒关系给出明确结论：守恒 / 不守恒 / 输入不足。
- 不守恒时给出差额，能定位到分项才有意义。
- winner 的 provenance 是否完整（每个字段能否指回来源）；不完整即为不通过。
- 是否有任何决定性数字不是来自确定性脚本或规格文件；有即为不通过。
- 检点覆盖面必须声明：本次检了哪几条，哪几条因输入不足没检。
- 拿不到检点所需输入时判不通过，不得因为缺输入就放过。`,
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
            gap: { type: 'string', description: '不守恒时的差额' },
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

const okInvariants = check && check.verdict === 'INVARIANT_OK'

// ---------------------------------------------------------------------------
// 返回值即落盘清单。检点不通过时 files 为空——退回，不写 winner。
// rejectedOptions 与 strategyVersions 必须回写 ledger：
// 没有前者，重跑会重新发明已否方案；没有后者，同输入两次跑出不同结果无法解释。
// ---------------------------------------------------------------------------
const ledgerPatch = {
  currentStage: STAGE,
  strategyVersions: {
    'comm-expert': '1.0',
    'memory-expert': '1.0',
    'physical-expert': '1.0',
    integrator: '1.0',
    'invariant-checker': '1.0',
  },
  rejectedOptions: (merged.excluded || []).map((e) => ({
    stage: STAGE,
    optionId: e.optionId,
    reason: e.reason,
    rejectedBy: e.source,
  })),
  openBlockers: (merged.conflicts || []).map((c, i) => ({
    id: `CONFLICT-${STAGE.toUpperCase()}-${String(i + 1).padStart(2, '0')}`,
    owner: 'integrator',
    unblockCondition: c.resolution,
  })),
}

const runRecord = {
  stage: STAGE,
  runId: RUN_ID,
  candidateSetSha256: candidateBrief.candidateSetSha256, designSpaceFileSha256: candidateBrief.designSpaceFileSha256,
  searchProvenance: SEARCH_BRIEF.provenance,
  totalCandidates: candidateBrief.totalCandidates,
  feasibleCandidates: candidateBrief.feasibleCandidates,
  evaluated: candidateBrief.candidates.length,
  // 记录搜索产物的来源路径与当时的口径标注；命令只作为溯源文字记录，
  // 本 workflow 不执行它（执行在主循环，见文件头注释）。
  searchArtifact: SEARCH_ARTIFACT,
  searchCommandForRecord: SEARCH_COMMAND_FOR_RECORD,
  // 口径是产物的一部分：面积是否含通道成本、功耗是 die 还是卡级。
  // 未标注口径时后续与规格的比对无意义，所以它必须随 runRecord 落盘。
  fieldCaliber: search.fieldCaliber || { areaIncludesPortCost: 'UNVERIFIED', powerScope: 'UNVERIFIED', note: '产物未提供口径标注' },
  policy: { dims: policy.dims, evaluationAxes: policy.evaluationAxes || [], excluded: policy.excluded, ranking: policy.ranking, threads: policy.threads },
  uncoveredDims: search.uncoveredDims || [],
  constraints,
  merge: merged,
  invariantCheck: check,
}

return {
  stage: STAGE,
  runId: RUN_ID,
  verdict: okInvariants ? 'INVARIANT_OK' : 'INVARIANT_VIOLATED',
  winner: okInvariants ? merged.winner : null,
  // 检点不通过时保留草稿供人看差在哪，但明确标注未被采纳、不落盘
  rejectedWinner: okInvariants ? null : merged.winner,
  violations: okInvariants ? [] : (check && check.violations) || ['检点未完成'],
  coverage: check && check.coverage,
  ledgerPatch,
  runRecord,
  files: okInvariants
    ? [
        {
          path: `${REPO}/out/comm/${STAGE}_winner.json`,
          content: JSON.stringify(merged.winner, null, 2),
        },
        {
          path: `${REPO}/out/comm/${STAGE}_run_record.json`,
          content: JSON.stringify(runRecord, null, 2),
        },
      ]
    : [],
}
