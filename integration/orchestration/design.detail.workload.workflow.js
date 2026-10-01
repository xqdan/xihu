export const meta = {
  name: 'design-detail-workload',
  description: 'K3 设计 detail.workload 阶段（B1）：model-expert 先定 manifest 与算子 DAG，compute-expert 与 memory-expert 并行做算术强度/Roofline/sizing，integrator 合并成算子账本，invariant-checker 检点后落盘',
  whenToUse: 'D 组第二格。需要 args.brief（stage=detail.workload 的 DesignBrief）、args.workloadArtifact（out/workload/planning_operator_workload.json 路径）、args.detailRunArtifact（out/detailed/detailed_architecture_run.json 路径）与可选 args.freezeArtifact（上一格落盘的冻结清单）。三者均由主循环生成。本 workflow 不跑 stage_b.js、不写既有产物。',
  phases: [
    { title: 'Operator inventory', detail: 'model-expert 定 manifest 与算子 DAG；未知配置必须 BLOCKED_CONFIG，不得静默补齐' },
    { title: 'Roofline and sizing', detail: 'compute-expert 与 memory-expert 并行：算术强度、Roofline、sizing 三条比' },
    { title: 'Merge', detail: 'integrator 合并成算子账本，只合并不重新发明' },
    { title: 'Invariant check', detail: 'invariant-checker 强制检点；不通过则不落盘' },
  ],
}

// ---------------------------------------------------------------------------
// D 组第二格：B1（19 号文档 §4）。
//
// 要回答的两个问题是 Q1（manifest / 算子 DAG 定下来了吗）与
// Q2（算术强度、Roofline、sizing 算得出来吗）。二者是**串行**的：
// 算子清单没定，逐个算子的强度就无从谈起。所以 model-expert 独自走第一步，
// compute-expert 与 memory-expert 在第二步并行——§4.1 表里 workload 的并行体是 2，
// 指的就是它俩。
//
// B1 的退出条件是三条，全部可复核：
//   1. 三条 sizing 比齐备（compute / bandwidch / network）；
//   2. 每个算子都有 operator_id、core_class、status、confidence、source；
//   3. LOCAL_DETAIL_FIX / DIRECTION_BACKFLOW / BLOCKED_CONFIG 的区分是明确的，
//      不是"三选一里随便挑一个"。
//
// 四条硬边界在此的落点：
//   边界 1：输出什么由本 workflow 注入，三份策略正文里没有输出契约。
//   边界 2：路径只出现在本文件里；策略靠 prompt 里的 agentId 自读正文。
//   边界 3：三位专家的裁决枚举由本 workflow 的 switch 消费。
//   边界 4：**强度、Roofline、三条比一律由 stage_b.js 的 ledgerRows 算好**，
//           绑在算子账本里。本文件与任何 agent 都不产生这些数字——
//           compute-expert 尤其不得输出 TPS/usr 或 PASS / D_GATE_PASSED。
// ---------------------------------------------------------------------------

const REPO = args.repo || '.'
const STAGE = 'detail.workload'
const BRIEF = args.brief
const RUN_ID = args.runId || 'detail-workload-run'
// 算子工作负载、上一步的细化产物、以及上一格的冻结清单，都由主循环先生成。
const WORKLOAD_ARTIFACT = args.workloadArtifact
const DETAIL_RUN_ARTIFACT = args.detailRunArtifact
const FREEZE_ARTIFACT = args.freezeArtifact || 'UNVERIFIED'
const STAGE_COMMAND_FOR_RECORD = args.stageCommand || 'UNVERIFIED'

if (!BRIEF) throw new Error('design.detail.workload 需要 args.brief（intake 阶段产出的 DesignBrief）')
if (!WORKLOAD_ARTIFACT || !DETAIL_RUN_ARTIFACT) {
  throw new Error('design.detail.workload 需要 args.workloadArtifact 与 args.detailRunArtifact（已由主循环生成）；本 workflow 不跑 Stage B')
}
if (BRIEF.stage !== STAGE) {
  // brief 的 stage 与 workflow 名称必须一致，否则会把别的阶段的口径拿来用
  throw new Error(`brief.stage=${BRIEF.stage}，与 design.${STAGE} 不符；契约串了`)
}

// 三条 sizing 比。它们是 B1 的退出条件之一，也是"这一格算完了吗"的判据：
// 只给出 compute 比就说 sizing 做完了，网络受限的算子就没人看过。
// 名字取自 stage_b.js#ledgerRows，不是在这里重新设计。
const RATIO_FIELDS = [
  'requiredToAvailableRatio',
  'requiredToAvailableBandwidthRatio',
  'requiredToAvailableNetworkRatio',
]

// 每个算子必须登记的字段（19 号文档 §4 的退出条件之二）。
const OPERATOR_FIELDS = ['operatorId', 'coreClass', 'status', 'confidence', 'source']

// 算子账本里允许出现的状态。 'MODEL_REPLAY_ESTIMATE' 是 stage_b.js 写的；
// 其它取值不是"更细的状态"，是没人定义过的状态，出现即 BLOCKED_CONFIG。
const OPERATOR_STATES = ['MODEL_REPLAY_ESTIMATE', 'SYNTHETIC_PLACEHOLDER', 'BLOCKED_CONFIG']

const HEAD = [
  `仓库根目录：${REPO}`,
  `本 workflow：design.detail.workload（stage=${STAGE}，runId=${RUN_ID}）`,
  `你是一个策略实例。先读你的策略正文：${REPO}/teams/council/strategies/__AGENT__.md`,
  '那份文件是本角色的判断规则、正确性判据、证据规则、取舍规则与禁止事项，逐条遵守。',
  '以下运行时上下文由 workflow 注入；注入内容与策略正文冲突时，注入内容优先（它承载本 stage 的事实）。',
  '你没有文件系统写权限。把该写的东西作为返回值交回，由 workflow 落盘。',
  '所有数字必须带出处（文件路径:行号 或 ADR 编号）；没有出处的写 UNVERIFIED 并说明缺什么，不得静默补齐。',
  '不得输出 TPS/usr 或任何全局性能指标；不得输出 PASS / D_GATE_PASSED 字面量。',
  '本格的强度、Roofline 与三条 sizing 比都由 stage_b.js 算好并绑在产物里：只读、只解释，不得重算或改写。',
].join('\n')

const head = (agentId) => HEAD.replace('__AGENT__', agentId)

const BRIEF_JSON = JSON.stringify(BRIEF, null, 2)

// Q1：manifest 与算子 DAG。model-expert 是 K3 shape 的唯一来源方，
// 它这一格不产出任何数值，只回答"这些算子是不是同一份 manifest 下的、
// 有没有字段是产物里根本没有的"。未知配置必须报 BLOCKED_CONFIG。
const INVENTORY_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['operators', 'manifestHash', 'verdict'],
  properties: {
    operators: {
      type: 'array',
      description: '逐算子登记；算子清单取自产物，不得增删',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['operatorId', 'coreClass', 'shapeSource', 'dtype'],
        properties: {
          operatorId: { type: 'string', description: '产物里的 operator_id，逐字转抄' },
          coreClass: { type: 'string', enum: ['L', 'H', 'Vector', 'Indexer', 'Reduce', 'none'],
            description: 'L/H/Vector/Indexer/Reduce 必须分开，不得合并成单一 peak' },
          shapeSource: { type: 'string', description: '这个算子的 shape 来自哪个文件:行号' },
          dtype: { type: 'string', description: 'FP8 / BF16 / MXFP4 …；dequant 与累加代价不得隐藏' },
        },
      },
    },
    manifestHash: { type: 'string', description: '这一轮的 manifest hash，逐字转抄产物里的值' },
    unknownFields: {
      type: 'array',
      description: '产物里没有、无法确认的字段——它们必须导致 BLOCKED_CONFIG，不得取近似值',
      items: { type: 'string' },
    },
    verdict: { type: 'string', enum: ['LOCAL_DETAIL_FIX', 'BLOCKED_CONFIG'] },
    blockedFields: { type: 'array', items: { type: 'string' }, description: 'BLOCKED_CONFIG 时必填' },
  },
}

// Q2：算术强度 / Roofline / sizing。两位专家共用同一形状，
// 因为"compute 侧说这个算子算力受限"和"memory 侧说它带宽受限"
// 必须指向同一个对象，integrator 才能判它们是不是在说同一件事。
const SIZING_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['from', 'operators', 'ratios', 'verdict'],
  properties: {
    from: { type: 'string', description: '给出申报的 agentId' },
    operators: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['operatorId', 'arithmeticIntensity', 'rooflineBound', 'evidence'],
        properties: {
          operatorId: { type: 'string' },
          arithmeticIntensity: { type: 'number', description: '产物里的裸值，逐字转抄，不得重算' },
          rooflineBound: { type: 'string', enum: ['bandwidth', 'compute'] },
          evidence: { type: 'string', description: '文件路径:行号 或 hash；引用不到写 UNVERIFIED' },
        },
      },
    },
    ratios: {
      type: 'array',
      description: '三条 sizing 比；名字取自 workflow 给出的清单，不得增减',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['name', 'worstOperator', 'worstValue', 'source'],
        properties: {
          name: { type: 'string' },
          worstOperator: { type: 'string', description: '本域里这条比最高的算子' },
          worstValue: { type: 'number', description: '裸值；不得只写"接近上限"' },
          source: { type: 'string' },
        },
      },
    },
    verdict: { type: 'string', enum: ['LOCAL_DETAIL_FIX', 'DIRECTION_BACKFLOW', 'BLOCKED_CONFIG'] },
    blockedFields: { type: 'array', items: { type: 'string' } },
    backflowReason: { type: 'string', description: 'DIRECTION_BACKFLOW 时必填：动摇了哪条方向级假设' },
  },
}

// 合并产物。integrator 只合并，不重新发明算子、通信或 PPA 模型。
const MERGE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['operators', 'ratios', 'rejectedOptions', 'conflicts', 'verdict'],
  properties: {
    operators: {
      type: 'array',
      description: '合并后的算子账本：每个算子五行齐全，三条比落位',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['operatorId', 'coreClass', 'status', 'confidence', 'source', 'rooflineBound',
          'requiredToAvailableRatio', 'requiredToAvailableBandwidthRatio', 'requiredToAvailableNetworkRatio'],
        properties: {
          operatorId: { type: 'string' },
          coreClass: { type: 'string' },
          status: { type: 'string', description: '必须是产物里已有的取值，不得发明' },
          confidence: { type: 'string', description: 'E0/E1/E2/E3 或产物里的 confidence 值' },
          source: { type: 'string', description: '文件路径:行号 或 hash' },
          rooflineBound: { type: 'string', enum: ['bandwidth', 'compute'] },
          requiredToAvailableRatio: { type: 'number' },
          requiredToAvailableBandwidthRatio: { type: 'number' },
          requiredToAvailableNetworkRatio: { type: 'number' },
        },
      },
    },
    ratios: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['name', 'worstOperator', 'worstValue'],
        properties: {
          name: { type: 'string' },
          worstOperator: { type: 'string' },
          worstValue: { type: 'number' },
        },
      },
    },
    rejectedOptions: {
      type: 'array',
      description: '被排除的算子/口径与理由。必须登记，否则重跑会重新发明已否方案',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['optionId', 'reason', 'rejectedBy'],
        properties: {
          optionId: { type: 'string' },
          reason: { type: 'string' },
          rejectedBy: { type: 'string', description: '哪条约束/哪个检查否掉了它' },
        },
      },
    },
    conflicts: {
      type: 'array',
      description: '两位专家的结论互相矛盾时**不下折中值**，保留双方',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['between', 'operatorId', 'description', 'resolution'],
        properties: {
          between: { type: 'array', items: { type: 'string' } },
          operatorId: { type: 'string' },
          description: { type: 'string' },
          resolution: { type: 'string', description: '解除冲突需要什么；不确定写 UNVERIFIED' },
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
          file: { type: 'string', description: '违反的具体文件' },
          field: { type: 'string', description: '违反的具体字段' },
          detail: { type: 'string' },
        },
      },
    },
    verdict: { type: 'string', enum: ['INVARIANT_OK', 'INVARIANT_VIOLATED'] },
  },
}

phase('Operator inventory')

// Q1 是串行的第一步：算子清单与 manifest 不确定，逐个算子的强度就没有对象。
// 让 compute/memory 与它并行，等于让两侧去算一份可能被推翻的算子表。
const inventory = await agent(
  `${head('model-expert')}\n\n`
  + `brief：\n${BRIEF_JSON}\n\n`
  + `算子工作负载（主循环已生成，只读）：${WORKLOAD_ARTIFACT}\n`
  + `细化产物（只读）：${DETAIL_RUN_ARTIFACT}\n`
  + `上一格落盘的冻结清单（只读）：${FREEZE_ARTIFACT}\n\n`
  + `任务：定下 B1 的算子 DAG。逐算子登记 operator_id、core_class、shape 出处与 dtype。规则：\n`
  + `1. K3 形状的唯一来源是 teams/model/src/design_engine.js 的 preset；`
  + `   别处重建出来的一律不算，产物里没有的就进 unknownFields。\n`
  + `2. attention、MoE、indexer、MTP 必须分类记账，不得合并。\n`
  + `3. L/H/Vector/Indexer/Reduce 不得合并为单一 peak；每个算子必须落到其中一个核心类。\n`
  + `4. **不得静默补齐**未知的层数、dtype、expert 参数。产物里没有的字段进 unknownFields，`
  + `   并据此报 BLOCKED_CONFIG，不得给出近似值。\n`
  + `5. manifest hash 逐字转抄产物里的值，不得重算。\n`
  + `登记完成且无缺失写 LOCAL_DETAIL_FIX；有未知字段写 BLOCKED_CONFIG。`,
  {label: 'inventory:model', phase: 'Operator inventory', effort: 'high', schema: INVENTORY_SCHEMA})

if (!inventory || inventory.verdict !== 'LOCAL_DETAIL_FIX') {
  return {
    stage: STAGE, runId: RUN_ID,
    verdict: inventory ? inventory.verdict : 'BLOCKED_CONFIG',
    inventory: inventory || null,
    reason: '算子 DAG 未定：manifest 存在未确认字段或算子清单不完整；不落盘',
    blockedFields: inventory ? (inventory.blockedFields || inventory.unknownFields || []) : [],
    nextActions: [
      ...(inventory ? (inventory.blockedFields || inventory.unknownFields || []).map((f) => `补齐产物里缺失的算子/manifest 字段：${f}`) : []),
      '确认算子清单与 manifest hash 是否可从 teams/model/src/design_engine.js 复算；补齐后重跑本格',
    ],
    files: [],
  }
}

phase('Roofline and sizing')

// 两域并行，互不可见。看见彼此的结论就会对齐口径，sizing 就变成一份结论被抄两遍——
// 而这一格的整个价值恰恰是"算力侧与带宽侧各自独立地指出瓶颈"。
const sizing = (await parallel([
  {agentId: 'compute-expert', domain: 'AI Core 微架构：算术强度、Roofline 的 compute 侧、核数与频率', label: 'sizing:compute'},
  {agentId: 'memory-expert', domain: 'SRAM 层级与 buffer lifetime、MC 控制器、TMA、带宽与容量墙', label: 'sizing:memory'},
].map((d) => () => agent(
  `${head(d.agentId)}\n\n`
  + `brief：\n${BRIEF_JSON}\n\n`
  + `细化产物（只读，含 script 算好的算子账本）：${DETAIL_RUN_ARTIFACT}\n`
  + `model-expert 定下的算子 DAG：\n${JSON.stringify(inventory, null, 2)}\n\n`
  + `三条 sizing 比的名字（用这些，不得增减）：\n${RATIO_FIELDS.join(', ')}\n\n`
  + `任务：你是本域（${d.domain}）的 sizing 申报人。对每个算子给出：`
  + `算术强度、Roofline 落在哪一侧、以及本域最吃紧的算子与裸值。规则：\n`
  + `1. **强度与三条比都由 stage_b.js 算好并绑在产物里**：逐字转抄，不得重算、不得取近似值。\n`
  + `2. 三条比必须齐备。只报 compute 比就说 sizing 做完了，网络受限的算子就没人看过。\n`
  + `3. 本域说不上话的算子照样登记，出处写 UNVERIFIED 并说明缺什么——不得跳过。\n`
  + `4. 不得隐藏 dequant 与累加代价；不得把理论带宽当作 sustained。\n`
  + `申报完成后给出本域裁决：\n`
  + `  LOCAL_DETAIL_FIX：本域的 sizing 完整，可在当前框架下自行调整。\n`
  + `  DIRECTION_BACKFLOW：本域发现在冻结的形态下某类算子根本算不过来或装不下，`
  + `不是差一点而是方向级矛盾，必须回到 direction 重定。用这个裁决时写明动摇了哪条假设。\n`
  + `  BLOCKED_CONFIG：产物缺字段或算子组合不可实现，在 blockedFields 里列出缺哪些。\n`
  + `注意：你不判 sizing 是否通过——那是 integrator 与检点者的事。`,
  {label: d.label, phase: 'Roofline and sizing', effort: 'high', schema: SIZING_SCHEMA})
))).filter(Boolean)

if (sizing.length < 2) {
  return {
    stage: STAGE, runId: RUN_ID, verdict: 'BLOCKED_CONFIG',
    reason: `sizing 申报不完整，缺：${['compute-expert', 'memory-expert'].filter((a) => !sizing.some((s) => s.from === a)).join(', ')}`,
    nextActions: ['补齐缺失一域的 sizing 申报；若产物缺字段，先补产物再重跑本格'],
    files: [],
  }
}

// 裁决枚举由 workflow 消费。方向回流在这里先拦：继续走只会产出一份
// 建立在错前提上的账本，而后面每一格都读它。
const backflow = sizing.filter((s) => s.verdict === 'DIRECTION_BACKFLOW')
const blockedSizing = sizing.filter((s) => s.verdict === 'BLOCKED_CONFIG')

if (backflow.length || blockedSizing.length) {
  const all = backflow.concat(blockedSizing)
  return {
    stage: STAGE, runId: RUN_ID,
    verdict: backflow.length ? backflow[0].verdict : 'BLOCKED_CONFIG',
    reason: backflow.length
      ? `sizing 报方向回流：${backflow.map((s) => `${s.from}(${s.backflowReason || '未说明'})`).join('；')}；未合并账本`
      : `sizing 被配置挡住：${blockedSizing.map((s) => s.from).join(', ')}；未合并账本`,
    blockedFields: all.flatMap((s) => s.blockedFields || []),
    nextActions: [
      ...backflow.map((s) => `把 ${s.from} 的方向级证据作为 DIRECTION_BACKFLOW 交给 A0 重定方向：${s.backflowReason || '未说明'}`),
      ...blockedSizing.flatMap((s) => (s.blockedFields || []).map((f) => `补齐被配置挡住的字段：${f}`)),
    ],
    sizing: all.map((s) => ({from: s.from, verdict: s.verdict})),
    files: [],
  }
}

phase('Merge')

const merged = await agent(
  `${head('integrator')}\n\n`
  + `brief：\n${BRIEF_JSON}\n\n`
  + `细化产物（只读，含 script 算好的算子账本）：${DETAIL_RUN_ARTIFACT}\n`
  + `算子 DAG：\n${JSON.stringify(inventory, null, 2)}\n`
  + `compute 侧的 sizing：\n${JSON.stringify(sizing.find((s) => s.from === 'compute-expert'), null, 2)}\n`
  + `memory 侧的 sizing：\n${JSON.stringify(sizing.find((s) => s.from === 'memory-expert'), null, 2)}\n\n`
  + `任务：把两侧合并成一份算子账本。规则：\n`
  + `1. 只合并，不重新发明算子模型。两侧的申报是输入，不是草稿；`
  + `   不得改写它们的裸值，也不得自行补一个产物里没有的算子。\n`
  + `2. 每个算子必须五行齐全（${OPERATOR_FIELDS.join('、')}），`
  + `   status 必须是产物里已有的取值，不得发明新状态。\n`
  + `3. 三条 sizing 比逐条落位，worst 算子与裸值原样带过来。\n`
  + `4. 被排除的口径进 rejectedOptions，写清是哪条约束/哪个检查否掉的。\n`
  + `5. 两侧互相矛盾时**不下折中值**——进 conflicts 并保留双方。\n`
  + `合并成立写 INTEGRATION_OK；有算子无法归位到任何一条 lane 时写 DELTA_UNEXPLAINED。`,
  {label: 'integrator', phase: 'Merge', effort: 'high', schema: MERGE_SCHEMA})

if (!merged || merged.verdict !== 'INTEGRATION_OK') {
  return {
    stage: STAGE, runId: RUN_ID, verdict: 'DELTA_UNEXPLAINED',
    merge: merged || null,
    reason: '两侧 sizing 无法合并成一份算子账本；不落盘',
    nextActions: ['定位无法归位的算子或冲突项（见 merge.conflicts），消解后重跑本格'],
    files: [],
  }
}

// B1 的退出条件由数据对账，不由 agent 自律保证：算子五行不齐、三条比缺一条，
// 这一格就没有算完。退回而不是"标注一下照样落盘"。
const incompleteOperators = merged.operators
  .filter((op) => OPERATOR_FIELDS.some((f) => op[f] === undefined || op[f] === null || op[f] === ''))
  .map((op) => op.operatorId)
const badStates = merged.operators.filter((op) => !OPERATOR_STATES.includes(op.status)).map((op) => `${op.operatorId}=${op.status}`)
const missingRatios = RATIO_FIELDS.filter((name) => !merged.ratios.some((r) => r.name === name))
const ratiosNotOnOperators = RATIO_FIELDS.filter((name) => merged.operators.some((op) => typeof op[name] !== 'number'))

const sizingGaps = [...new Set([
  ...incompleteOperators.map((id) => `${id}: 算子账本字段不齐`),
  ...badStates.map((s) => `状态未定义：${s}`),
  ...missingRatios.map((r) => `缺 sizing 比：${r}`),
  ...ratiosNotOnOperators.map((r) => `算子账本缺比：${r}`),
])]

if (sizingGaps.length) {
  return {
    stage: STAGE, runId: RUN_ID, verdict: 'BLOCKED_CONFIG',
    reason: `B1 退出条件未满足：${sizingGaps.join('；')}`,
    sizingGaps,
    nextActions: sizingGaps.map((g) => `补齐/更正：${g}`),
    files: [],
  }
}

phase('Invariant check')

// 末步是检点，不是总结。integrator 有"给自己的合并结果背书"的结构性偏好，
// 所以它与检点者必须是两次调用——让合并的人自己当检点，违规项会被它解释掉。
const check = await agent(
  `${head('invariant-checker')}\n\n`
  + `细化产物（只读）：${DETAIL_RUN_ARTIFACT}\n`
  + `算子 DAG：\n${JSON.stringify(inventory, null, 2)}\n`
  + `两位专家各自的 sizing 申报：\n${JSON.stringify(sizing, null, 2)}\n`
  + `合并后的算子账本：\n${JSON.stringify(merged, null, 2)}\n\n`
  + `任务：对这份算子账本做全局不变量检点，逐条给出 pass/fail 与裸值：\n`
  + `7-reticle 面积守恒、单一硬件规格（ADR-0021）、MC320/MC640 分离、peak 与 sustained 分离、`
  + `单位一致、证据等级齐全。B1 还要专门核本格的三条退出条件：\n`
  + `  (a) 三条 sizing 比齐备且落在具体算子上；\n`
  + `  (b) 每个算子的 ${OPERATOR_FIELDS.join('、')} 都有值；\n`
  + `  (c) 两位专家的裁决区分是明确的——LOCAL_DETAIL_FIX 与 BACKFLOW/BLOCKED 的边界没有被摊平。\n`
  + `另外核一条：L/H/Vector/Indexer/Reduce 是否真的分开记账，有没有被合并成单一 peak。\n`
  + `违规项必须给出违反的具体文件与字段。\n`
  + `不得把违规项解释掉（解释权归 architect）；不得以文档措辞为依据，只以数值和来源为依据。\n`
  + `全部通过写 INVARIANT_OK，任一不通过写 INVARIANT_VIOLATED。`,
  {label: 'invariant-checker', phase: 'Invariant check', effort: 'high', schema: CHECK_SCHEMA})

const okInvariants = check && check.verdict === 'INVARIANT_OK'

const ledgerPatch = {
  currentStage: STAGE,
  strategyVersions: {
    'model-expert': '1.0', 'compute-expert': '1.0', 'memory-expert': '1.0',
    integrator: '1.0', 'invariant-checker': '1.0',
  },
  // rejectedOptions 必须带：否则重跑会重新发明已否方案。
  rejectedOptions: (merged.rejectedOptions || []).map((r) => ({
    stage: STAGE, optionId: r.optionId, reason: r.reason, rejectedBy: r.rejectedBy,
  })),
  // 两位专家的矛盾不下折中值，登记为 blocker 保留双方。
  openBlockers: (merged.conflicts || []).map((c, i) => ({
    id: `CONFLICT-${STAGE.toUpperCase().replace('.', '-')}-${String(i + 1).padStart(2, '0')}`,
    owner: (c.between && c.between[0]) || 'integrator',
    unblockCondition: c.resolution,
  })),
}

const runRecord = {
  schemaVersion: 'design-run-record-v0.1',
  stage: STAGE,
  runId: RUN_ID,
  sourceCommit: BRIEF.sourceCommit,
  workloadArtifact: WORKLOAD_ARTIFACT,
  detailRunArtifact: DETAIL_RUN_ARTIFACT,
  freezeArtifact: FREEZE_ARTIFACT,
  stageCommand: STAGE_COMMAND_FOR_RECORD,
  manifestHash: inventory.manifestHash,
  // 算子集的指纹：两次跑出来的算子账本是否同一份，靠这个可复核，
  // 而不是靠人比对两份几百行的 JSON。
  operatorSet: merged.operators.map((op) => `${op.operatorId}|${op.coreClass}|${op.rooflineBound}`).sort(),
  operatorCount: merged.operators.length,
  sizingRatios: merged.ratios.map((r) => r.name).sort(),
  declarants: sizing.map((s) => s.from).sort(),
  caliber: '算子账本为 CALIBRATED_PLANNING_TOKEN_TIME 口径；强度、Roofline 与三条比一律取自 stage_b.js 的产物，workflow 不产生任何数字',
}

return {
  stage: STAGE,
  runId: RUN_ID,
  verdict: okInvariants ? 'INVARIANT_OK' : 'INVARIANT_VIOLATED',
  operators: okInvariants ? merged.operators : null,
  ratios: okInvariants ? merged.ratios : null,
  manifestHash: inventory.manifestHash,
  conflicts: merged.conflicts || [],
  violations: okInvariants ? [] : ((check && check.violations) || ['检点未完成']),
  ledgerPatch,
  runRecord,
  files: okInvariants ? [
    {
      path: `${REPO}/out/detailed/detail_workload.json`,
      content: JSON.stringify({
        schemaVersion: 'design-detail-workload-v0.1',
        stage: STAGE, runId: RUN_ID, sourceCommit: BRIEF.sourceCommit,
        workloadArtifact: WORKLOAD_ARTIFACT,
        detailRunArtifact: DETAIL_RUN_ARTIFACT,
        manifestHash: inventory.manifestHash,
        operators: merged.operators,
        ratios: merged.ratios,
        rejectedOptions: merged.rejectedOptions || [],
        conflicts: merged.conflicts || [],
      }, null, 2) + '\n',
    },
    {
      path: `${REPO}/out/detailed/detail_workload_run_record.json`,
      content: JSON.stringify(runRecord, null, 2) + '\n',
    },
  ] : [],
}
