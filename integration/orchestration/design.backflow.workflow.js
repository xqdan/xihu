export const meta = {
  name: 'design-backflow',
  description: 'K3 设计 backflow 阶段（E 组）：把 detail.integrate 的 delta 归因变成方向级回流——integrator 归纳→被归因专家逐条认领→architect 判该不该回流→framing-critic 检回流框定是否成立；产物落 out/governance/',
  whenToUse: 'E 组。需要 args.brief（stage=backflow）与 args.attribution（detail.integrate 的 delta 归因产物路径或对象）。attribution 为空时本格无事可做，直接返回 nextActions 而不是假装跑一轮。',
  phases: [
    { title: 'Attribution triage', detail: 'integrator 把 delta 归因归纳成可追责的条目；无归因即无回流' },
    { title: 'Expert claim', detail: '被归因专家逐条认领，1–3 个实例，只认属于自己的条目' },
    { title: 'Direction ruling', detail: 'architect 判该不该动方向；动方向必须有方向级理由' },
    { title: 'Framing check', detail: 'framing-critic 检回流框定本身是否成立，可整体否决' },
  ],
}

// ---------------------------------------------------------------------------
// E 组 backflow。这一格接替 generate_direction_feedback.js 的"Stage B -> Stage A 回流"职能，
// 但两者不是同一件事，区别要写清楚：
//
//   * generate_direction_feedback.js 是**确定性的**：它从五份落盘产物里读出门控 blocker
//     与每模型最佳规划估计，算 gapFactor。那些数字是脚本算的，不是 agent 说的。
//   * design.backflow 是**判断性的**：它回答的是"这次细化的结果，动摇了哪条方向级假设"。
//     这个问题没有公式——它要求理解为什么某个细化结论会让 Stage A 的某条选择站不住。
//
// 因此本格不产出任何 gapFactor、不产出任何 TPS 数字，也不改写 direction_feedback.json。
// 它产出的是**方向级回流提案**，由人决定是否据此重跑 Stage A。
// 把判断和计算混在一格里，两边都会退化。
//
// 触发条件来自上游：design.detail.integrate 的 DELTA_UNEXPLAINED，
// 或 design.verify 的 architect 判 DIRECTION_BACKFLOW。两者都指向同一个问题——
// "细化结果与方向级预期对不上"。对不上有两种可能：
//   (a) 方向选错了 —— 要回流；
//   (b) 细化本身错了 —— 该回 detail，不该动方向。
// 本格的职责就是分清这两种，并且**允许结论是"不用回流"**。
// 一个只会说"要回流"的回流器，会把每个细化瑕疵都升级成方向重做。
//
// 四条硬边界的落点：
//   边界 1：输出契约由本文件注入，策略正文里没有。
//   边界 2：路径只出现在本文件里。
//   边界 3：integrator / 专家 / architect / framing-critic 的裁决枚举在此消费。
//   边界 4：本格不产生决定性数字，门控结论仍只由 evaluate_gates.js 计算。
// ---------------------------------------------------------------------------

const REPO = args.repo || '.'
const STAGE = 'backflow'
const BRIEF = args.brief
const RUN_ID = args.runId || 'backflow-run'
const ATTRIBUTION = args.attribution
const FEEDBACK_ARTIFACT = args.feedbackArtifact
    || `${REPO}/out/governance/direction_feedback.json`
const INTEGRATE_ARTIFACT = args.integrateArtifact
    || `${REPO}/out/detailed/detail_integrate.json`
const VERIFY_REPORT = args.verifyReport
    || `${REPO}/out/verification/verify_report.json`

if (!BRIEF) throw new Error('design.backflow 需要 args.brief（stage=backflow 的 DesignBrief）')
if (BRIEF.stage !== STAGE) {
  throw new Error(`brief.stage=${BRIEF.stage}，与 design.backflow 不符；契约串了`)
}

// ---------------------------------------------------------------------------
// 无事可做是合法结论。
//
// 回流不是常态，是例外。没有归因说明细化结果与方向级预期一致，那就不该有回流。
// 这里显式早退，而不是让四个实例在没有输入的情况下各写一段"无需回流"的文字——
// 那种产物看起来像一次完整评估，实际上什么也没评估，还会在 ledger 里留下虚假的覆盖。
// ---------------------------------------------------------------------------
if (!ATTRIBUTION || (typeof ATTRIBUTION === 'object' && !Object.keys(ATTRIBUTION).length)) {
  return {
    stage: STAGE,
    runId: RUN_ID,
    verdict: 'DIRECTION_BACKFLOW_NOOP',
    reason: '没有 delta 归因输入，没有可回流的条目；无事可做比空跑一轮更诚实',
    nextActions: [
      `确认 ${INTEGRATE_ARTIFACT} 已落盘且带有 delta 归因；归因为空说明细化和方向一致，本格不需要运行`,
    ],
    files: [],
  }
}

const ATTRIBUTION_JSON = typeof ATTRIBUTION === 'string'
  ? `见落盘产物 ${ATTRIBUTION}（workflow 读不了文件，以下是主循环传入的定位；请自行读取该路径）`
  : JSON.stringify(ATTRIBUTION, null, 2)

// ---------------------------------------------------------------------------
// 归因条目的规范化。
//
// 上游 detail.integrate 的归因条目字段名在本仓里已存在（见 B4 的 delta 归因），
// 这里只做**读取容忍**，不重命名、不补默认值：缺字段就是缺字段，
// 静默补一个 "unknown" 会让"这条归因没写清归谁"变成一个看起来正常的条目。
// ---------------------------------------------------------------------------
const attrItems = Array.isArray(ATTRIBUTION)
  ? ATTRIBUTION
  : (Array.isArray(ATTRIBUTION.items) ? ATTRIBUTION.items : [])

if (!attrItems.length && typeof ATTRIBUTION === 'object' && ATTRIBUTION.items) {
  throw new Error('attribution.items 是空数组；空归因与无归因同义，应由主循环早退而不是走到这里')
}

// 每个专家实例只处理归因给自己的条目。归因给别的专家的条目**不注入**，
// 否则一个专家会顺手评论别人的领域——那正是"旁证"和"认领"的区别所在。
const KNOWN_EXPERTS = [
  'compute-expert', 'memory-expert', 'comm-expert',
  'software-expert', 'physical-expert', 'model-expert',
]

const byOwner = {}
for (const it of attrItems) {
  const owner = it.owner || it.attributedTo || it.expertId
  if (!KNOWN_EXPERTS.includes(owner)) continue
  ;(byOwner[owner] = byOwner[owner] || []).push(it)
}

const owners = Object.keys(byOwner).sort()
const cappedOwners = owners.slice(0, 3)
const droppedOwners = owners.slice(3)

const HEAD = [
  `仓库根目录：${REPO}`,
  `本 workflow：design.backflow（stage=${STAGE}，runId=${RUN_ID}）`,
  `你是一个策略实例。先读你的策略正文：${REPO}/teams/council/strategies/__AGENT__.md`,
  '那份文件是本角色的判断规则、判据、证据规则、取舍规则与禁止事项，逐条遵守。',
  '以下运行时上下文由 workflow 注入；注入内容与策略正文冲突时，注入内容优先（它承载本 stage 的事实）。',
  '你没有文件系统写权限。把该写的东西作为返回值交回，由 workflow 落盘。',
  '所有数字必须带出处（文件路径:行号 或 ADR 编号）；没有出处的写 UNVERIFIED 并说明缺什么。',
  '不得输出 TPS/usr 或任何全局性能指标。',
  '',
  '**回流是一条很贵的路**：它意味着 Stage A 的选择要重做，已经落盘的细化产物要重跑。',
  '因此举证责任在"要回流"这一边：说不出被动摇的是哪条方向级假设，就不该走这条路。',
].join('\n')

const head = (agentId) => HEAD.replace('__AGENT__', agentId)

const BRIEF_JSON = JSON.stringify(BRIEF, null, 2)

// integrator 的归纳。它把归因条目变成"可追责、可否定"的回流候选。
const TRIAGE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['candidates', 'notDirectionLevel', 'verdict'],
  properties: {
    candidates: {
      type: 'array',
      description: '够得上方向级的回流候选；够不上的放 notDirectionLevel',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['id', 'shakenAssumption', 'evidence', 'owner', 'whyDirectionLevel'],
        properties: {
          id: { type: 'string', description: '本条候选的标识' },
          shakenAssumption: { type: 'string', description: '被摇动的是哪条**方向级**假设；写不出具体假设的候选不该出现在这里' },
          evidence: { type: 'string', description: '出处：文件路径:行号 或字段路径' },
          owner: { type: 'string', description: '该由哪个专家认领' },
          whyDirectionLevel: { type: 'string', description: '为什么这是方向级而不是细化级；这是本格最需要说服别人的一句话' },
        },
      },
    },
    notDirectionLevel: {
      type: 'array',
      description: '看起来像回流、实际只是细化瑕疵的条目；这份清单和 candidates 一样重要',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['id', 'reason', 'goesBackTo'],
        properties: {
          id: { type: 'string' },
          reason: { type: 'string', description: '为什么它够不上方向级' },
          goesBackTo: { type: 'string', description: '它该回哪一格处理' },
        },
      },
    },
    verdict: { type: 'string', enum: ['INTEGRATION_OK', 'DELTA_UNEXPLAINED'] },
  },
}

// 专家认领。只认自己的条目，可以拒认。
const CLAIM_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['expertId', 'claims', 'verdict'],
  properties: {
    expertId: { type: 'string', description: '就是你自己的 agentId' },
    claims: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['candidateId', 'accepted', 'reason', 'directionImpact', 'localFix'],
        properties: {
          candidateId: { type: 'string' },
          accepted: { type: 'boolean', description: '这条归因是否成立；不成立也必须给理由' },
          reason: { type: 'string', description: '认领或拒认的理由，带出处' },
          directionImpact: { type: 'string', description: '成立时：动的是哪条方向级假设；不成立写 none' },
          localFix: { type: 'string', description: '如果其实只需本域局部修正，写清修什么；这决定了它是不是真的该回流' },
        },
      },
    },
    verdict: { type: 'string', enum: ['LOCAL_DETAIL_FIX', 'DIRECTION_BACKFLOW', 'PPA_DIRECTION_BACKFLOW', 'BLOCKED_CONFIG'] },
  },
}

// architect 的方向裁决。它可以判"不回流"。
const RULING_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['ruling', 'acceptedCandidates', 'rejectedCandidates', 'reworkScope', 'verdict'],
  properties: {
    ruling: { type: 'string', description: '一句话结论：动不动方向，动哪条' },
    acceptedCandidates: {
      type: 'array',
      description: '被接受为方向级的候选',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['candidateId', 'assumption', 'reworkFrom'],
        properties: {
          candidateId: { type: 'string' },
          assumption: { type: 'string', description: '要重做的那条假设' },
          reworkFrom: { type: 'string', description: '从哪一格开始重做：direction / dgate / compute / memory / comm / physical' },
        },
      },
    },
    rejectedCandidates: {
      type: 'array',
      description: '被拒的候选及其去处；不得静默丢弃',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['candidateId', 'reason', 'reroutedTo'],
        properties: {
          candidateId: { type: 'string' },
          reason: { type: 'string' },
          reroutedTo: { type: 'string', description: '改由哪一格处理' },
        },
      },
    },
    reworkScope: {
      type: 'object',
      additionalProperties: false,
      required: ['stages', 'estimatedCost'],
      properties: {
        stages: { type: 'array', items: { type: 'string' } },
        estimatedCost: { type: 'string', description: '重做范围的定性描述（如"重跑 direction + 四域"）；不得给工时或 TPS 数字' },
      },
    },
    verdict: { type: 'string', enum: ['D_GATE_PROPOSAL', 'DIRECTION_BACKFLOW', 'ARCH_FREEZE'] },
  },
}

// framing-critic 检的是**回流框定**，不是回流结论。
const FRAMING_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['framingOk', 'issues', 'verdict'],
  properties: {
    framingOk: { type: 'boolean' },
    issues: {
      type: 'array',
      description: '框定层面的问题：归因范围太窄、把细化瑕疵当方向问题、重做范围过大或过小',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['issue', 'evidence', 'severity'],
        properties: {
          issue: { type: 'string' },
          evidence: { type: 'string' },
          severity: { type: 'string', enum: ['blocking', 'noted'] },
        },
      },
    },
    verdict: { type: 'string', enum: ['FRAMING_OK', 'FRAMING_INSUFFICIENT'] },
  },
}

phase('Attribution triage')

const triage = await agent(
  `${head('integrator')}\n\n`
  + `brief：\n${BRIEF_JSON}\n\n`
  + `delta 归因输入：\n${ATTRIBUTION_JSON}\n\n`
  + `可参考的落盘产物（只读）：\n`
  + `  ${INTEGRATE_ARTIFACT}\n  ${FEEDBACK_ARTIFACT}\n  ${VERIFY_REPORT}\n\n`
  + `任务：把归因条目归纳成回流候选。规则：\n`
  + `1. 每个候选必须写清**被动摇的是哪条方向级假设**。写不出具体假设的，`
  + `   它不是方向级问题——放进 notDirectionLevel，并说明它该回哪一格。\n`
  + `2. notDirectionLevel 与 candidates 同等重要。回流器最常见的失效不是漏掉问题，`
  + `   而是把所有细化瑕疵都升级成方向重做——那样每轮细化都会触发一次 Stage A。\n`
  + `3. 每个候选给出 owner（该由哪个专家认领）。\n`
  + `4. 归因只能追到"某条结论与方向级预期对不上"，追不到"哪个模块的实现细节错了"——`
  + `   后者本格不处理。\n`
  + `5. 若全部条目都够不上方向级，判 INTEGRATION_OK。这是合法且常见的结论。`,
  {label: 'integrator:triage', phase: 'Attribution triage', effort: 'high', schema: TRIAGE_SCHEMA})

if (!triage) {
  return {
    stage: STAGE, runId: RUN_ID, verdict: 'BLOCKED_CONFIG',
    reason: 'integrator 归纳未产出；没有可消费的候选，本格不落盘',
    nextActions: ['重跑 design.backflow 的归因归纳阶段'],
    files: [],
  }
}

const candidates = triage.candidates || []

// 全部够不上方向级 → 本格到此为止，不产回流提案。
// 这一条分支是刻意放在专家之前的：让专家先认领一遍再判"其实不用回流"，
// 会让每个专家都为一件不会发生的事写一份材料。
if (triage.verdict === 'INTEGRATION_OK' || !candidates.length) {
  return {
    stage: STAGE,
    runId: RUN_ID,
    verdict: 'INTEGRATION_OK',
    reason: '归因条目全部够不上方向级；回流不成立，细化结果与方向一致',
    notDirectionLevel: triage.notDirectionLevel || [],
    nextActions: (triage.notDirectionLevel || []).map(
      (n) => `${n.id} 回 ${n.goesBackTo} 处理：${n.reason}`),
    files: [],
  }
}

phase('Expert claim')

// 只把属于自己的候选发给对应专家。上限 3 个是计划 §4.2 的约束（"被归因专家×1–3"）；
// 超出的部分显式记录，不静默吞掉。
if (droppedOwners.length) {
  log(`design.backflow 本轮的专家实例上限为 3；以下归因主体未获实例，其条目已记录在 run record：${droppedOwners.join(', ')}`)
}

const claims = (await parallel(cappedOwners.map((owner) => () => agent(
  `${head(owner)}\n\n`
  + `brief：\n${BRIEF_JSON}\n\n`
  + `归因给你（${owner}）的条目：\n${JSON.stringify(byOwner[owner], null, 2)}\n\n`
  + `回流的整体框定（只读，供你判断自己的条目在其中的位置）：\n`
  + `  候选：${JSON.stringify(candidates.map((c) => ({id: c.id, shakenAssumption: c.shakenAssumption})), null, 2)}\n`
  + `  够不上方向级的条目：${JSON.stringify(triage.notDirectionLevel || [], null, 2)}\n\n`
  + `任务：逐条认领或拒认归因给你的条目。规则：\n`
  + `1. 归因可能**不成立**。它是从 delta 反推出来的，反推会错。`
  + `   拒认要给理由与出处，不得含糊带过。\n`
  + `2. 认领一条，必须同时写清 directionImpact：动的究竟是哪条方向级假设。\n`
  + `3. **localFix 比 directionImpact 更常需要填**。如果这条其实只需本域局部修正，`
  + `   写清修什么——这直接把一条贵重的方向回流降级成一次局部返工。`
  + `   一个只会往上报的专家，等于没有把关。\n`
  + `4. 如果你认领的条目全部只够局部修正，判 LOCAL_DETAIL_FIX；`
  + `   确实动摇了方向级假设才判 DIRECTION_BACKFLOW；`
  + `   若问题在物理/PPA 方向则用 PPA_DIRECTION_BACKFLOW。\n`
  + `5. 缺少必要输入导致无法判断时判 BLOCKED_CONFIG 并写明缺什么。`,
  {label: `claim:${owner}`, phase: 'Expert claim', effort: 'high', schema: CLAIM_SCHEMA})
))).filter(Boolean)

if (claims.length < cappedOwners.length) {
  const absent = cappedOwners.filter((o) => !claims.some((c) => c.expertId === o))
  return {
    stage: STAGE, runId: RUN_ID, verdict: 'BLOCKED_CONFIG',
    reason: `专家认领不完整，缺：${absent.join(', ')}；归因没有全部被认领，回流提案不成立，不落盘`,
    nextActions: absent.map((o) => `补齐 ${o} 的认领后重跑本格`),
    files: [],
  }
}

// 脚本侧汇总裁决。这里不做判断——只把专家用过的枚举归集，
// 供 architect 在下一阶段作为**输入**而非结论使用。
const expertVerdicts = {}
for (const c of claims) expertVerdicts[c.verdict] = (expertVerdicts[c.verdict] || 0) + 1
const anyDirectionLevel = claims.some((c) => c.verdict === 'DIRECTION_BACKFLOW' || c.verdict === 'PPA_DIRECTION_BACKFLOW')
const blockedConfigs = claims.filter((c) => c.verdict === 'BLOCKED_CONFIG')

phase('Direction ruling')

const ruling = await agent(
  `${head('architect')}\n\n`
  + `brief：\n${BRIEF_JSON}\n\n`
  + `归因归纳：\n${JSON.stringify(triage, null, 2)}\n\n`
  + `专家认领：\n${JSON.stringify(claims, null, 2)}\n\n`
  + `可参考的落盘产物（只读）：\n  ${INTEGRATE_ARTIFACT}\n  ${FEEDBACK_ARTIFACT}\n\n`
  + `任务：裁决该不该动方向。规则：\n`
  + `1. 你可以判 **不回流**。这是本格存在的意义之一：`
  + `   专家认领了一条问题，不等于方向错了——它可能只需要一次局部返工。\n`
  + `2. 接受某条候选为方向级时，必须写出要重做的**那条假设**与从哪一格重做。\n`
  + `3. 拒绝某条候选时，写明它改由哪一格处理。**不得静默丢弃**：`
  + `   被拒的条目也要落盘，否则下一轮会重新发现同一个问题。\n`
  + `4. reworkScope 只做定性描述，不得给工时、TPS 或其他决定性数字。\n`
  + `5. 判 DIRECTION_BACKFLOW 时，acceptedCandidates 不得为空，`
  + `   且 reworkScope.stages 必须非空——"要回流但不知道重做什么"不是结论。\n`
  + `6. 涉及物理/PPA 方向的重做，在 ruling 里点明；PPA 方向回流与功能方向回流的重做范围不同。`,
  {label: 'architect:ruling', phase: 'Direction ruling', effort: 'high', schema: RULING_SCHEMA})

const okRuling = !!ruling && (
  ruling.verdict !== 'DIRECTION_BACKFLOW'
  || ((ruling.acceptedCandidates || []).length > 0
      && ruling.reworkScope && (ruling.reworkScope.stages || []).length > 0)
)

phase('Framing check')

// framing-critic 检的是**框定**：这次回流问的问题对不对、范围划得对不对。
// 它拿得到结论，但它的职责不是同意或否决某条候选，
// 而是发现"整件事被框错了"——比如把一次局部返工包装成了方向重做。
const framing = await agent(
  `${head('framing-critic')}\n\n`
  + `brief：\n${BRIEF_JSON}\n\n`
  + `归因归纳：\n${JSON.stringify(triage, null, 2)}\n\n`
  + `专家认领：\n${JSON.stringify(claims, null, 2)}\n\n`
  + `架构师裁决：\n${JSON.stringify(ruling, null, 2)}\n\n`
  + `任务：就**回流的框定本身**做批判。规则：\n`
  + `1. 你要问的是：这个回流问的问题对吗？范围合适吗？\n`
  + `   - 归因是不是只看见了最容易看见的那条，漏掉了真正动摇方向的？\n`
  + `   - 重做范围是不是过大（把一次局部返工升格成方向重做，代价远超收益）？\n`
  + `   - 是不是过小（真正的方向级问题被降级成本地修补，会在下一轮以更大的形态回来）？\n`
  + `2. 归因链的每一环都要有出处；推不出来的环节就是断链，断链要报。\n`
  + `3. severity 为 blocking 的问题必须是真的挡住结论的；`
  + `   只是可以更好的记为 noted，不要用 blocking 来表达偏好。\n`
  + `4. 框定成立写 FRAMING_OK；框定不成立、结论不该按现在这个形状落地，写 FRAMING_INSUFFICIENT。\n`
  + `你的否决是否决**这次框定**，不是否决某条技术判断。`,
  {label: 'framing-critic', phase: 'Framing check', effort: 'high', schema: FRAMING_SCHEMA})

const framingBlocking = !!framing && (framing.issues || []).some((i) => i.severity === 'blocking')
const okFraming = !!framing && framing.verdict === 'FRAMING_OK' && !framingBlocking

const ok = okRuling && okFraming && blockedConfigs.length === 0

// 落盘的门槛与 design.verify 一致：结论不自相矛盾才写。
// 一份"要回流但说不出重做什么"或"框定被否决却照样落地"的提案，
// 会在下游被当成有效输入——那比不落盘危险得多。
const contradictions = []
if (ruling && ruling.verdict === 'DIRECTION_BACKFLOW' && !okRuling) {
  contradictions.push('判回流但未给出要重做的假设或重做范围')
}
if (framing && framing.verdict === 'FRAMING_INSUFFICIENT' && ruling && ruling.verdict === 'DIRECTION_BACKFLOW') {
  contradictions.push('框定被判不成立，回流结论不得按现形状落地')
}
if (blockedConfigs.length) {
  contradictions.push(`有 ${blockedConfigs.length} 个专家因缺输入判 BLOCKED_CONFIG（${blockedConfigs.map((c) => c.expertId).join(', ')}）；归因未闭合，不得产出回流提案`)
}
if (claims.every((c) => c.verdict === 'LOCAL_DETAIL_FIX') && ruling && ruling.verdict === 'DIRECTION_BACKFLOW') {
  contradictions.push('全部专家判局部修正，architect 却判方向回流；专家与裁决对不上，需人工确认')
}

const localFixes = claims.flatMap((c) => (c.claims || [])
  .filter((x) => x.accepted && x.localFix && x.localFix !== 'none')
  .map((x) => ({expertId: c.expertId, candidateId: x.candidateId, localFix: x.localFix})))

const ledgerPatch = {
  currentStage: STAGE,
  strategyVersions: {integrator: '1.0', architect: '1.0', 'framing-critic': '1.0'},
  rejectedOptions: (ruling ? (ruling.rejectedCandidates || []) : []).map((r) => ({
    stage: STAGE, optionId: r.candidateId, reason: r.reason, rejectedBy: 'architect',
  })),
  openBlockers: [
    ...(triage.notDirectionLevel || []).map((n, i) => ({
      id: `BACKFLOW-LOCAL-${String(i + 1).padStart(2, '0')}`,
      owner: 'integrator',
      unblockCondition: `${n.id} 改由 ${n.goesBackTo} 处理：${n.reason}`,
    })),
    ...localFixes.map((f, i) => ({
      id: `BACKFLOW-FIX-${String(i + 1).padStart(2, '0')}`,
      owner: f.expertId,
      unblockCondition: `局部修正 ${f.candidateId}：${f.localFix}`,
    })),
    ...((framing && framing.issues) || []).filter((i) => i.severity === 'blocking').map((i, n) => ({
      id: `BACKFLOW-FRAMING-${String(n + 1).padStart(2, '0')}`,
      owner: 'framing-critic',
      unblockCondition: i.issue,
    })),
  ],
}

const runRecord = {
  schemaVersion: 'design-run-record-v0.1',
  stage: STAGE,
  runId: RUN_ID,
  sourceCommit: BRIEF.sourceCommit,
  attributionSource: typeof ATTRIBUTION === 'string' ? ATTRIBUTION : 'inline-object',
  feedbackArtifact: FEEDBACK_ARTIFACT,
  expertInstances: cappedOwners,
  expertsWithoutInstance: droppedOwners,
  candidateCount: candidates.length,
  notDirectionLevelCount: (triage.notDirectionLevel || []).length,
  expertVerdicts,
  anyDirectionLevel,
  strategyVersions: {'integrator': '1.0', architect: '1.0', 'framing-critic': '1.0'},
  caliber: '本格产出的是方向级回流**提案**，不含任何决定性数字；gapFactor 与每模型规划估计由 integration/pipelines/generate_direction_feedback.js 从落盘产物确定性算出，本格不产出也不改写它',
}

return {
  stage: STAGE,
  runId: RUN_ID,
  verdict: ok ? ruling.verdict : 'BLOCKED_CONFIG',
  reason: ok ? ruling.ruling : contradictions.join('；'),
  triage,
  claims,
  ruling: ruling || null,
  framing: framing || null,
  localFixes,
  notDirectionLevel: triage.notDirectionLevel || [],
  contradictions,
  ledgerPatch,
  runRecord,
  nextActions: ok ? [
    ...(ruling.verdict === 'DIRECTION_BACKFLOW'
      ? [`按 reworkScope 重跑：${(ruling.reworkScope.stages || []).join(' → ')}`]
      : ['回流不成立，本格无后续动作']),
  ] : [
    ...contradictions,
    ...(okFraming ? [] : ['处理 framing-critic 的 blocking 问题后重跑本格']),
  ],
  files: ok ? [
    {
      path: `${REPO}/out/governance/${STAGE}_proposal.json`,
      content: JSON.stringify({
        schemaVersion: 'architecture-backflow-proposal-v0.1',
        stage: STAGE, runId: RUN_ID, sourceCommit: BRIEF.sourceCommit,
        verdict: ruling.verdict,
        ruling: ruling.ruling,
        acceptedCandidates: ruling.acceptedCandidates,
        rejectedCandidates: ruling.rejectedCandidates,
        reworkScope: ruling.reworkScope,
        notDirectionLevel: triage.notDirectionLevel,
        localFixes,
        framingVerdict: framing.verdict,
        expertVerdicts,
        // 这是**提案**，不是门控结论，也不是 direction_feedback.json 的替代品。
        // 后者由 generate_direction_feedback.js 确定性生成，本文件不改写它。
        isGateConclusion: false,
        supersedesDirectionFeedback: false,
        note: '方向级回流提案；是否据此重跑 Stage A 由人决定。gapFactor 与每模型规划估计见 direction_feedback.json（脚本生成）',
      }, null, 2) + '\n',
    },
    {
      path: `${REPO}/out/governance/${STAGE}_run_record.json`,
      content: JSON.stringify(runRecord, null, 2) + '\n',
    },
  ] : [],
}
