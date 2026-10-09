export const meta = {
  name: 'design-integrate',
  description: 'K3 设计 integrate 阶段（L5-a，D 组五格合一）：冻结配置（B0）→ 三路事件流与五条守恒（B2）→ Q6 软件与 Q7 PPA 执行账本（B3）→ 18 个观察位合并与粗估-细估 delta 归因（B4）→ verifier 独立验证 → invariant-checker 检点后落盘；Q7 的方向级发现走 PPA_DIRECTION_BACKFLOW 专属回流 A0',
  whenToUse: 'D 组唯一一格，排在 L3 域设计与 coupling 之后、design.converge 之前。需要 args.brief（stage=integrate 的 DesignBrief）、args.registerArtifact（out/governance/candidate_register.json）、args.detailRunArtifact（out/detailed/detailed_architecture_run.json）、args.replayArtifact（out/detailed/formal_event_replay.json）、args.observationArtifact（out/workload/tps_observation_matrix.json）、args.directionArtifact（out/direction/directional_tps_scorecard.json，粗估侧）与可选 args.workloadArtifact（L1-a design.req.workload 的算子账本）。均由主循环生成。本 workflow 不跑 stage_b.js、不写既有产物。',
  phases: [
    { title: 'Freeze declaration', detail: 'B0：model-expert 与 memory-expert 各从本域核验冻结项，两路互不可见' },
    { title: 'Freeze assembly', detail: 'B0：冻结清单与 provenance 由脚本产物逐字转抄，agent 只登记缺项' },
    { title: 'Event declaration', detail: 'B2：三路并行、互不可见，各自申报本域事件；三路共享同一 manifest hash' },
    { title: 'Conservation', detail: 'B2：字节/FLOP/事务/buffer lifetime/credit 五条守恒由脚本对账，integrator 做跨域对账' },
    { title: 'Software and PPA declaration', detail: 'B3：software-expert 与 physical-expert 两路并行、互不可见' },
    { title: 'Execute merge', detail: 'B3：integrator 合并成一份执行账本；面积、peak/sustained 与功耗口径由脚本对账' },
    { title: 'Slot merge', detail: 'B4：integrator 逐槽位对账 18 个观察位，delta 由脚本算' },
    { title: 'Delta attribution', detail: 'B4：architect 只对无法归因的 delta 做裁决；解释权在这里，不在合并者' },
    { title: 'Independent verification', detail: 'verifier 只拿拟落盘产物，独立验证 schema/守恒/provenance/可回放性' },
    { title: 'Invariant check', detail: 'invariant-checker 对整份产物强制检点；不通过则不落盘' },
  ],
}

// ---------------------------------------------------------------------------
// L5-a：D 组五格合一（23 号文档 §8 P6）。
//
// 原先 D 组是五个串行脚本：detail.freeze（B0）、detail.workload（B1）、
// detail.events（B2）、detail.execute（B3）、detail.integrate（B4）。
// B1 已前移为 L1-a 的 design.req.workload（它回答的是"需要什么"，必须在预算切分之前），
// 其余四格在这里合成一格。合并的理由是它们之间没有人的判断：
// 每一格的输入就是上一格的输出，主循环在两格之间只做"把路径传下去"——
// 四次 brief、四次检点、四份 run record，换来的是四个可以各自通过、合起来却
// 不成立的切面（B2 的事件流与 B3 的执行账本用的是不是同一个 manifest，
// 只有合在一起看才看得出来）。
//
// 合并不是摊平。四格各自的阶段块原样保留为内部 phase：
//   B0 冻结       Freeze declaration → Freeze assembly
//   B2 事件与守恒  Event declaration → Conservation
//   B3 执行账本    Software and PPA declaration → Execute merge
//   B4 delta 归因  Slot merge → Delta attribution
//   独立验证与检点  Independent verification → Invariant check
// 每一块的脚本侧对账与终止分支都保留：任一块不成立，本格就在那一块以
// BLOCKED_CONFIG / DIRECTION_BACKFLOW / PPA_DIRECTION_BACKFLOW / DELTA_UNEXPLAINED
// 收场，不进入下一块——拿着一个上游缺口往下走，后面每一块都会建在它上面。
//
// 变的只有两处：
//   1. 中间的四次 invariant-checker 收成末尾一次。块与块之间的对账由脚本做
//      （它们是算术与枚举核对），检点者在末尾看整份产物——它要找的正是
//      "每一块都合规、合起来不成立"的那种违规。
//   2. 产物只落一份 out/detailed/detail_integrate.json，含冻结清单、事件流、
//      执行账本与 18 位合并；verifier 验的就是这一份。
//
// 四条硬边界在此的落点：
//   边界 1：输出什么由本 workflow 注入，策略正文里没有输出契约。
//   边界 2：路径只出现在本文件里；策略靠 prompt 里的 agentId 自读正文。
//   边界 3：各策略的裁决枚举由本 workflow 的分支消费。
//   边界 4：**每一个决定性的数都由 stage_b.js 算或由本文件的算术得出**。
//           agent 只转抄与核验；delta 的百分比由本文件相减，原因由 architect 给。
// ---------------------------------------------------------------------------

const REPO = args.repo || '.'
const STAGE = 'integrate'
const BRIEF = args.brief
const RUN_ID = args.runId || 'integrate-run'
// 冻结的候选由 D-Gate 定死，不由本格枚举。下列产物都由主循环先生成。
const REGISTER_ARTIFACT = args.registerArtifact
const DETAIL_RUN_ARTIFACT = args.detailRunArtifact
const REPLAY_ARTIFACT = args.replayArtifact
const OBSERVATION_ARTIFACT = args.observationArtifact
const DIRECTION_ARTIFACT = args.directionArtifact
const WORKLOAD_ARTIFACT = args.workloadArtifact || 'UNVERIFIED'
const STAGE_COMMAND_FOR_RECORD = args.stageCommand || 'UNVERIFIED'

if (!BRIEF) throw new Error('design.integrate 需要 args.brief（intake 阶段产出的 DesignBrief）')
if (!REGISTER_ARTIFACT || !DETAIL_RUN_ARTIFACT || !REPLAY_ARTIFACT || !OBSERVATION_ARTIFACT || !DIRECTION_ARTIFACT) {
  throw new Error('design.integrate 需要 args.registerArtifact / args.detailRunArtifact / args.replayArtifact / '
    + 'args.observationArtifact / args.directionArtifact（已由主循环生成）；本 workflow 不跑 Stage B')
}
if (BRIEF.stage !== STAGE) {
  // brief 的 stage 与 workflow 名称必须一致，否则会把别的阶段的输入拿来用
  throw new Error(`brief.stage=${BRIEF.stage}，与 design.${STAGE} 不符；契约串了`)
}

// --- B0 冻结的常量 -----------------------------------------------------------

// B0 必须冻结的字段。这份清单是**阶段定义**（19 号文档 §3），不是从产物里读出来的——
// 用被测数据决定核验范围，等于让被测者定考题。少核一项，冻结就是有洞的。
const FREEZE_FIELDS = [
  'candidateId', 'runMode', 'modelId', 'physicalProfile', 'mcProfile',
  'tp', 'cp', 'ep', 'sourceCommit', 'manifestHash', 'inputHashes', 'seed',
]

// 每个模型可接受的 manifest 状态。三者之外的取值不是"更细的状态"，
// 是没人定义过的状态——出现即 BLOCKED_CONFIG，不得按"看起来像 planning"放行。
const MANIFEST_STATES = ['FROZEN', 'PLANNING', 'BLOCKED_CONFIG']

// --- B2 事件与守恒的常量 ------------------------------------------------------

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
// 而事件流一旦不可追溯，后面的执行账本与 18 位合并就无法复核它。
const EVENT_TRACE_FIELDS = ['operatorId', 'layerId', 'tileId', 'manifestHash']

// 无出处乘子：事件流里最自然的写法是"流水线重叠 ×1.3"——它看起来像一句结论，不像一个错误。
const MULTIPLIER_PATTERN = /(?:加速|speedup|overlap|重叠|utilization\s*(?:gain|multiplier)|乘子)\s*[×x*]\s*\d|\d+(?:\.\d+)?\s*[×x]\s*(?:加速|speedup|overlap|重叠)/i

// --- B3 执行账本的常量 --------------------------------------------------------

// 面积守恒的容差。**零**，不是"接近即可"：7-reticle 面积守恒是一条等式，
// 不是一条不等式。给一个 1% 的宽容度，等于允许一片 die 被放错地方而没人发现。
const AREA_TOLERANCE_MM2 = 0

// Q7 必须覆盖的 PPA 面。缺一面就说"PPA 做完了"，那个面就永远没人看。
const PPA_SECTIONS = ['power', 'thermal', 'ras', 'area']

// Q6 事件必须登记的追溯字段。软件事件的追溯对象是调度决策本身，
// 所以追溯键是"哪个算子在流水线的哪一步被谁派发"，不是 tile。
const SW_TRACE_FIELDS = ['eventId', 'operatorId', 'pipelineStep', 'dispatcher', 'source']

// 卡功耗口径。两个域各有一套，**不可互换**：memory 域的卡功耗口径是
// 8×die + MC + 固定 80 W，**刻意不计**共享端口项；physical 域的口径计它——
// 两者相差恰好 21.915648 W。一个从 memory 域借来的功耗裕量，放到 physical 域就是负的。
const POWER_CALIBERS = ['MEMORY_DOMAIN', 'PHYSICAL_DOMAIN']

// 执行账本这一块的乘子扫描比事件流宽：散热与降频最容易被写成"×0.9 的热降频系数"，
// 而那个 0.9 通常没有任何出处。
const PPA_MULTIPLIER_PATTERN = /(?:加速|speedup|overlap|重叠|降频|throttl|utilization\s*(?:gain|multiplier)|乘子|系数)\s*[×x*]?\s*\d|\d+(?:\.\d+)?\s*[×x]\s*(?:加速|speedup|overlap|重叠|降频)/i

// --- B4 观察位的常量 ----------------------------------------------------------

// 18 个观察位 = 3 模型 × TP 三档 × MC 两档。这不是"大概这些"，
// 是这一块的输出定义本身：少一位，那个组合就没人看过。
const OBSERVATION_MODELS = ['GLM-5.2', 'DeepSeek-V4-Pro', 'Kimi-K3']
const OBSERVATION_TP = [8, 16, 32]
const OBSERVATION_MC = ['MC320', 'MC640']
const OBSERVATION_COUNT = OBSERVATION_MODELS.length * OBSERVATION_TP.length * OBSERVATION_MC.length

const slotKey = (modelId, tp, mcProfile) => `${modelId}|TP${tp}|${mcProfile}`

// 观察状态。四个取值之外的第五个不是"更细的状态"，是没人定义过的状态。
const OBSERVATION_STATES = ['MODEL_OBSERVED', 'PENDING_MODEL_RUN', 'BLOCKED_CONFIG', 'SILICON_OBSERVED']

// 细估能不能被独立的东西印证。Stage A 与 Stage B 是同一个公式、同一组标定，
// 两者的 TPS 差在构造上就是 0——"delta 为 0"对没有独立估计的槽位不是对账结果。
// 唯一独立的估计是 K3 详细模拟器，它只映射 K3 的 TP32。取值由 stage_b.js 写进观察矩阵，
// integrator 逐字转抄：
//   FITTED_POINT     标定点本身，残差不是证据
//   DETAILED_HOLDOUT 留出点，残差是 K3 因子在该带宽下的真实外推误差
//   UNCORROBORATED   没有详细模型，数字是外推
//   NONE             BLOCKED_CONFIG，没有 TPS
const CORROBORATION_KINDS = ['FITTED_POINT', 'DETAILED_HOLDOUT', 'UNCORROBORATED', 'NONE']

// 逐位拆分必须覆盖的口径。它们是"这个数是怎么来的"的最小分解，
// 少一项总时间就有一块无名的来源。
const BREAKDOWN_FIELDS = ['memoryUs', 'computeUs', 'commUs', 'tmaExposedUs', 'fixedUs']

// 尾延迟分位。缺一个，尾部就没有被描述——而设计里的门控正是卡在尾部的。
const TAIL_PERCENTILES = ['p50', 'p95', 'p99']

const DELTA_EPS = 1e-9

// --- 注入的上下文 -------------------------------------------------------------

const HEAD = [
  `仓库根目录：${REPO}`,
  `本 workflow：design.integrate（stage=${STAGE}，runId=${RUN_ID}）`,
  `你是一个策略实例。先读你的策略正文：${REPO}/teams/council/strategies/__AGENT__.md`,
  '那份文件是本角色的判断规则、正确性判据、证据规则、取舍规则与禁止事项，逐条遵守。',
  '以下运行时上下文由 workflow 注入；注入内容与策略正文冲突时，注入内容优先（它承载本 stage 的事实）。',
  '你没有文件系统写权限。把该写的东西作为返回值交回，由 workflow 落盘。',
  '所有数字必须带出处（文件路径:行号 或 ADR 编号）；没有出处的写 UNVERIFIED 并说明缺什么，不得静默补齐。',
  '不得输出 TPS/usr 或任何全局性能指标；不得输出 PASS / D_GATE_PASSED 字面量。',
  '本格是细化与合并，不是设计：不得发明候选、不得产生新的设计选项、不得重算任何数值、不得改写产物里的任何字段。',
  '禁止出现任何**无出处的全局加速比或利用率乘子**（例如"×1.3 流水线重叠"）；加速只能来自事件流与调度的排布本身。',
].join('\n')

const head = (agentId) => HEAD.replace('__AGENT__', agentId)

// 每一块各自多出的一条规矩。不并进 HEAD：它们只对那一块成立。
const BLOCK_RULES = {
  freeze: '你在 B0 冻结块：只抄录与核验，hash、seed、候选 id 一律逐字转抄。',
  events: '你在 B2 事件块：产出是**事件流**，不是结论——逐事件写清发生了什么，不要写"整体上快了"；用乘子抹平的时间差一律算违规。',
  execute: '你在 B3 执行块：功耗数字必须写清是哪一套卡功耗口径——两套口径的数不得混用。',
  slots: '你在 B4 合并块：粗估与细估的数逐字转抄即可；delta 的百分比由 workflow 算，你不得自己算它。',
}

const BRIEF_JSON = JSON.stringify(BRIEF, null, 2)

const SOURCES = [
  `候选寄存器（只读）：${REGISTER_ARTIFACT}`,
  `细化产物（主循环已用 stage_b.js 生成，只读，细估侧）：${DETAIL_RUN_ARTIFACT}`,
  `事件重放产物（只读）：${REPLAY_ARTIFACT}`,
  `观察矩阵（只读）：${OBSERVATION_ARTIFACT}`,
  `方向记分卡（只读，粗估侧）：${DIRECTION_ARTIFACT}`,
  `L1-a 算子账本（只读）：${WORKLOAD_ARTIFACT}`,
].join('\n')

// --- schema ------------------------------------------------------------------
// 所有 schema 都在第一块之前声明：每一块的逻辑只在它自己的 phase 里，
// 读者（与结构测试）按 phase 切片就能看到这一块到底调用了谁、消费了哪些裁决。

// B0 冻结申报。专家从**本域**回答"这些冻结项在本域能不能兑现"。两个 schema 的
// 裁决枚举不同——model-expert 只有 LOCAL_DETAIL_FIX / BLOCKED_CONFIG
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

const FREEZE_MODEL_SCHEMA = freezeSchema(['LOCAL_DETAIL_FIX', 'BLOCKED_CONFIG'])
const FREEZE_MEMORY_SCHEMA = freezeSchema(['LOCAL_DETAIL_FIX', 'DIRECTION_BACKFLOW', 'BLOCKED_CONFIG'])

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

// B2 三域共用一个 schema 形状：它们描述的是同一份 manifest 的三个切面，
// 形状不同会让"三路共享同一 hash"这件事无法在数据上核对。
const eventSchema = (verdictEnum) => ({
  type: 'object',
  additionalProperties: false,
  required: ['from', 'domain', 'manifestHash', 'events', 'conservations', 'verdict'],
  properties: {
    from: { type: 'string', description: '给出申报的 agentId' },
    domain: { type: 'string', enum: ['Q3', 'Q4', 'Q5'] },
    manifestHash: { type: 'string', description: '逐字转抄产物里的 manifest hash，不得重算' },
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
          manifestHash: { type: 'string', description: '必须与本域申报的 manifestHash 逐字一致' },
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

const EVENT_MEMORY_SCHEMA = eventSchema(['LOCAL_DETAIL_FIX', 'DIRECTION_BACKFLOW', 'BLOCKED_CONFIG'])
const EVENT_COMM_SCHEMA = eventSchema(['LOCAL_DETAIL_FIX', 'DIRECTION_BACKFLOW', 'BLOCKED_CONFIG'])
const EVENT_COMPUTE_SCHEMA = eventSchema(['LOCAL_DETAIL_FIX', 'DIRECTION_BACKFLOW', 'BLOCKED_CONFIG'])

// B2 合并产物。三路已经各自守恒，这里只做**跨域对账 + 归位**，不重新发明事件。
const EVENT_MERGE_SCHEMA = {
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

// B3 两域共用形状、**裁决枚举不同**。physical-expert 是 roster 里唯一拥有
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

// B3 合并产物。
const EXECUTE_MERGE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['software', 'ppa', 'area', 'exposedVsHidden', 'rejectedOptions', 'blockers', 'verdict'],
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

// B4 逐槽位登记。粗估与细估两个裸值 + 出处是 integrator 的唯一工作；
// 它不解释、不算差、不判断——那些分别属于 architect 与本文件。
const SLOT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['slotKey', 'modelId', 'tp', 'mcProfile', 'coarseTps', 'fineTps', 'coarseSource', 'fineSource', 'status', 'corroboration'],
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
    corroboration: { type: 'string', enum: CORROBORATION_KINDS, description: '观察矩阵里该槽位 corroboration.kind 的逐字转抄' },
    detailedTps: { type: 'number', description: '观察矩阵里 corroboration.detailedTpsPerUser 的逐字转抄；kind 为 FITTED_POINT / DETAILED_HOLDOUT 时必填，其余不写' },
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

const SLOT_MERGE_SCHEMA = {
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
    // 这一块的核心产物：哪些 delta 归不了因。
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

// ===========================================================================
// B0 冻结（19 号文档 §3）。要回答的唯一问题是"这一轮细化用的到底是哪一份配置"。
//
// 这一块**没有 integrator**：freeze 是"抄录 + 核验"，不是"合并"。B0 的上游只有一份
// 确定性产物（stage_b.js 写的 detailed_architecture_run.json），给单一输入配合并者，
// integrator 的判据 INTEGRATION_OK / DELTA_UNEXPLAINED 在这里无从判定——它会退化成橡皮图章。
// 也**没有 verifier**：冻结清单是配置抄录，没有可回放的物理量可验。
// ===========================================================================

phase('Freeze declaration')

// 两域各核验一遍。它们互不可见是刻意的：memory-expert 若看见 model-expert 的
// manifest 核验结论，就会顺着它接受"manifest 没问题"，于是 MC profile 与
// manifest 的耦合（例如 MTP 是否计入、KV 精度）就没人独立看第二眼。
const FREEZE_DECLARANTS = [
  {agentId: 'model-expert', domain: 'manifest 字段、逐层 shape、MoE routing、KV 与精度策略、MTP',
    label: 'freeze:model', schema: FREEZE_MODEL_SCHEMA},
  {agentId: 'memory-expert', domain: 'SRAM 层级、MC profile、容量与带宽墙、TMA 描述符',
    label: 'freeze:memory', schema: FREEZE_MEMORY_SCHEMA},
]

const freezeDeclarations = (await parallel(FREEZE_DECLARANTS.map((d) => () => agent(
  `${head(d.agentId)}\n${BLOCK_RULES.freeze}\n\n`
  + `brief：\n${BRIEF_JSON}\n\n`
  + `${SOURCES}\n\n`
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

if (freezeDeclarations.length < FREEZE_DECLARANTS.length) {
  const absent = FREEZE_DECLARANTS.filter((d) => !freezeDeclarations.some((x) => x.from === d.agentId)).map((d) => d.agentId)
  return {
    stage: STAGE, runId: RUN_ID, block: 'freeze', verdict: 'BLOCKED_CONFIG',
    reason: `冻结核验不完整，缺：${absent.join(', ')}`,
    nextActions: absent.map((a) => `补齐 ${a} 本域的冻结字段核验；若产物缺字段，先补产物再重跑本格`),
    absentDeclarants: absent,
    files: [],
  }
}

// 冻结是在整条细化链的最前面：拿着一个方向级矛盾走下去，后面每一块都会建在它上面。
const freezeBackflow = freezeDeclarations.filter((d) => d.verdict === 'DIRECTION_BACKFLOW')
const freezeBlocked = freezeDeclarations.filter((d) => d.verdict === 'BLOCKED_CONFIG')

if (freezeBackflow.length || freezeBlocked.length) {
  const all = freezeBackflow.concat(freezeBlocked)
  return {
    stage: STAGE, runId: RUN_ID, block: 'freeze',
    verdict: freezeBackflow.length ? freezeBackflow[0].verdict : 'BLOCKED_CONFIG',
    reason: freezeBackflow.length
      ? `冻结核验报方向回流：${freezeBackflow.map((d) => `${d.from}(${d.backflowReason || '未说明'})`).join('；')}；未冻结`
      : `冻结核验被配置挡住：${freezeBlocked.map((d) => d.from).join(', ')}；未冻结`,
    blockedFields: all.flatMap((d) => d.blockedFields || []),
    nextActions: [
      ...freezeBackflow.map((d) => `把 ${d.from} 的方向级证据作为 DIRECTION_BACKFLOW 交给 A0 重定方向；本格不冻结`),
      ...freezeBlocked.flatMap((d) => (d.blockedFields || []).map((f) => `补齐被配置挡住的冻结字段：${f}`)),
    ],
    declarations: all.map((d) => ({from: d.from, verdict: d.verdict})),
    files: [],
  }
}

phase('Freeze assembly')

const declaredMissing = [...new Set(freezeDeclarations.flatMap((d) => d.missingFields || []))]

// 冻结清单由 model-expert 汇总——它是 manifest 的唯一来源方，冻结项里
// manifest hash 与 model 字段占多数。memory-expert 的核验作为旁证一并交给它，
// 但两者**不是**合并关系：model-expert 只做登记，冲突进 unfrozenFields，不自己裁定谁对。
const frozen = await agent(
  `${head('model-expert')}\n${BLOCK_RULES.freeze}\n\n`
  + `brief：\n${BRIEF_JSON}\n\n`
  + `${SOURCES}\n`
  + `必须冻结的字段清单：\n${FREEZE_FIELDS.join(', ')}\n\n`
  + `两域的核验结果：\n${JSON.stringify(freezeDeclarations, null, 2)}\n\n`
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
  {label: 'freeze:assembly', phase: 'Freeze assembly', effort: 'high', schema: FREEZE_SCHEMA})

if (!frozen || frozen.verdict !== 'LOCAL_DETAIL_FIX') {
  return {
    stage: STAGE, runId: RUN_ID, block: 'freeze',
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
    stage: STAGE, runId: RUN_ID, block: 'freeze', verdict: 'BLOCKED_CONFIG',
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

// 冻结项的指纹：字段名排序后取规范化串，让"两次跑冻结的是不是同一份配置"
// 可复核，而不是靠人去比对两份 JSON。
const freezeFingerprint = frozen.frozen.map((f) => `${f.field}=${f.value}`).sort()
const FROZEN_JSON = JSON.stringify(frozen.frozen, null, 2)

// ===========================================================================
// B2 事件与守恒（19 号文档 §5）。Q3（tile / memory 事件）、Q4（NoC / 集合通信事件）、
// Q5（kernel cycle）**并行**：三者描述的是同一份 manifest 的三个切面，
// 共同前提只有 manifest hash——所以并行后先逐字核对 hash，再进入合并。
//
// 特别提示：formal_event_replay.json 里的 Q3–Q6 事件是
// status = SYNTHETIC_PLACEHOLDER 的占位，stage_b.js 的文件头明确写着
// "Q3-Q8 events are placeholders and do not drive latency"。
// 这一块的任务是**替换**它们，不是引用它们当证据。
// ===========================================================================

phase('Event declaration')

// 三路并行，互不可见。看见彼此的事件流会让后完成的一路去"对齐"先完成的——
// 只有独立，跨域对账才有信息量。如果三路是抄的，对账永远成立，也永远没用。
// Q3 → memory-expert、Q4 → comm-expert、Q5 → compute-expert：每一个都是该切面的唯一来源方。
const EVENT_DECLARANTS = [
  {agentId: 'memory-expert', q: 'Q3', domain: 'Q3 tile / memory 事件：tile 搬运、SRAM 层级、buffer lifetime、TMA 描述符',
    label: 'events:q3-memory', schema: EVENT_MEMORY_SCHEMA},
  {agentId: 'comm-expert', q: 'Q4', domain: 'Q4 NoC / 集合通信事件：包切分、credit、链路占用、集合通信的相位',
    label: 'events:q4-comm', schema: EVENT_COMM_SCHEMA},
  {agentId: 'compute-expert', q: 'Q5', domain: 'Q5 kernel cycle：AI Core 各核心类的拍数、流水、发射占用',
    label: 'events:q5-compute', schema: EVENT_COMPUTE_SCHEMA},
]

const eventDeclarations = (await parallel(EVENT_DECLARANTS.map((d) => () => agent(
  `${head(d.agentId)}\n${BLOCK_RULES.events}\n\n`
  + `brief：\n${BRIEF_JSON}\n\n`
  + `${SOURCES}\n\n`
  + `上一块 B0 已冻结的配置（本 workflow 内，尚未落盘）：\n${FROZEN_JSON}\n\n`
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

if (eventDeclarations.length < EVENT_DECLARANTS.length) {
  const absent = EVENT_DECLARANTS.filter((d) => !eventDeclarations.some((x) => x.from === d.agentId)).map((d) => d.agentId)
  return {
    stage: STAGE, runId: RUN_ID, block: 'events', verdict: 'BLOCKED_CONFIG',
    reason: `事件申报不完整，缺：${absent.join(', ')}`,
    nextActions: absent.map((a) => `补齐 ${a} 本域的事件申报；若产物缺字段，先补产物再重跑本格`),
    absentDeclarants: absent,
    files: [],
  }
}

// 共享 manifest hash 是这一块的前提，所以它在数据上被核对，而不是被假定。
// 三路里只要有一路在别处重建了 shape，它的事件流与其它两路就不是同一件事，
// 后面所有的跨域对账都失去意义——所以这里直接退回，不进入合并。
const hashes = [...new Set(eventDeclarations.map((d) => d.manifestHash))]
if (hashes.length !== 1) {
  return {
    stage: STAGE, runId: RUN_ID, block: 'events', verdict: 'BLOCKED_CONFIG',
    reason: `三路未共享同一 manifest hash：${eventDeclarations.map((d) => `${d.from}=${d.manifestHash}`).join(', ')}；事件流不可对账`,
    nextActions: eventDeclarations.map((d) => `让 ${d.from} 回到产物里的 manifest hash 重新申报；不得在别处重建 shape`),
    manifestHashes: eventDeclarations.map((d) => ({from: d.from, manifestHash: d.manifestHash})),
    files: [],
  }
}
const MANIFEST_HASH = hashes[0]

// 方向回流与配置缺口在这里先拦：继续合并只会产出一份建立在错前提上的事件流，
// 而执行账本与 18 位合并都读它。
const eventBackflow = eventDeclarations.filter((d) => d.verdict === 'DIRECTION_BACKFLOW')
const eventBlocked = eventDeclarations.filter((d) => d.verdict === 'BLOCKED_CONFIG')

if (eventBackflow.length || eventBlocked.length) {
  const all = eventBackflow.concat(eventBlocked)
  return {
    stage: STAGE, runId: RUN_ID, block: 'events',
    verdict: eventBackflow.length ? eventBackflow[0].verdict : 'BLOCKED_CONFIG',
    reason: eventBackflow.length
      ? `事件申报报方向回流：${eventBackflow.map((d) => `${d.from}(${d.backflowReason || '未说明'})`).join('；')}；未合并`
      : `事件申报被配置挡住：${eventBlocked.map((d) => d.from).join(', ')}；未合并`,
    blockedFields: all.flatMap((d) => d.blockedFields || []),
    nextActions: [
      ...eventBackflow.map((d) => `把 ${d.from} 的方向级证据作为 DIRECTION_BACKFLOW 交给 A0 重定方向：${d.backflowReason || '未说明'}`),
      ...eventBlocked.flatMap((d) => (d.blockedFields || []).map((f) => `补齐被配置挡住的字段：${f}`)),
    ],
    declarants: all.map((d) => ({from: d.from, verdict: d.verdict})),
    files: [],
  }
}

phase('Conservation')

// 脚本侧对账先行：五条守恒是算术，不是判断。agent 各自申报 lhs/rhs 之后，
// 脚本逐条重算再比对——让 integrator 去"看"这些数对不对，等于把算术交给一个会读错数的读者。
// 这里只做可判定的事（等号两侧、追溯字段齐全、乘子扫描），语义上的取舍留给 integrator。
const flatEvents = eventDeclarations.flatMap((d) => (d.events || []).map((e) => ({...e, declaredBy: d.from, declaredQ: d.q})))

const traceGaps = flatEvents
  .filter((e) => EVENT_TRACE_FIELDS.some((f) => e[f] === undefined || e[f] === null || e[f] === ''))
  .map((e) => `${e.eventId || '(无名)'}: 缺 ${EVENT_TRACE_FIELDS.filter((f) => e[f] === undefined || e[f] === null || e[f] === '').join('/')}`)

const hashMismatch = flatEvents.filter((e) => e.manifestHash !== MANIFEST_HASH).map((e) => `${e.eventId}: hash=${e.manifestHash}`)

// 五条守恒逐条重算：lhs 与 rhs 必须真的相等，且 met 必须与比对结果一致。
// agent 写了 met=true 但两个数不等，是一次静默放行——比缺一条守恒更坏，因为它看起来是查过的。
const conservationErrors = []
for (const d of eventDeclarations) {
  for (const c of (d.conservations || [])) {
    const equal = Math.abs((c.lhs || 0) - (c.rhs || 0)) <= 1e-9 * Math.max(1, Math.abs(c.rhs || 0))
    if (equal !== c.met) {
      conservationErrors.push(`${d.q}/${c.name}: lhs=${c.lhs} rhs=${c.rhs} met=${c.met}（对账不符）`)
    }
  }
}
const missingConservations = eventDeclarations
  .flatMap((d) => CONSERVATIONS.filter((name) => !(d.conservations || []).some((c) => c.name === name)).map((name) => `${d.q} 缺 ${name}`))

// 无出处乘子要脚本扫而不是靠 agent 自律。
const multiplierHits = flatEvents
  .filter((e) => MULTIPLIER_PATTERN.test(String(e.source || '')) || MULTIPLIER_PATTERN.test(String(e.bufferLifetime || '')))
  .map((e) => e.eventId)

const eventGaps = [...traceGaps, ...hashMismatch.map((h) => `manifest hash 不一致：${h}`),
  ...conservationErrors, ...missingConservations, ...multiplierHits.map((id) => `${id}: 疑似无出处乘子`)]

if (eventGaps.length) {
  return {
    stage: STAGE, runId: RUN_ID, block: 'events', verdict: 'BLOCKED_CONFIG',
    reason: `B2 事件流未自洽：${eventGaps.slice(0, 12).join('；')}${eventGaps.length > 12 ? ` …共 ${eventGaps.length} 项` : ''}`,
    eventGaps,
    nextActions: eventGaps.slice(0, 12).map((g) => `补齐/更正：${g}`),
    files: [],
  }
}

const eventMerge = await agent(
  `${head('integrator')}\n${BLOCK_RULES.events}\n\n`
  + `brief：\n${BRIEF_JSON}\n\n`
  + `事件重放产物（只读）：${REPLAY_ARTIFACT}\n`
  + `三域各自申报的事件流：\n${JSON.stringify(eventDeclarations, null, 2)}\n`
  + `workflow 已核对的共享 manifest hash：${MANIFEST_HASH}\n\n`
  + `任务：把三域事件流合并成一份，并做**跨域对账**。规则：\n`
  + `1. 只合并，不重新发明事件。三路的裸值原样保留，不得改写。\n`
  + `2. 逐算子做跨域对账：Q3 说搬了多少字节、Q4 说发了多少包与 credit、`
  + `   Q5 说花了多少拍——三者必须打得通。打不通的进 crossDomain 并置 consistent=false，`
  + `   不要替它们圆场。\n`
  + `3. 被排除的事件口径进 rejectedOptions，写清是哪条约束否掉的。\n`
  + `4. 三域互相矛盾时**不下折中值**——进 conflicts 并保留双方。\n`
  + `   特别地：若某域用了一个无出处的加速比，不要把它折算掉，原样报上来。\n`
  + `合并成立写 INTEGRATION_OK；有算子在三域之间对不上时写 DELTA_UNEXPLAINED。`,
  {label: 'events:integrator', phase: 'Conservation', effort: 'high', schema: EVENT_MERGE_SCHEMA})

if (!eventMerge || eventMerge.verdict !== 'INTEGRATION_OK') {
  return {
    stage: STAGE, runId: RUN_ID, block: 'events', verdict: 'DELTA_UNEXPLAINED',
    merge: eventMerge || null,
    reason: '三域事件流无法跨域对账；不落盘',
    nextActions: [
      ...((eventMerge && eventMerge.crossDomain) || []).filter((x) => !x.consistent)
        .map((x) => `打通 ${x.operatorId} 在 Q3/Q4/Q5 之间的口径`),
      ...((eventMerge && eventMerge.conflicts) || []).map((c) => `消解冲突：${c.subject || ''} —— ${c.resolution || '未给解除条件'}`),
      '定位无法归位的事件（见 merge）后重跑本格',
    ],
    files: [],
  }
}

const EVENTS_JSON = JSON.stringify({manifestHash: MANIFEST_HASH, events: eventMerge.events, crossDomain: eventMerge.crossDomain}, null, 2)

// ===========================================================================
// B3 执行账本（19 号文档 §6）。Q6（调度器 / 软件事件）与 Q7（PPA / thermal / RAS）
// **并行**：Q6 说的是"谁在什么时刻被派活"，Q7 说的是"这块硅在这个功耗与温度下
// 还能不能跑"，没有先后依赖，唯一的共同前提是上面冻结的候选与上一块的事件流。
//
// 这一块最特殊的地方是 **PPA_DIRECTION_BACKFLOW**：它是 roster 里只有 physical-expert
// 拥有的裁决。Q7 若发现需要改变方向，必须走 A0 作为 PPA_DIRECTION_BACKFLOW 回流，
// 而不是在这里自行重定方向。两种回流分开处理：
//   DIRECTION_BACKFLOW     （software） → A0 重定方向
//   PPA_DIRECTION_BACKFLOW （physical） → A0 重定方向，且携带 PPA 证据
// 回流的路由是数据，把它们摊平成同一个枚举，等于把"功耗/散热说不行"和
// "软件说不行"变成同一件事。
// ===========================================================================

phase('Software and PPA declaration')

// 两域并行、互不可见。让 physical-expert 看见 Q6 的调度结论，它就会先判断
// "软件那边说排得下"，再去算功耗——而功耗是否可行与软件是否排得下毫不相关。
const EXECUTE_DECLARANTS = [
  {agentId: 'software-expert', domain: 'Q6 调度 / 软件事件：图调度、固件、主机运行时、kernel 发射、同步与依赖',
    label: 'execute:q6-software', schema: SOFTWARE_SCHEMA},
  {agentId: 'physical-expert', domain: 'Q7 PPA / thermal / RAS：面积守恒、功耗（含口径）、散热、可靠性',
    label: 'execute:q7-physical', schema: PHYSICAL_SCHEMA},
]

const executeDeclarations = (await parallel(EXECUTE_DECLARANTS.map((d) => () => agent(
  `${head(d.agentId)}\n${BLOCK_RULES.execute}\n\n`
  + `brief：\n${BRIEF_JSON}\n\n`
  + `${SOURCES}\n\n`
  + `上一块 B2 合并后的事件流（本 workflow 内，尚未落盘）：\n${EVENTS_JSON}\n\n`
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
      + `   physical 域计它——两者相差 21.915648 W。混用口径的功耗裕量不是裕量。\n`
      + `4. peak 与 sustained 不得合并成一个数；写清每个数是哪一个。\n`
      + `5. 面积与功耗都要与 ADR-0021 的单一硬件规格对齐；出现第二份规格如实写出。\n`)
  + `申报完成后给出本域裁决：\n`
  + `  LOCAL_DETAIL_FIX：本域结论自洽，可在当前框架下自行调整。\n`
  + (d.agentId === 'physical-expert'
    ? `  PPA_DIRECTION_BACKFLOW：Q7 发现需要改变**方向**——不是"再多留点裕量就好"，`
      + `   而是当前的形态在功耗/散热/面积上根本不成立（例如在给定散热下峰值功耗`
      + `   无论怎么排都超出，或者面积在 7-reticle 约束下放不下）。`
      + `   这一条必须走 A0 回流，**不得在本格内部自行重定方向**；`
      + `   用这个裁决时在 backflowReason 里写明动摇了哪条方向级假设。\n`
    : `  DIRECTION_BACKFLOW：调度发现需要改变方向——不是"换个派发顺序就好"，`
      + `   而是当前的形态下流水线根本排不开。用这个裁决时写明动摇了哪条假设。\n`)
  + `  BLOCKED_CONFIG：产物缺字段或结论无法归位，在 blockedFields 里列出缺哪些。\n`
  + `注意：你不判这一格是否通过——那是检点者的事。`,
  {label: d.label, phase: 'Software and PPA declaration', effort: 'high', schema: d.schema})
))).filter(Boolean)

if (executeDeclarations.length < EXECUTE_DECLARANTS.length) {
  const absent = EXECUTE_DECLARANTS.filter((d) => !executeDeclarations.some((x) => x.from === d.agentId)).map((d) => d.agentId)
  return {
    stage: STAGE, runId: RUN_ID, block: 'execute', verdict: 'BLOCKED_CONFIG',
    reason: `声明不完整，缺：${absent.join(', ')}`,
    nextActions: absent.map((a) => `补齐 ${a} 本域的申报；若产物缺字段，先补产物再重跑本格`),
    absentDeclarants: absent,
    files: [],
  }
}

// 方向回流是终止性的：拿着一个方向级矛盾往下走，后面每一块都会建在它上面，
// 而且越往后越贵（B4 要跑 18 个槽位）。两种回流分开返回，不合并成同一个枚举。
const executeBackflow = executeDeclarations.filter((d) => d.verdict === 'DIRECTION_BACKFLOW' || d.verdict === 'PPA_DIRECTION_BACKFLOW')
const executeBlocked = executeDeclarations.filter((d) => d.verdict === 'BLOCKED_CONFIG')

if (executeBackflow.length || executeBlocked.length) {
  const all = executeBackflow.concat(executeBlocked)
  // 两种回流同时出现时，PPA 优先上报：它的证据更硬（面积与功耗是可测的物理约束），
  // 而软件排不开往往在换一个形态后就消失了。两者都在 nextActions 里保留。
  const primary = executeBackflow.find((d) => d.verdict === 'PPA_DIRECTION_BACKFLOW') || executeBackflow[0]
  return {
    stage: STAGE, runId: RUN_ID, block: 'execute',
    verdict: primary ? primary.verdict : 'BLOCKED_CONFIG',
    reason: executeBackflow.length
      ? `执行块报方向回流：${executeBackflow.map((d) => `${d.from}=${d.verdict}(${d.backflowReason || '未说明'})`).join('；')}；未合并账本`
      : `执行块被配置挡住：${executeBlocked.map((d) => d.from).join(', ')}；未合并账本`,
    // 回流去哪，由这里说清：PPA 的方向级发现走 A0，携带 Q7 证据。
    nextActions: [
      ...executeBackflow.map((d) => d.verdict === 'PPA_DIRECTION_BACKFLOW'
        ? `把 ${d.from} 的 PPA 证据（backflowReason + ppa 列表）作为 PPA_DIRECTION_BACKFLOW 交给 A0（design.converge / design.arch.direction）重定方向`
        : `把 ${d.from} 的方向级证据作为 DIRECTION_BACKFLOW 交给 A0 重定方向`),
      ...executeBlocked.flatMap((d) => (d.blockedFields || []).map((f) => `补齐被配置挡住的字段：${f}`)),
    ],
    blockedFields: all.flatMap((d) => d.blockedFields || []),
    declarants: all.map((d) => ({from: d.from, verdict: d.verdict})),
    files: [],
  }
}

phase('Execute merge')

const executeMerge = await agent(
  `${head('integrator')}\n${BLOCK_RULES.execute}\n\n`
  + `brief：\n${BRIEF_JSON}\n\n`
  + `细化产物（只读）：${DETAIL_RUN_ARTIFACT}\n`
  + `上一块 B2 的事件流：\n${EVENTS_JSON}\n`
  + `Q6 软件侧申报：\n${JSON.stringify(executeDeclarations.find((d) => d.domain === 'Q6'), null, 2)}\n`
  + `Q7 PPA 侧申报：\n${JSON.stringify(executeDeclarations.find((d) => d.domain === 'Q7'), null, 2)}\n\n`
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
  {label: 'execute:integrator', phase: 'Execute merge', effort: 'high', schema: EXECUTE_MERGE_SCHEMA})

if (!executeMerge || executeMerge.verdict !== 'INTEGRATION_OK') {
  return {
    stage: STAGE, runId: RUN_ID, block: 'execute', verdict: 'DELTA_UNEXPLAINED',
    merge: executeMerge || null,
    reason: 'Q6 与 Q7 无法合并成一份执行账本；不落盘',
    nextActions: ['定位无法归位的 Q6 事件或缺失的 Q7 面，补申报后重跑本格'],
    files: [],
  }
}

// 面积守恒、峰值/持续分离、口径完整、追溯字段齐全——这些是可判定的算术与
// 枚举核对，交给脚本；语义取舍（某个热余量够不够）留给检点者。
const swEvents = executeMerge.software || []

const swTraceGaps = swEvents
  .filter((e) => SW_TRACE_FIELDS.some((f) => e[f] === undefined || e[f] === null || e[f] === ''))
  .map((e) => `${e.eventId || '(无名)'}: 缺 ${SW_TRACE_FIELDS.filter((f) => e[f] === undefined || e[f] === null || e[f] === '').join('/')}`)

// 面积守恒：容差 0。placed + keep-out 必须**恰好**等于总面积。
// 差一点点不是舍入，是有一个区域既没被放东西也没被留空——它去哪了？
const areaSum = (executeMerge.area.placedMm2 || 0) + (executeMerge.area.keepOutMm2 || 0)
const areaGap = Math.abs(areaSum - (executeMerge.area.totalMm2 || 0))
const areaViolated = areaGap > AREA_TOLERANCE_MM2

// peak 与 sustained 分离：合并后的 PPA 里两者必须都在。
// 只给一个数，说明有一个被丢掉了——而丢掉的通常是 peak。
const powerItems = (executeMerge.ppa || []).filter((p) => p.section === 'power')
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
const coveredSections = [...new Set((executeMerge.ppa || []).map((p) => p.section))]
const missingSections = PPA_SECTIONS.filter((s) => !coveredSections.includes(s))

const ppaMultiplierHits = (executeMerge.ppa || [])
  .filter((p) => PPA_MULTIPLIER_PATTERN.test(String(p.source || '')) || PPA_MULTIPLIER_PATTERN.test(String(p.metric || '')))
  .map((p) => p.metric)

const executeGaps = [
  ...swTraceGaps,
  ...(areaViolated ? [`面积守恒不成立（容差 ${AREA_TOLERANCE_MM2}）：placed ${executeMerge.area.placedMm2} + keep-out ${executeMerge.area.keepOutMm2} = ${areaSum} ≠ total ${executeMerge.area.totalMm2}`] : []),
  ...powerGaps,
  ...caliberGaps.map((c) => `功耗口径未标注或未定义：${c}`),
  ...missingSections.map((s) => `PPA 缺面：${s}`),
  ...ppaMultiplierHits.map((m) => `${m}: 疑似无出处乘子`),
]

if (executeGaps.length) {
  return {
    stage: STAGE, runId: RUN_ID, block: 'execute', verdict: 'BLOCKED_CONFIG',
    reason: `B3 退出条件未满足：${executeGaps.slice(0, 12).join('；')}${executeGaps.length > 12 ? ` …共 ${executeGaps.length} 项` : ''}`,
    executeGaps,
    nextActions: executeGaps.slice(0, 12).map((g) => `补齐/更正：${g}`),
    files: [],
  }
}

// 两套口径同时出现不是问题（各自标注清楚即可），但**同一个被比较的限值**
// 只能属于一套口径。这里只登记事实，判断交给检点者。
const caliberMixNote = mixedCalibers.length > 1
  ? `本格同时出现 ${mixedCalibers.join(' 与 ')} 两套卡功耗口径（相差 21.915648 W）；任何与功耗限值的比较必须同口径`
  : null

// ===========================================================================
// B4 18 位合并与 delta 归因（19 号文档 §7）。**只做合并，不产生新设计。**
// 这一块是 S6 的验收落点："粗估-细估 delta 有归因"。硬规矩：
//
//   **delta 的数值由本文件算，delta 的原因由 architect 给。**
//
// 粗估与细估两个数由 integrator 逐字转抄，百分比由本文件的算术得出——
// 它是一个决定性的数，因此不得由任何 agent 产生。"为什么差这么多"是对
// **已存在的两个数**的解释，那才是判断，属于 architect。
// ===========================================================================

phase('Slot merge')

const expectedKeys = OBSERVATION_MODELS.flatMap((m) => OBSERVATION_TP.flatMap((tp) => OBSERVATION_MC.map((mc) => slotKey(m, tp, mc))))

const slotMerge = await agent(
  `${head('integrator')}\n${BLOCK_RULES.slots}\n\n`
  + `brief：\n${BRIEF_JSON}\n\n`
  + `${SOURCES}\n\n`
  + `本次必须覆盖的 ${OBSERVATION_COUNT} 个观察位（键格式 modelId|TP<8|16|32>|MC<320|640>）：\n`
  + `${expectedKeys.join('\n')}\n\n`
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
  + `7. 每个槽位逐字转抄观察矩阵里的 corroboration.kind（${CORROBORATION_KINDS.join(' / ')}）；`
  + `kind 为 FITTED_POINT / DETAILED_HOLDOUT 时同时转抄 corroboration.detailedTpsPerUser 到 detailedTps。`
  + `粗估与细估同公式同标定，两者相同不是核对结果；UNCORROBORATED 的槽位不得写成"已对账一致"。\n`
  + `   注意：键里的 Kimi-K3 在两份产物里的 modelId 是 K3，按 modelId 查找，键仍按上面给出的写。\n`
  + `全部 ${OBSERVATION_COUNT} 位齐备且每一位都归了位写 INTEGRATION_OK；`
  + `有槽位归不了位写 DELTA_UNEXPLAINED。`,
  {label: 'slots:integrator', phase: 'Slot merge', effort: 'high', schema: SLOT_MERGE_SCHEMA})

if (!slotMerge) {
  return {
    stage: STAGE, runId: RUN_ID, block: 'slots', verdict: 'BLOCKED_CONFIG',
    reason: '合并未返回；18 个观察位无法对账',
    nextActions: ['检查 args.detailRunArtifact / args.observationArtifact / args.directionArtifact 是否可读，补产物后重跑本格'],
    files: [],
  }
}

// --- 脚本侧对账之一：18 位的覆盖与形态 ---
// 这一块的输出定义就是"18 位"，所以它以数据的形式被核对。
// 少一位、多一位、键写错、同一模型出现两次——都在这里被抓住。
const seenKeys = slotMerge.slots.map((s) => s.slotKey)
const missingSlots = expectedKeys.filter((k) => !seenKeys.includes(k))
const extraSlots = seenKeys.filter((k) => !expectedKeys.includes(k))
const duplicatedSlots = seenKeys.filter((k, i) => seenKeys.indexOf(k) !== i)

const badSlotStates = slotMerge.slots.filter((s) => !OBSERVATION_STATES.includes(s.status)).map((s) => `${s.slotKey}=${s.status}`)

// 拆分与尾延迟：产物里没有是允许的（写 UNVERIFIED），
// 但**整块缺失**不是——它意味着这一位没有被真正分解过。
const slotsMissingBreakdown = slotMerge.slots
  .filter((s) => !s.breakdown || BREAKDOWN_FIELDS.filter((f) => typeof s.breakdown[f] === 'number').length === 0)
  .map((s) => s.slotKey)
const slotsMissingTail = slotMerge.slots
  .filter((s) => !s.tail || typeof s.tail !== 'object' || TAIL_PERCENTILES.some((p) => s.tail[p] === undefined))
  .map((s) => s.slotKey)

// 单一硬件规格：18 位必须来自同一份规格。这里只看档位的取值集合，
// "是不是唯一一份 ADR-0021 规格"是检点者的判断，脚本只负责把事实摆出来。
const physicalProfiles = [...new Set(slotMerge.slots.map((s) => s.mcProfile).filter(Boolean))]

const badCorroboration = slotMerge.slots.filter((s) => !CORROBORATION_KINDS.includes(s.corroboration)).map((s) => `${s.slotKey}=${s.corroboration}`)
const corroboratedWithoutDetailed = slotMerge.slots
  .filter((s) => ['FITTED_POINT', 'DETAILED_HOLDOUT'].includes(s.corroboration) && !(typeof s.detailedTps === 'number' && s.detailedTps > 0))
  .map((s) => s.slotKey)

const coverageGaps = [
  ...missingSlots.map((k) => `缺观察位：${k}`),
  ...extraSlots.map((k) => `多出未定义的观察位：${k}`),
  ...duplicatedSlots.map((k) => `观察位重复：${k}`),
  ...badSlotStates.map((s) => `观察状态未定义：${s}`),
  ...badCorroboration.map((s) => `印证类别未定义：${s}`),
  ...corroboratedWithoutDetailed.map((k) => `${k}: 声称有详细模拟器印证却没有转抄 detailedTps`),
  ...slotsMissingBreakdown.map((k) => `${k}: 无逐位拆分`),
  ...slotsMissingTail.map((k) => `${k}: 尾延迟分位不全（需 ${TAIL_PERCENTILES.join('/')}）`),
]

if (coverageGaps.length) {
  return {
    stage: STAGE, runId: RUN_ID, block: 'slots', verdict: 'BLOCKED_CONFIG',
    reason: `B4 观察位不齐：${coverageGaps.slice(0, 12).join('；')}${coverageGaps.length > 12 ? ` …共 ${coverageGaps.length} 项` : ''}`,
    nextActions: coverageGaps.slice(0, 12).map((g) => `补齐/更正：${g}`),
    coverageGaps,
    files: [],
  }
}

// --- 脚本侧对账之二：delta 由本文件算 ---
// 这是边界 4 在这一块最具体的落点：TPS 的差是**决定性的数**，
// 只由确定性算术产生。任何一个读者拿这两个裸值都能重算出同一个百分比。
const deltaBySlot = new Map(slotMerge.slots.map((s) => {
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

// 印证的账：残差由本文件对 fineTps 与 detailedTps 做减法得出（同样不由 agent 产生）。
const corroborationBySlot = slotMerge.slots.map((s) => ({
  slotKey: s.slotKey,
  kind: s.corroboration,
  fineTps: s.fineTps,
  detailedTps: typeof s.detailedTps === 'number' ? s.detailedTps : null,
  residualPct: typeof s.detailedTps === 'number' && s.detailedTps > 0
    ? Math.round(((s.fineTps / s.detailedTps) - 1) * 100 * 1e4) / 1e4
    : null,
}))
const uncorroboratedSlots = corroborationBySlot.filter((c) => c.kind === 'UNCORROBORATED').map((c) => c.slotKey)
const corroborationSummary = {
  fittedPoint: corroborationBySlot.filter((c) => c.kind === 'FITTED_POINT').length,
  detailedHoldout: corroborationBySlot.filter((c) => c.kind === 'DETAILED_HOLDOUT').length,
  uncorroborated: uncorroboratedSlots.length,
  none: corroborationBySlot.filter((c) => c.kind === 'NONE').length,
  heldOutMaxAbsResidualPct: Math.max(0, ...corroborationBySlot.filter((c) => c.kind === 'DETAILED_HOLDOUT' && c.residualPct !== null).map((c) => Math.abs(c.residualPct))),
}

const nonzeroDelta = [...deltaBySlot.values()].filter((d) => d.deltaPct !== null && Math.abs(d.deltaPct) > DELTA_EPS)

// 归因齐备性：**每一个非零 delta 都必须有归因**。
// 不设"小于 x% 可以不解释"的宽容线——那正是 delta 悄悄溜走的方式。
// 归不了因是允许的结果（它会让本格以 DELTA_UNEXPLAINED 收场），但"没提这件事"不是。
const attributedKeys = new Set([
  ...(slotMerge.attributions || []).map((a) => a.slotKey),
  ...(slotMerge.unattributedDelta || []).map((a) => a.slotKey),
])
const silentDeltas = nonzeroDelta.filter((d) => !attributedKeys.has(d.slotKey)).map((d) => `${d.slotKey}: delta ${d.deltaPct}% 未被提及`)

if (silentDeltas.length) {
  return {
    stage: STAGE, runId: RUN_ID, block: 'slots', verdict: 'BLOCKED_CONFIG',
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
  ...(slotMerge.unattributedDelta || []),
  ...nonzeroDelta
    .filter((d) => !(slotMerge.attributions || []).some((a) => a.slotKey === d.slotKey))
    .filter((d) => !(slotMerge.unattributedDelta || []).some((a) => a.slotKey === d.slotKey))
    .map((d) => ({slotKey: d.slotKey, deltaPct: d.deltaPct, observation: 'workflow 计算：该位 delta 非零但未给出归因项'})),
]

const attribution = await agent(
  `${head('architect')}\n\n`
  + `brief：\n${BRIEF_JSON}\n\n`
  + `${SOURCES}\n\n`
  + `workflow 算出的逐位 delta（粗估 → 细估的百分比，已由脚本相减得出）：\n`
  + `${JSON.stringify([...deltaBySlot.values()], null, 2)}\n\n`
  + `integrator 已给出的归因：\n${JSON.stringify(slotMerge.attributions || [], null, 2)}\n\n`
  + `**尚未归因**的 delta（需要你裁决的）：\n${JSON.stringify(unexplainedInput, null, 2)}\n\n`
  + `单一硬件规格（integrator 登记）：${slotMerge.singleHardwareSpec}\n`
  + `逐位物理/存储档位：${physicalProfiles.join(', ')}\n`
  + `本格前几块登记的执行账本阻塞项：\n${JSON.stringify(executeMerge.blockers || [], null, 2)}\n`
  + (caliberMixNote ? `workflow 登记的口径事实：${caliberMixNote}\n` : '')
  + `\n任务：对每一个尚未归因的 delta 给出归因，并给出本格的方向级裁决。规则：\n`
  + `1. 归因必须指到**具体的拆分项或口径差**（memoryUs / computeUs / commUs / tmaExposedUs / fixedUs / `
  + `   粗估与细估的口径差 / 观察位的状态）。\n`
  + `2. **不得用"综合因素""多个原因共同作用"类措辞糊过去**。`
  + `   归不了因就写进 unexplained——那是允许的结果，它会让本格以 DELTA_UNEXPLAINED 收场，`
  + `   而一条假归因会让一个真缺口永远消失。\n`
  + `3. 逐条标注 directionLevel：这个 delta 是细节问题，还是动摇了方向级假设。\n`
  + `4. 两套卡功耗口径（memory 域不计共享端口项、physical 域计它，相差 21.915648 W）`
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
    stage: STAGE, runId: RUN_ID, block: 'slots', verdict: 'BLOCKED_CONFIG',
    reason: '归因裁决未返回；delta 无法归位',
    nextActions: ['重跑 architect 归因步；若产物缺字段，先补产物'],
    files: [],
  }
}

// 方向回流是终止性的：本格之后就是 A0，
// 拿着一个方向级矛盾进入收敛，收敛出来的会是一份建立在错前提上的结论。
if (attribution.verdict === 'DIRECTION_BACKFLOW') {
  return {
    stage: STAGE, runId: RUN_ID, block: 'slots', verdict: 'DIRECTION_BACKFLOW',
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
const stillUnexplained = attribution.unexplained || []

phase('Independent verification')

// verifier 只拿拟落盘产物。给它 agent 的申报散文，它就会去验证叙述的
// 自洽性，而不是验证产物的可回放性——那正是本格需要被独立看的地方。
// 冻结清单没有可回放的物理量，但它与 18 位同在一份产物里：verifier 看它，
// 是为了核 provenance（细估的数是不是出自被冻结的那份配置），不是去"验证"一份抄录。
const artifactDraft = {
  schemaVersion: 'design-integrate-v0.1',
  stage: STAGE, runId: RUN_ID, sourceCommit: BRIEF.sourceCommit,
  registerArtifact: REGISTER_ARTIFACT,
  detailRunArtifact: DETAIL_RUN_ARTIFACT,
  replayArtifact: REPLAY_ARTIFACT,
  observationArtifact: OBSERVATION_ARTIFACT,
  directionArtifact: DIRECTION_ARTIFACT,
  workloadArtifact: WORKLOAD_ARTIFACT,
  freeze: {
    frozen: frozen.frozen,
    provenance: frozen.provenance,
    manifestStatus: frozen.manifestStatus,
    singleHardwareSpec: frozen.singleHardwareSpec,
    unfrozenFields: frozen.unfrozenFields || [],
    fingerprint: freezeFingerprint,
  },
  events: {
    manifestHash: MANIFEST_HASH,
    events: eventMerge.events,
    crossDomain: eventMerge.crossDomain,
    conflicts: eventMerge.conflicts || [],
  },
  execute: {
    software: executeMerge.software,
    exposedVsHidden: executeMerge.exposedVsHidden,
    ppa: executeMerge.ppa,
    area: executeMerge.area,
    powerCalibers: mixedCalibers.slice().sort(),
    blockers: executeMerge.blockers || [],
  },
  observationCount: slotMerge.slots.length,
  slots: slotMerge.slots,
  deltaBySlot: [...deltaBySlot.values()],
  corroborationBySlot,
  corroborationSummary,
  singleHardwareSpec: slotMerge.singleHardwareSpec,
  physicalProfiles,
  attributions: [
    ...(slotMerge.attributions || []).map((a) => ({...a, source: 'integrator'})),
    ...(attribution.attributions || []).map((a) => ({...a, source: 'architect'})),
  ],
  unexplained: stillUnexplained,
  rejectedOptions: [
    ...(eventMerge.rejectedOptions || []).map((r) => ({...r, block: 'events'})),
    ...(executeMerge.rejectedOptions || []).map((r) => ({...r, block: 'execute'})),
    ...(slotMerge.rejectedOptions || []).map((r) => ({...r, block: 'slots'})),
  ],
  verdict: stillUnexplained.length ? 'DELTA_UNEXPLAINED' : 'INTEGRATION_OK',
}

const verification = await agent(
  `${head('verifier')}\n\n`
  + `拟落盘的细化合并产物（这是你要验证的对象；你**不**看任何 agent 的申报过程）：\n`
  + `${JSON.stringify(artifactDraft, null, 2)}\n\n`
  + `源产物（只读）：\n${SOURCES}\n\n`
  + `任务：对这份产物做独立验证，逐项给出 pass/fail 与裸值：\n`
  + `  1. schema：字段齐备性与取值域（观察状态必须落在 ${OBSERVATION_STATES.join(' / ')} 内）。\n`
  + `  2. 守恒：18 位是否恰好覆盖 ${OBSERVATION_COUNT} 个组合，有没有多出或重复的位；`
  + `     events 段的五条守恒（${CONSERVATIONS.join('、')}）与 execute 段的面积三件套是否能由产物里的裸值重算成立。\n`
  + `  3. provenance：粗估与细估的数是否真的能在源产物里找到，字段是否对得上；`
  + `     freeze 段冻结的 manifestHash / seed / 候选 id 是否与源产物一致。\n`
  + `  4. golden trace：抽查若干位的和 —— 粗估与细估的 delta 百分比能否由两个裸值重算出来`
  + `     （重算结果必须与产物里的 deltaPct 一致）。\n`
  + `  5. 可回放性：同一个 runId 下，重跑能否得到同一组裸值。\n`
  + `任一项不合，给出具体的文件与字段。\n`
  + `全部通过写 VERIFIED，任一不通过写 VERIFY_FAILED。`,
  {label: 'verifier', phase: 'Independent verification', effort: 'high', schema: VERIFY_SCHEMA})

const okVerified = verification && verification.verdict === 'VERIFIED'

phase('Invariant check')

// 末步是检点，不是总结。各块的合并者都有"自己的对账没问题"的结构性偏好；
// 原先四格各自检点一次，现在收成这一次，检点者看的是整份产物——
// 它要专门找的正是"每一块都合规、合起来不成立"的那种违规。
const check = await agent(
  `${head('invariant-checker')}\n\n`
  + `源产物（只读）：\n${SOURCES}\n\n`
  + `拟落盘的合并产物：\n${JSON.stringify(artifactDraft, null, 2)}\n`
  + `architect 的裁决：\n${JSON.stringify(attribution, null, 2)}\n`
  + `verifier 的结论：\n${JSON.stringify(verification, null, 2)}\n`
  + (caliberMixNote ? `workflow 登记的口径事实：${caliberMixNote}\n` : '')
  + `\n任务：对这份产物做全局不变量检点，逐条给出 pass/fail 与裸值：\n`
  + `7-reticle 面积守恒、单一硬件规格（ADR-0021）、MC320/MC640 分离、peak 与 sustained 分离、`
  + `单位一致、证据等级齐全。另按块核本格的退出条件：\n`
  + `B0 冻结：\n`
  + `  (a) 候选来源唯一可追溯——冻结的 candidateId 必须能回到候选寄存器，且只有一个来源；\n`
  + `  (b) run_id 与 input hash 在冻结清单与产物之间共享，不是各写各的。\n`
  + `B2 事件：\n`
  + `  (c) 每个事件都能追溯到 ${EVENT_TRACE_FIELDS.join('、')}，且三路的 manifest hash 逐字一致；\n`
  + `  (d) 五条守恒（${CONSERVATIONS.join('、')}）在合并后仍然成立——合并不得让任何一条守恒的 lhs 与 rhs 漂移；\n`
  + `  (e) 重放产物里的 SYNTHETIC_PLACEHOLDER 事件没有被引用为证据。\n`
  + `B3 执行：\n`
  + `  (f) Q6 每个事件可追溯（${SW_TRACE_FIELDS.join('、')}），Q7 每项有出处；\n`
  + `  (g) 面积守恒在容差 ${AREA_TOLERANCE_MM2} 下成立；\n`
  + `  (h) **卡功耗口径没有被混用**：同一个被比较的限值只能属于一套口径。`
  + `      两套口径相差 21.915648 W（memory 域是 8×die + MC + 固定 80 W，不计共享端口项；`
  + `      physical 域计它）。拿 memory 域的裕量去说 physical 域够用，是最隐蔽的违规；\n`
  + `  (i) exposed 与 hidden 真的分开，没有被合成一个总数。\n`
  + `B4 合并：\n`
  + `  (j) 18 个观察位（${OBSERVATION_MODELS.length} 模型 × ${OBSERVATION_TP.join('/')} × ${OBSERVATION_MC.join('/')}）齐备；\n`
  + `  (k) **单一硬件规格**：18 位是不是真的来自同一份 ADR-0021 规格，物理档位集合 `
  + `      ${physicalProfiles.join(', ')} 是否与候选寄存器里的正式选中候选、与冻结清单的 physicalProfile/mcProfile 一致；\n`
  + `  (l) 每一个非零的粗估-细估 delta 都有归因，且归因指到了具体拆分项（"综合因素"类措辞不算归因）；\n`
  + `  (m) 观察状态没有把 PENDING_MODEL_RUN 当成已观测。\n`
  + `跨块再核两条：全流里**没有**无出处的全局加速比、利用率乘子或热降频系数——这一条要主动去找，不是等它写出来；`
  + `architect 的裁决与它给出的归因是否自洽——判了 ARCH_FREEZE 却留着未归因的 delta，这两件事不能同时成立。\n`
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
    'model-expert': '1.0', 'memory-expert': '1.0', 'comm-expert': '1.0', 'compute-expert': '1.0',
    'software-expert': '1.0', 'physical-expert': '1.0',
    integrator: '1.0', architect: '1.0', verifier: '1.0', 'invariant-checker': '1.0',
  },
  // 冻结块没有"被否候选"——候选早在 D-Gate 定死了。被否的是**冻结字段**：
  // 没能冻结的字段就是一个上游缺口，不记下来，重跑会重新发明一遍同样的清单。
  rejectedOptions: [
    ...(frozen.unfrozenFields || []).map((field) => ({
      stage: STAGE, optionId: field,
      reason: '该字段在本轮产物中无法复现或未被登记', rejectedBy: 'invariant-checker',
    })),
    ...artifactDraft.rejectedOptions.map((r) => ({
      stage: STAGE, optionId: r.optionId, reason: r.reason, rejectedBy: r.rejectedBy,
    })),
  ],
  // 对不上的跨域口径、三域矛盾、执行账本的阻塞与仍归不了因的 delta 都进 blocker：
  // 它们不会自己消失，converge 与 backflow 都会读这份产物。
  openBlockers: [
    ...(eventMerge.conflicts || []).map((c, i) => ({
      id: `EVENT-CONFLICT-${String(i + 1).padStart(2, '0')}`,
      owner: (c.between && c.between[0]) || 'integrator',
      unblockCondition: c.resolution,
    })),
    ...(eventMerge.crossDomain || []).filter((x) => !x.consistent).map((x, i) => ({
      id: `EVENT-CROSSDOMAIN-${String(i + 1).padStart(2, '0')}`,
      owner: 'integrator',
      unblockCondition: `打通 ${x.operatorId} 在 Q3/Q4/Q5 之间的口径`,
    })),
    ...(executeMerge.blockers || []).map((b, i) => ({
      id: `EXECUTE-${String(i + 1).padStart(2, '0')}`,
      owner: b.owner || 'integrator',
      unblockCondition: b.unblockCondition,
    })),
    ...stillUnexplained.map((k, i) => ({
      id: `DELTA-${String(i + 1).padStart(2, '0')}`,
      owner: 'architect',
      unblockCondition: `${k}: 粗估与细估的差需要归到具体拆分项或口径差`,
    })),
  ],
}

const runRecord = {
  schemaVersion: 'design-run-record-v0.1',
  stage: STAGE,
  runId: RUN_ID,
  sourceCommit: BRIEF.sourceCommit,
  registerArtifact: REGISTER_ARTIFACT,
  detailRunArtifact: DETAIL_RUN_ARTIFACT,
  replayArtifact: REPLAY_ARTIFACT,
  observationArtifact: OBSERVATION_ARTIFACT,
  directionArtifact: DIRECTION_ARTIFACT,
  workloadArtifact: WORKLOAD_ARTIFACT,
  stageCommand: STAGE_COMMAND_FOR_RECORD,
  // B0
  frozenFields: FREEZE_FIELDS,
  freezeFieldCount: frozen.frozen.length,
  freezeFingerprint,
  manifestStates: Object.fromEntries(frozen.manifestStatus.map((m) => [m.modelId, m.status])),
  // B2：事件集指纹——两次跑出来的是不是同一份事件流，靠这个可复核。
  manifestHash: MANIFEST_HASH,
  eventSet: flatEvents.map((e) => `${e.eventId}|${e.type}|${e.operatorId}|${e.tileId}`).sort(),
  eventCount: flatEvents.length,
  byDomain: Object.fromEntries(eventDeclarations.map((d) => [d.q, (d.events || []).length])),
  conservations: Object.fromEntries(CONSERVATIONS.map((name) => [
    name,
    eventDeclarations.every((d) => (d.conservations || []).some((c) => c.name === name && c.met)) ? 'met' : 'violated',
  ])),
  // B3
  swEventCount: swEvents.length,
  ppaMetricCount: (executeMerge.ppa || []).length,
  swEventSet: swEvents.map((e) => `${e.eventId}|${e.operatorId}|${e.pipelineStep}|${e.latencyType}`).sort(),
  ppaSections: coveredSections.slice().sort(),
  areaBudgetMm2: executeMerge.area.totalMm2,
  areaPlacedMm2: executeMerge.area.placedMm2,
  areaKeepOutMm2: executeMerge.area.keepOutMm2,
  powerCalibers: mixedCalibers.slice().sort(),
  exposedCycles: executeMerge.exposedVsHidden.exposedCycles,
  hiddenCycles: executeMerge.exposedVsHidden.hiddenCycles,
  // B4
  observationCount: slotMerge.slots.length,
  expectedObservationCount: OBSERVATION_COUNT,
  observationStates: Object.fromEntries(
    OBSERVATION_STATES.map((s) => [s, slotMerge.slots.filter((x) => x.status === s).length])),
  singleHardwareSpec: slotMerge.singleHardwareSpec,
  physicalProfiles: physicalProfiles.slice().sort(),
  deltaBySlot: [...deltaBySlot.values()],
  corroborationSummary,
  uncorroboratedSlots,
  nonzeroDeltaCount: nonzeroDelta.length,
  attributedCount: attributedKeys.size,
  unexplainedCount: stillUnexplained.length,
  architectVerdict: attribution.verdict,
  verifierVerdict: verification ? verification.verdict : 'UNVERIFIED',
  declarants: {
    freeze: freezeDeclarations.map((d) => d.from).sort(),
    events: eventDeclarations.map((d) => d.from).sort(),
    execute: executeDeclarations.map((d) => d.from).sort(),
    slots: ['integrator', 'architect', 'verifier', 'invariant-checker'],
  },
  caliber: '冻结项逐字转抄；事件流与执行账本的 bytes/flops/cycles/mm²/W 皆为产物裸值；'
    + 'delta 百分比由 workflow 对两个裸值做减法得出，不由任何 agent 产生；'
    + 'TPS 裸值一律取自 stage_b.js 与 Stage A 的产物；'
    + '粗估与细估是同一公式同一标定，delta 为 0 对 uncorroboratedSlots 不构成核对，'
    + '只有 K3 详细模拟器的印证（corroborationSummary）是独立的；'
    + 'Q3-Q6 的 SYNTHETIC_PLACEHOLDER 占位不作为证据',
}

return {
  stage: STAGE,
  runId: RUN_ID,
  verdict: ok
    ? 'INTEGRATION_OK'
    : (stillUnexplained.length ? 'DELTA_UNEXPLAINED'
      : (!okVerified ? 'VERIFY_FAILED' : 'INVARIANT_VIOLATED')),
  frozen: ok ? frozen.frozen : null,
  provenance: ok ? frozen.provenance : null,
  unfrozenFields: frozen.unfrozenFields || [],
  manifestHash: MANIFEST_HASH,
  events: ok ? eventMerge.events : null,
  crossDomain: ok ? eventMerge.crossDomain : null,
  conflicts: eventMerge.conflicts || [],
  software: ok ? executeMerge.software : null,
  ppa: ok ? executeMerge.ppa : null,
  area: ok ? executeMerge.area : null,
  blockers: executeMerge.blockers || [],
  slots: ok ? slotMerge.slots : null,
  deltaBySlot: [...deltaBySlot.values()],
  corroborationSummary,
  uncorroboratedSlots,
  attributions: artifactDraft.attributions,
  unexplained: stillUnexplained,
  architectVerdict: attribution.verdict,
  violations: okInvariants ? [] : ((check && check.violations) || ['检点未完成']),
  verifyFailures: okVerified ? [] : ((verification && verification.failures) || ['独立验证未完成']),
  nextActions: ok ? [] : [
    ...stillUnexplained.map((k) => `${k}: 归因粗估-细估的差，或交 architect 重定方向`),
    ...(!okVerified && verification ? (verification.failures || []).map((f) => `修 ${f.check}：${f.file}#${f.field}`) : []),
    ...(!okInvariants && check ? (check.violations || []).map((v) => `修 ${v.invariant}：${v.file}#${v.field}`) : []),
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
