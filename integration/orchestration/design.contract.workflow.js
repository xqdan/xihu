export const meta = {
  name: 'design-contract',
  description: 'K3 设计 contract 阶段：四域专家各申报本域对外接口，架构师收敛成一份契约，verifier 只读已落盘契约独立验证，invariant-checker 检点后落盘',
  whenToUse: 'A 组。需要 args.brief（stage=contract 的 DesignBrief）与 args.contractArtifact（主循环已用 generate_team_contracts.js 生成好的契约路径）。本 workflow 不生成契约、不写文件。',
  phases: [
    { title: 'Interface declaration', detail: '四域专家各申报本域的对外接口、单位与守恒量' },
    { title: 'Contract convergence', detail: 'architect 收敛成一份契约，登记冲突与未决接口' },
    { title: 'Independent verification', detail: 'verifier 只读已落盘契约，不读申报过程的中间产物' },
    { title: 'Invariant check', detail: 'invariant-checker 强制检点；不通过则不落盘' },
  ],
}

// ---------------------------------------------------------------------------
// A 组 contract。要回答的唯一问题是"接口长什么样"。
//
// 与 C 组骨架的三点关键区别：
//
// 1. 契约不是这份 workflow 生成的。`generate_team_contracts.js` 是生成器
//    （它把 teams/<team>/contract.json 合并成 out/contracts/ 四份产物并按 sha256 绑定），
//    契约产物由**主循环**先生成、路径经 args 传入。本 workflow 只回答
//    "这些契约的接口面之间是否自洽、单位是否一致、还差哪条"。让 agent 生成契约
//    等于给只读护栏开口子，而且生成器已经把哈希绑好了，重写一份反而是第二份事实。
//
// 2. 末步是 verifier 的独立验证 + invariant-checker 的检点，两次调用，不是一次。
//    verifier 的策略正文明确"不得读设计过程的中间产物，只能读已落盘的最终 artifact"
//    ——所以它**拿不到**四位专家的申报原文，只拿契约产物与申报摘要里的接口名，
//    这是刻意的：验证者若能看到申报的推理过程，就会顺着理由接受结论。
//
// 3. 四条硬边界在此全部有落点：接口面（边界 1：输出什么由 workflow 注入）、
//    路径只出现在 workflow 里而不进策略（边界 2）、专家的裁决枚举由 workflow 消费
//    （边界 3）、契约里的数字一律由生成器算（边界 4）。
// ---------------------------------------------------------------------------

const REPO = args.repo || '.'
const STAGE = 'contract'
const BRIEF = args.brief
const RUN_ID = args.runId || 'contract-run'
const MAX_INTERFACES = args.maxInterfaces || 24
// 契约产物由主循环调用 generate_team_contracts.js 生成；这里只接收路径。
const CONTRACT_ARTIFACT = args.contractArtifact
const CONTRACT_COMMAND_FOR_RECORD = args.contractCommand || 'UNVERIFIED'

if (!BRIEF) throw new Error('design.contract 需要 args.brief（intake 阶段产出的 DesignBrief）')
if (!CONTRACT_ARTIFACT) {
  throw new Error('design.contract 需要 args.contractArtifact（已由主循环调用 generate_team_contracts.js 生成好的契约路径）；本 workflow 不生成契约')
}
if (BRIEF.stage !== 'contract') {
  // brief 的 stage 与 workflow 名称必须一致，否则会把别的阶段的契约拿来用
  throw new Error(`brief.stage=${BRIEF.stage}，与 design.contract 不符；契约串了`)
}

const HEAD = [
  `仓库根目录：${REPO}`,
  `本 workflow：design.contract（stage=${STAGE}，runId=${RUN_ID}）`,
  `你是一个策略实例。先读你的策略正文：${REPO}/teams/council/strategies/__AGENT__.md`,
  '那份文件是本角色的判断规则、正确性判据、证据规则、取舍规则与禁止事项，逐条遵守。',
  '以下运行时上下文由 workflow 注入；注入内容与策略正文冲突时，注入内容优先（它承载本 stage 的事实）。',
  '你没有文件系统写权限。把该写的东西作为返回值交回，由 workflow 落盘。',
  '所有数字必须带出处（文件路径:行号 或 ADR 编号）；没有出处的写 UNVERIFIED 并说明缺什么，不得静默补齐。',
  '不得输出 TPS/usr 或任何全局性能指标；不得输出 PASS / D_GATE_PASSED 字面量。',
].join('\n')

const head = (agentId) => HEAD.replace('__AGENT__', agentId)

const BRIEF_JSON = JSON.stringify(BRIEF, null, 2)

// 申报的接口面。五域共用同一形状，这样"硬件申报的 MC 接口"和"软件申报的 MC 接口"
// 是同一个对象，架构师不必翻译就能判它们是否指同一件事。
// interfaceId 必须引用 brief 里已有的硬约束或契约里的 requiredFields——
// 申报是**登记接口**，不是发明接口；发明出来的接口没有出处，下游无法复核。
//
// 形状是工厂而不是常量：五域的裁决枚举不同（physical-expert 报 PPA_DIRECTION_BACKFLOW，
// 其余四域报 DIRECTION_BACKFLOW），而 schema 是 agent 的返回值约束。
// 若五域共用一个常量，就只能取五个枚举的并集，等于允许软件专家报 PPA 回流——
// 一个它无权声明的裁决。枚举必须来自 agent_roster.json，不是在这里重新设计。
const interfaceSchema = (verdictEnum) => ({
  type: 'object',
  additionalProperties: false,
  required: ['from', 'interfaces', 'verdict'],
  properties: {
    from: { type: 'string', description: '给出申报的 agentId' },
    interfaces: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['interfaceId', 'name', 'direction', 'unit', 'conserved', 'evidence'],
        properties: {
          interfaceId: { type: 'string', description: '本域对外的接口标识；已存在的写原 id，新增写 NEW' },
          name: { type: 'string', description: '接口名，例如 "MC raw/sustained/effective bandwidth"' },
          direction: { type: 'string', enum: ['provides', 'consumes', 'both'] },
          unit: { type: 'string', description: '数值单位；无量纲写 "none"。单位不一致的接口才是真问题' },
          conserved: { type: 'string', description: '本接口上必须守恒的量（容量/带宽/credit/面积），没有写 "none"' },
          evidence: { type: 'string', description: '规格文件路径:行号、ADR 编号，或 UNVERIFIED' },
        },
      },
    },
    verdict: { type: 'string', enum: verdictEnum },
    blockedFields: { type: 'array', items: { type: 'string' } },
    backflowReason: { type: 'string', description: 'DIRECTION_BACKFLOW / PPA_DIRECTION_BACKFLOW 时必填：动摇了哪条方向级假设' },
  },
})

// architect 的收敛裁决。枚举取自 agent_roster.json，不在这里重新设计——
// 这里原本写的是 INTEGRATION_OK / DELTA_UNEXPLAINED，那是 **integrator** 的枚举：
// 合并者报"合没合上"，架构师报"这一格能不能定稿"。两个角色的词汇不同，
// 混用会让"谁在下这个结论"从产物里看不出来。
//
// 合并结果本身（冲突、未决接口）是**数据**，走 conflicts / undecided 两个字段，
// 不该再占一个裁决值："合上了但有 3 条冲突"和"没合上"是两件事，
// 前者照样是一条完整的收敛结论。
const CONVERGENCE_VERDICTS = ['ARCH_FREEZE', 'DIRECTION_BACKFLOW', 'D_GATE_PROPOSAL']

// 契约收敛的产物。architect 只收敛，不发明接口；冲突不下折中值，登记为 blocker。
const CONTRACT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['interfaces', 'conflicts', 'undecided', 'verdict'],
  properties: {
    interfaces: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['interfaceId', 'owner', 'counterparties', 'unit', 'conserved', 'evidenceLevel'],
        properties: {
          interfaceId: { type: 'string' },
          owner: { type: 'string', description: '接口归属团队' },
          counterparties: { type: 'array', items: { type: 'string' } },
          unit: { type: 'string' },
          conserved: { type: 'string' },
          evidenceLevel: { type: 'string', enum: ['E0', 'E1', 'E2', 'E3', 'UNVERIFIED'] },
        },
      },
    },
    conflicts: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['interfaceId', 'parties', 'description', 'resolution'],
        properties: {
          interfaceId: { type: 'string' },
          parties: { type: 'array', items: { type: 'string' }, description: '冲突双方' },
          description: { type: 'string' },
          resolution: { type: 'string', description: '解除这个冲突需要什么；不确定的写 UNVERIFIED' },
        },
      },
    },
    undecided: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['interfaceId', 'neededFrom', 'missing'],
        properties: {
          interfaceId: { type: 'string' },
          neededFrom: { type: 'string' },
          missing: { type: 'string' },
        },
      },
    },
    verdict: { type: 'string', enum: CONVERGENCE_VERDICTS },
  },
}

// 独立验证。verifier 只拿到契约产物本身与接口名清单，拿不到申报原文。
const VERIFY_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['checks', 'verdict'],
  properties: {
    checks: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['check', 'result', 'detail'],
        properties: {
          check: { type: 'string', enum: ['schema', 'unit', 'conservation', 'provenance', 'version', 'profileSeparation'] },
          result: { type: 'string', enum: ['met', 'violated', 'UNVERIFIED'] },
          detail: { type: 'string', description: '可复现的检查方式与裸值；不得以设计者自述为依据' },
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

phase('Interface declaration')

// 五域专家各申报本域的对外接口。五个并行调用，互不共享上下文：
// 让它们互相看不见，申报才是独立的；看见彼此会互相抄接口表。
//
// 五域而不是四域：roster 里 design.contract 的 consumers 列了 physical-expert，
// 且封装是接口面的真正定界者——"这个接口要多少 PHY 岸线、多少 keep-out" 只有它答得了。
// 少它一个，架构师收敛出的契约面就是没有面积归属的。
//
// verdict 枚举逐条取自 agent_roster.json，不是在这里现写的：
//   compute / memory / comm / software → LOCAL_DETAIL_FIX / DIRECTION_BACKFLOW / BLOCKED_CONFIG
//   physical                           → LOCAL_DETAIL_FIX / PPA_DIRECTION_BACKFLOW / BLOCKED_CONFIG
const DOMAINS = [
  {agentId: 'compute-expert', domain: 'AI Core 微架构', label: 'interface:compute',
    verdictEnum: ['LOCAL_DETAIL_FIX', 'DIRECTION_BACKFLOW', 'BLOCKED_CONFIG']},
  {agentId: 'memory-expert', domain: 'SRAM/MC/TMA', label: 'interface:memory',
    verdictEnum: ['LOCAL_DETAIL_FIX', 'DIRECTION_BACKFLOW', 'BLOCKED_CONFIG']},
  {agentId: 'comm-expert', domain: 'NoC/collective/Die-to-Die', label: 'interface:comm',
    verdictEnum: ['LOCAL_DETAIL_FIX', 'DIRECTION_BACKFLOW', 'BLOCKED_CONFIG']},
  {agentId: 'physical-expert', domain: '封装/floorplan/热/电/RAS', label: 'interface:physical',
    verdictEnum: ['LOCAL_DETAIL_FIX', 'PPA_DIRECTION_BACKFLOW', 'BLOCKED_CONFIG']},
  {agentId: 'software-expert', domain: '调度/融合/量化/执行', label: 'interface:software',
    verdictEnum: ['LOCAL_DETAIL_FIX', 'DIRECTION_BACKFLOW', 'BLOCKED_CONFIG']},
]

const declarations = (await parallel(DOMAINS.map((d) => () => agent(
  `${head(d.agentId)}\n\n`
  + `brief：\n${BRIEF_JSON}\n\n`
  + `任务：你是本域（${d.domain}）的接口申报人。申报本域**对外**的接口面：别人要拿什么、`
  + `本域要给什么、单位是什么、哪条量必须守恒。只登记接口，不做领域设计，不对其他域是否可行下结论。\n`
  + `接口不超过 ${MAX_INTERFACES} 条。每条必须有出处；没有出处的接口标 UNVERIFIED 并说明缺什么。\n`
  + `申报完成后给出本域的裁决，三选一：\n`
  + `  LOCAL_DETAIL_FIX：对外接口面完整，本域可在当前框架下自行调整，不需要上游介入。\n`
  + `  ${d.agentId === 'physical-expert' ? 'PPA_DIRECTION_BACKFLOW' : 'DIRECTION_BACKFLOW'}：`
  + `本次申报动摇了方向级假设（例如某条接口在给定面积/带宽预算下根本不存在），`
  + `必须回到 direction 重定，不得靠收敛把矛盾摊平。用这个裁决时在 backflowReason 里写明动摇了哪条假设。\n`
  + `  BLOCKED_CONFIG：输入不足或组合不可实现，在 blockedFields 里列出缺哪些字段。\n`
  + `注意：申报接口不是给整机下结论。你不判契约是否通过——那是 verifier 与检点者的事。`,
  {label: d.label, phase: 'Interface declaration', effort: 'high', schema: interfaceSchema(d.verdictEnum)})
))).filter(Boolean)

if (declarations.length < DOMAINS.length) {
  const absent = DOMAINS.filter((d) => !declarations.some((x) => x.from === d.agentId)).map((d) => d.agentId)
  return {
    stage: STAGE, runId: RUN_ID, verdict: 'BLOCKED_CONFIG',
    reason: `接口申报不完整，缺：${absent.join(', ')}`,
    absentDeclarants: absent,
    files: [],
  }
}

// 裁决枚举由 workflow 消费——这一步是四处裁决真正生效的地方。
// 申报人报了方向回流，收敛就没有意义：继续走只会产出一份建立在错前提上的契约，
// 而契约一旦落盘，下游每个域都会照着它开工。所以这里先拦，再谈收敛。
const blockedDeclarants = declarations.filter((d) => d.verdict === 'BLOCKED_CONFIG')
const backflowDeclarants = declarations.filter(
  (d) => d.verdict === 'DIRECTION_BACKFLOW' || d.verdict === 'PPA_DIRECTION_BACKFLOW',
)

if (backflowDeclarants.length || blockedDeclarants.length) {
  const all = backflowDeclarants.concat(blockedDeclarants)
  return {
    stage: STAGE, runId: RUN_ID,
    verdict: backflowDeclarants.length ? backflowDeclarants[0].verdict : 'BLOCKED_CONFIG',
    reason: backflowDeclarants.length
      ? `接口申报报方向回流：${backflowDeclarants.map((d) => `${d.from}(${d.backflowReason || '未说明'})`).join('；')}；未收敛契约`
      : `接口申报被配置挡住：${blockedDeclarants.map((d) => d.from).join(', ')}；未收敛契约`,
    blockedFields: all.flatMap((d) => d.blockedFields || []),
    declarations: all.map((d) => ({from: d.from, verdict: d.verdict})),
    files: [],
  }
}

const declaredInterfaces = declarations.flatMap((d) => (d.interfaces || []).map((i) => ({...i, declaredBy: d.from})))

phase('Contract convergence')

const merged = await agent(
  `${head('architect')}\n\n`
  + `brief：\n${BRIEF_JSON}\n\n`
  + `契约产物（主循环已生成，只读）：${CONTRACT_ARTIFACT}\n`
  + `四域申报的接口面：\n${JSON.stringify(declaredInterfaces, null, 2)}\n\n`
  + `任务：收敛成一份契约的接口面清单。规则：\n`
  + `1. 只合并，不发明接口。申报里没有、契约产物里也没有的接口，不得凭空补上。\n`
  + `2. 同一接口被两域申报成不同单位或不同守恒量时**不下折中值**，进 conflicts 并把`
  + `   解决它需要什么写进 resolution。\n`
  + `3. 契约产物里 requiredFields 列出但无人申报的接口，进 undecided。\n`
  + `4. 证据等级按申报出处判定；出处缺失的写 UNVERIFIED，不得按"看起来合理"升级。\n`
  + `每个接口给 owner 与 counterparties（谁提供、谁消费）。\n`
  + `收敛完成后给出裁决，三选一：\n`
  + `  ARCH_FREEZE：接口面已收敛到可定稿，下游可以据此开工。冲突与未决接口仍可存在——`
  + `它们已经进了 conflicts / undecided 两个字段，是数据，不改变"这一格定了没有"。\n`
  + `  DIRECTION_BACKFLOW：收敛过程中发现方向级矛盾（例如某接口在给定形态下根本不存在），`
  + `必须回到 direction 重定，不得靠下折中值把矛盾摊平。\n`
  + `  D_GATE_PROPOSAL：接口面收敛了，但它改变了候选集的裁定范围，需要 dgate 重新裁定。\n`
  + `注意：这是"这一格能不能定稿"，不是"契约通过没通过"——那由 verifier 与检点者判。`,
  {label: 'architect', phase: 'Contract convergence', effort: 'high', schema: CONTRACT_SCHEMA})

// architect 的裁决在这里被消费。之前这里只认 INTEGRATION_OK，那是 integrator 的枚举——
// 换成 architect 的三个之后，如果不同步改这一行，条件对任何合法返回都为真，契约永远落不了盘。
const CONVERGENCE_ROUTE = {
  ARCH_FREEZE: {proceed: true},
  D_GATE_PROPOSAL: {proceed: true},
  DIRECTION_BACKFLOW: {proceed: false},
}
const convergenceRoute = merged ? CONVERGENCE_ROUTE[merged.verdict] : null

if (!merged || !convergenceRoute || !convergenceRoute.proceed) {
  return {
    stage: STAGE, runId: RUN_ID,
    verdict: merged ? merged.verdict : 'BLOCKED_CONFIG',
    merge: merged || null,
    reason: merged && merged.verdict === 'DIRECTION_BACKFLOW'
      ? '收敛发现方向级矛盾；交回 direction，不落盘'
      : '接口面未收敛成一份契约；不落盘',
    files: [],
  }
}

phase('Independent verification')

// verifier 只看已落盘的契约产物与接口名清单——刻意不给它申报原文。
// 给了它就能顺着专家的理由接受结论，独立验证就退化成复核。
const verified = await agent(
  `${head('verifier')}\n\n`
  + `契约产物（主循环已生成，只读）：${CONTRACT_ARTIFACT}\n`
  + `收敛后的接口面清单（只有接口名与单位，不含申报与收敛的推理过程）：\n`
  + `${JSON.stringify(merged.interfaces.map((i) => ({interfaceId: i.interfaceId, owner: i.owner, unit: i.unit, conserved: i.conserved})), null, 2)}\n\n`
  + `任务：独立验证这份契约。你**没有**申报原文与收敛过程，也不得索取——`
  + `验证依据只能是契约产物本身与仓库规格文件。逐项给出可复现的检查方式与裸值：\n`
  + `schema、单位一致、守恒（容量/带宽/credit/面积）、provenance（source commit / manifest hash / run_id）、`
  + `版本、profile 分离（MC320 与 MC640 不得合并成一份）。\n`
  + `不得修改被测数据来制造通过；不得以设计者自述为依据。\n`
  + `全部通过写 VERIFIED，任一项不通过写 VERIFY_FAILED。`,
  {label: 'verifier', phase: 'Independent verification', effort: 'high', schema: VERIFY_SCHEMA})

phase('Invariant check')

// 末步是检点，不是总结。verifier 与 invariant-checker 查的是两件事：
// verifier 查契约**本身**是否成立，invariant-checker 查它与全局不变量是否冲突
// （单一硬件规格、MC320/MC640 分离、peak≠sustained、单位、证据等级）。
// 两次调用必须分开：让验证者兼任检点，冲突会被它顺着自己的验证结论解释掉。
const check = await agent(
  `${head('invariant-checker')}\n\n`
  + `契约产物（只读）：${CONTRACT_ARTIFACT}\n`
  + `收敛后的接口面：\n${JSON.stringify(merged.interfaces, null, 2)}\n`
  + `verifier 的验证结论：\n${JSON.stringify(verified, null, 2)}\n\n`
  + `任务：对这份契约做全局不变量检点，逐条给出 pass/fail 与裸值：\n`
  + `7-reticle 面积守恒、单一硬件规格（ADR-0021）、MC320/MC640 分离、peak 与 sustained 分离、`
  + `单位一致、证据等级齐全。违规项必须给出违反的具体文件与字段。\n`
  + `不得把违规项解释掉（解释权归 architect）；不得以文档措辞为依据，只以数值和来源为依据。\n`
  + `全部通过写 INVARIANT_OK，任一不通过写 INVARIANT_VIOLATED。`,
  {label: 'invariant-checker', phase: 'Invariant check', effort: 'high', schema: CHECK_SCHEMA})

const okInvariants = check && check.verdict === 'INVARIANT_OK'
const okVerified = verified && verified.verdict === 'VERIFIED'

// 裁决枚举由 workflow 消费，不是写进报告给人看：verifier 与检点各自决定一个方向的放行。
const blocked = !okInvariants
  ? {verdict: 'INVARIANT_VIOLATED', violations: (check && check.violations) || ['检点未完成']}
  : (!okVerified
    ? {verdict: 'VERIFY_FAILED', violations: (verified && verified.checks.filter((c) => c.result !== 'met')) || ['独立验证未完成']}
    : null)

const ledgerPatch = {
  currentStage: STAGE,
  strategyVersions: {
    architect: '1.0', 'compute-expert': '1.0', 'memory-expert': '1.0',
    'comm-expert': '1.0', 'physical-expert': '1.0', 'software-expert': '1.0',
    verifier: '1.0', 'invariant-checker': '1.0',
  },
  // 契约阶段没有"被否候选"，被否的是接口：没归位的接口就是被排除的接口。
  // 不记下来，重跑会重新发明一遍同样的接口表，且无法解释两次跑为何不同。
  rejectedOptions: (merged.undecided || []).map((u) => ({
    stage: STAGE, optionId: u.interfaceId,
    reason: `${u.neededFrom}: ${u.missing}`, rejectedBy: 'architect',
  })),
  openBlockers: (merged.conflicts || []).map((c, i) => ({
    id: `CONFLICT-${STAGE.toUpperCase()}-${String(i + 1).padStart(2, '0')}`,
    owner: c.parties && c.parties.length ? c.parties[0] : 'architect',
    unblockCondition: c.resolution,
  })),
}

const runRecord = {
  schemaVersion: 'design-run-record-v0.1',
  stage: STAGE,
  runId: RUN_ID,
  sourceCommit: BRIEF.sourceCommit,
  contractArtifact: CONTRACT_ARTIFACT,
  contractCommand: CONTRACT_COMMAND_FOR_RECORD,
  // 接口面的指纹：接口 id 与单位排序后取哈希语义等价的规范化串，
  // 让"两次跑出来的接口面是否同一份"可复核，而不是靠人去比对。
  interfaceSet: declaredInterfaces.map((i) => `${i.interfaceId}|${i.unit}|${i.declaredBy}`).sort(),
  interfaceCount: declaredInterfaces.length,
  declarants: declarations.map((d) => d.from).sort(),
  caliber: '接口面为 PLANNING 口径；数值一律取自契约产物，workflow 不产生任何数字',
}

return {
  stage: STAGE,
  runId: RUN_ID,
  verdict: blocked ? blocked.verdict : 'VERIFIED',
  interfaces: blocked ? null : merged.interfaces,
  rejectedInterfaces: blocked ? null : (merged.undecided || []),
  conflicts: merged.conflicts || [],
  violations: blocked ? blocked.violations : [],
  verification: verified || null,
  ledgerPatch,
  runRecord,
  files: blocked ? [] : [
    {
      path: `${REPO}/out/contracts/${STAGE}_interfaces.json`,
      content: JSON.stringify({
        schemaVersion: 'design-contract-interfaces-v0.1',
        stage: STAGE, runId: RUN_ID, sourceCommit: BRIEF.sourceCommit,
        contractArtifact: CONTRACT_ARTIFACT,
        interfaces: merged.interfaces,
        undecided: merged.undecided || [],
        conflicts: merged.conflicts || [],
      }, null, 2) + '\n',
    },
    {
      path: `${REPO}/out/contracts/${STAGE}_run_record.json`,
      content: JSON.stringify(runRecord, null, 2) + '\n',
    },
  ],
}
