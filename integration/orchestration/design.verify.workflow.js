export const meta = {
  name: 'design-verify',
  description: 'K3 设计 verify 阶段（E 组）：7 类独立检查各一个 verifier 实例并行核验**已落盘产物**，gate-keeper 核验门控证据完备性，architect 签署送审意见；门控结论由 evaluate_gates.js 计算，本 workflow 不判、不写字面量',
  whenToUse: 'E 组。需要 args.brief（stage=verify 的 DesignBrief）与 args.artifacts（**已落盘**产物路径数组，全部在 out/ 下）。不接受设计过程中的申报、候选或草稿：那些是设计中间产物，verifier 读它们就不再独立。',
  phases: [
    { title: 'Landed artifact intake', detail: '脚本侧核对注入的产物确已落盘；设计中间产物在此被挡在门外' },
    { title: 'Independent checks', detail: '7 类检查各一个 verifier 实例，互不可见，只读落盘产物' },
    { title: 'Gate evidence', detail: 'gate-keeper 核验门控证据完备性；不判门控结论' },
    { title: 'Architect sign-off', detail: 'architect 签署送审/回流意见；结论引用检查结果，不覆盖' },
  ],
}

// ---------------------------------------------------------------------------
// E 组 verify。这一格接替 k3_multiteam_review 的"独立门控"职能。
//
// 它要回答的唯一问题：**这份产物能不能被独立验证站住**。
//
// 与 C/D 组的关键区别，全部来自 verifier 策略的那一条禁令：
// "不得读设计过程的中间产物，只能读已落盘的最终产物。"
//
//   * 本 workflow 只接收**路径**（args.artifacts），不接收任何设计对象。
//     申报、候选、草稿包、搜索中间解都是设计过程里的东西；把它们序列化进 prompt，
//     验证者就会顺着写者的理由接受结论，独立验证退化成复核。
//     落盘产物是设计者唯一无法再解释的形态——它已经写死了。
//   * 因此 intake 阶段在脚本侧就挡住：凡不在 out/ 下的路径一律不收，
//     scratch/ 尤其不收（那是 design.explore 的产物，明文规定不得作为任何 claim 的证据）。
//   * 检查类别是常量（7 类），不从产物里读——用产物的形状决定查什么，
//     等于让被测数据决定考题。少一类，那一类的问题就没人看过。
//
// 与 C/D 组的另一点区别：**没有 invariant-checker**。
// roster 的 §4.2 给 design.verify 的实例是 verifier×≥6 · gate-keeper×1 · architect×1。
// 这不是遗漏：verify 的终端检查就是 verifier 本身，再叠一个检点者只会得到
// 两个都声称独立、实际上互相参考的检查者。
//
// 四条硬边界在此的落点：
//   边界 1：输出什么由本 workflow 注入；策略正文里没有输出契约。
//   边界 2：路径只出现在本文件里；策略靠 prompt 里的 agentId 自读正文。
//   边界 3：verifier / gate-keeper / architect 的裁决枚举由本 workflow 消费。
//   边界 4：本文件不产生任何数字、不判定门控。PASS 只由
//           integration/governance/evaluate_gates.js 计算。
// ---------------------------------------------------------------------------

const REPO = args.repo || '.'
const STAGE = 'verify'
const BRIEF = args.brief
const RUN_ID = args.runId || 'verify-run'
const ARTIFACTS = Array.isArray(args.artifacts) ? args.artifacts : []
const GATE_STATUS_ARTIFACT = args.gateStatusArtifact
const REGISTER_ARTIFACT = args.registerArtifact
const GATE_COMMAND_FOR_RECORD = args.gateCommand || 'UNVERIFIED'

if (!BRIEF) throw new Error('design.verify 需要 args.brief（intake 阶段产出的 DesignBrief）')
if (!ARTIFACTS.length) {
  throw new Error('design.verify 需要 args.artifacts（已落盘产物路径数组）；没有产物就没有可验证的对象')
}
if (BRIEF.stage !== STAGE) {
  // brief 的 stage 与 workflow 名称必须一致，否则会把别的阶段的契约拿来用
  throw new Error(`brief.stage=${BRIEF.stage}，与 design.verify 不符；契约串了`)
}

// ---------------------------------------------------------------------------
// intake：脚本侧把设计中间产物挡在门外。
//
// 这是本 workflow 与 S7 验收判据"verify/audit 的策略注入里确认不含设计中间产物"
// 的落点。它必须在**脚本里**实现，不能只写在 prompt 里：
// prompt 里的规则是请求，脚本里的规则是事实。
// ---------------------------------------------------------------------------

// 落盘产物只可能在 out/ 下——那是全仓库唯一由生成器/工作流写出、且不允许手改的目录。
// 一条路径不在 out/ 下，它就不是"已落盘的最终产物"，而是别的东西。
const LANDED_MARK = '/out/'

// 显式拒收的目录。scratch/ 是 design.explore 的产物（明文不得作为任何 claim 的证据）；
// probes/ 与 .probe-tmp/ 是探针的临时输出。
const NOT_EVIDENCE_DIRS = ['/scratch/', '/probes/', '/.probe-tmp/']

const notLanded = ARTIFACTS.filter((p) => !String(p).includes(LANDED_MARK))
const notEvidence = ARTIFACTS.filter((p) => NOT_EVIDENCE_DIRS.some((d) => String(p).includes(d)))
const duplicated = ARTIFACTS.filter((p, i) => ARTIFACTS.indexOf(p) !== i)

if (notLanded.length || notEvidence.length || duplicated.length) {
  throw new Error([
    notLanded.length
      ? `design.verify 只接受已落盘产物（须在 out/ 下），收到：${notLanded.join(', ')}。`
        + '设计过程的申报、候选与草稿不是可验证对象——验证者读到它们就不再独立。'
      : null,
    notEvidence.length
      ? `design.verify 拒收非证据目录：${notEvidence.join(', ')}。`
        + `${NOT_EVIDENCE_DIRS.join(' / ')} 下的东西不是证据，不得进入验证。`
      : null,
    duplicated.length
      ? `design.verify 收到重复产物路径：${[...new Set(duplicated)].join(', ')}；重复会让同一份产物被查两遍而另一份没人查`
      : null,
  ].filter(Boolean).join(' '))
}

// 7 类检查。取自 verifier 策略的判断规则与正确性判据——
// 它要求"独立验证 schema、单位、守恒、版本、链接、profile 分离与 provenance"，
// 并要求"七类守恒逐项给出结果"与"回归矩阵覆盖三模型 × TP8/16/32 × MC320/MC640"。
//
// 类别是常量，不从产物里读。产物里有几类就查几类，等于让被测者定考题。
const VERIFY_CHECKS = [
  {id: 'V-SCHEMA', name: 'schema 与单位',
    scope: '每个产物的 schemaVersion、必填字段、字段类型；单位与量纲是否自洽（us/ms、GB/s vs GiB/s、TFLOPS vs TOPS）'},
  {id: 'V-CONSERVATION', name: '七类守恒',
    scope: '算术、bytes、time、capacity、credit、transaction、epoch 逐类给出结果；每类给出裸值，不得只写结论'},
  {id: 'V-PROVENANCE', name: 'provenance',
    scope: 'source commit、manifest hash、run_id、seed 与策略版本是否齐全且互相一致；缺任一项这份结论就无法被复现'},
  {id: 'V-PROFILE', name: 'profile 分离',
    scope: 'MC320 与 MC640 是否分开陈述、peak 与 sustained 是否分开、粗估与细估是否分开；混用即失败'},
  {id: 'V-MATRIX', name: '回归矩阵覆盖',
    scope: '三模型 × TP8/16/32 × MC320/MC640 共 18 个槽位是否都有结果或 blocker；空缺必须显式列出，不得以"其余同理"带过'},
  {id: 'V-REPLAY', name: '可回放性',
    scope: 'golden trace 是否存在且能被独立重放；每条结论是否给出可复现的检查方式（换个人按同样步骤能得出同样结果）'},
  {id: 'V-SYNTHETIC', name: '合成数据不得签核',
    scope: '产物里的合成/占位事件是否被当成了实测；合成数据可用于压力测试，不能用于签核。凡 status=SYNTHETIC_PLACEHOLDER 的条目都不得支撑任何结论'},
]

// 单类检查的结果。逐条 `checks` 必须带 locator——没有出处的"通过"不是通过。
const CHECK_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['checkId', 'name', 'checks', 'gaps', 'verdict'],
  properties: {
    checkId: { type: 'string', description: '就是这个检查的 id，不得改写' },
    name: { type: 'string', description: '照抄注入的检查名' },
    checks: {
      type: 'array',
      description: '逐项结论；每一项都要有可复现的检查方式与出处',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['item', 'result', 'locator', 'detail'],
        properties: {
          item: { type: 'string', description: '这一项查的是什么' },
          result: { type: 'string', enum: ['passed', 'failed', 'unverifiable'] },
          locator: { type: 'string', description: '文件路径:行号 或字段路径；引用不到写 UNVERIFIED 并说明缺什么' },
          detail: { type: 'string', description: '裸值与检查方式；不得只写结论' },
        },
      },
    },
    gaps: {
      type: 'array',
      description: '未覆盖或无法完成的项；空数组表示这一类全查到了。检不了不作为通过处理',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['what', 'why', 'owner'],
        properties: {
          what: { type: 'string' },
          why: { type: 'string', description: '为什么查不了：产物缺字段、来源不可引、还是本类不适用' },
          owner: { type: 'string', description: '谁来补；不确定写 UNVERIFIED' },
        },
      },
    },
    verdict: { type: 'string', enum: ['VERIFIED', 'VERIFY_FAILED'] },
  },
}

// 门控证据完备性。gate-keeper 只核"证据齐不齐"，不判门控成不成立。
const GATE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['gateDecision', 'gateDecisionSource', 'items', 'verdict'],
  properties: {
    gateDecision: {
      type: 'string',
      description: '照抄门控结论产物里的 decision 原文；不得改写、不得推断。抄不到写 UNVERIFIED',
    },
    gateDecisionSource: {
      type: 'string',
      description: '必须是 integration/governance/evaluate_gates.js 及其产物路径',
    },
    items: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['requirement', 'evidenceLevel', 'locator', 'blocker'],
        properties: {
          requirement: { type: 'string' },
          evidenceLevel: { type: 'string', enum: ['E0', 'E1', 'E2', 'E3', 'UNVERIFIED'] },
          locator: { type: 'string', description: '文件路径:行号 或 ADR 编号；机器可读，不是文档叙述' },
          blocker: { type: 'string', description: '挡住这一条的原因；没有写 none' },
        },
      },
    },
    verdict: { type: 'string', enum: ['GATE_EVIDENCE_COMPLETE', 'GATE_BLOCKED'] },
  },
}

// architect 的签署意见。它**引用**检查结果，不覆盖。
const SIGN_OFF_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['conclusion', 'basis', 'openItems', 'directionLevelFindings', 'verdict'],
  properties: {
    conclusion: { type: 'string', description: '这份产物能不能送评审，一句话说清' },
    basis: {
      type: 'array',
      description: '结论的依据，逐条指向检查结果或产物字段',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['claim', 'source'],
        properties: {
          claim: { type: 'string' },
          source: { type: 'string', description: '指向本 workflow 的某条检查结论或某份产物的字段' },
        },
      },
    },
    openItems: {
      type: 'array',
      description: '签署时仍然开着的项；判送审时它可以非空，判冻结时必须为空',
      items: { type: 'string' },
    },
    directionLevelFindings: {
      type: 'array',
      description: '方向级不成立的发现；用 DIRECTION_BACKFLOW 时必填',
      items: { type: 'string' },
    },
    verdict: { type: 'string', enum: ['D_GATE_PROPOSAL', 'DIRECTION_BACKFLOW', 'ARCH_FREEZE'] },
  },
}

const HEAD = [
  `仓库根目录：${REPO}`,
  `本 workflow：design.verify（stage=${STAGE}，runId=${RUN_ID}）`,
  `你是一个策略实例。先读你的策略正文：${REPO}/teams/council/strategies/__AGENT__.md`,
  '那份文件是本角色的判断规则、正确性判据、证据规则、取舍规则与禁止事项，逐条遵守。',
  '以下运行时上下文由 workflow 注入；注入内容与策略正文冲突时，注入内容优先（它承载本 stage 的事实）。',
  '你没有文件系统写权限。把该写的东西作为返回值交回，由 workflow 落盘。',
  '所有数字必须带出处（文件路径:行号 或 ADR 编号）；没有出处的写 UNVERIFIED 并说明缺什么，不得静默补齐。',
  '不得输出 TPS/usr 或任何全局性能指标。',
  '',
  '**独立性的唯一资产**：你只能读下面列出的**已落盘产物**。',
  '不得读设计过程的中间产物、对话或任何未落盘的东西；不得以设计者自述作为验证依据——',
  '自述是待验证的输入，不是证据。看到写者的推理过程，你就会顺着理由接受结论，验证随之退化成复核。',
].join('\n')

const head = (agentId) => HEAD.replace('__AGENT__', agentId)

const BRIEF_JSON = JSON.stringify(BRIEF, null, 2)
const ARTIFACT_LIST = ARTIFACTS.map((p) => `  ${p}`).join('\n')

phase('Landed artifact intake')

// intake 的判定已经在上面做完了（不通过直接抛错，不会走到这里）。
// 这里把**实际收下什么**记进 run record——它回答的是"这次验证到底看了哪些文件"，
// 而这正是事后复核一份验证结论时第一个要问的问题。
log(`design.verify 收下 ${ARTIFACTS.length} 份落盘产物；注入内容只有路径，不含任何设计中间对象`)

phase('Independent checks')

// 7 个独立实例并行。它们互不可见是刻意的：
// 一个实例看到另一个的结论，就会把"别人查过"当成"这一类没问题"，
// 于是 7 类检查退化成一个检查加六次附和。
const checks = (await parallel(VERIFY_CHECKS.map((c) => () => agent(
  `${head('verifier')}\n\n`
  + `brief：\n${BRIEF_JSON}\n\n`
  + `已落盘产物（只读，这是你可以读的全部内容）：\n${ARTIFACT_LIST}\n\n`
  + `你本次**只负责一类**检查：\n`
  + `  id：${c.id}\n`
  + `  名称：${c.name}\n`
  + `  范围：${c.scope}\n\n`
  + `任务：对上面的产物逐项做这一类检查。规则：\n`
  + `1. 每一项都要有 **可复现的检查方式**：换一个人按同样的步骤能得出同样的结果。\n`
  + `   写不出步骤的结论不算结论。\n`
  + `2. 每一项都要有出处（文件路径:行号 或字段路径）与裸值。引用不到就写 unverifiable，`
  + `   并进 gaps 说明缺什么——**检不了不作为通过处理**：无法验证与验证失败在后果上是同一件事。\n`
  + `3. 不得只验证 JSON 结构而跳过物理与时间守恒。\n`
  + `4. 不得修改被测数据来制造通过。发现问题要报告，而不是修好之后报告"没问题"。\n`
  + `5. 合成事件不能使结论成立。合成数据可以用于压力测试，不能用于签核。\n`
  + `全部通过写 VERIFIED；任一项不通过或无法完成写 VERIFY_FAILED。\n`
  + `你不判门控是否通过——门控结论由 integration/governance/evaluate_gates.js 计算。`,
  {label: `verify:${c.id}`, phase: 'Independent checks', effort: 'high', schema: CHECK_SCHEMA})
))).filter(Boolean)

if (checks.length < VERIFY_CHECKS.length) {
  const absent = VERIFY_CHECKS.filter((c) => !checks.some((r) => r.checkId === c.id)).map((c) => c.id)
  return {
    stage: STAGE, runId: RUN_ID, verdict: 'BLOCKED_CONFIG',
    reason: `独立检查不完整，缺：${absent.join(', ')}；本次验证不成立，不落盘`,
    nextActions: absent.map((id) => `补齐 ${id} 这一类检查后重跑本格`),
    absentChecks: absent,
    files: [],
  }
}

// 脚本侧汇总。这里不重算任何检查结论——只做"有没有失败项"的计数与归集。
const failedChecks = checks.filter((c) => c.verdict !== 'VERIFIED')
const gaps = checks.flatMap((c) => (c.gaps || []).map((g) => ({checkId: c.checkId, ...g})))
const okVerified = failedChecks.length === 0

phase('Gate evidence')

// gate-keeper 只核证据完备性。它拿得到门控结论产物，但只**照抄** decision，
// 不因为它而改自己的裁决——两条判断各走各的。
const gate = await agent(
  `${head('gate-keeper')}\n\n`
  + `brief：\n${BRIEF_JSON}\n\n`
  + `已落盘产物（只读）：\n${ARTIFACT_LIST}\n`
  + (GATE_STATUS_ARTIFACT ? `门控结论产物（只读，由 evaluate_gates.js 算出）：${GATE_STATUS_ARTIFACT}\n` : '')
  + (REGISTER_ARTIFACT ? `候选寄存器（只读）：${REGISTER_ARTIFACT}\n` : '')
  + `\n7 类独立检查的结果：\n${JSON.stringify(checks, null, 2)}\n\n`
  + `任务：核验门控**证据**的完备性。规则：\n`
  + `1. 每条要求必须给出证据等级与机器可读的出处；引用不到写 UNVERIFIED。\n`
  + `   不得以文档叙述代替机器可读证据。\n`
  + `2. 每条必须有 blocker 字段：挡住的写原因，没挡住写 none。不得留空。\n`
  + `3. gateDecision **照抄**门控结论产物里的 decision 原文，不得改写、不得推断，`
  + `   不得因为"证据都齐"就把它写成通过。抄不到写 UNVERIFIED。\n`
  + `4. 证据不足与进度冲突时，证据不足优先：记为 blocker 而不是放行。\n`
  + `**你不判 PASS**：门控结论由 integration/governance/evaluate_gates.js 计算。`,
  {label: 'gate-keeper', phase: 'Gate evidence', effort: 'high', schema: GATE_SCHEMA})

const okGate = !!gate && gate.verdict === 'GATE_EVIDENCE_COMPLETE'

phase('Architect sign-off')

// architect 签署送审意见。它引用下面的检查结果，**不覆盖**它们：
// 把失败项解释成可接受，正是本 workflow 要防的"以结论代替核验"。
const signOff = await agent(
  `${head('architect')}\n\n`
  + `brief：\n${BRIEF_JSON}\n\n`
  + `已落盘产物（只读）：\n${ARTIFACT_LIST}\n\n`
  + `7 类独立检查的结果：\n${JSON.stringify(checks, null, 2)}\n`
  + `未覆盖项：\n${JSON.stringify(gaps, null, 2)}\n`
  + `门控证据完备性：\n${JSON.stringify(gate, null, 2)}\n\n`
  + `任务：就这份产物给出签署意见。规则：\n`
  + `1. conclusion 与 basis 必须建立在**上面的检查结果**之上，逐条指向它们。\n`
  + `   你不得重做检查、不得覆盖检查结论、不得把失败项解释成可接受。\n`
  + `   解释权在你，但解释改变不了检查结果本身——两者都会落盘。\n`
  + `2. 判 D_GATE_PROPOSAL（送评审）时：检查必须全通过、门控证据必须完备。\n`
  + `3. 判 ARCH_FREEZE（本轮到此冻结）时：openItems 必须为空。`
  + `   "冻结了但还有点东西开着"不是冻结。\n`
  + `4. 判 DIRECTION_BACKFLOW 时：directionLevelFindings 必须逐条写明动摇了哪条方向级假设。\n`
  + `5. openItems 列出签署时仍然开着的项，不得为了收口而漏记。\n`
  + `注意：你不判门控是否通过。你的 D_GATE_PROPOSAL 只是一个**送审提案**。`,
  {label: 'architect', phase: 'Architect sign-off', effort: 'high', schema: SIGN_OFF_SCHEMA})

// ---------------------------------------------------------------------------
// 路由夹取。签署意见与检查结果自相矛盾时，本格不落盘。
//
// 这一块存在的理由：architect 有权说"这些失败项我认了，还是送评审"，
// 但它无权在**检查说失败**的时候说"检查通过了"。前者是判断，后者是改写事实。
// 因此凡是"意见要求通过、事实不支持通过"的组合，一律记为矛盾而非放行。
// ---------------------------------------------------------------------------
const routeContradictions = []
if (signOff) {
  if (signOff.verdict === 'D_GATE_PROPOSAL' && !okVerified) {
    routeContradictions.push(`检查有 ${failedChecks.length} 类未通过（${failedChecks.map((c) => c.checkId).join(', ')}），不得送评审`)
  }
  if (signOff.verdict === 'D_GATE_PROPOSAL' && !okGate) {
    routeContradictions.push('门控证据不完备，不得送评审')
  }
  if (signOff.verdict === 'D_GATE_PROPOSAL' && (signOff.openItems || []).length) {
    routeContradictions.push(`送评审时仍有 ${(signOff.openItems || []).length} 项开着，不得送评审`)
  }
  if (signOff.verdict === 'ARCH_FREEZE' && (signOff.openItems || []).length) {
    routeContradictions.push(`判冻结却仍列出 ${(signOff.openItems || []).length} 项开着的项，冻结不成立`)
  }
  if (signOff.verdict === 'ARCH_FREEZE' && !okVerified) {
    routeContradictions.push('检查未通过却判冻结；冻结不得建立在未通过的检查之上')
  }
  if (signOff.verdict === 'DIRECTION_BACKFLOW' && !(signOff.directionLevelFindings || []).length) {
    routeContradictions.push('判方向回流却未给出任何方向级发现')
  }
}

const ok = !!signOff && okVerified && okGate && routeContradictions.length === 0

const ledgerPatch = {
  currentStage: STAGE,
  strategyVersions: {'verifier': '1.0', 'gate-keeper': '1.0', architect: '1.0'},
  // 未通过的检查就是本阶段的"被否选项"。不记下来，重跑会重新发明同一个缺口。
  rejectedOptions: failedChecks.map((c) => ({
    stage: STAGE,
    optionId: c.checkId,
    reason: (c.checks || []).filter((x) => x.result !== 'passed').map((x) => `${x.item}: ${x.detail}`).join('；') || '检查未通过',
    rejectedBy: 'verifier',
  })),
  openBlockers: [
    ...gaps.map((g, i) => ({
      id: `VERIFY-GAP-${String(i + 1).padStart(2, '0')}`,
      owner: g.owner || 'UNVERIFIED',
      unblockCondition: `${g.checkId} 未覆盖项：${g.what}（${g.why}）`,
    })),
    ...((gate && gate.items) || []).filter((it) => it.blocker && it.blocker !== 'none').map((it, i) => ({
      id: `VERIFY-GATE-${String(i + 1).padStart(2, '0')}`,
      owner: 'gate-keeper',
      unblockCondition: `${it.requirement}：${it.blocker}`,
    })),
    ...(signOff ? (signOff.openItems || []).map((o, i) => ({
      id: `VERIFY-OPEN-${String(i + 1).padStart(2, '0')}`,
      owner: 'architect',
      unblockCondition: o,
    })) : []),
  ],
}

const runRecord = {
  schemaVersion: 'design-run-record-v0.1',
  stage: STAGE,
  runId: RUN_ID,
  sourceCommit: BRIEF.sourceCommit,
  artifactsVerified: ARTIFACTS.slice().sort(),
  artifactCount: ARTIFACTS.length,
  gateStatusArtifact: GATE_STATUS_ARTIFACT || 'UNVERIFIED',
  registerArtifact: REGISTER_ARTIFACT || 'UNVERIFIED',
  gateCommand: GATE_COMMAND_FOR_RECORD,
  checkIds: checks.map((c) => c.checkId).sort(),
  verifiedCount: checks.filter((c) => c.verdict === 'VERIFIED').length,
  failedCount: failedChecks.length,
  gapCount: gaps.length,
  injectedDesignIntermediates: [],
  caliber: '本格只向实例注入已落盘产物的路径；设计过程的申报、候选与草稿一律不注入。门控结论取自 integration/governance/evaluate_gates.js 的产物，workflow 与任何 agent 均不判定',
}

return {
  stage: STAGE,
  runId: RUN_ID,
  // 落盘与否由三件事共同决定：检查全通过、门控证据完备、签署意见不自相矛盾。
  // 少了第三件，"检查失败但意见说通过"就会静默落盘。
  verdict: ok ? signOff.verdict : (routeContradictions.length ? 'BLOCKED_CONFIG' : 'VERIFY_FAILED'),
  checks: ok ? checks : null,
  failedChecks: ok ? [] : failedChecks.map((c) => ({checkId: c.checkId, verdict: c.verdict})),
  gaps,
  gateEvidence: gate,
  signOff: signOff || null,
  routeContradictions,
  gateDecision: gate ? gate.gateDecision : 'UNVERIFIED',
  ledgerPatch,
  runRecord,
  nextActions: ok ? [] : [
    ...failedChecks.map((c) => `处理 ${c.checkId}（${c.name}）的未通过项：${(c.checks || []).filter((x) => x.result !== 'passed').map((x) => x.item).join('、') || '见该检查的 gaps'}`),
    ...gaps.map((g) => `补齐未覆盖项：${g.what}（${g.why}）`),
    ...routeContradictions,
  ],
  files: ok ? [
    {
      path: `${REPO}/out/verification/${STAGE}_report.json`,
      content: JSON.stringify({
        schemaVersion: 'design-verify-report-v0.1',
        stage: STAGE, runId: RUN_ID, sourceCommit: BRIEF.sourceCommit,
        artifactsVerified: ARTIFACTS,
        checks,
        gaps,
        gateEvidence: gate,
        signOff,
        gateDecision: gate.gateDecision,
        gateDecisionSource: gate.gateDecisionSource,
        note: '本产物是一份独立验证报告；门控结论由 integration/governance/evaluate_gates.js 计算，本报告不判定它',
      }, null, 2) + '\n',
    },
    {
      path: `${REPO}/out/verification/${STAGE}_run_record.json`,
      content: JSON.stringify(runRecord, null, 2) + '\n',
    },
  ] : [],
}
