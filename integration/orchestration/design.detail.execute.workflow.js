export const meta = {
  name: 'design-detail-execute',
  description: 'K3 设计 detail.execute 阶段（B3）：software-expert 与 physical-expert 两路并行产出 Q6 调度/软件事件与 Q7 PPA/thermal/RAS，integrator 合并成一份执行账本，invariant-checker 检点后落盘；Q7 的方向级发现走 PPA_DIRECTION_BACKFLOW 专属回流 A0',
  whenToUse: 'D 组第四格。需要 args.brief（stage=detail.execute 的 DesignBrief）、args.detailRunArtifact、args.eventsArtifact（上一格 B2 的事件流）与可选 args.replayArtifact。均由主循环生成。本 workflow 不跑 stage_b.js、不写既有产物。',
  phases: [
    { title: 'Software and PPA declaration', detail: 'software-expert 与 physical-expert 两路并行、互不可见' },
    { title: 'Merge', detail: 'integrator 合并成一份执行账本，只合并不重新发明' },
    { title: 'Invariant check', detail: 'invariant-checker 强制检点；不通过则不落盘' },
  ],
}

// ---------------------------------------------------------------------------
// D 组第四格：B3（19 号文档 §6）。
//
// 要回答的两个问题：Q6（调度器 / 软件事件）、Q7（PPA / thermal / RAS）。
// 二者**并行**，因为它们的对象根本不重叠：Q6 说的是"谁在什么时刻被派活"，
// Q7 说的是"这块硅在这个功耗与温度下还能不能跑"。没有先后依赖，
// 唯一的共同前提是同一个 candidate_id 与同一份事件流。
//
// 这一格最特殊的地方是 **PPA_DIRECTION_BACKFLOW**。
// 它是 roster 里只有 physical-expert 拥有的裁决——§6 明确：
// Q7 若发现需要改变方向，必须走 A0 作为 PPA_DIRECTION_BACKFLOW 回流，
// 而不是在 B3 内部自行重定方向。所以本 workflow 对两种回流是**分开处理**的：
//
//   DIRECTION_BACKFLOW     （software） → A0 重定方向
//   PPA_DIRECTION_BACKFLOW （physical） → A0 重定方向，且携带 PPA 证据
//
// 两者都终止本格，但**不合并成一个名字**：回流的路由是数据，
// 下游 A0 需要知道是哪一类证据触发的回流。把它们摊平成同一个枚举，
// 等于把"功耗/散热说不行"和"软件说不行"变成同一件事。
//
// B3 的退出条件有三条：
//   1. Q6 的每个事件可追溯，Q7 的每个 PPA 项有出处；
//   2. 面积守恒在容差 0 下成立（placed + keep-out = 总面积）；
//   3. peak 与 sustained 分离，且**卡功耗口径没有被混用**
//      （memory 域的卡功耗口径是 8×die + MC + 固定 80 W，**刻意不计**共享端口项；
//       physical 域的口径计它——两者相差恰好 45.5141376 W。
//       把两个口径的数放在一起比，是这一格最容易犯且最难发现的错）。
//
// 第三条不是洁癖：memory 域的搜索就因为这个差项而"2800 W 更宽松"。
// 一个从 memory 域借来的功耗裕量，放到 physical 域就是负的。
// ---------------------------------------------------------------------------

const REPO = args.repo || '.'
const STAGE = 'detail.execute'
const BRIEF = args.brief
const RUN_ID = args.runId || 'detail-execute-run'
const DETAIL_RUN_ARTIFACT = args.detailRunArtifact
const EVENTS_ARTIFACT = args.eventsArtifact
const REPLAY_ARTIFACT = args.replayArtifact || 'UNVERIFIED'
const STAGE_COMMAND_FOR_RECORD = args.stageCommand || 'UNVERIFIED'

if (!BRIEF) throw new Error('design.detail.execute 需要 args.brief（intake 阶段产出的 DesignBrief）')
if (!DETAIL_RUN_ARTIFACT || !EVENTS_ARTIFACT) {
  throw new Error('design.detail.execute 需要 args.detailRunArtifact 与 args.eventsArtifact（B2 的事件流）；本 workflow 不跑 Stage B')
}
if (BRIEF.stage !== STAGE) {
  throw new Error(`brief.stage=${BRIEF.stage}，与 design.${STAGE} 不符；契约串了`)
}

// 面积守恒的容差。**零**，不是"接近即可"：7-reticle 面积守恒是一条等式，
// 不是一条不等式。给一个 1% 的宽容度，等于允许一片 die 被放错地方而没人发现。
const AREA_TOLERANCE_MM2 = 0

// Q7 必须覆盖的 PPA 面。缺一面就说"PPA 做完了"，那个面就永远没人看。
const PPA_SECTIONS = ['power', 'thermal', 'ras', 'area']

// Q6 事件必须登记的追溯字段。软件事件的追溯对象是调度决策本身，
// 所以追溯键是"哪个算子在流水线的哪一步被谁派发"，不是 tile。
const SW_TRACE_FIELDS = ['eventId', 'operatorId', 'pipelineStep', 'dispatcher', 'source']

// 卡功耗口径。两个域各有一套，**不可互换**。
const POWER_CALIBERS = ['MEMORY_DOMAIN', 'PHYSICAL_DOMAIN']

const HEAD = [
  `仓库根目录：${REPO}`,
  `本 workflow：design.detail.execute（stage=${STAGE}，runId=${RUN_ID}）`,
  `你是一个策略实例。先读你的策略正文：${REPO}/teams/council/strategies/__AGENT__.md`,
  '那份文件是本角色的判断规则、正确性判据、证据规则、取舍规则与禁止事项，逐条遵守。',
  '以下运行时上下文由 workflow 注入；注入内容与策略正文冲突时，注入内容优先（它承载本 stage 的事实）。',
  '你没有文件系统写权限。把该写的东西作为返回值交回，由 workflow 落盘。',
  '所有数字必须带出处（文件路径:行号 或 ADR 编号）；没有出处的写 UNVERIFIED 并说明缺什么，不得静默补齐。',
  '不得输出 TPS/usr 或任何全局性能指标；不得输出 PASS / D_GATE_PASSED 字面量。',
  '禁止出现任何**无出处的全局加速比或利用率乘子**；加速只能来自调度排布本身。',
  '功耗数字必须写清是哪一套卡功耗口径——两套口径的数不得混用。',
].join('\n')

const head = (agentId) => HEAD.replace('__AGENT__', agentId)

const BRIEF_JSON = JSON.stringify(BRIEF, null, 2)

// 两域共用形状、**裁决枚举不同**。physical-expert 是 roster 里唯一拥有
// PPA_DIRECTION_BACKFLOW 的角色；software-expert 没有它——软件排不出调度
// 是方向问题（改 A0 的形态），不是 PPA 问题，让它报 PPA 回流会把两类证据混在一起。
const declarationSchema = (verdictEnum) => ({
  type: 'object',
  additionalProperties: false,
  required: ['from', 'domain', 'verdict'],
  properties: {
    from: { type: 'string', description: '给出申报的 agentId' },
    domain: { type: 'string', enum: ['Q6', 'Q7'] },
    events: {
      type: 'array',
      description: 'Q6 必填：逐事件登记调度/软件事件，每个事件带齐追溯字段',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['eventId', 'operatorId', 'pipelineStep', 'dispatcher', 'latencyType', 'source'],
        properties: {
          eventId: { type: 'string' },
          operatorId: { type: 'string' },
          pipelineStep: { type: 'string', description: '这个算子落在流水线的哪一步' },
          dispatcher: { type: 'string', description: '谁派发的：图调度器 / 固件 / 主机运行时 …' },
          latencyType: { type: 'string', enum: ['exposed', 'hidden', 'overlapped'],
            description: '**exposed 与 hidden 必须分开**；把它们合成一个"总开销"会让隐藏代价消失' },
          cycles: { type: 'number', description: '裸值；不得写区间或"约"' },
          onCriticalPath: { type: 'boolean' },
          source: { type: 'string', description: '文件路径:行号 或 ADR 编号；引用不到写 UNVERIFIED' },
        },
      },
    },
    ppa: {
      type: 'array',
      description: 'Q7 必填：逐项登记 PPA/thermal/RAS，每项带出处',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['section', 'metric', 'value', 'unit', 'source'],
        properties: {
          section: { type: 'string', description: `必须覆盖 ${PPA_SECTIONS.join(' / ')}` },
          metric: { type: 'string' },
          value: { type: 'number', description: '裸值' },
          unit: { type: 'string', description: '单位必须写；mm² / W / ℃ / FIT …' },
          caliber: { type: 'string', description: '功耗项必填：MEMORY_DOMAIN 或 PHYSICAL_DOMAIN；其它项写 N/A' },
          peakOrSustained: { type: 'string', enum: ['peak', 'sustained', 'N/A'],
            description: '**peak 与 sustained 不得合并成一个数**' },
          source: { type: 'string' },
        },
      },
    },
    area: {
      type: 'object',
      description: 'Q7 必填：面积守恒三件套，供 workflow 在容差 0 下对账',
      additionalProperties: false,
      required: ['placedMm2', 'keepOutMm2', 'totalMm2', 'source'],
      properties: {
        placedMm2: { type: 'number' },
        keepOutMm2: { type: 'number', description: '**留空**的那部分面积，不是可用面积；读反了每个面积数都会反' },
        totalMm2: { type: 'number' },
        source: { type: 'string' },
      },
    },
    blockedFields: { type: 'array', items: { type: 'string' }, description: 'BLOCKED_CONFIG 时必填' },
    backflowReason: { type: 'string', description: 'DIRECTION_BACKFLOW / PPA_DIRECTION_BACKFLOW 时必填：动摇了哪条方向级假设' },
    verdict: { type: 'string', enum: verdictEnum },
  },
})

const SOFTWARE_SCHEMA = declarationSchema(['LOCAL_DETAIL_FIX', 'DIRECTION_BACKFLOW', 'BLOCKED_CONFIG'])
const PHYSICAL_SCHEMA = declarationSchema(['LOCAL_DETAIL_FIX', 'PPA_DIRECTION_BACKFLOW', 'BLOCKED_CONFIG'])

// 合并产物。
const MERGE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['software', 'ppa', 'area', 'rejectedOptions', 'blockers', 'verdict'],
  properties: {
    software: {
      type: 'array',
      description: '合并后的 Q6 事件；裸值原样保留',
      items: { type: 'object' },
    },
    ppa: {
      type: 'array',
      items: { type: 'object' },
    },
    area: {
      type: 'object',
      additionalProperties: false,
      required: ['placedMm2', 'keepOutMm2', 'totalMm2'],
      properties: {
        placedMm2: { type: 'number' },
        keepOutMm2: { type: 'number' },
        totalMm2: { type: 'number' },
      },
    },
    exposedVsHidden: {
      type: 'object',
      description: 'Q6 的 exposed 与 hidden 各自的合计与来源；不得只给一个总数',
      additionalProperties: false,
      required: ['exposedCycles', 'hiddenCycles', 'basis'],
      properties: {
        exposedCycles: { type: 'number' },
        hiddenCycles: { type: 'number' },
        basis: { type: 'string' },
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
    blockers: {
      type: 'array',
      description: '软件与 PPA 之间无法互相满足的地方；不下折中值',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['subject', 'description', 'owner', 'unblockCondition'],
        properties: {
          subject: { type: 'string' }, description: { type: 'string' },
          owner: { type: 'string' }, unblockCondition: { type: 'string' },
        },
      },
    },
    verdict: { type: 'string', enum: ['INTEGRATION_OK', 'DELTA_UNEXPLAINED'] },
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

phase('Software and PPA declaration')

// 两域并行、互不可见。让 physical-expert 看见 Q6 的调度结论，
// 它就会先判断"软件那边说排得下"，再去算功耗——而功耗是否可行
// 与软件是否排得下毫不相关。两者必须是两份独立的结论，合并才有信息量。
const DECLARANTS = [
  {agentId: 'software-expert', domain: 'Q6 调度 / 软件事件：图调度、固件、主机运行时、kernel 发射、同步与依赖',
    label: 'execute:q6-software', schema: SOFTWARE_SCHEMA},
  {agentId: 'physical-expert', domain: 'Q7 PPA / thermal / RAS：面积守恒、功耗（含口径）、散热、可靠性',
    label: 'execute:q7-physical', schema: PHYSICAL_SCHEMA},
]

const declarations = (await parallel(DECLARANTS.map((d) => () => agent(
  `${head(d.agentId)}\n\n`
  + `brief：\n${BRIEF_JSON}\n\n`
  + `细化产物（只读）：${DETAIL_RUN_ARTIFACT}\n`
  + `上一格 B2 的事件流（只读）：${EVENTS_ARTIFACT}\n`
  + `事件重放产物（只读）：${REPLAY_ARTIFACT}\n\n`
  + `任务：你是本域（${d.domain}）的申报人。\n`
  + (d.agentId === 'software-expert'
    ? `Q6 逐事件登记调度/软件事件：每个事件写清它派发的是哪个算子、落在流水线哪一步、`
      + `谁派发的、以及它的延迟是 **exposed 还是 hidden**。规则：\n`
      + `1. exposed 与 hidden 必须分开记。合成一个"总开销"，隐藏的代价就消失了，`
      + `   而 hidden 之所以叫 hidden，是因为它躲在别人的时间后面。\n`
      + `2. 每个事件必须带齐 ${SW_TRACE_FIELDS.join('、')}；追溯不到写 UNVERIFIED。\n`
      + `3. 固件是否落在每集合通信的关键路径上，必须明确回答（见 teams/hardware/docs/10_COMM_CORE.md）。\n`
      + `4. AI Core 是否花时间在通信控制上，必须明确回答——它是 0 还是不是 0，是两种设计。\n`
    : `Q7 逐项登记 PPA/thermal/RAS。规则：\n`
      + `1. 四个面（${PPA_SECTIONS.join(' / ')}）都要覆盖，缺一面就别说 PPA 做完了。\n`
      + `2. 面积守恒三件套（placed / keep-out / total）都要给裸值。`
      + `   **keep-out 是留空的那部分**——留空比例 0.1254 = 658.29 / 5248，读反了所有面积都会反。\n`
      + `3. 功耗项必须写明是 ${POWER_CALIBERS.join(' 还是 ')} 口径。`
      + `   memory 域的口径是 8×die + MC + 固定 80 W，**刻意不计**共享端口项；`
      + `   physical 域计它——两者相差 45.5141376 W。混用口径的功耗裕量不是裕量。\n`
      + `4. peak 与 sustained 不得合并成一个数；写清每个数是哪一个。\n`
      + `5. 面积与功耗都要与 ADR-0021 的单一硬件规格对齐；出现第二份规格如实写出。\n`)
  + `申报完成后给出本域裁决：\n`
  + `  LOCAL_DETAIL_FIX：本域结论自洽，可在当前框架下自行调整。\n`
  + (d.agentId === 'physical-expert'
    ? `  PPA_DIRECTION_BACKFLOW：Q7 发现需要改变**方向**——不是"再多留点裕量就好"，`
      + `   而是当前的形态在功耗/散热/面积上根本不成立（例如在给定散热下峰值功耗`
      + `   无论怎么排都超出，或者面积在 7-reticle 约束下放不下）。`
      + `   这一条必须走 A0 回流，**不得在 B3 内部自行重定方向**；`
      + `   用这个裁决时在 backflowReason 里写明动摇了哪条方向级假设。\n`
    : `  DIRECTION_BACKFLOW：调度发现需要改变方向——不是"换个派发顺序就好"，`
      + `   而是当前的形态下流水线根本排不开。用这个裁决时写明动摇了哪条假设。\n`)
  + `  BLOCKED_CONFIG：产物缺字段或结论无法归位，在 blockedFields 里列出缺哪些。\n`
  + `注意：你不判这一格是否通过——那是检点者的事。`,
  {label: d.label, phase: 'Software and PPA declaration', effort: 'high', schema: d.schema})
))).filter(Boolean)

if (declarations.length < DECLARANTS.length) {
  const absent = DECLARANTS.filter((d) => !declarations.some((x) => x.from === d.agentId)).map((d) => d.agentId)
  return {
    stage: STAGE, runId: RUN_ID, verdict: 'BLOCKED_CONFIG',
    reason: `声明不完整，缺：${absent.join(', ')}`,
    nextActions: absent.map((a) => `补齐 ${a} 本域的申报；若产物缺字段，先补产物再重跑本格`),
    absentDeclarants: absent,
    files: [],
  }
}

// 裁决枚举由 workflow 消费——这是两种回流真正分流的地方。
// 方向回流在整条 D 链里是**终止性**的：拿着一个方向级矛盾往下走，
// 后面每一格都会建在它上面，而且越往后越贵（B4 要跑 18 个槽位）。
//
// 两种回流分开返回，不合并成同一个枚举：回流的路由是数据，
// A0 需要知道是"软件排不开"还是"PPA 装不下"——它们的重定方向完全不同。
const backflow = declarations.filter((d) => d.verdict === 'DIRECTION_BACKFLOW' || d.verdict === 'PPA_DIRECTION_BACKFLOW')
const blockedDeclarants = declarations.filter((d) => d.verdict === 'BLOCKED_CONFIG')

if (backflow.length || blockedDeclarants.length) {
  const all = backflow.concat(blockedDeclarants)
  // 两种回流同时出现时，PPA 优先上报：它的证据更硬（面积与功耗是可测的物理约束），
  // 而软件排不开往往在换一个形态后就消失了。两者都在 nextActions 里保留。
  const primary = backflow.find((d) => d.verdict === 'PPA_DIRECTION_BACKFLOW') || backflow[0]
  return {
    stage: STAGE, runId: RUN_ID,
    verdict: primary ? primary.verdict : 'BLOCKED_CONFIG',
    reason: backflow.length
      ? `本格报方向回流：${backflow.map((d) => `${d.from}=${d.verdict}(${d.backflowReason || '未说明'})`).join('；')}；未合并账本`
      : `本格被配置挡住：${blockedDeclarants.map((d) => d.from).join(', ')}；未合并账本`,
    // 回流去哪，由这里说清：PPA 的方向级发现走 A0，携带 Q7 证据。
    nextActions: [
      ...backflow.map((d) => d.verdict === 'PPA_DIRECTION_BACKFLOW'
        ? `把 ${d.from} 的 PPA 证据（backflowReason + ppa 列表）作为 PPA_DIRECTION_BACKFLOW 交给 A0（design.converge / direction）重定方向`
        : `把 ${d.from} 的方向级证据作为 DIRECTION_BACKFLOW 交给 A0 重定方向`),
      ...blockedDeclarants.flatMap((d) => (d.blockedFields || []).map((f) => `补齐被配置挡住的字段：${f}`)),
    ],
    blockedFields: all.flatMap((d) => d.blockedFields || []),
    declarants: all.map((d) => ({from: d.from, verdict: d.verdict})),
    files: [],
  }
}

phase('Merge')

const merged = await agent(
  `${head('integrator')}\n\n`
  + `brief：\n${BRIEF_JSON}\n\n`
  + `细化产物（只读）：${DETAIL_RUN_ARTIFACT}\n`
  + `事件流（只读）：${EVENTS_ARTIFACT}\n`
  + `Q6 软件侧申报：\n${JSON.stringify(declarations.find((d) => d.domain === 'Q6'), null, 2)}\n`
  + `Q7 PPA 侧申报：\n${JSON.stringify(declarations.find((d) => d.domain === 'Q7'), null, 2)}\n\n`
  + `任务：把两侧合并成一份执行账本。规则：\n`
  + `1. 只合并，不重新发明。两侧的裸值原样保留，不得改写、不得取近似值。\n`
  + `2. Q6 的 exposed 与 hidden 分开汇总，**不得**合成一个总数。\n`
  + `3. Q7 的功耗项保留各自的口径标注；发现两侧引用同一个功耗限值但口径不同，`
  + `   在 blockers 里明确写出——这是一个会导致错误裕量的真实缺口，不是格式问题。\n`
  + `4. 面积三件套原样带过来。\n`
  + `5. 被排除的口径进 rejectedOptions。\n`
  + `6. 软件排不开的地方与 PPA 装不下的地方若互相嵌套（例如为了散热降频导致流水线变长），`
  + `   写进 blockers 并保留双方，**不下折中值**。\n`
  + `合并成立写 INTEGRATION_OK；有 Q6 事件无法归位或 Q7 有面缺失时写 DELTA_UNEXPLAINED。`,
  {label: 'integrator', phase: 'Merge', effort: 'high', schema: MERGE_SCHEMA})

if (!merged || merged.verdict !== 'INTEGRATION_OK') {
  return {
    stage: STAGE, runId: RUN_ID, verdict: 'DELTA_UNEXPLAINED',
    merge: merged || null,
    reason: 'Q6 与 Q7 无法合并成一份执行账本；不落盘',
    nextActions: ['定位无法归位的 Q6 事件或缺失的 Q7 面，补申报后重跑本格'],
    files: [],
  }
}

// --- 脚本侧对账 -------------------------------------------------------------
// 面积守恒、峰值/持续分离、口径完整、追溯字段齐全——这些是可判定的算术与
// 枚举核对，交给脚本；语义取舍（某个热余量够不够）留给检点者。
// 理由与 B2 相同：让 agent 去"看"一批数对不对，等于把算术交给一个会读错数的读者。

const swEvents = merged.software || []

const swTraceGaps = swEvents
  .filter((e) => SW_TRACE_FIELDS.some((f) => e[f] === undefined || e[f] === null || e[f] === ''))
  .map((e) => `${e.eventId || '(无名)'}: 缺 ${SW_TRACE_FIELDS.filter((f) => e[f] === undefined || e[f] === null || e[f] === '').join('/')}`)

// 面积守恒：容差 0。placed + keep-out 必须**恰好**等于总面积。
// 差一点点不是舍入，是有一个区域既没被放东西也没被留空——它去哪了？
const areaSum = (merged.area.placedMm2 || 0) + (merged.area.keepOutMm2 || 0)
const areaGap = Math.abs(areaSum - (merged.area.totalMm2 || 0))
const areaViolated = areaGap > AREA_TOLERANCE_MM2

// peak 与 sustained 分离：合并后的 PPA 里两者必须都在，且 peak ≥ sustained。
// 只给一个数，说明有一个被丢掉了——而丢掉的通常是 peak。
const powerItems = (merged.ppa || []).filter((p) => p.section === 'power')
const peakItems = powerItems.filter((p) => p.peakOrSustained === 'peak')
const sustainedItems = powerItems.filter((p) => p.peakOrSustained === 'sustained')
const powerGaps = []
if (!peakItems.length) powerGaps.push('功耗项缺 peak')
if (!sustainedItems.length) powerGaps.push('功耗项缺 sustained')

// 口径完整：每个功耗项必须标口径，且口径必须是两套之一。
// 标了 N/A 或者标了第三个名字的，都是把一个不知道口径的数当成知道的用。
const caliberGaps = powerItems
  .filter((p) => !POWER_CALIBERS.includes(p.caliber))
  .map((p) => `${p.metric}: caliber=${p.caliber || '(空)'}`)
const mixedCalibers = [...new Set(powerItems.map((p) => p.caliber).filter((c) => POWER_CALIBERS.includes(c)))]

// PPA 四面齐备。
const coveredSections = [...new Set((merged.ppa || []).map((p) => p.section))]
const missingSections = PPA_SECTIONS.filter((s) => !coveredSections.includes(s))

// 无出处乘子：与 B2 同一条扫描。这一格尤其要扫——散热与降频最容易
// 被写成"×0.9 的热降频系数"，而那个 0.9 通常没有任何出处。
const MULTIPLIER_PATTERN = /(?:加速|speedup|overlap|重叠|降频|throttl|utilization\s*(?:gain|multiplier)|乘子|系数)\s*[×x*]?\s*\d|\d+(?:\.\d+)?\s*[×x]\s*(?:加速|speedup|overlap|重叠|降频)/i
const multiplierHits = (merged.ppa || [])
  .filter((p) => MULTIPLIER_PATTERN.test(String(p.source || '')) || MULTIPLIER_PATTERN.test(String(p.metric || '')))
  .map((p) => p.metric)

const executeGaps = [
  ...swTraceGaps,
  ...(areaViolated ? [`面积守恒不成立（容差 ${AREA_TOLERANCE_MM2}）：placed ${merged.area.placedMm2} + keep-out ${merged.area.keepOutMm2} = ${areaSum} ≠ total ${merged.area.totalMm2}`] : []),
  ...powerGaps,
  ...caliberGaps.map((c) => `功耗口径未标注或未定义：${c}`),
  ...missingSections.map((s) => `PPA 缺面：${s}`),
  ...multiplierHits.map((m) => `${m}: 疑似无出处乘子`),
]

if (executeGaps.length) {
  return {
    stage: STAGE, runId: RUN_ID, verdict: 'BLOCKED_CONFIG',
    reason: `B3 退出条件未满足：${executeGaps.slice(0, 12).join('；')}${executeGaps.length > 12 ? ` …共 ${executeGaps.length} 项` : ''}`,
    executeGaps,
    nextActions: executeGaps.slice(0, 12).map((g) => `补齐/更正：${g}`),
    files: [],
  }
}

// 两套口径同时出现不是问题（各自标注清楚即可），但**同一个被比较的限值**
// 只能属于一套口径。这里只登记事实，判断交给检点者。
const caliberMixNote = mixedCalibers.length > 1
  ? `本格同时出现 ${mixedCalibers.join(' 与 ')} 两套卡功耗口径（相差 45.5141376 W）；任何与功耗限值的比较必须同口径`
  : null

phase('Invariant check')

const check = await agent(
  `${head('invariant-checker')}\n\n`
  + `细化产物（只读）：${DETAIL_RUN_ARTIFACT}\n`
  + `事件流（只读）：${EVENTS_ARTIFACT}\n`
  + `两侧申报：\n${JSON.stringify(declarations, null, 2)}\n`
  + `合并后的执行账本：\n${JSON.stringify(merged, null, 2)}\n`
  + (caliberMixNote ? `\nworkflow 登记的口径事实：${caliberMixNote}\n` : '')
  + `\n任务：对这份执行账本做全局不变量检点，逐条给出 pass/fail 与裸值：\n`
  + `7-reticle 面积守恒、单一硬件规格（ADR-0021）、MC320/MC640 分离、peak 与 sustained 分离、`
  + `单位一致、证据等级齐全。B3 还要专门核本格的三条退出条件：\n`
  + `  (a) Q6 每个事件可追溯（${SW_TRACE_FIELDS.join('、')}），Q7 每项有出处；\n`
  + `  (b) 面积守恒在容差 ${AREA_TOLERANCE_MM2} 下成立；\n`
  + `  (c) **卡功耗口径没有被混用**：同一个被比较的限值只能属于一套口径。`
  + `      两套口径相差 45.5141376 W（memory 域是 8×die + MC + 固定 80 W，不计共享端口项；`
  + `      physical 域计它）。拿 memory 域的裕量去说 physical 域够用，是这一格最隐蔽的违规。\n`
  + `另外核两条：exposed 与 hidden 是否真的分开（有没有被合成一个总数）；`
  + `全流里有没有无出处的加速比或热降频系数——这一条要主动去找。\n`
  + `违规项必须给出违反的具体文件与字段。\n`
  + `不得把违规项解释掉（解释权归 architect）；不得以文档措辞为依据，只以数值和来源为依据。\n`
  + `全部通过写 INVARIANT_OK，任一不通过写 INVARIANT_VIOLATED。`,
  {label: 'invariant-checker', phase: 'Invariant check', effort: 'high', schema: CHECK_SCHEMA})

const okInvariants = check && check.verdict === 'INVARIANT_OK'

const ledgerPatch = {
  currentStage: STAGE,
  strategyVersions: {
    'software-expert': '1.0', 'physical-expert': '1.0',
    integrator: '1.0', 'invariant-checker': '1.0',
  },
  rejectedOptions: (merged.rejectedOptions || []).map((r) => ({
    stage: STAGE, optionId: r.optionId, reason: r.reason, rejectedBy: r.rejectedBy,
  })),
  openBlockers: (merged.blockers || []).map((b, i) => ({
    id: `EXECUTE-${String(i + 1).padStart(2, '0')}`,
    owner: b.owner || 'integrator',
    unblockCondition: b.unblockCondition,
  })),
}

const runRecord = {
  schemaVersion: 'design-run-record-v0.1',
  stage: STAGE,
  runId: RUN_ID,
  sourceCommit: BRIEF.sourceCommit,
  detailRunArtifact: DETAIL_RUN_ARTIFACT,
  eventsArtifact: EVENTS_ARTIFACT,
  replayArtifact: REPLAY_ARTIFACT,
  stageCommand: STAGE_COMMAND_FOR_RECORD,
  swEventCount: swEvents.length,
  swEventSet: swEvents.map((e) => `${e.eventId}|${e.operatorId}|${e.pipelineStep}|${e.latencyType}`).sort(),
  ppaSections: coveredSections.slice().sort(),
  ppaMetricCount: (merged.ppa || []).length,
  areaBudgetMm2: merged.area.totalMm2,
  areaPlacedMm2: merged.area.placedMm2,
  areaKeepOutMm2: merged.area.keepOutMm2,
  powerCalibers: mixedCalibers.slice().sort(),
  exposedCycles: merged.exposedVsHidden.exposedCycles,
  hiddenCycles: merged.exposedVsHidden.hiddenCycles,
  declarants: declarations.map((d) => d.from).sort(),
  caliber: 'Q6 为逐事件口径、Q7 为逐项口径；cycles / mm² / W 皆为产物裸值，'
    + 'workflow 只做面积与 peak/sustained 的算术对账，不产生任何新的决定性数字',
}

return {
  stage: STAGE,
  runId: RUN_ID,
  verdict: okInvariants ? 'INVARIANT_OK' : 'INVARIANT_VIOLATED',
  software: okInvariants ? merged.software : null,
  ppa: okInvariants ? merged.ppa : null,
  area: okInvariants ? merged.area : null,
  blockers: merged.blockers || [],
  violations: okInvariants ? [] : ((check && check.violations) || ['检点未完成']),
  ledgerPatch,
  runRecord,
  files: okInvariants ? [
    {
      path: `${REPO}/out/detailed/detail_execute.json`,
      content: JSON.stringify({
        schemaVersion: 'design-detail-execute-v0.1',
        stage: STAGE, runId: RUN_ID, sourceCommit: BRIEF.sourceCommit,
        detailRunArtifact: DETAIL_RUN_ARTIFACT,
        eventsArtifact: EVENTS_ARTIFACT,
        software: merged.software,
        exposedVsHidden: merged.exposedVsHidden,
        ppa: merged.ppa,
        area: merged.area,
        powerCalibers: mixedCalibers.slice().sort(),
        rejectedOptions: merged.rejectedOptions || [],
        blockers: merged.blockers || [],
      }, null, 2) + '\n',
    },
    {
      path: `${REPO}/out/detailed/detail_execute_run_record.json`,
      content: JSON.stringify(runRecord, null, 2) + '\n',
    },
  ] : [],
}
