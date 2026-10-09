export const meta = {
  name: 'design-coupling',
  description: 'K3 设计 L3 跨域联合：五个域 winner 合成后联合回放，耦合两侧的域专家审行，integrator 取 Pareto 点，invariant-checker 检点后落盘唯一全局设计点',
  whenToUse: '五个 C 组域（compute / sram / mc / comm / physical）都已落盘 winner 之后。需要 args.brief（make_brief.js coupling 派生的 DesignBrief）、args.searchArtifact（主循环已生成好的联合候选产物路径，仅作记录）与 args.searchBrief（search_brief.js brief coupling 核验过的候选集）。本 workflow 不执行回放、不写文件。',
  phases: [
    { title: 'Joint replay', detail: '由 coupling_search.js 合成五个 winner 并在三条耦合的小网格上联合回放，由 search_brief.js 读取核验；workflow 内没有 agent 参与取数。没有可行行即回流 L1-b' },
    { title: 'Coupling review', detail: '每条耦合两侧的域专家（compute / memory-expert 的 SRAM 席与 MC 席 / comm / physical）审本域字段被改动的行' },
    { title: 'Merge', detail: 'integrator 在可行的 Pareto 行里取联合点，登记被否组合；脚本核对它是候选产物的原行' },
    { title: 'Invariant check', detail: 'invariant-checker 强制检点；不通过则不落盘' },
  ],
}

// ---------------------------------------------------------------------------
// L3 design.coupling（doc 23 第 4 节）。五个域各自选 winner 时，其他域都钉在发布点上，
// 五个 winner 从没有一起回放过。本 workflow 回答两个问题：放在一起合同还成立吗；
// 沿耦合维度有没有比"各域自己的最好"更好的组合。
//
// 与 C 组五域骨架的区别：
//
// 1. 没有搜索策略这一步。耦合网格是设计空间文件（teams/hardware/inputs/coupling_design_space.json）
//    定死的三条：SRAM 窗口 × 预取深度 × MC 带宽；τ × commOverlap × 向量 lanes；
//    SRAM ↔ 矩阵 ↔ Reduce/TMA/RDMA 的面积再分配（复用 die_area_reallocation.js 的 MOVES）。
//    网格很小，全部回放，没有需要专家收窄的维度。
//
// 2. 旁证换成"耦合两侧的域专家"。每一行相对合成点改了哪些字段、按所属域分好（departsFrom），
//    每个域专家只对本域字段被改动的行说接不接得住。
//
// 3. 合并之后先做一次机械核对：integrator 交回的联合点必须是候选集里可行且在 Pareto 集上的一行，
//    values 逐字等于产物行。这一步不交给检点者——它是字符串比对，不需要判断。
//
// 4. 没有任何可行行时不合并，按 doc 23 第 6 节回流 L1-b（design.req.budget），
//    带上缺口与各域的最好点；那份回流内容是产物自带的，workflow 原样转交。
//
// 落盘的是 out/coupling/joint_point.json：L4 / L5 读的唯一全局设计点 x。
// ---------------------------------------------------------------------------

const REPO = args.repo || '.'
const STAGE = 'coupling'
const BRIEF = args.brief
const RUN_ID = args.runId || 'coupling-run'
const MAX_CANDIDATES = args.maxCandidates || 12
// 联合候选产物由**主循环**在调用本 workflow 之前产生（npm run coupling:search），路径经 args 传入；
// 理由与 C 组相同：回放脚本会写 out/，workflow agent 全程只读。
const SEARCH_ARTIFACT = args.searchArtifact
const SEARCH_COMMAND_FOR_RECORD = args.searchCommand || 'UNVERIFIED'
// 已核验的候选集（search_brief.js brief coupling 的输出）；workflow 不自己读产物，也不让 agent 转写数值。
const SEARCH_BRIEF = args.searchBrief

if (!BRIEF) throw new Error('design.coupling 需要 args.brief（node integration/pipelines/make_brief.js coupling 派生的 DesignBrief）')
if (!SEARCH_ARTIFACT) {
  throw new Error('design.coupling 需要 args.searchArtifact（已由主循环生成好的联合候选产物路径）；本 workflow 不执行回放')
}
if (!SEARCH_BRIEF) {
  throw new Error('design.coupling 需要 args.searchBrief（主循环用 node integration/pipelines/search_brief.js brief coupling 生成）；本 workflow 不读候选产物')
}
if (BRIEF.stage !== 'coupling') {
  // brief 的 stage 与 workflow 名称必须一致，否则会把别的阶段的契约拿来用
  throw new Error(`brief.stage=${BRIEF.stage}，与 design.coupling 不符；契约串了`)
}

const HEAD = [
  `仓库根目录：${REPO}`,
  `本 workflow：design.coupling（stage=${STAGE}，runId=${RUN_ID}）`,
  `你是一个策略实例。先读你的策略正文：${REPO}/teams/council/strategies/__AGENT__.md`,
  '那份文件是本角色的判断规则、正确性判据、证据规则、取舍规则与禁止事项，逐条遵守。',
  '以下运行时上下文由 workflow 注入；注入内容与策略正文冲突时，注入内容优先（它承载本 stage 的事实）。',
  '你没有文件系统写权限。把该写的东西作为返回值交回，由 workflow 落盘。',
  '所有数字必须带出处（文件路径:行号 或 ADR 编号）；没有出处的写 UNVERIFIED 并说明缺什么，不得静默补齐。',
  '不得输出 PASS / D_GATE_PASSED 字面量。',
].join('\n')
const head = (agentId) => HEAD.replace('__AGENT__', agentId)

// 耦合两侧的席位。每一席说的是哪个域、坐在哪几条耦合上——与设计空间文件
// couplings.*.seats 一致（tests/regression/test_coupling_workflow_behavior.js 核对，改一边另一边会报）。
// memory-expert 同时是 sram 与 mc 两个域的主策略，所以分两席记名，缺席时才说得清缺的是哪一侧。
const SEATS = [
  { seat: 'compute-expert', agent: 'compute-expert', domain: 'compute', couplings: ['tauOverlapCompute', 'areaReallocation'],
    speaksFor: 'AI Core：向量 lanes、矩阵形态（hRows / hEngines / lCols）改动后，compute winner 自己的 H-core kernel 是否仍隐藏向量时间，B-SERIAL-CMP 一侧是否接得住' },
  { seat: 'memory-expert/sram', agent: 'memory-expert', domain: 'sram', couplings: ['sramDepthMc', 'areaReallocation'],
    speaksFor: '片上 SRAM/TMA：Shared 窗口、预取深度、L/H Local bank、Shared slice、TMA 引擎改动后 B-SRAM-CAP 是否成立、tile 是否放得下' },
  { seat: 'memory-expert/mc', agent: 'memory-expert', domain: 'mc', couplings: ['sramDepthMc'],
    speaksFor: 'MC：链路带宽改动后 B-MEM-BW 的持续 payload 口径是否成立；不得用 MC640 数字冒充可制造默认值' },
  { seat: 'comm-expert', agent: 'comm-expert', domain: 'comm', couplings: ['tauOverlapCompute', 'areaReallocation'],
    speaksFor: 'Comm Core：commOverlap、Reduce lanes、RDMA lanes 改动后最慢集合通信是否仍在 B-TAU 上限内；τ 按上限回放，τ 扫描只是灵敏度' },
  { seat: 'physical-expert', agent: 'physical-expert', domain: 'physical', couplings: ['areaReallocation'],
    speaksFor: '物理实现：面积在 SRAM / 矩阵 / IO 之间挪动后，die 面积与功耗、整卡功耗、封装放置窗口与 PHY 岸线是否仍在 B-AREA 与 physical winner 的预留之内' },
]

const BRIEF_JSON = JSON.stringify(BRIEF, null, 2)

// 与 C 组五域同一形状的约束契约：一条约束在各 stage 之间传递时不需要翻译。
const CONSTRAINT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['from', 'constraints', 'verdict'],
  properties: {
    from: { type: 'string', description: '给出约束的席位（agentId 或 agentId/席位）' },
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
            description: '它否掉哪个 optionId、哪种取值，或哪一类行；必须具体到能被机械核对',
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

phase('Joint replay')

// 第一步（确定性，没有 agent）：合成与联合回放都在 coupling_search.js 里，读取与指纹核对
// （设计空间哈希 + 重跑回放）在 search_brief.js 里，workflow 只消费结果。
const search = { ...SEARCH_BRIEF, candidates: SEARCH_BRIEF.candidates || [] }

if (!search.ok) {
  return {
    stage: STAGE,
    runId: RUN_ID,
    verdict: 'BLOCKED_CONFIG',
    reason: `联合候选产物不可用：${search.notes || '缺失、不可解析，或不含候选明细'}；不以估算代替`,
    searchNode: search,
    files: [],
  }
}

// 五个 winner 合成的点是参照：它自己不可行不是事故，是本 stage 要回答的问题。
const composed = (search.composition && search.composition.composed) || null
if (composed) {
  log(`合成点：TPS/usr ${composed.tpsPerUser}，die ${composed.dieAreaMm2} mm2；${(composed.violations || []).join(', ') || '可行'}`)
}

// 没有任何可行行：回流 L1-b（doc 23 第 6 节）。回流内容（缺口、最接近的行、各域最好点）是产物自带的，
// 原样转交；不在本 stage 选一个最不坏的当联合点。
if (!search.candidates.length || search.feasibleCandidates === 0) {
  log('联合回放没有可行行；回流 L1-b，不硬凑联合点')
  return {
    stage: STAGE,
    runId: RUN_ID,
    verdict: 'DIRECTION_BACKFLOW',
    routeTo: 'design.req.budget',
    reason: `五个 winner 合成后联合回放没有可行行（可行 ${search.feasibleCandidates} / 共 ${search.totalCandidates}）；合同在联合点上不成立，回到 L1-b 重新拆分`,
    backflow: search.backflow || null,
    infeasibleByCause: search.infeasibleByCause || null,
    composition: search.composition || null,
    nextActions: [
      '把 backflow 里的缺口与各域最好点交给 design.req.budget，按 infeasibleByCause 判断是哪一条合同条目需要重新拆分',
      '新的合同落盘后，五个域与本 stage 依次重跑；不得在本 stage 放宽任何条目取得联合点',
    ],
    ledgerPatch: {
      currentStage: STAGE,
      openBlockers: [{
        id: 'BACKFLOW-COUPLING-L1B',
        owner: 'design.req.budget',
        unblockCondition: `L1-b 给出能让联合回放可行的拆分（当前缺口 ${search.backflow && search.backflow.shortfallTpsPerUser !== undefined ? search.backflow.shortfallTpsPerUser : 'UNVERIFIED'} TPS/usr）`,
      }],
    },
    searchNode: search,
    files: [],
  }
}
if (search.candidates.length > MAX_CANDIDATES) {
  log(`候选 ${search.candidates.length} 个，只取前 ${MAX_CANDIDATES} 个进入审行与合并；其余未评估`)
}

const candidateBrief = {
  candidateSetSha256: search.candidateSetSha256, designSpaceFileSha256: search.designSpaceFileSha256,
  totalCandidates: search.totalCandidates,
  feasibleCandidates: search.feasibleCandidates,
  paretoCandidates: search.paretoCandidates,
  infeasibleByCause: search.infeasibleByCause,
  fieldCaliber: search.fieldCaliber,
  // 合成点与"每个域单独换上 winner"的回放：说明差距从哪个域来。
  composition: search.composition,
  candidates: search.candidates.slice(0, MAX_CANDIDATES),
}
const CANDIDATES_JSON = JSON.stringify(candidateBrief, null, 2)

phase('Coupling review')

// 第二步：耦合两侧的域专家审行，并行。每一席只对本域字段被改动的行（departsFrom 里有本域）发言；
// 别的域的字段、Pareto 取舍、联合点的选择都不是它的决定。
const readings = await parallel(
  SEATS.map((s) => () =>
    agent(
      `${head(s.agent)}
你坐 ${s.seat} 席，替 ${s.domain} 域说话：${s.speaksFor}。
你坐在这几条耦合上：${s.couplings.join('、')}（定义见 brief.allowedDesignSpace 指向的设计空间文件 couplings 一节）。

brief（本 stage 的注入契约，逐字段遵守）：
${BRIEF_JSON}

联合回放的候选集（数值的唯一来源；你不得修改、重算或新增任何行）。每行的 values 是产物原行的 JSON：
departsFrom 按所属域列出该行相对合成点改了哪些字段，clauses 是五个合同条目在该行的结果，violations 是该行不可行的原因：
${CANDIDATES_JSON}

任务：对 departsFrom 含 ${s.domain} 的行，给出**本域一侧的约束**。只回答本域接不接得住这些改动，
不要评价哪一行更好、不要重算任何数值、不要替产物补口径。
- 逐条给出：这条约束否掉哪个 optionId 或哪种取值，依据是什么（引用 brief.hardConstraints 的 id）。
- 产物已按条款判不可行的行不必重复否决；只提产物没有覆盖、而本域知道的约束。
- 说不出否掉谁的约束不要提；只影响常数项、不改变取舍的也不要提。
- 若本域无法判断任何一行（缺输入），判 BLOCKED_CONFIG 并在 blockedFields 里说明缺什么。
- 若联合回放动摇了本域 winner 所依据的方向级假设，用 DIRECTION_BACKFLOW 并说明动摇了哪条。`,
      { label: `seat:${s.seat}`, phase: 'Coupling review', effort: 'high', schema: CONSTRAINT_SCHEMA },
    ),
  ),
)

// 缺席不是"没有意见"：某一席调用失败，它那一侧的约束就不存在，而合并者会把"没人反对"当成通过。
const absentLateral = SEATS.filter((_, i) => !readings[i]).map((s) => s.seat)
if (absentLateral.length) {
  log(`耦合审行缺 ${absentLateral.length} 席：${absentLateral.join(', ')}；退回，不合并`)
  return {
    stage: STAGE,
    runId: RUN_ID,
    verdict: 'BLOCKED_CONFIG',
    reason: `耦合审行不完整，缺：${absentLateral.join(', ')}；缺席的一侧不能当作"没有意见"，未合并联合点`,
    absentLateral,
    nextActions: absentLateral.map((seat) => `补齐 ${seat} 对联合候选集的约束后重跑本格`),
    searchNode: search,
    files: [],
  }
}
const constraints = readings
const blocked = constraints.find((c) => c.verdict === 'BLOCKED_CONFIG')
const backflow = constraints.find((c) => c.verdict === 'DIRECTION_BACKFLOW' || c.verdict === 'PPA_DIRECTION_BACKFLOW')
if (backflow || blocked) {
  return {
    stage: STAGE,
    runId: RUN_ID,
    verdict: (backflow || blocked).verdict,
    reason: backflow ? `${backflow.from} 报方向回退，未合并联合点` : `${blocked.from} 输入不足，未合并联合点`,
    blockedFields: (blocked && blocked.blockedFields) || [],
    constraints,
    searchNode: search,
    files: [],
  }
}

phase('Merge')

// 第三步：合并。integrator 只在可行且在 Pareto 集上的行里取一行，不新增、不重算、不拼字段。
const merged = await agent(
  `${head('integrator')}

brief：
${BRIEF_JSON}

联合回放的候选集（数值的唯一来源；你不得修改、重算或新增任何行）：
${CANDIDATES_JSON}

耦合两侧的域专家给出的约束：
${JSON.stringify(constraints, null, 2)}

任务：取唯一联合点。
- 联合点只能是 feasible 为 true 且 pareto 为 true 的一行；winner.optionId 是那一行的 optionId，
  winner.values 逐字复制那一行的 values 字符串，不得改写、不得截断、不得重新排版。
- 排序判据就是 brief 与产物 ranking 给出的：可行优先，Pareto 集上，然后 die 面积小、整卡功耗小。
  偏离产物排名第一的行时，必须写清是哪一席的哪条约束否掉了它。
- excluded：Pareto 集上未选的行与被专家否掉的行逐个登记，写清违反哪条约束或输在哪一轴（引用产物的 lostOn / violations），不得写"综合判断更优"。
- 合成点（composed）不可行时，必须在 provenance 里写清联合点相对合成点改了哪些字段、各属哪个域（引用 departsFrom）。
- TPS/usr 只引用产物里 K3 详细回放的数，并写明它是 K3 口径；GLM-5.2 与 DeepSeek-V4-Pro 只由 compute winner 的 kernel 检查覆盖，不得说成三模型都达标。
- 候选之间或专家之间不一致时显式记录冲突，不得抹平。
- 存在无法归因的差异时用 DELTA_UNEXPLAINED 交回。不要判定联合点是否满足合同——那是下一步检点的事。`,
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
          values: { type: 'string', description: '逐字取自候选集那一行的 values，不得改写' },
          provenance: { type: 'string', description: '取自哪一行、由谁给出，相对合成点改了哪些字段' },
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
            source: { type: 'string', description: '给出该排除依据的约束 id、席位或确定性脚本' },
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
    files: [],
  }
}

// 机械核对（不是判断，所以不交给 agent）：联合点必须是候选集里的一行，values 逐字相同，
// 且该行可行、在 Pareto 集上。落盘的 x / opt / model 取自这一行，不取自 integrator 的转写。
const listed = candidateBrief.candidates.find((c) => c.optionId === merged.winner.optionId)
let row = null
const mechanical = []
if (!listed) mechanical.push(`联合点 ${merged.winner.optionId} 不在交给合并的候选集里`)
else if (listed.values !== merged.winner.values) mechanical.push(`联合点 ${merged.winner.optionId} 的 values 与候选集原行不一致；数值没有逐字复制`)
else {
  row = JSON.parse(listed.values)
  if (row.feasible !== true) mechanical.push(`联合点 ${row.optionId} 在产物里不可行（${(row.violations || []).join(', ')}）`)
  if (row.pareto !== true) mechanical.push(`联合点 ${row.optionId} 不在 Pareto 集上`)
}
if (mechanical.length) {
  log(`机械核对不通过：${mechanical.join('；')}`)
  return {
    stage: STAGE,
    runId: RUN_ID,
    verdict: 'INVARIANT_VIOLATED',
    winner: null,
    rejectedWinner: merged.winner,
    violations: mechanical,
    merge: merged,
    constraints,
    files: [],
  }
}

phase('Invariant check')

// 第四步：强制检点。合并者与检点者必须是不同的 agent——见 integrator.md 的策略说明。
const check = await agent(
  `${head('invariant-checker')}

brief：
${BRIEF_JSON}

联合点（待检点；values 已由脚本核对为候选产物的原行）：
${JSON.stringify(merged.winner, null, 2)}

被排除的行与排除依据：
${JSON.stringify(merged.excluded, null, 2)}

未解决的冲突：
${JSON.stringify(merged.conflicts, null, 2)}

合成点与各域单独换上 winner 的回放（参照）：
${JSON.stringify(candidateBrief.composition, null, 2)}

联合候选产物的元信息（指纹与计数）：
${JSON.stringify({ candidateSetSha256: candidateBrief.candidateSetSha256, designSpaceFileSha256: candidateBrief.designSpaceFileSha256, totalCandidates: candidateBrief.totalCandidates, feasibleCandidates: candidateBrief.feasibleCandidates, paretoCandidates: candidateBrief.paretoCandidates, infeasibleByCause: candidateBrief.infeasibleByCause }, null, 2)}

检点清单是 brief.allowedDesignSpace 指向的设计空间文件里的 constraints 一节，外加 brief 的 exitCriteria。
任务：逐条检点。只检点，不设计、不提改进建议。
- 五个合同条目（B-MEM-BW、B-SERIAL-CMP、B-TAU、B-SRAM-CAP、B-AREA）在联合点上逐条给结论：引用 values 里 clauses 的值与合同限值并列。
- K3 回放是否达到合同目标；其他两个模型只由 compute winner 的 kernel 检查覆盖，这一点是否被如实陈述。
- 面积是否含 Shared 端口计费、option 开销与 comm core；功耗是 die 级还是卡级；口径未写明即不通过。
- provenance 是否写清联合点相对合成点改了哪些字段、各属哪个域；不完整即不通过。
- 是否有任何决定性数字不是来自候选产物或规格文件；有即为不通过。
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
// 返回值即落盘清单。检点不通过时 files 为空——退回，不写联合点。
// ---------------------------------------------------------------------------
const ledgerPatch = {
  currentStage: STAGE,
  strategyVersions: {
    'compute-expert': '1.0',
    'memory-expert': '1.0',
    'comm-expert': '1.0',
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

// 联合点：integrator 的 optionId / values / provenance，加上 L4 / L5 直接读的 x / opt / model。
// 后三项取自产物原行（search_brief.js verify 落盘前再核对一次它们等于原行）。
const jointPoint = {
  optionId: merged.winner.optionId,
  values: merged.winner.values,
  provenance: merged.winner.provenance,
  x: row.x,
  opt: row.opt,
  model: row.model,
}

const runRecord = {
  stage: STAGE,
  runId: RUN_ID,
  candidateSetSha256: candidateBrief.candidateSetSha256, designSpaceFileSha256: candidateBrief.designSpaceFileSha256,
  searchProvenance: SEARCH_BRIEF.provenance,
  totalCandidates: candidateBrief.totalCandidates,
  feasibleCandidates: candidateBrief.feasibleCandidates,
  paretoCandidates: candidateBrief.paretoCandidates,
  evaluated: candidateBrief.candidates.length,
  infeasibleByCause: candidateBrief.infeasibleByCause,
  composition: candidateBrief.composition,
  searchArtifact: SEARCH_ARTIFACT,
  searchCommandForRecord: SEARCH_COMMAND_FOR_RECORD,
  fieldCaliber: search.fieldCaliber || { areaIncludesPortCost: 'UNVERIFIED', powerScope: 'UNVERIFIED', note: '产物未提供口径标注' },
  seats: SEATS.map((s) => ({ seat: s.seat, domain: s.domain, couplings: s.couplings })),
  constraints,
  merge: merged,
  invariantCheck: check,
}

return {
  stage: STAGE,
  runId: RUN_ID,
  verdict: okInvariants ? 'INVARIANT_OK' : 'INVARIANT_VIOLATED',
  winner: okInvariants ? merged.winner : null,
  rejectedWinner: okInvariants ? null : merged.winner,
  violations: okInvariants ? [] : (check && check.violations) || ['检点未完成'],
  coverage: check && check.coverage,
  ledgerPatch,
  runRecord,
  files: okInvariants
    ? [
        {
          path: `${REPO}/out/coupling/joint_point.json`,
          content: JSON.stringify(jointPoint, null, 2),
        },
        {
          path: `${REPO}/out/coupling/coupling_run_record.json`,
          content: JSON.stringify(runRecord, null, 2),
        },
      ]
    : [],
}
