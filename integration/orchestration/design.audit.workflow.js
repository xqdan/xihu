export const meta = {
  name: 'design-audit',
  description: 'K3 设计 audit 阶段（E 组）：四个复核视角各一个 verifier 实例并行——证据链、依据一致性、算术、覆盖度；一个 verifier 实例汇总。复核的是**证据与口径**，不是产物本身；同样只读已落盘产物',
  whenToUse: 'E 组。需要 args.brief（stage=audit）与 args.artifacts（**已落盘**产物路径数组）。与 design.verify 的分工：verify 问"这份产物能否独立站住"，audit 问"支撑它的证据链与口径是否自洽"。',
  phases: [
    { title: 'Landed artifact intake', detail: '与 verify 同一道门：只接受 out/ 下的落盘产物' },
    { title: 'Four lenses', detail: '证据链 / 依据一致性 / 算术 / 覆盖度，各一个 verifier 实例，互不可见' },
    { title: 'Consolidation', detail: 'verifier 汇总四路发现；汇总不产生新结论，也不推翻单路发现' },
  ],
}

// ---------------------------------------------------------------------------
// E 组 audit。这一格接替 k3_external_references 的"证据/口径复核"职能。
//
// 与 design.verify 的分工要写清楚，否则两者会退化成同一件事跑两遍：
//
//   design.verify  问："这份产物本身能不能独立站住？" —— 面向产物。
//   design.audit   问："支撑它的证据链与口径自洽吗？" —— 面向依据。
//
// 一个具体的例子：verify 会检查某份功率数字是否带出处；audit 会沿着那条出处
// 往回走，看它引用的是什么、那东西本身是否支撑这个数字、以及同一个量在
// 别处是不是用了另一个口径。**audit 查的是关系，verify 查的是个体。**
//
// ---------------------------------------------------------------------------
// 关于 §4.2 里那四个"视角"
//
// 计划 §4.2 把 design.audit 的实例写成
//   `evidence-chain` / `basis-consistency` / `arithmetic` / `coverage` 各×1 · `verifier`×1 汇总。
//
// 这四个名字**不在 12 个策略的 roster 里**，而 tests/governance/test_agent_strategy_boundary.js
// 把 roster 钉死在 12（每个策略都要有同名的 .md 与一致的版本号）。
//
// 因此这里不新增四个 agent：四个视角是**四次注入给 verifier 的检查口径**。
// 理由不是绕开测试，而是这四个名字本来就不是角色：
//   * 一个"证据链专家"没有自己的判断规则、判据、取舍规则——它的正文会和 verifier 一模一样；
//     策略正文相同、只有标签不同的四个 agent，是四个 agent 的价钱买一次检查。
//   * roster 是按**业务策略**分的（compute/memory/comm/physical/software/model/architect/…），
//     不是按**检查手法**分的。手法是 workflow 在每个 stage 上对同一策略的取用方式。
//     这正是本仓库"agent 只有在 workflow 里运行时才参与设计"的那条原则：
//     视角是运行时的，不是定义里的。
//   * `verifier.consumers` 在 roster 里已经列了 `design.audit`，说明这个安排是预案之内的。
//
// 所以下面 VERIFY_LENSES 是**四个视角常量**，注入给四个 verifier 实例。
// 若将来要把它们提升为正式策略，改的是 agent_roster.json 与
// teams/council/strategies/ 下的 .md，以及那条 12 的断言——不在本文件的范围内。
// ---------------------------------------------------------------------------

const REPO = args.repo || '.'
const STAGE = 'audit'
const BRIEF = args.brief
const RUN_ID = args.runId || 'audit-run'
const ARTIFACTS = Array.isArray(args.artifacts) ? args.artifacts : []
const REFERENCE_ARTIFACT = args.referenceArtifact
const BASELINE_ARTIFACT = args.baselineArtifact

if (!BRIEF) throw new Error('design.audit 需要 args.brief（stage=audit 的 DesignBrief）')
if (!ARTIFACTS.length) {
  throw new Error('design.audit 需要 args.artifacts（已落盘产物路径数组）；没有产物就没有可复核的对象')
}
if (BRIEF.stage !== STAGE) {
  throw new Error(`brief.stage=${BRIEF.stage}，与 design.audit 不符；契约串了`)
}

// ---------------------------------------------------------------------------
// 与 design.verify 完全相同的 intake 门。
//
// 这不是复制粘贴的疏忽——它是同一条判据在两个 workflow 上的两次落点。
// audit 比 verify 更危险的地方在于：它天然要看"依据"，而依据最容易被
// 理解成"设计者为什么这么选"。那不是依据，那是自述。依据是落盘的东西。
// ---------------------------------------------------------------------------
const LANDED_MARK = '/out/'
const NOT_EVIDENCE_DIRS = ['/scratch/', '/probes/', '/.probe-tmp/']

const notLanded = ARTIFACTS.filter((p) => !String(p).includes(LANDED_MARK))
const notEvidence = ARTIFACTS.filter((p) => NOT_EVIDENCE_DIRS.some((d) => String(p).includes(d)))
const duplicated = ARTIFACTS.filter((p, i) => ARTIFACTS.indexOf(p) !== i)

if (notLanded.length || notEvidence.length || duplicated.length) {
  throw new Error([
    notLanded.length
      ? `design.audit 只接受已落盘产物（须在 out/ 下），收到：${notLanded.join(', ')}；`
        + '设计过程的申报、候选与草稿没有可复核的证据链。'
      : null,
    notEvidence.length
      ? `design.audit 拒收非证据目录：${notEvidence.join(', ')}；这些目录下的东西不是证据。`
      : null,
    duplicated.length
      ? `design.audit 收到重复产物路径：${[...new Set(duplicated)].join(', ')}`
      : null,
  ].filter(Boolean).join(' '))
}

// 四个视角。每个都有**自己的失效模式**——这是四个实例而不是一个实例跑四遍的理由。
// 冗余的检查者只能发现同一类问题四次；视角不同才覆盖不同的失效。
const VERIFY_LENSES = [
  {
    id: 'A-EVIDENCE-CHAIN',
    name: '证据链',
    failureMode: '结论有出处，但出处支撑不了结论——引用的是一次会议记录、一个未落盘的估算、或一条被后续推翻的早期结论',
    scope: [
      '每一条结论的出处是否**真能推出**该结论；"引用存在"不等于"引用支撑"',
      '证据链上是否有一环是未落盘的东西（对话、临时估算、agent 自述）——那一环即断链',
      '出处引用的版本是否是当前版本：引用了一份已被后续产物覆盖的旧结论，等于没有出处',
      'E0–E3 的证据等级是否与出处的实际性质一致；把估算标成实测是这里最容易出的问题',
    ],
  },
  {
    id: 'A-BASIS-CONSISTENCY',
    name: '依据一致性',
    failureMode: '每条结论单独看都自洽，合起来互相矛盾——同一个量在两处用了不同依据、不同口径、不同基准',
    scope: [
      '同一个物理量在不同产物里是否用了同一条依据；出现两个依据时必须有一条被显式作废',
      '口径是否统一：MC320 与 MC640 不得混用、peak 与 sustained 不得混用、粗估与细估不得混用',
      '这两组 card-power 口径（内存域 8×die+MC+固定 80W、物理域含共享端口项）是否被明确区分',
      '单位与量纲在跨产物引用时是否守恒（us/ms、GB/s vs GiB/s、TFLOPS vs TOPS）',
      '结论之间是否有互斥：A 说 X 是瓶颈、B 说 X 有余量，两者都不能原样成立',
    ],
  },
  {
    id: 'A-ARITHMETIC',
    name: '算术',
    failureMode: '数字本身算错——换算写反、口径漏项、量级错位；这类错误在叙述里看不出来',
    scope: [
      '逐条复算产物里出现的算术关系：乘除、比例、百分比、单位换算',
      '守恒是否真的成立：算术 / bytes / time / capacity / credit / transaction / epoch 七类',
      '中间量的量级是否合理；量级错误（10^3 写成 10^6）通常伴随一个看起来很整的数字',
      '百分比与绝对值是否对得上；比率的分母是不是该用的那个',
      '你复算时用的是产物里的裸值，不是产物里的比例——用别人算好的比例验算，只能验出抄写错误',
    ],
  },
  {
    id: 'A-COVERAGE',
    name: '覆盖度',
    failureMode: '查过的都说没问题，没查的根本没提——覆盖面被无声地缩小，读起来却像全查过了',
    scope: [
      '三模型 × TP8/16/32 × MC320/MC640 共 18 个槽位，逐槽说明有结果还是空着；空着的必须显式列出',
      '不得以"其余同理"带过。同理不是证据：其余可能就是不同',
      '被否选项是否都记录了否掉的理由；丢了被否项，下一轮会重新发明同一个缺口',
      'blocker 是否有 owner 与解除条件；没有人负责的 blocker 不是 blocker，是愿望',
      '本产物没有覆盖到的东西，是否被写成了"未覆盖"而不是省略；**省略是覆盖度审计里最严重的失效**',
    ],
  },
]

// 单视角结果。locator 必填的理由与 verify 相同：没有出处的发现无法被复核。
const LENS_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['lensId', 'name', 'findings', 'clean', 'verdict'],
  properties: {
    lensId: { type: 'string', description: '就是这个视角的 id，不得改写' },
    name: { type: 'string', description: '照抄注入的视角名' },
    findings: {
      type: 'array',
      description: '发现的每一条问题；一条都没有时给空数组，并把想查的项写进 clean',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['issue', 'locator', 'expected', 'found', 'severity'],
        properties: {
          issue: { type: 'string', description: '问题是什么' },
          locator: { type: 'string', description: '文件路径:行号 或字段路径；指不到具体位置的发现不算发现' },
          expected: { type: 'string', description: '按依据/算术应该是什么' },
          found: { type: 'string', description: '产物里实际是什么（裸值）' },
          severity: { type: 'string', enum: ['blocking', 'noted'] },
        },
      },
    },
    clean: {
      type: 'array',
      description: '本视角查过且确认没问题的项，逐条写；空数组会被当成"没查"，不是"没问题"',
      items: { type: 'string' },
    },
    verdict: { type: 'string', enum: ['VERIFIED', 'VERIFY_FAILED'] },
  },
}

// 汇总结果。汇总者**不产生新结论**，也不推翻单路发现。
const SUMMARY_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['consolidated', 'crossLensPatterns', 'unresolved', 'verdict'],
  properties: {
    consolidated: {
      type: 'array',
      description: '四路发现的合并清单，逐条保留原始 locator 与 severity；不得改判严重度',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['lensId', 'issue', 'locator', 'severity'],
        properties: {
          lensId: { type: 'string' },
          issue: { type: 'string' },
          locator: { type: 'string' },
          severity: { type: 'string', enum: ['blocking', 'noted'] },
        },
      },
    },
    crossLensPatterns: {
      type: 'array',
      description: '跨视角才看得见的模式：多个视角指向同一处、或一个视角的发现解释另一个视角的现象',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['pattern', 'lenses', 'whyItMatters'],
        properties: {
          pattern: { type: 'string' },
          lenses: { type: 'array', items: { type: 'string' } },
          whyItMatters: { type: 'string' },
        },
      },
    },
    unresolved: {
      type: 'array',
      description: '汇总时仍无法定论、需要人看的项。汇总者的职责是把它们标出来，不是替它们下结论',
      items: { type: 'string' },
    },
    verdict: { type: 'string', enum: ['VERIFIED', 'VERIFY_FAILED'] },
  },
}

const HEAD = [
  `仓库根目录：${REPO}`,
  `本 workflow：design.audit（stage=${STAGE}，runId=${RUN_ID}）`,
  `你是一个策略实例。先读你的策略正文：${REPO}/teams/council/strategies/__AGENT__.md`,
  '那份文件是本角色的判断规则、正确性判据、证据规则、取舍规则与禁止事项，逐条遵守。',
  '以下运行时上下文由 workflow 注入；注入内容与策略正文冲突时，注入内容优先（它承载本 stage 的事实）。',
  '你没有文件系统写权限。把该写的东西作为返回值交回，由 workflow 落盘。',
  '所有数字必须带出处（文件路径:行号 或 ADR 编号）；没有出处的写 UNVERIFIED 并说明缺什么。',
  '不得输出 TPS/usr 或任何全局性能指标。',
  '',
  '**你复核的是证据与口径，不是产物本身。**',
  '只能读下面列出的**已落盘产物**与仓库里的规格/ADR 正文。',
  '不得读设计过程的中间产物、对话或任何未落盘的东西。',
  '设计者的自述不是依据——它是待复核的对象。你顺着写者的理由走，复核就退化成盖章。',
].join('\n')

const head = (agentId) => HEAD.replace('__AGENT__', agentId)

const BRIEF_JSON = JSON.stringify(BRIEF, null, 2)
const ARTIFACT_LIST = ARTIFACTS.map((p) => `  ${p}`).join('\n')

// 参照物：规格与 ADR 是 audit 特有的输入——verify 不看它们，audit 必须看，
// 因为"依据是否支撑结论"要先知道依据是什么。
const REFERENCES = [
  REFERENCE_ARTIFACT,
  BASELINE_ARTIFACT,
  `${REPO}/teams/hardware/docs/`,
  `${REPO}/docs/architecture/`,
].filter(Boolean).map((p) => `  ${p}`).join('\n')

phase('Landed artifact intake')

log(`design.audit 收下 ${ARTIFACTS.length} 份落盘产物，按 ${VERIFY_LENSES.length} 个视角复核；注入内容只有路径，不含任何设计中间对象`)

phase('Four lenses')

// 四个视角并行且互不可见。理由与 verify 相同，但这里还有一层：
// 视角之间一旦互相看见，覆盖度那个视角就会抄证据链的结论，
// 于是"四个视角"退化成"一个视角加三次复述"。
const lensResults = (await parallel(VERIFY_LENSES.map((l) => () => agent(
  `${head('verifier')}\n\n`
  + `brief：\n${BRIEF_JSON}\n\n`
  + `已落盘产物（只读，这是你可以读的全部产物）：\n${ARTIFACT_LIST}\n\n`
  + `可参照的依据（只读）：\n${REFERENCES}\n\n`
  + `你本次**只负责一个视角**：\n`
  + `  id：${l.id}\n`
  + `  名称：${l.name}\n`
  + `  这一类问题典型的失效方式是：${l.failureMode}\n`
  + `  检查范围：\n${l.scope.map((s) => `    - ${s}`).join('\n')}\n\n`
  + `任务：沿这个视角复核。规则：\n`
  + `1. 每一条发现必须给 locator（文件路径:行号 或字段路径）、expected 与 found 裸值。\n`
  + `   指不到具体位置的发现不算发现——它无法被复核，而无法复核的发现只是印象。\n`
  + `2. **你必须写下 clean 清单**：本视角查过、确认没问题的项。\n`
  + `   空数组会被读成"这个视角没查"，而不是"这个视角没问题"。\n`
  + `3. 发现的问题按严重度分：blocking（结论不成立）与 noted（结论成立但应当改进）。\n`
  + `   不要用 blocking 表达偏好。\n`
  + `4. 不要为了显得有产出而报告伪问题；也不要为了显得干净而漏报真问题。`
  + `   两者都会让这份复核失去意义。\n`
  + `5. 有 blocking 发现写 VERIFY_FAILED，否则写 VERIFIED。\n`
  + `你不判门控是否通过——门控结论由 integration/governance/evaluate_gates.js 计算。`,
  {label: `audit:${l.id}`, phase: 'Four lenses', effort: 'high', schema: LENS_SCHEMA})
))).filter(Boolean)

if (lensResults.length < VERIFY_LENSES.length) {
  const absent = VERIFY_LENSES.filter((l) => !lensResults.some((r) => r.lensId === l.id)).map((l) => l.id)
  return {
    stage: STAGE, runId: RUN_ID, verdict: 'BLOCKED_CONFIG',
    reason: `复核视角不完整，缺：${absent.join(', ')}；覆盖不全的复核不成立，不落盘——`
      + '漏掉的那个视角，读起来会像"那个视角也没问题"',
    nextActions: absent.map((id) => `补齐 ${id} 视角后重跑本格`),
    absentLenses: absent,
    files: [],
  }
}

const blocking = lensResults.flatMap((r) => (r.findings || [])
  .filter((f) => f.severity === 'blocking')
  .map((f) => ({lensId: r.lensId, ...f})))
const noted = lensResults.flatMap((r) => (r.findings || [])
  .filter((f) => f.severity !== 'blocking')
  .map((f) => ({lensId: r.lensId, ...f})))
const failedLenses = lensResults.filter((l) => l.verdict !== 'VERIFIED')
const okLenses = failedLenses.length === 0

// 视角判失败却没有 blocking 发现（或反之）——这是内部不自洽，必须记下来。
// 静默放行会让"verdict 字段"变成一个没人看的装饰。
const lensSelfContradictions = lensResults
  .filter((l) => (l.verdict === 'VERIFIED' && (l.findings || []).some((f) => f.severity === 'blocking'))
              || (l.verdict === 'VERIFY_FAILED' && !(l.findings || []).some((f) => f.severity === 'blocking')))
  .map((l) => `${l.lensId}：裁决为 ${l.verdict}，但与 findings 的严重度不符`)

phase('Consolidation')

const summary = await agent(
  `${head('verifier')}\n\n`
  + `brief：\n${BRIEF_JSON}\n\n`
  + `四个视角的完整结果：\n${JSON.stringify(lensResults, null, 2)}\n\n`
  + `已落盘产物（只读）：\n${ARTIFACT_LIST}\n\n`
  + `任务：汇总四路发现。规则：\n`
  + `1. **你不得改判严重度、不得否掉任何一条发现、不得重做复核。**\n`
  + `   你的职责是合并与关联，不是裁决。单路发现原样进入 consolidated。\n`
  + `2. 找出**跨视角才看得见的模式**：同一处被两个视角从不同角度指到，`
  + `   或一个视角的发现解释了另一个视角的现象。这是把四个实例并成一个的真正产出。\n`
  + `3. 汇总时仍无法定论的项，写进 unresolved——标出来给人看，不要替它下结论。\n`
  + `4. 有 blocking 级发现（或任一视角失败）写 VERIFY_FAILED，否则写 VERIFIED。\n`
  + `注意：这个汇总是**复核意见**的一部分，不是门控结论。`,
  {label: 'verifier:consolidation', phase: 'Consolidation', effort: 'high', schema: SUMMARY_SCHEMA})

// 汇总与单路的对账：汇总里少了一条 blocking 发现，说明合并时把它丢了。
// 这类丢失不会报错，只会让产物看起来比实际干净——所以在这里显式对账。
const consolidatedIds = new Set(((summary && summary.consolidated) || [])
  .map((c) => `${c.lensId}::${c.locator}`))
const droppedFindings = blocking
  .filter((f) => !consolidatedIds.has(`${f.lensId}::${f.locator}`))
  .map((f) => `${f.lensId} 的 blocking 发现在汇总中丢失：${f.locator}`)

const contradictions = [...lensSelfContradictions, ...droppedFindings]

const ok = !!summary && okLenses && (summary.verdict === 'VERIFIED') && contradictions.length === 0

const ledgerPatch = {
  currentStage: STAGE,
  strategyVersions: {verifier: '1.0'},
  // audit 的被否项是 blocking 发现指向的具体位置。
  // 与 verify 的"整类检查未通过"不同，audit 的粒度是单点——
  // 记成整类会让下一轮重查一遍全类，记成单点才能直接修。
  rejectedOptions: blocking.map((f, i) => ({
    stage: STAGE,
    optionId: `${f.lensId}-${String(i + 1).padStart(2, '0')}`,
    reason: `${f.issue}（期望 ${f.expected}，实为 ${f.found}）@ ${f.locator}`,
    rejectedBy: 'verifier',
  })),
  openBlockers: (summary ? (summary.unresolved || []) : []).map((u, i) => ({
    id: `AUDIT-UNRESOLVED-${String(i + 1).padStart(2, '0')}`,
    owner: 'UNVERIFIED',
    unblockCondition: u,
  })),
}

const runRecord = {
  schemaVersion: 'design-run-record-v0.1',
  stage: STAGE,
  runId: RUN_ID,
  sourceCommit: BRIEF.sourceCommit,
  artifactsAudited: ARTIFACTS.slice().sort(),
  artifactCount: ARTIFACTS.length,
  referenceArtifact: REFERENCE_ARTIFACT || 'UNVERIFIED',
  baselineArtifact: BASELINE_ARTIFACT || 'UNVERIFIED',
  lensIds: lensResults.map((l) => l.lensId).sort(),
  lensVerdicts: Object.fromEntries(lensResults.map((l) => [l.lensId, l.verdict])),
  blockingCount: blocking.length,
  notedCount: noted.length,
  strategyVersions: {verifier: '1.0'},
  injectedDesignIntermediates: [],
  caliber: '四个复核视角是注入给 verifier 实例的检查口径，不是四个独立策略——roster 仍是 12 个策略，本格不新增 agent 定义。'
    + '本格只向实例注入已落盘产物与仓库规格/ADR；设计过程的申报、候选与草稿一律不注入',
}

return {
  stage: STAGE,
  runId: RUN_ID,
  verdict: ok ? 'VERIFIED' : 'VERIFY_FAILED',
  lenses: lensResults,
  blocking,
  noted,
  consolidation: summary || null,
  contradictions,
  unresolved: (summary && summary.unresolved) || [],
  crossLensPatterns: (summary && summary.crossLensPatterns) || [],
  ledgerPatch,
  runRecord,
  nextActions: ok ? [] : [
    ...blocking.map((f) => `修复 ${f.locator}：${f.issue}（期望 ${f.expected}，实为 ${f.found}）`),
    ...failedLenses.map((l) => `复核 ${l.lensId}（${l.name}）的失败项`),
    ...contradictions,
    ...((summary && summary.unresolved) || []).map((u) => `人工定论：${u}`),
  ],
  files: ok ? [
    {
      path: `${REPO}/out/verification/${STAGE}_report.json`,
      content: JSON.stringify({
        schemaVersion: 'design-audit-report-v0.1',
        stage: STAGE, runId: RUN_ID, sourceCommit: BRIEF.sourceCommit,
        artifactsAudited: ARTIFACTS,
        lenses: lensResults,
        blocking,
        noted,
        consolidation: summary,
        crossLensPatterns: summary.crossLensPatterns,
        unresolved: summary.unresolved,
        // 与 verify_report.json 同处 verification/，靠 stage 字段区分。
        // 两份报告回答不同的问题，不互相替代。
        note: '证据与口径复核报告；与 verify_report.json 的分工是"面向依据"对"面向产物"。门控结论由 integration/governance/evaluate_gates.js 计算，本报告不判定它',
      }, null, 2) + '\n',
    },
    {
      path: `${REPO}/out/verification/${STAGE}_run_record.json`,
      content: JSON.stringify(runRecord, null, 2) + '\n',
    },
  ] : [],
}
