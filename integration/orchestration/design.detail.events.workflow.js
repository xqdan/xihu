export const meta = {
  name: 'design-detail-events',
  description: 'K3 设计 detail.events 阶段（B2）：memory-expert / comm-expert / compute-expert 三路并行产出 Q3 tile/memory 事件、Q4 NoC/集合通信事件、Q5 kernel cycle，三路共享同一 manifest hash，由脚本对账守恒，invariant-checker 检点后落盘',
  whenToUse: 'D 组第三格。需要 args.brief（stage=detail.events 的 DesignBrief）、args.replayArtifact（out/detailed/formal_event_replay.json 路径）、args.detailRunArtifact 与可选 args.workloadArtifact（上一格 B1 的算子账本）。均由主循环生成。本 workflow 不跑 stage_b.js、不写既有产物。',
  phases: [
    { title: 'Event declaration', detail: '三路并行、互不可见，各自申报本域事件；三路共享同一 manifest hash' },
    { title: 'Conservation', detail: '字节/FLOP/事务/buffer lifetime/credit 五条守恒由脚本对账，不由 agent 自律' },
    { title: 'Invariant check', detail: 'invariant-checker 强制检点；不通过则不落盘' },
  ],
}

// ---------------------------------------------------------------------------
// D 组第三格：B2（19 号文档 §5）。
//
// 要回答的三个问题：Q3（tile / memory 事件）、Q4（NoC / 集合通信事件）、
// Q5（kernel cycle）。它们**并行**，因为三者描述的是同一份 manifest 的
// 三个不同切面：Q3 说数据怎么动、Q4 说数据怎么过网、Q5 说核上花了多少拍。
// 谁先谁后都不改变另外两方的对象——三者的共同前提只有 manifest hash。
//
// 三路并行成立的条件是**共享同一 manifest hash**。这不是一句约定，
// 是这一格的正确性基础：三份事件流若来自不同的 shape，守恒关系
// 就无从对账（Q3 说搬了 N 字节，Q5 说算了 M 个 FLOP，两者不是同一件事）。
// 所以本文件在并行前先钉住 hash，并在并行后逐个核对它逐字一致。
//
// B2 的退出条件有三条，前两条可脚本对账，第三条靠裁决：
//   1. 每个事件都能追溯到 operator_id / layer_id / tile_id / manifest_hash；
//   2. 五条守恒成立（字节、FLOP、事务、buffer lifetime、credit）；
//   3. 没有**无出处的**全局加速比或利用率乘子。
//
// 第三条是这一格最容易失守的地方：一个"×1.3 的流水线重叠"能让所有
// 数字好看，而它没有任何出处。它必须被禁止——不是"要求标注出处"，
// 是禁止出现。加速只能来自事件流的排布，不能来自一个乘子。
//
// 特别提示：formal_event_replay.json 里的 Q3–Q6 事件是
// status = SYNTHETIC_PLACEHOLDER 的占位，stage_b.js 的文件头明确写着
// "Q3-Q8 events are placeholders and do not drive latency"。
// 本格的任务是**替换**它们，不是引用它们当证据。
// ---------------------------------------------------------------------------

const REPO = args.repo || '.'
const STAGE = 'detail.events'
const BRIEF = args.brief
const RUN_ID = args.runId || 'detail-events-run'
const REPLAY_ARTIFACT = args.replayArtifact
const DETAIL_RUN_ARTIFACT = args.detailRunArtifact
const WORKLOAD_ARTIFACT = args.workloadArtifact || 'UNVERIFIED'
const STAGE_COMMAND_FOR_RECORD = args.stageCommand || 'UNVERIFIED'

if (!BRIEF) throw new Error('design.detail.events 需要 args.brief（intake 阶段产出的 DesignBrief）')
if (!REPLAY_ARTIFACT || !DETAIL_RUN_ARTIFACT) {
  throw new Error('design.detail.events 需要 args.replayArtifact 与 args.detailRunArtifact（已由主循环生成）；本 workflow 不跑 Stage B')
}
if (BRIEF.stage !== STAGE) {
  throw new Error(`brief.stage=${BRIEF.stage}，与 design.${STAGE} 不符；契约串了`)
}

// 五条守恒。它们是 B2 的退出条件之二，也是"事件流是不是自洽"的判据。
// 名字取自 19 号文档 §5，不是在这里重新设计。
const CONSERVATIONS = [
  'byteConservation',
  'flopConservation',
  'transactionConservation',
  'bufferLifetime',
  'creditConservation',
]

// 每个事件必须登记的追溯字段。少一个，"可追溯"就是有洞的——
// 而事件流一旦不可追溯，它就无法被下游的 execute 或 integrate 复核。
const EVENT_TRACE_FIELDS = ['operatorId', 'layerId', 'tileId', 'manifestHash']

const HEAD = [
  `仓库根目录：${REPO}`,
  `本 workflow：design.detail.events（stage=${STAGE}，runId=${RUN_ID}）`,
  `你是一个策略实例。先读你的策略正文：${REPO}/teams/council/strategies/__AGENT__.md`,
  '那份文件是本角色的判断规则、正确性判据、证据规则、取舍规则与禁止事项，逐条遵守。',
  '以下运行时上下文由 workflow 注入；注入内容与策略正文冲突时，注入内容优先（它承载本 stage 的事实）。',
  '你没有文件系统写权限。把该写的东西作为返回值交回，由 workflow 落盘。',
  '所有数字必须带出处（文件路径:行号 或 ADR 编号）；没有出处的写 UNVERIFIED 并说明缺什么，不得静默补齐。',
  '不得输出 TPS/usr 或任何全局性能指标；不得输出 PASS / D_GATE_PASSED 字面量。',
  '本格的产出是**事件流**，不是结论：逐事件写清发生了什么，不要写"整体上快了"。',
  '禁止出现任何**无出处的全局加速比或利用率乘子**（例如"×1.3 流水线重叠"）。',
  '加速只能来自事件流的排布本身；用乘子抹平的时间差一律算违规。',
].join('\n')

const head = (agentId) => HEAD.replace('__AGENT__', agentId)

const BRIEF_JSON = JSON.stringify(BRIEF, null, 2)

// 三域共用一个 schema 形状：它们描述的是同一份 manifest 的三个切面，
// 形状不同会让"三路共享同一 hash"这件事无法在数据上核对。
const eventSchema = (verdictEnum) => ({
  type: 'object',
  additionalProperties: false,
  required: ['from', 'domain', 'manifestHash', 'events', 'conservations', 'verdict'],
  properties: {
    from: { type: 'string', description: '给出申报的 agentId' },
    domain: { type: 'string', enum: ['Q3', 'Q4', 'Q5'] },
    manifestHash: { type: 'string', description: '逐字转抄 workflow 钉住的 manifest hash，不得重算' },
    events: {
      type: 'array',
      description: '逐事件申报；每个事件必须能追溯到四个 id',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['eventId', 'type', 'operatorId', 'layerId', 'tileId', 'manifestHash',
          'bytes', 'flops', 'transactions', 'source', 'confidence'],
        properties: {
          eventId: { type: 'string' },
          type: { type: 'string', description: 'TILE_MEMORY / COLLECTIVE_PACKET / KERNEL_CYCLE …' },
          operatorId: { type: 'string' },
          layerId: { type: 'string' },
          tileId: { type: 'string' },
          manifestHash: { type: 'string', description: '必须与 workflow 钉住的 hash 逐字一致' },
          bytes: { type: 'number', description: '裸值；不得写"约"或区间' },
          flops: { type: 'number' },
          transactions: { type: 'number' },
          bufferLifetime: { type: 'string', description: '这块 buffer 从哪一拍活到哪一拍；对不上就是违规' },
          credit: { type: 'number', description: 'Q4 的 credit 计数；其它域写 0 并说明不适用' },
          source: { type: 'string', description: '文件路径:行号 或 ADR 编号；引用不到写 UNVERIFIED' },
          confidence: { type: 'string', description: 'E0/E1/E2/E3 或产物里的 confidence 值' },
        },
      },
    },
    conservations: {
      type: 'array',
      description: '五条守恒逐条对账；名字取自 workflow 给出的清单，不得增减',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['name', 'lhs', 'rhs', 'met'],
        properties: {
          name: { type: 'string' },
          lhs: { type: 'number', description: '等式左边的裸值' },
          rhs: { type: 'number', description: '等式右边的裸值' },
          met: { type: 'boolean', description: '由 lhs 与 rhs 直接比对得出，不得凭印象填' },
          note: { type: 'string' },
        },
      },
    },
    placeholdersReplaced: {
      type: 'array',
      description: '本域替换掉的 SYNTHETIC_PLACEHOLDER 事件；没有替换的写清为什么',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['placeholderId', 'replacedBy', 'why'],
        properties: {
          placeholderId: { type: 'string' },
          replacedBy: { type: 'string' },
          why: { type: 'string' },
        },
      },
    },
    verdict: { type: 'string', enum: verdictEnum },
    blockedFields: { type: 'array', items: { type: 'string' }, description: 'BLOCKED_CONFIG 时必填' },
    backflowReason: { type: 'string', description: 'DIRECTION_BACKFLOW 时必填：动摇了哪条方向级假设' },
  },
})

const MEMORY_SCHEMA = eventSchema(['LOCAL_DETAIL_FIX', 'DIRECTION_BACKFLOW', 'BLOCKED_CONFIG'])
const COMM_SCHEMA = eventSchema(['LOCAL_DETAIL_FIX', 'DIRECTION_BACKFLOW', 'BLOCKED_CONFIG'])
const COMPUTE_SCHEMA = eventSchema(['LOCAL_DETAIL_FIX', 'DIRECTION_BACKFLOW', 'BLOCKED_CONFIG'])

// 合并产物。三路已经各自守恒，这里只做**跨域对账 + 归位**，不重新发明事件。
const MERGE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['manifestHash', 'events', 'crossDomain', 'rejectedOptions', 'conflicts', 'verdict'],
  properties: {
    manifestHash: { type: 'string' },
    events: {
      type: 'array',
      description: '三域事件的合集；逐事件保留原始追溯字段，不得改写裸值',
      items: { type: 'object' },
    },
    crossDomain: {
      type: 'array',
      description: '跨域对账：同一个 operator 在 Q3/Q4/Q5 里的口径是否打得通',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['operatorId', 'q3', 'q4', 'q5', 'consistent'],
        properties: {
          operatorId: { type: 'string' },
          q3: { type: 'string', description: 'Q3 对该算子说了什么（裸值口径）' },
          q4: { type: 'string' },
          q5: { type: 'string' },
          consistent: { type: 'boolean' },
          note: { type: 'string' },
        },
      },
    },
    rejectedOptions: {
      type: 'array',
      description: '被排除的事件口径/建模方式与理由',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['optionId', 'reason', 'rejectedBy'],
        properties: {
          optionId: { type: 'string' },
          reason: { type: 'string' },
          rejectedBy: { type: 'string' },
        },
      },
    },
    conflicts: {
      type: 'array',
      description: '三域互相矛盾时不下折中值，保留双方',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['between', 'subject', 'description', 'resolution'],
        properties: {
          between: { type: 'array', items: { type: 'string' } },
          subject: { type: 'string' },
          description: { type: 'string' },
          resolution: { type: 'string' },
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

phase('Event declaration')

// 三路并行，互不可见。看见彼此的事件流会让后完成的一路去"对齐"先完成的——
// 而这一格的价值恰恰是三域各自独立地描述同一份 manifest：
// 只有独立，跨域对账才有信息量。如果三路是抄的，对账永远成立，也永远没用。
//
// Q3 → memory-expert、Q4 → comm-expert、Q5 → compute-expert。这个映射不是随意的：
// 每一个都是该切面的**唯一来源方**——Q5 的 kernel cycle 只有 compute-expert
// 了解核上的拍数，让 memory-expert 去申报它等于让它编。
const DECLARANTS = [
  {agentId: 'memory-expert', q: 'Q3', domain: 'Q3 tile / memory 事件：tile 搬运、SRAM 层级、buffer lifetime、TMA 描述符',
    label: 'events:q3-memory', schema: MEMORY_SCHEMA},
  {agentId: 'comm-expert', q: 'Q4', domain: 'Q4 NoC / 集合通信事件：包切分、credit、链路占用、集合通信的相位',
    label: 'events:q4-comm', schema: COMM_SCHEMA},
  {agentId: 'compute-expert', q: 'Q5', domain: 'Q5 kernel cycle：AI Core 各核心类的拍数、流水、发射占用',
    label: 'events:q5-compute', schema: COMPUTE_SCHEMA},
]

const declarations = (await parallel(DECLARANTS.map((d) => () => agent(
  `${head(d.agentId)}\n\n`
  + `brief：\n${BRIEF_JSON}\n\n`
  + `事件重放产物（主循环已生成，只读）：${REPLAY_ARTIFACT}\n`
  + `细化产物（只读）：${DETAIL_RUN_ARTIFACT}\n`
  + `上一格的算子账本（只读）：${WORKLOAD_ARTIFACT}\n\n`
  + `任务：你是 ${d.q}（${d.domain}）的申报人。逐事件描述本次细化里发生了什么。规则：\n`
  + `1. **manifest hash 逐字转抄**产物里的值。三路共享同一个 hash——`
  + `   你的事件流必须建立在那个 hash 对应的 shape 上，不得自己在别处重建一份 shape。\n`
  + `2. 每个事件必须带齐 ${EVENT_TRACE_FIELDS.join('、')}。`
  + `   追溯不到的字段写 UNVERIFIED 并说明缺什么，不得省略、不得编。\n`
  + `3. 五条守恒（${CONSERVATIONS.join('、')}）逐条对账，给出 lhs 与 rhs 裸值，`
  + `   met 由两个数直接比对得出，不得凭印象填。\n`
  + `4. **不得出现无出处的全局加速比或利用率乘子**。`
  + `   "×1.3 的流水线重叠"这类东西不是事件，是抹平——它必须能展开成具体事件，展不开就不要写。\n`
  + `5. 重放产物里的 Q3–Q6 事件是 SYNTHETIC_PLACEHOLDER 占位，`
  + `   **不得引用它们作为证据**。你的任务是给出真实事件并说明替换了哪些占位。\n`
  + `申报完成后给出本域裁决：\n`
  + `  LOCAL_DETAIL_FIX：本域事件流自洽，可在当前框架下自行调整。\n`
  + `  DIRECTION_BACKFLOW：本域发现在冻结的形态下某件事根本做不了`
  + `（例如某个集合通信的相位在给定的 NoC 拓扑下无法排布），是方向级矛盾而非差一点。\n`
  + `  BLOCKED_CONFIG：产物缺字段或事件无法归位，在 blockedFields 里列出缺哪些。\n`
  + `注意：你不判事件流整体是否通过——那是检点者的事。`,
  {label: d.label, phase: 'Event declaration', effort: 'high', schema: d.schema})
))).filter(Boolean)

if (declarations.length < DECLARANTS.length) {
  const absent = DECLARANTS.filter((d) => !declarations.some((x) => x.from === d.agentId)).map((d) => d.agentId)
  return {
    stage: STAGE, runId: RUN_ID, verdict: 'BLOCKED_CONFIG',
    reason: `事件申报不完整，缺：${absent.join(', ')}`,
    nextActions: absent.map((a) => `补齐 ${a} 本域的事件申报；若产物缺字段，先补产物再重跑本格`),
    absentDeclarants: absent,
    files: [],
  }
}

// 共享 manifest hash 是这一格的前提，所以它在数据上被核对，而不是被假定。
// 三路里只要有一路在别处重建了 shape，它的事件流与其它两路就不是同一件事，
// 后面所有的跨域对账都失去意义——所以这里直接退回，不进入合并。
const hashes = [...new Set(declarations.map((d) => d.manifestHash))]
if (hashes.length !== 1) {
  return {
    stage: STAGE, runId: RUN_ID, verdict: 'BLOCKED_CONFIG',
    reason: `三路未共享同一 manifest hash：${declarations.map((d) => `${d.from}=${d.manifestHash}`).join(', ')}；事件流不可对账`,
    nextActions: declarations.map((d) => `让 ${d.from} 回到产物里的 manifest hash 重新申报；不得在别处重建 shape`),
    manifestHashes: declarations.map((d) => ({from: d.from, manifestHash: d.manifestHash})),
    files: [],
  }
}
const MANIFEST_HASH = hashes[0]

// 裁决枚举由 workflow 消费。方向回流与配置缺口在这里先拦：
// 继续合并只会产出一份建立在错前提上的事件流，而后面两格都读它。
const backflow = declarations.filter((d) => d.verdict === 'DIRECTION_BACKFLOW')
const blockedDeclarants = declarations.filter((d) => d.verdict === 'BLOCKED_CONFIG')

if (backflow.length || blockedDeclarants.length) {
  const all = backflow.concat(blockedDeclarants)
  return {
    stage: STAGE, runId: RUN_ID,
    verdict: backflow.length ? backflow[0].verdict : 'BLOCKED_CONFIG',
    reason: backflow.length
      ? `事件申报报方向回流：${backflow.map((d) => `${d.from}(${d.backflowReason || '未说明'})`).join('；')}；未合并`
      : `事件申报被配置挡住：${blockedDeclarants.map((d) => d.from).join(', ')}；未合并`,
    blockedFields: all.flatMap((d) => d.blockedFields || []),
    nextActions: [
      ...backflow.map((d) => `把 ${d.from} 的方向级证据作为 DIRECTION_BACKFLOW 交给 A0 重定方向：${d.backflowReason || '未说明'}`),
      ...blockedDeclarants.flatMap((d) => (d.blockedFields || []).map((f) => `补齐被配置挡住的字段：${f}`)),
    ],
    declarants: all.map((d) => ({from: d.from, verdict: d.verdict})),
    files: [],
  }
}

phase('Conservation')

// 合并由 comm-expert 之外的**脚本侧对账**先行：五条守恒是算术，
// 不是判断。agent 各自申报 lhs/rhs 之后，脚本逐条重算再比对——
// 让 integrator 去"看"这些数对不对，等于把算术交给一个会读错数的读者。
// 这里只做可判定的事（等号两侧、追溯字段齐全、乘子扫描），
// 语义上的取舍留给 integrator。
const flatEvents = declarations.flatMap((d) => (d.events || []).map((e) => ({...e, declaredBy: d.from, declaredQ: d.q})))

const traceGaps = flatEvents
  .filter((e) => EVENT_TRACE_FIELDS.some((f) => e[f] === undefined || e[f] === null || e[f] === ''))
  .map((e) => `${e.eventId || '(无名)'}: 缺 ${EVENT_TRACE_FIELDS.filter((f) => e[f] === undefined || e[f] === null || e[f] === '').join('/')}`)

const hashMismatch = flatEvents.filter((e) => e.manifestHash !== MANIFEST_HASH).map((e) => `${e.eventId}: hash=${e.manifestHash}`)

// 五条守恒逐条重算：lhs 与 rhs 必须真的相等，且 met 必须与比对结果一致。
// agent 写了 met=true 但两个数不等，是一次静默放行——比缺一条守恒更坏，因为它看起来是查过的。
const conservationErrors = []
for (const d of declarations) {
  for (const c of (d.conservations || [])) {
    const equal = Math.abs((c.lhs || 0) - (c.rhs || 0)) <= 1e-9 * Math.max(1, Math.abs(c.rhs || 0))
    if (equal !== c.met) {
      conservationErrors.push(`${d.q}/${c.name}: lhs=${c.lhs} rhs=${c.rhs} met=${c.met}（对账不符）`)
    }
  }
}
const missingConservations = declarations
  .flatMap((d) => CONSERVATIONS.filter((name) => !(d.conservations || []).some((c) => c.name === name)).map((name) => `${d.q} 缺 ${name}`))

// 无出处乘子：把事件流里的每一个倍率找出来。这一条之所以要脚本扫而不是靠 agent 自律，
// 是因为乘子最自然的写法是"流水线重叠 ×1.3"——它看起来像一句结论，不像一个错误。
const MULTIPLIER_PATTERN = /(?:加速|speedup|overlap|重叠|utilization\s*(?:gain|multiplier)|乘子)\s*[×x*]\s*\d|\d+(?:\.\d+)?\s*[×x]\s*(?:加速|speedup|overlap|重叠)/i
const multiplierHits = flatEvents
  .filter((e) => MULTIPLIER_PATTERN.test(String(e.source || '')) || MULTIPLIER_PATTERN.test(String(e.bufferLifetime || '')))
  .map((e) => e.eventId)

const eventGaps = [...traceGaps, ...hashMismatch.map((h) => `manifest hash 不一致：${h}`),
  ...conservationErrors, ...missingConservations, ...multiplierHits.map((id) => `${id}: 疑似无出处乘子`)]

if (eventGaps.length) {
  return {
    stage: STAGE, runId: RUN_ID, verdict: 'BLOCKED_CONFIG',
    reason: `B2 事件流未自洽：${eventGaps.slice(0, 12).join('；')}${eventGaps.length > 12 ? ` …共 ${eventGaps.length} 项` : ''}`,
    eventGaps,
    nextActions: eventGaps.slice(0, 12).map((g) => `补齐/更正：${g}`),
    files: [],
  }
}

const merged = await agent(
  `${head('integrator')}\n\n`
  + `brief：\n${BRIEF_JSON}\n\n`
  + `事件重放产物（只读）：${REPLAY_ARTIFACT}\n`
  + `三域各自申报的事件流：\n${JSON.stringify(declarations, null, 2)}\n`
  + `workflow 已钉住的 manifest hash：${MANIFEST_HASH}\n\n`
  + `任务：把三域事件流合并成一份，并做**跨域对账**。规则：\n`
  + `1. 只合并，不重新发明事件。三路的裸值原样保留，不得改写。\n`
  + `2. 逐算子做跨域对账：Q3 说搬了多少字节、Q4 说发了多少包与 credit、`
  + `   Q5 说花了多少拍——三者必须打得通。打不通的进 crossDomain 并置 consistent=false，`
  + `   不要替它们圆场。\n`
  + `3. 被排除的事件口径进 rejectedOptions，写清是哪条约束否掉的。\n`
  + `4. 三域互相矛盾时**不下折中值**——进 conflicts 并保留双方。\n`
  + `   特别地：若某域用了一个无出处的加速比，不要把它折算掉，原样报上来。\n`
  + `合并成立写 INTEGRATION_OK；有算子在三域之间对不上时写 DELTA_UNEXPLAINED。`,
  {label: 'integrator', phase: 'Conservation', effort: 'high', schema: MERGE_SCHEMA})

if (!merged || merged.verdict !== 'INTEGRATION_OK') {
  return {
    stage: STAGE, runId: RUN_ID, verdict: 'DELTA_UNEXPLAINED',
    merge: merged || null,
    reason: '三域事件流无法跨域对账；不落盘',
    nextActions: [
      ...((merged && merged.crossDomain) || []).filter((x) => !x.consistent)
        .map((x) => `打通 ${x.operatorId} 在 Q3/Q4/Q5 之间的口径`),
      ...((merged && merged.conflicts) || []).map((c) => `消解冲突：${c.subject || ''} —— ${c.resolution || '未给解除条件'}`),
      '定位无法归位的事件（见 merge）后重跑本格',
    ],
    files: [],
  }
}

phase('Invariant check')

// 末步是检点，不是总结。integrator 刚做完跨域对账，有"自己的对账没问题"的
// 结构性偏好；让它自己检点，对不上的地方会被解释成"口径差异"。
const check = await agent(
  `${head('invariant-checker')}\n\n`
  + `事件重放产物（只读）：${REPLAY_ARTIFACT}\n`
  + `三域申报：\n${JSON.stringify(declarations, null, 2)}\n`
  + `合并后的事件流：\n${JSON.stringify(merged, null, 2)}\n\n`
  + `任务：对这份事件流做全局不变量检点，逐条给出 pass/fail 与裸值：\n`
  + `7-reticle 面积守恒、单一硬件规格（ADR-0021）、MC320/MC640 分离、peak 与 sustained 分离、`
  + `单位一致、证据等级齐全。B2 还要专门核本格的三条退出条件：\n`
  + `  (a) 每个事件都能追溯到 ${EVENT_TRACE_FIELDS.join('、')}，且三路的 manifest hash 逐字一致；\n`
  + `  (b) 五条守恒（${CONSERVATIONS.join('、')}）在合并后仍然成立——`
  + `      合并不得让任何一条守恒的 lhs 与 rhs 漂移；\n`
  + `  (c) 全流里**没有**无出处的全局加速比或利用率乘子。`
  + `      这一条要主动去找，不是等它写出来。\n`
  + `另外核一条：重放产物里的 SYNTHETIC_PLACEHOLDER 事件有没有被真的引用为证据。`
  + `违规项必须给出违反的具体文件与字段。\n`
  + `不得把违规项解释掉（解释权归 architect）；不得以文档措辞为依据，只以数值和来源为依据。\n`
  + `全部通过写 INVARIANT_OK，任一不通过写 INVARIANT_VIOLATED。`,
  {label: 'invariant-checker', phase: 'Invariant check', effort: 'high', schema: CHECK_SCHEMA})

const okInvariants = check && check.verdict === 'INVARIANT_OK'

const ledgerPatch = {
  currentStage: STAGE,
  strategyVersions: {
    'memory-expert': '1.0', 'comm-expert': '1.0', 'compute-expert': '1.0',
    integrator: '1.0', 'invariant-checker': '1.0',
  },
  rejectedOptions: (merged.rejectedOptions || []).map((r) => ({
    stage: STAGE, optionId: r.optionId, reason: r.reason, rejectedBy: r.rejectedBy,
  })),
  // 对不上的跨域口径与三域矛盾都进 blocker：它们不会自己消失，
  // 下游的 execute 与 integrate 都会读这份事件流。
  openBlockers: [
    ...(merged.conflicts || []).map((c, i) => ({
      id: `EVENT-CONFLICT-${String(i + 1).padStart(2, '0')}`,
      owner: (c.between && c.between[0]) || 'integrator',
      unblockCondition: c.resolution,
    })),
    ...(merged.crossDomain || []).filter((x) => !x.consistent).map((x, i) => ({
      id: `EVENT-CROSSDOMAIN-${String(i + 1).padStart(2, '0')}`,
      owner: 'integrator',
      unblockCondition: `打通 ${x.operatorId} 在 Q3/Q4/Q5 之间的口径`,
    })),
  ],
}

const runRecord = {
  schemaVersion: 'design-run-record-v0.1',
  stage: STAGE,
  runId: RUN_ID,
  sourceCommit: BRIEF.sourceCommit,
  replayArtifact: REPLAY_ARTIFACT,
  detailRunArtifact: DETAIL_RUN_ARTIFACT,
  workloadArtifact: WORKLOAD_ARTIFACT,
  stageCommand: STAGE_COMMAND_FOR_RECORD,
  manifestHash: MANIFEST_HASH,
  // 事件集指纹：两次跑出来的是不是同一份事件流，靠这个可复核。
  eventSet: flatEvents.map((e) => `${e.eventId}|${e.type}|${e.operatorId}|${e.tileId}`).sort(),
  eventCount: flatEvents.length,
  byDomain: Object.fromEntries(declarations.map((d) => [d.q, (d.events || []).length])),
  conservations: Object.fromEntries(CONSERVATIONS.map((name) => [
    name,
    declarations.every((d) => (d.conservations || []).some((c) => c.name === name && c.met)) ? 'met' : 'violated',
  ])),
  declarants: declarations.map((d) => d.from).sort(),
  caliber: '事件流为逐事件口径；bytes/flops/transactions 皆为产物裸值，workflow 不产生任何数字；'
    + 'Q3-Q6 的 SYNTHETIC_PLACEHOLDER 占位不作为证据',
}

return {
  stage: STAGE,
  runId: RUN_ID,
  verdict: okInvariants ? 'INVARIANT_OK' : 'INVARIANT_VIOLATED',
  events: okInvariants ? merged.events : null,
  crossDomain: okInvariants ? merged.crossDomain : null,
  manifestHash: MANIFEST_HASH,
  conflicts: merged.conflicts || [],
  violations: okInvariants ? [] : ((check && check.violations) || ['检点未完成']),
  ledgerPatch,
  runRecord,
  files: okInvariants ? [
    {
      path: `${REPO}/out/detailed/detail_events.json`,
      content: JSON.stringify({
        schemaVersion: 'design-detail-events-v0.1',
        stage: STAGE, runId: RUN_ID, sourceCommit: BRIEF.sourceCommit,
        replayArtifact: REPLAY_ARTIFACT,
        detailRunArtifact: DETAIL_RUN_ARTIFACT,
        manifestHash: MANIFEST_HASH,
        events: merged.events,
        crossDomain: merged.crossDomain,
        rejectedOptions: merged.rejectedOptions || [],
        conflicts: merged.conflicts || [],
      }, null, 2) + '\n',
    },
    {
      path: `${REPO}/out/detailed/detail_events_run_record.json`,
      content: JSON.stringify(runRecord, null, 2) + '\n',
    },
  ] : [],
}
