export const meta = {
  name: 'design-detail-freeze',
  description: 'K3 设计 detail.freeze 阶段（B0 控制面）：冻结 candidate_id / runMode / model_id / physicalProfile / mcProfile / tp·cp·ep / source commit / 输入 hash / manifest hash / seed，model-expert 与 memory-expert 各从本域核验冻结项是否可复现，invariant-checker 检点后落盘',
  whenToUse: 'D 组第一格。需要 args.brief（stage=detail.freeze 的 DesignBrief）、args.registerArtifact（out/governance/candidate_register.json 路径）与 args.detailRunArtifact（主循环已用 stage_b.js 生成好的 out/detailed/detailed_architecture_run.json 路径）。本 workflow 不跑 stage_b.js、不写 out/ 的任何既有产物。',
  phases: [
    { title: 'Freeze declaration', detail: 'model-expert 与 memory-expert 各从本域核验冻结项，两路互不可见' },
    { title: 'Freeze assembly', detail: '冻结清单与 provenance 由脚本产物逐字转抄，agent 只登记缺项' },
    { title: 'Invariant check', detail: 'invariant-checker 强制检点；不通过则不落盘' },
  ],
}

// ---------------------------------------------------------------------------
// D 组第一格：B0 控制面（19 号文档 §3）。
//
// 要回答的唯一问题是"这一轮细化用的到底是哪一份配置"。
// B0 的退出条件是三条，全部是**可复核的事实**，不是判断：
//   1. 候选来源唯一可追溯（candidate_id → candidate_register.json）
//   2. 所有模型的 manifest 状态是 FROZEN / PLANNING / BLOCKED_CONFIG 之一
//   3. 资源只来自单一硬件规格（ADR-0021）；run_id 与 input hash 共享
//
// 与 C 组骨架的三点关键区别：
//
// 1. **没有 integrator。** §4.2 明确规定。freeze 是"抄录 + 核验"，不是"合并"——
//    合并的语义是"多个上游结论汇成一个"（那是 B4 与 B1 的事），而 B0 的上游
//    只有一份确定性产物（stage_b.js 写的 detailed_architecture_run.json）。
//    给一个只有单一输入的格子配 integrator，等于让合并者去"合并"一份文件，
//    而 integrator 的判据 INTEGRATION_OK / DELTA_UNEXPLAINED 是关于
//    "多份结论能不能归位"的，在这里无从判定——它会退化成橡皮图章。
//
// 2. **没有搜索步。** freeze 不枚举任何设计空间：候选早在 D-Gate 就定死了。
//    这里的确定性输入是 stage_b.js，由主循环先跑完，路径经 args 传入。
//
// 3. **末步仍是 invariant-checker**，且落盘受它门控。冻结清单一旦落盘，
//    后面每一格都建在它上面；检点不通过还写出去，等于把违规的 provenance
//    变成下游的既成事实。
//
// 四条硬边界在此的落点：
//   边界 1：输出什么由本 workflow 注入，两份策略正文里没有输出契约。
//   边界 2：路径只出现在本文件里；策略靠 prompt 里的 agentId 自读正文。
//   边界 3：两位专家的裁决枚举（LOCAL_DETAIL_FIX / DIRECTION_BACKFLOW /
//           BLOCKED_CONFIG）与检点枚举由本 workflow 的 switch 消费。
//   边界 4：**冻结项里的每一个数字都由 stage_b.js 算**。本文件与任何 agent
//           都不得产生 candidate_id、hash、seed 或任何 TPS——只转抄与核验。
//           model-expert 尤其不得输出 TPS/usr，也不得输出 PASS / D_GATE_PASSED。
// ---------------------------------------------------------------------------

const REPO = args.repo || '.'
const STAGE = 'detail.freeze'
const BRIEF = args.brief
const RUN_ID = args.runId || 'detail-freeze-run'
// 冻结的候选由 D-Gate 定死，不由本格枚举。寄存器与细化产物都由主循环先生成。
const REGISTER_ARTIFACT = args.registerArtifact
const DETAIL_RUN_ARTIFACT = args.detailRunArtifact
const STAGE_COMMAND_FOR_RECORD = args.stageCommand || 'UNVERIFIED'

if (!BRIEF) throw new Error('design.detail.freeze 需要 args.brief（intake 阶段产出的 DesignBrief）')
if (!REGISTER_ARTIFACT || !DETAIL_RUN_ARTIFACT) {
  throw new Error('design.detail.freeze 需要 args.registerArtifact 与 args.detailRunArtifact（已由主循环用 stage_b.js 生成）；本 workflow 不跑 Stage B')
}
if (BRIEF.stage !== STAGE) {
  // brief 的 stage 与 workflow 名称必须一致，否则会把别的阶段的冻结项拿来用
  throw new Error(`brief.stage=${BRIEF.stage}，与 design.${STAGE} 不符；契约串了`)
}

// B0 必须冻结的字段。这份清单是**阶段定义**（19 号文档 §3），不是从产物里读出来的——
// 用被测数据决定核验范围，等于让被测者定考题。少核一项，冻结就是有洞的。
const FREEZE_FIELDS = [
  'candidateId', 'runMode', 'modelId', 'physicalProfile', 'mcProfile',
  'tp', 'cp', 'ep', 'sourceCommit', 'manifestHash', 'inputHashes', 'seed',
]

// 每个模型可接受的 manifest 状态。三者之外的取值不是"更细的状态"，
// 是没人定义过的状态——出现即 BLOCKED_CONFIG，不得按"看起来像 planning"放行。
const MANIFEST_STATES = ['FROZEN', 'PLANNING', 'BLOCKED_CONFIG']

const HEAD = [
  `仓库根目录：${REPO}`,
  `本 workflow：design.detail.freeze（stage=${STAGE}，runId=${RUN_ID}）`,
  `你是一个策略实例。先读你的策略正文：${REPO}/teams/council/strategies/__AGENT__.md`,
  '那份文件是本角色的判断规则、正确性判据、证据规则、取舍规则与禁止事项，逐条遵守。',
  '以下运行时上下文由 workflow 注入；注入内容与策略正文冲突时，注入内容优先（它承载本 stage 的事实）。',
  '你没有文件系统写权限。把该写的东西作为返回值交回，由 workflow 落盘。',
  '所有数字必须带出处（文件路径:行号 或 ADR 编号）；没有出处的写 UNVERIFIED 并说明缺什么，不得静默补齐。',
  '不得输出 TPS/usr 或任何全局性能指标；不得输出 PASS / D_GATE_PASSED 字面量。',
  '本格是冻结，不是设计：不得发明候选、不得重算任何数值、不得改写产物里的任何字段。',
].join('\n')

const head = (agentId) => HEAD.replace('__AGENT__', agentId)

const BRIEF_JSON = JSON.stringify(BRIEF, null, 2)

// 冻结申报。专家从**本域**回答"这些冻结项在本域能不能兑现"：
// model-expert 关心 manifest 字段与 shape 是否可复算，
// memory-expert 关心 MC profile 与容量/带宽是否与冻结的 mcProfile 一致。
// 两个 schema 的裁决枚举不同——model-expert 只有 LOCAL_DETAIL_FIX / BLOCKED_CONFIG
// （roster 里它没有 DIRECTION_BACKFLOW：模型字段缺失是配置问题，不是方向问题，
// 让它报方向回流会让一个本域修得好的事升级成整条链路重定）。
const freezeSchema = (verdictEnum) => ({
  type: 'object',
  additionalProperties: false,
  required: ['from', 'checkedFields', 'verdict'],
  properties: {
    from: { type: 'string', description: '给出申报的 agentId' },
    checkedFields: {
      type: 'array',
      description: '逐项登记本域核验过的冻结字段；不得只写"已检查"',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['field', 'valueSeen', 'source', 'result'],
        properties: {
          field: { type: 'string', description: '冻结字段名，取自 workflow 给出的清单' },
          valueSeen: { type: 'string', description: '产物里的裸值；不得改写、不得取近似值' },
          source: { type: 'string', description: '文件路径:行号、hash 或 ADR 编号；引用不到写 UNVERIFIED' },
          result: { type: 'string', enum: ['consistent', 'inconsistent', 'UNVERIFIED'] },
        },
      },
    },
    missingFields: {
      type: 'array',
      description: '产物里根本没有、无法核验的冻结字段',
      items: { type: 'string' },
    },
    verdict: { type: 'string', enum: verdictEnum },
    blockedFields: { type: 'array', items: { type: 'string' }, description: 'BLOCKED_CONFIG 时必填' },
    backflowReason: { type: 'string', description: 'DIRECTION_BACKFLOW 时必填：动摇了哪条方向级假设' },
  },
})

const MODEL_SCHEMA = freezeSchema(['LOCAL_DETAIL_FIX', 'BLOCKED_CONFIG'])
const MEMORY_SCHEMA = freezeSchema(['LOCAL_DETAIL_FIX', 'DIRECTION_BACKFLOW', 'BLOCKED_CONFIG'])

// 冻结清单。由 agent 把**产物里的裸值**登记进来，schema 强制每个字段带 source——
// 凭记忆写出来的冻结项没法复核，而冻结项的整个意义就是可复核。
const FREEZE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['frozen', 'provenance', 'manifestStatus', 'verdict'],
  properties: {
    frozen: {
      type: 'array',
      description: '逐项冻结清单；字段名必须取自 workflow 给出的清单，不得增减',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['field', 'value', 'source'],
        properties: {
          field: { type: 'string' },
          value: { type: 'string', description: '产物里的裸值，逐字转抄' },
          source: { type: 'string', description: '文件路径#字段 或 hash' },
        },
      },
    },
    provenance: {
      type: 'array',
      description: 'sourceCommit / manifestHash / inputHashes / seed / runId，逐条给来源',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['name', 'value', 'source'],
        properties: {
          name: { type: 'string' },
          value: { type: 'string' },
          source: { type: 'string' },
        },
      },
    },
    manifestStatus: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['modelId', 'status', 'source'],
        properties: {
          modelId: { type: 'string' },
          status: { type: 'string', description: '必须是 FROZEN / PLANNING / BLOCKED_CONFIG 之一' },
          source: { type: 'string' },
        },
      },
    },
    singleHardwareSpec: { type: 'string', description: '这一轮的资源来自哪一份规格；出现第二份即违规' },
    verdict: { type: 'string', enum: ['LOCAL_DETAIL_FIX', 'BLOCKED_CONFIG'] },
    unfrozenFields: { type: 'array', items: { type: 'string' }, description: '未能冻结的字段' },
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

phase('Freeze declaration')

// 两域各核验一遍。它们互不可见是刻意的：memory-expert 若看见 model-expert 的
// manifest 核验结论，就会顺着它接受"manifest 没问题"，于是 MC profile 与
// manifest 的耦合（例如 MTP 是否计入、KV 精度）就没人独立看第二眼。
const DECLARANTS = [
  {agentId: 'model-expert', domain: 'manifest 字段、逐层 shape、MoE routing、KV 与精度策略、MTP',
    label: 'freeze:model', schema: MODEL_SCHEMA},
  {agentId: 'memory-expert', domain: 'SRAM 层级、MC profile、容量与带宽墙、TMA 描述符',
    label: 'freeze:memory', schema: MEMORY_SCHEMA},
]

const declarations = (await parallel(DECLARANTS.map((d) => () => agent(
  `${head(d.agentId)}\n\n`
  + `brief：\n${BRIEF_JSON}\n\n`
  + `候选寄存器（主循环已生成，只读）：${REGISTER_ARTIFACT}\n`
  + `细化产物（主循环已用 stage_b.js 生成，只读）：${DETAIL_RUN_ARTIFACT}\n\n`
  + `本次必须冻结的字段清单（用这些名字，不得增减）：\n${FREEZE_FIELDS.join(', ')}\n\n`
  + `任务：你是本域（${d.domain}）的核验人。从本域角度逐项核验这些冻结字段`
  + `在产物里是否真的可复现：值是什么、出处是什么、本域能不能兑现它。\n`
  + `只核验与登记，**不重算**：产物里的 hash、seed、TPS 一律逐字转抄，`
  + `不得重算、不得取近似值、不得改写。缺的字段进 missingFields，不得静默补齐。\n`
  + `核验完成后给出本域裁决：\n`
  + `  LOCAL_DETAIL_FIX：冻结项在本域可兑现，本域可在当前框架下自行调整。\n`
  + (d.agentId === 'memory-expert'
    ? `  DIRECTION_BACKFLOW：冻结的 mcProfile 与 manifest 之间存在方向级矛盾`
      + `（例如某个 shape 在冻结的 MC 档位下根本装不下，而不是差一点），`
      + `必须回到 direction 重定。用这个裁决时在 backflowReason 里写明动摇了哪条假设。\n`
    : '')
  + `  BLOCKED_CONFIG：产物里缺字段或组合不可实现，在 blockedFields 里列出缺哪些。\n`
  + `注意：你不判这一轮能不能通过——那是检点者的事。`,
  {label: d.label, phase: 'Freeze declaration', effort: 'high', schema: d.schema})
))).filter(Boolean)

if (declarations.length < DECLARANTS.length) {
  const absent = DECLARANTS.filter((d) => !declarations.some((x) => x.from === d.agentId)).map((d) => d.agentId)
  return {
    stage: STAGE, runId: RUN_ID, verdict: 'BLOCKED_CONFIG',
    reason: `冻结核验不完整，缺：${absent.join(', ')}`,
    nextActions: absent.map((a) => `补齐 ${a} 本域的冻结字段核验；若产物缺字段，先补产物再重跑本格`),
    absentDeclarants: absent,
    files: [],
  }
}

// 裁决枚举由 workflow 消费——这是两域裁决真正生效的地方。
// 冻结是在整条细化链的最前面：拿着一个方向级矛盾走下去，后面每一格都会建在它上面。
const backflow = declarations.filter((d) => d.verdict === 'DIRECTION_BACKFLOW')
const blockedDeclarants = declarations.filter((d) => d.verdict === 'BLOCKED_CONFIG')

if (backflow.length || blockedDeclarants.length) {
  const all = backflow.concat(blockedDeclarants)
  return {
    stage: STAGE, runId: RUN_ID,
    verdict: backflow.length ? backflow[0].verdict : 'BLOCKED_CONFIG',
    reason: backflow.length
      ? `冻结核验报方向回流：${backflow.map((d) => `${d.from}(${d.backflowReason || '未说明'})`).join('；')}；未冻结`
      : `冻结核验被配置挡住：${blockedDeclarants.map((d) => d.from).join(', ')}；未冻结`,
    blockedFields: all.flatMap((d) => d.blockedFields || []),
    nextActions: [
      ...backflow.map((d) => `把 ${d.from} 的方向级证据作为 DIRECTION_BACKFLOW 交给 A0 重定方向；本格不冻结`),
      ...blockedDeclarants.flatMap((d) => (d.blockedFields || []).map((f) => `补齐被配置挡住的冻结字段：${f}`)),
    ],
    declarations: all.map((d) => ({from: d.from, verdict: d.verdict})),
    files: [],
  }
}

phase('Freeze assembly')

const declaredFields = declarations.flatMap((d) => (d.checkedFields || []).map((f) => ({...f, checkedBy: d.from})))
const declaredMissing = [...new Set(declarations.flatMap((d) => d.missingFields || []))]

// 冻结清单由 model-expert 汇总——它是 manifest 的唯一来源方，冻结项里
// manifest hash 与 model 字段占多数。memory-expert 的核验作为旁证一并交给它，
// 但两者**不是**合并关系（这里没有 integrator）：model-expert 只做登记，
// 冲突进 unfrozenFields，不自己裁定谁对。
const frozen = await agent(
  `${head('model-expert')}\n\n`
  + `brief：\n${BRIEF_JSON}\n\n`
  + `候选寄存器（只读）：${REGISTER_ARTIFACT}\n`
  + `细化产物（只读）：${DETAIL_RUN_ARTIFACT}\n`
  + `必须冻结的字段清单：\n${FREEZE_FIELDS.join(', ')}\n\n`
  + `两域的核验结果：\n${JSON.stringify(declarations, null, 2)}\n\n`
  + `任务：把这一轮实际用的配置登记成一份冻结清单。规则：\n`
  + `1. **逐字转抄**。每个字段的值必须来自产物，出处必须给出文件路径#字段或 hash。\n`
  + `   不得重算任何 hash、不得改写任何值、不得取近似值。\n`
  + `2. 字段清单是给定的，不得增减。产物里没有的进 unfrozenFields，不得凭空补一个值。\n`
  + `3. provenance 逐条登记 sourceCommit、manifestHash、inputHashes、seed、runId，各带来源。\n`
  + `4. 每个模型的 manifest 状态必须是 ${MANIFEST_STATES.join(' / ')} 之一；`
  + `   出现别的取值时写进 unfrozenFields 并在裁决上退让，不得按"看起来像 planning"放行。\n`
  + `5. 明确指出这一轮的资源来自哪一份硬件规格；出现第二份规格就是违规，如实写出。\n`
  + `6. 两域核验互相矛盾时**不下折中值**：把两个值都留下并进 unfrozenFields。\n`
  + `登记完成写 LOCAL_DETAIL_FIX；有字段冻结不了写 BLOCKED_CONFIG 并列出 unfrozenFields。`,
  {label: 'freeze-assembly', phase: 'Freeze assembly', effort: 'high', schema: FREEZE_SCHEMA})

if (!frozen || frozen.verdict !== 'LOCAL_DETAIL_FIX') {
  return {
    stage: STAGE, runId: RUN_ID,
    verdict: frozen ? frozen.verdict : 'BLOCKED_CONFIG',
    freeze: frozen || null,
    reason: '配置未能冻结成一份完整清单；不落盘',
    unfrozenFields: frozen ? (frozen.unfrozenFields || []) : [],
    nextActions: [
      ...((frozen && frozen.unfrozenFields) || []).map((f) => `补齐冻结字段 ${f} 在产物里的出处`),
      '确认候选寄存器与细化产物是否可读；补齐后重跑本格',
    ],
    files: [],
  }
}

// 字段覆盖由数据保证，不由 agent 自律保证：agent 少登记一个字段，
// "冻结"就是有洞的。这里逐项对账，缺项直接退回。
const frozenNames = new Set(frozen.frozen.map((f) => f.field))
const notFrozen = FREEZE_FIELDS.filter((name) => !frozenNames.has(name))
const badStates = frozen.manifestStatus.filter((m) => !MANIFEST_STATES.includes(m.status))

if (notFrozen.length || badStates.length || declaredMissing.length) {
  return {
    stage: STAGE, runId: RUN_ID, verdict: 'BLOCKED_CONFIG',
    reason: [
      notFrozen.length ? `冻结清单缺字段：${notFrozen.join(', ')}` : null,
      badStates.length ? `manifest 状态未定义：${badStates.map((m) => `${m.modelId}=${m.status}`).join(', ')}` : null,
      declaredMissing.length ? `核验时报缺字段：${declaredMissing.join(', ')}` : null,
    ].filter(Boolean).join('；'),
    missingFields: [...notFrozen, ...declaredMissing],
    nextActions: [
      ...notFrozen.map((f) => `把冻结字段 ${f} 登记进清单（值取自产物，逐字转抄）`),
      ...badStates.map((m) => `确认 ${m.modelId} 的 manifest 状态在 ${MANIFEST_STATES.join(' / ')} 之内`),
      ...declaredMissing.map((f) => `补齐核验时报缺的字段 ${f} 在产物里的出处`),
    ],
    files: [],
  }
}

phase('Invariant check')

// 末步是检点，不是总结。freeze 没有 verifier：verifier 的判据是
// "schema、守恒、provenance、golden trace、可回放性"，那是对**数值产物**的独立验证；
// B0 的产物是一份配置抄录，没有可回放的物理量可验——把它塞进来会让 verifier
// 去"验证"一份它无从下手的清单。真正需要独立看的是它与全局不变量的冲突，那是检点者的活。
const check = await agent(
  `${head('invariant-checker')}\n\n`
  + `细化产物（只读）：${DETAIL_RUN_ARTIFACT}\n`
  + `候选寄存器（只读）：${REGISTER_ARTIFACT}\n`
  + `拟落盘的冻结清单：\n${JSON.stringify(frozen, null, 2)}\n`
  + `两域核验：\n${JSON.stringify(declarations, null, 2)}\n\n`
  + `任务：对这份冻结清单做全局不变量检点，逐条给出 pass/fail 与裸值：\n`
  + `7-reticle 面积守恒、单一硬件规格（ADR-0021）、MC320/MC640 分离、peak 与 sustained 分离、`
  + `单位一致、证据等级齐全。freeze 还要专门核两条本格的退出条件：\n`
  + `  (a) 候选来源唯一可追溯——冻结的 candidateId 必须能回到候选寄存器，且只有一个来源；\n`
  + `  (b) run_id 与 input hash 在冻结清单与产物之间共享，不是各写各的。\n`
  + `违规项必须给出违反的具体文件与字段。\n`
  + `不得把违规项解释掉（解释权归 architect）；不得以文档措辞为依据，只以数值和来源为依据。\n`
  + `全部通过写 INVARIANT_OK，任一不通过写 INVARIANT_VIOLATED。`,
  {label: 'invariant-checker', phase: 'Invariant check', effort: 'high', schema: CHECK_SCHEMA})

const okInvariants = check && check.verdict === 'INVARIANT_OK'

const ledgerPatch = {
  currentStage: STAGE,
  strategyVersions: {
    'model-expert': '1.0', 'memory-expert': '1.0', 'invariant-checker': '1.0',
  },
  // 冻结阶段没有"被否候选"——候选早在 D-Gate 定死了。被否的是**冻结字段**：
  // 没能冻结的字段就是一个上游缺口，不记下来，重跑会重新发明一遍同样的清单。
  rejectedOptions: (frozen.unfrozenFields || []).map((field) => ({
    stage: STAGE, optionId: field,
    reason: `该字段在本轮产物中无法复现或未被登记`, rejectedBy: 'invariant-checker',
  })),
  openBlockers: (declaredMissing || []).map((field, i) => ({
    id: `FREEZE-${String(i + 1).padStart(2, '0')}`,
    owner: 'model-expert',
    unblockCondition: `补齐冻结字段 ${field} 的产物出处`,
  })),
}

// 冻结项的指纹：字段名排序后取规范化串，让"两次跑冻结的是不是同一份配置"
// 可复核，而不是靠人去比对两份 JSON。
const freezeFingerprint = frozen.frozen
  .map((f) => `${f.field}=${f.value}`)
  .sort()

const runRecord = {
  schemaVersion: 'design-run-record-v0.1',
  stage: STAGE,
  runId: RUN_ID,
  sourceCommit: BRIEF.sourceCommit,
  registerArtifact: REGISTER_ARTIFACT,
  detailRunArtifact: DETAIL_RUN_ARTIFACT,
  stageCommand: STAGE_COMMAND_FOR_RECORD,
  frozenFields: FREEZE_FIELDS,
  freezeFingerprint,
  freezeFieldCount: frozen.frozen.length,
  manifestStates: Object.fromEntries(frozen.manifestStatus.map((m) => [m.modelId, m.status])),
  declarants: declarations.map((d) => d.from).sort(),
  caliber: '冻结项为逐字转抄口径；hash、seed、候选 id 一律取自 stage_b.js 的产物，workflow 不产生任何数字',
}

return {
  stage: STAGE,
  runId: RUN_ID,
  verdict: okInvariants ? 'INVARIANT_OK' : 'INVARIANT_VIOLATED',
  frozen: okInvariants ? frozen.frozen : null,
  provenance: okInvariants ? frozen.provenance : null,
  unfrozenFields: okInvariants ? (frozen.unfrozenFields || []) : (frozen.unfrozenFields || []),
  violations: okInvariants ? [] : ((check && check.violations) || ['检点未完成']),
  ledgerPatch,
  runRecord,
  files: okInvariants ? [
    {
      path: `${REPO}/out/detailed/${STAGE.replace('.', '_')}.json`,
      content: JSON.stringify({
        schemaVersion: 'design-detail-freeze-v0.1',
        stage: STAGE, runId: RUN_ID, sourceCommit: BRIEF.sourceCommit,
        registerArtifact: REGISTER_ARTIFACT,
        detailRunArtifact: DETAIL_RUN_ARTIFACT,
        frozen: frozen.frozen,
        provenance: frozen.provenance,
        manifestStatus: frozen.manifestStatus,
        singleHardwareSpec: frozen.singleHardwareSpec,
        unfrozenFields: frozen.unfrozenFields || [],
      }, null, 2) + '\n',
    },
    {
      path: `${REPO}/out/detailed/${STAGE.replace('.', '_')}_run_record.json`,
      content: JSON.stringify(runRecord, null, 2) + '\n',
    },
  ] : [],
}
