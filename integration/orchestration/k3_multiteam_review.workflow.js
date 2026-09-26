export const meta = {
  name: 'k3-multiteam-review',
  description: '五团队 probe+lead，CLM 独立编号，六接口配对，blocker 全量三视角核验，Council 新增项回核，critic 查漏',
  phases: [
    { title: 'Probe', detail: '11 个窄探针并行，登记职责覆盖' },
    { title: 'Team merge', detail: '5 个 lead 合并本团队 claim，脚本统一编号 CLM-*' },
    { title: 'Interface pairs', detail: '6 个接口按声明双方配对，缺边显式登记' },
    { title: 'Adversarial', detail: 'blocker 全量核验，非 blocker 争议项按团队轮转取样' },
    { title: 'Council', detail: '只吃 ledger，新增项单列，单套验收线' },
    { title: 'Council recheck', detail: 'Council 新增项三视角回核，必要时出增补' },
    { title: 'Critic', detail: '反问漏项与口径' },
  ],
}

const TOPIC = '议题：K3 P1 候选（TP32 / PP1 / B=1 / Context=1M，目标 1000 TPS/usr、架构冻结门槛 1050 TPS/usr）当前距离冻结门槛到底差多少、差距应归因到哪个团队的具体项、由谁负责补齐、以及有哪些未满足前提应当记为 blocker 而不是直接放行。'

const RULES = [
  '只读模式：严禁修改、创建或删除任何文件，包括 out/ 与 teams/*/inputs/。',
  '每个数字必须给出出处（文件路径:行号）。给不出出处的，evidence 字段必须显式写 UNVERIFIED，并说明缺什么。',
  '严格区分 MODEL 等级结论与产品承诺；硬件 peak 不等于 sustained；软件收益必须带实现前提。',
  '严格区分目标 1000 与冻结门槛 1050 两个口径，引用余量、盈亏点、容差时必须写明是对哪一个算的。',
  '不得写入 PASS / D_GATE_PASSED 之类字面量结论，网关结论由 governance 脚本计算。',
  '不要复述仓库文档，只给结论、证据和分歧。',
].join('\n- ')

const SHARED_READS = 'README.md、AGENTS.md、docs/architecture/、integration/、out/、teams/council/adr/'

const TEAMS = [
  { key: 'hardware', prefix: 'HW', owns: ['Package/floorplan', 'AI Core', 'SRAM/TMA', 'MC', 'NoC/Die-to-Die', 'PPA/RAS'] },
  { key: 'software', prefix: 'SW', owns: ['Deployment/runtime', 'compiler', 'kernels', 'fusion', 'collective overlap', 'scheduler', 'profiler'] },
  { key: 'model', prefix: 'MODEL', owns: ['Model manifest', 'workload/operator ledger', 'scenarios', 'routing/sparsity', 'golden traces', 'model KPI'] },
  { key: 'vv', prefix: 'VV', owns: ['schema', 'conservation', 'traceability', 'regression', 'Q-Gate'] },
  { key: 'council', prefix: 'ARCH', owns: ['Requirements', 'contracts', 'ADR', 'candidate integration', 'D-Gate'] },
]
// 仓库外依赖，不属于任何团队，Council 必须显式登记而不是算作"无缺席"
const EXTERNAL_DEPS = ['MC/DRAM 供应商：sustained 效率与命令混合实测（0.7 系数无来源）', '封装/散热供应商：液冷与封装面积可制造性']

const INTERFACES = {
  'hw-sw-abi': { sides: ['hardware', 'software'], desc: 'Hardware × Software：deployment-to-hardware ABI，带宽/时延/DMA 粒度契约，sustained 还是 peak' },
  'workload-operator': { sides: ['model', 'hardware'], desc: 'Model × Hardware：workload/operator contract，逐算子账本与硬件能力是否对得上' },
  'k3-shape': { sides: ['model', 'vv'], desc: 'Model × V&V：K3 形状单一来源（design_engine.js preset）与 manifest/profile/workload 一致性及其测试覆盖' },
  'sw-model-precision': { sides: ['software', 'model'], desc: 'Software × Model：精度政策（FP8 KV 等）、countBasis 折叠合法性、多模型 lowering 与 kernel 映射' },
  'ppa-gap': { sides: ['hardware', 'council'], desc: 'Hardware × Council：面积/功耗/冷却/交付代价与冻结门槛的余量账，含 ADR 对档位的约束' },
  'gate-governance': { sides: ['vv', 'council'], desc: 'V&V × Council：门槛语义与 gate 计算口径、证据等级、测试能否证实门槛结论' },
}
const INTERFACE_LIST = Object.entries(INTERFACES).map(([k, v]) => `  ${k}：${v.desc}`).join('\n')

const PROBES = [
  { team: 'hardware', id: 'HW-A', covers: ['AI Core', 'SRAM/TMA', 'MC', 'NoC/Die-to-Die'],
    task: 'sustained 能力。把当前 P1 候选的 sustained 算力/带宽算出来（不是 peak，必须说明 peak 到 sustained 的折扣依据和出处），指出瓶颈落在哪个硬件单元，并给出对距离 1050 TPS/usr 冻结门槛的量化差距。',
    reads: 'teams/hardware/inputs/（硬件基线规格）、teams/hardware/src/、teams/hardware/docs/02_*.md 到 06_*.md' },
  { team: 'hardware', id: 'HW-C', covers: ['MC', 'NoC/Die-to-Die'],
    task: '对外接口假设。明确列出 Hardware 给 Software 和 Model 的契约数字：带宽、时延、容量各是多少，是 peak 还是 sustained，余量多少。这是你团队的对外承诺，Software/Model 会拿这些数字直接算。',
    reads: 'teams/hardware/contract.json、teams/hardware/inputs/k3_mc_baseline.json、teams/hardware/docs/06_*.md 与 07_*.md' },

  { team: 'software', id: 'SW-A', covers: ['compiler', 'kernels', 'fusion', 'collective overlap', 'scheduler'],
    task: '策略开关与实现前提。列出当前软件优化策略的状态，每项给出收益（单项回退值）与它需要的实现前提（编译期/运行期、依赖哪个硬件特性）。',
    reads: 'teams/software/docs/、teams/software/contract.json、teams/software/src/（若有）' },
  { team: 'software', id: 'SW-C', covers: ['Deployment/runtime', 'profiler'],
    task: '接口假设与证据分级。第一，明确你算性能时假定的带宽/时延取自哪里，是 peak 还是 sustained——如果拿的是 peak，直接说明这是未声明假设。第二，把软件收益分级：已被代码或测试证明 / 仅纸面估计 / 需要重测。',
    reads: 'teams/software/docs/、integration/、out/、tests/ 中与软件收益相关的部分' },

  { team: 'model', id: 'MODEL-A', covers: ['Model manifest'],
    task: '形状单一来源。核验 K3 形状是否只能来自 teams/model/src/design_engine.js 的 preset，有没有被 manifest/profile/planning workload 绕过的路径，以及测试是否真的强制了一致性。',
    reads: 'teams/model/src/design_engine.js、teams/model/inputs/、tests/ 中强制 model 一致性的用例' },
  { team: 'model', id: 'MODEL-C', covers: ['workload/operator ledger', 'scenarios'],
    task: '负载账本与未验证字段。核验 operator ledger / scenario matrix 是否自洽，列出所有仍标记为 UNVERIFIED_PLANNING_MANIFEST 或 MISSING_SOURCE 的字段，并说明每个字段影响哪些结论。',
    reads: 'teams/model/docs/deployment/OPERATOR_LEDGER.md、SCENARIO_MATRIX.md、teams/model/inputs/formal_model_manifests.json、model_profiles.json、model_manifest_qualification_matrix.json' },

  { team: 'vv', id: 'VV-A', covers: ['schema', 'regression', 'traceability'],
    task: '不变量与可绕过规则。列出当前测试真正锁住的不变量，以及哪些规则在结构上可被绕过（团队依赖规则、model 一致性规则、gate 字面量规则）。',
    reads: 'teams/vv/、tests/（含 tests/structure/test_project_structure.js）、package.json' },
  { team: 'vv', id: 'VV-C', covers: ['conservation', 'Q-Gate'],
    task: '不可证伪清单。针对本议题，明确列出哪些声明在原理上无法被现有测试证实（给出被绕过的机制或缺失的回归），并说明为什么现有测试覆盖不到。',
    reads: 'tests/、teams/vv/、integration/governance/、integration/pipelines/' },

  { team: 'council', id: 'ARCH-A', covers: ['Requirements', 'ADR', 'candidate integration', 'D-Gate'],
    task: 'Council 侧的门槛与余量账。核验：(1) 门槛 1050 在 gate 计算链中的真实语义——stage_a.js、evaluate_gates.js、gate_status.json 里 meetsArchitectureGate / directionGate / D-Gate 各按什么口径判定，是否考虑档位能否制造；(2) engineeringMargin 1.17 等决定门槛预算的系数的出处；(3) 面积/封装余量、冷却前提与交付代价，以及现有 ADR（尤其 ADR-0019、ADR-0005）对候选的约束。',
    reads: 'teams/council/adr/、teams/council/docs/、teams/council/inputs/、integration/governance/、integration/pipelines/stage_a.js、out/governance/、docs/architecture/21_TPS_DESIGN_BASELINE.md、docs/architecture/OPEN_ISSUES.md' },

  { team: 'hardware', id: 'HW-P', covers: ['Package/floorplan', 'PPA/RAS'],
    task: 'Package / Power / PPA 账。给出 P1 候选的封装面积、die 面积、卡功耗、SRAM 面积占比、冷却前提各自的预算与当前值及余量（写明出处），说明哪些档位（MC 数量/速率、SRAM 容量、AI Core 数）受面积或功耗卡死；并判断 MC480 以上档位在面积/功耗/冷却上是否可制造。明确 open issue O-015 及类似 PPA 项当前是否有 owner 与证据。',
    reads: 'teams/hardware/docs/09_PACKAGE_POWER_RAS.md、teams/hardware/inputs/、teams/hardware/contract.json、teams/council/adr/（ADR-0019、ADR-0005）、docs/architecture/OPEN_ISSUES.md' },
  { team: 'model', id: 'MODEL-R', covers: ['routing/sparsity', 'golden traces', 'model KPI'],
    task: 'Routing / sparsity 与模型 KPI 前提。核验 MoE 专家预测命中率（如 0.8）、activeParams、专家路由分布这些影响 TPS/usr 的模型侧参数的出处：是来自 golden trace / 实测，还是硬编码常数（给出文件:行号）；每个参数变化对 1050 门槛余量的敏感度（写明口径）；以及当前有没有 golden trace 能证实它们。',
    reads: 'teams/model/src/、teams/model/inputs/、teams/model/docs/、integration/detailed/（特别是 k3_operator_sram_sim.js 与预测命中率相关代码）' },
]

const CLAIM_SCHEMA_PART = {
  type: 'array',
  items: {
    type: 'object',
    properties: {
      claim_id: { type: 'string', description: '临时编号，脚本会统一重编' },
      owner: { type: 'string' },
      statement: { type: 'string', description: '一句话结论' },
      evidence: { type: 'string', description: '文件路径:行号，或 UNVERIFIED: 缺什么' },
      number: { type: 'string', description: '关键数字加单位并注明口径（1000 目标还是 1050 门槛），没有则 none' },
      interfaces: { type: 'array', items: { type: 'string', enum: Object.keys(INTERFACES) } },
      flip_evidence: { type: 'string', description: '哪条证据出现会让你改判' },
      severity: { type: 'string', enum: ['blocker', 'gap', 'info'] },
    },
    required: ['claim_id', 'owner', 'statement', 'evidence', 'number', 'interfaces', 'flip_evidence', 'severity'],
  },
}
const PROBE_SCHEMA = {
  type: 'object',
  properties: { probe: { type: 'string' }, team: { type: 'string' }, claims: CLAIM_SCHEMA_PART },
  required: ['probe', 'team', 'claims'],
}
const LEAD_SCHEMA = {
  type: 'object',
  properties: {
    team: { type: 'string' },
    position: { type: 'string', description: '一句话正式立场：差距多大、卡在谁身上' },
    gap_estimate: { type: 'string' },
    claims: CLAIM_SCHEMA_PART,
    internal_conflicts: { type: 'array', items: { type: 'string' }, description: '本团队内部探针之间的矛盾及你的裁决' },
    we_own: { type: 'array', items: { type: 'string' } },
    blockers: { type: 'array', items: { type: 'string' } },
  },
  required: ['team', 'position', 'gap_estimate', 'claims', 'internal_conflicts', 'we_own', 'blockers'],
}
const PAIR_SCHEMA = {
  type: 'object',
  properties: {
    pairs: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          claim_ids: { type: 'array', items: { type: 'string' } },
          relations: { type: 'array', items: { type: 'string', enum: ['contradict', 'assume', 'incompatible', 'consistent'] } },
          finding: { type: 'string', description: '双方数字在接口处是否真的对得上；对不上则给可核查反证' },
          severity: { type: 'string', enum: ['blocker', 'gap', 'ok'] },
        },
        required: ['claim_ids', 'relations', 'finding', 'severity'],
      },
    },
    mislabeled_claims: { type: 'array', items: { type: 'string' }, description: '被标到本接口、但实际不跨越本接口的 claim_id' },
    interface_verdict: { type: 'string' },
  },
  required: ['pairs', 'mislabeled_claims', 'interface_verdict'],
}
const VERDICT_SCHEMA = {
  type: 'object',
  properties: {
    refuted: { type: 'boolean', description: '拿不出结论时默认 true' },
    basis: { type: 'string' },
  },
  required: ['refuted', 'basis'],
}
const COUNCIL_SCHEMA = {
  type: 'object',
  properties: {
    report: { type: 'string', description: '结构化中文集成报告（Markdown）' },
    new_items: {
      type: 'array',
      description: 'ledger 中不存在、由 Council 自己提出的结论或 blocker，一律放这里，报告中只能以 PENDING 身份引用',
      items: {
        type: 'object',
        properties: {
          item_id: { type: 'string', description: '形如 CLM-NEW-01' },
          statement: { type: 'string' },
          evidence: { type: 'string', description: '文件路径:行号，或 UNVERIFIED' },
          number: { type: 'string' },
          proposed_owner: { type: 'string' },
          proposed_severity: { type: 'string', enum: ['blocker', 'gap', 'info'] },
        },
        required: ['item_id', 'statement', 'evidence', 'number', 'proposed_owner', 'proposed_severity'],
      },
    },
  },
  required: ['report', 'new_items'],
}

const LENSES = [
  { key: 'arithmetic', prompt: '只查算术与单位：这个数字怎么来的、量纲对不对、换算是否漏了效率项或重复扣了效率项。' },
  { key: 'evidence-chain', prompt: '只查证据链：出处是否真实存在且真的支持这句话、是否把未验证假设写成了结论、是否用"预期/应当"掩盖没有测量。' },
  { key: 'basis-consistency', prompt: '只查口径：该数字对应的是目标 1000 还是门槛 1050、标称/peak 还是 sustained、每颗/每 die/每卡、单项回退还是联合、详细模型还是规划模型。口径与 claim 的表述不匹配即判 refuted。' },
]
const judge = (votes) => {
  const returned = votes.filter((v) => v.returned).length
  const refuted = votes.filter((v) => v.refuted === true).length
  const status = refuted >= 2 ? 'killed' : returned < LENSES.length ? 'incomplete' : refuted === 1 ? 'split' : 'survived'
  return { status, refuted, returned }
}
const verifyPrompt = (item, lens) =>
  `你是独立怀疑者，任务是尝试**反驳**以下 claim。默认立场是它站不住，拿不出结论就判 refuted=true。\n\n${TOPIC}\n\n被检验的 claim：\n${JSON.stringify(item, null, 2)}\n\n核验视角（${lens.key}）：${lens.prompt}\n\n只读，不要修改任何文件。回到仓库实际核验，给出文件路径:行号级别的依据，反驳不了才判 refuted=false。`

const stageFailures = { probe: [], lead: [], pair: [], verify: 0, recheck: 0 }

// ---------- Phase 1: probes ----------
phase('Probe')
log(`${PROBES.length} 个窄探针并行，按 AGENTS.md ownership 登记职责覆盖`)

const probeRaw = await parallel(PROBES.map((p) => () =>
  agent(
    `你是本项目 ${p.team} 团队的探针 agent（编号 ${p.id}）。\n\n${TOPIC}\n\n你只负责回答这一个问题：\n${p.task}\n\n先读透：${p.reads}\n需要时再读共享材料（只读）：${SHARED_READS}\n\n输出要求：\n- claims 最多 6 条，每条只讲一个结论。claim_id 用 ${p.id}1、${p.id}2 这样编号，owner 一律填 ${p.team}。\n- interfaces 只标该 claim 真正跨越的接口，标错会导致路由失效。可选接口：\n${INTERFACE_LIST}\n- severity：无法承诺的未满足前提填 blocker，影响结论的差距填 gap，背景事实填 info。\n- 不要写综述，不要铺垫。证据拿不到就写 UNVERIFIED 并说缺什么。\n\n硬性规则：\n- ${RULES}`,
    { label: `probe:${p.id}`, phase: 'Probe', schema: PROBE_SCHEMA },
  )
))
PROBES.forEach((p, i) => { if (!probeRaw[i]) stageFailures.probe.push(p.id) })
const probeResults = probeRaw.map((r, i) => (r ? { ...r, team: PROBES[i].team, probe: PROBES[i].id } : null)).filter(Boolean)
if (stageFailures.probe.length) log(`警告：探针未返回 ${stageFailures.probe.join(', ')}，对应团队覆盖不完整`)

// 职责覆盖：absent_teams 只按团队名单算，这里按 AGENTS.md 的 ownership 逐项算
const coveredBy = {}
PROBES.forEach((p, i) => { if (probeRaw[i]) for (const r of p.covers) (coveredBy[`${p.team}:${r}`] ||= []).push(p.id) })
const uncoveredResponsibilities = TEAMS.flatMap((t) => t.owns.filter((r) => !coveredBy[`${t.key}:${r}`]).map((r) => ({ team: t.key, responsibility: r })))
if (uncoveredResponsibilities.length) log(`职责未被探针覆盖：${uncoveredResponsibilities.map((u) => `${u.team}/${u.responsibility}`).join('、')}`)

// ---------- Phase 2: team leads ----------
phase('Team merge')
log(`${TEAMS.length} 个 lead 并行合并本团队 claim`)

const leadRaw = await parallel(TEAMS.map((t) => async () => {
  const mine = probeResults.filter((r) => r.team === t.key)
  if (!mine.length) return null
  return agent(
    `你是本项目 ${t.key} 团队的 lead，负责把本团队探针的结论合并成团队正式立场。\n\n${TOPIC}\n\n本团队探针原始输出：\n${JSON.stringify(mine, null, 2)}\n\n任务：\n1. 合并去重：同一结论只保留一条，冲突的按证据强弱裁决，把裁决过程写进 internal_conflicts。\n2. claims 上限 12 条，owner 一律填 ${t.key}。claim_id 随便填，脚本会统一重编为 CLM-${t.prefix}-NN（这是 claim 命名空间，与仓库工作项 ${t.prefix}-* 编号无关，不要混用）。\n3. 复核每条 claim 的 interfaces：只保留它真正跨越的接口。接口定义：\n${INTERFACE_LIST}\n4. 重新评定 severity，blocker 从严：只有"未满足且单独就能翻转 1050 门槛结论"或"被现行 ADR 明令禁止"的前提才算 blocker；其余影响结论的差距为 gap，背景事实为 info。探针自评的 blocker 不必保留。\n5. 只输出本团队能负责的结论，不要替其他团队说话；需要别人做的事写进 blockers。\n6. position 一句话说清：差距多大、卡在谁身上。\n\n不得引入探针里没有的新结论；需要新结论请写进 blockers 并说明缺什么证据。\n\n硬性规则：\n- ${RULES}`,
    { label: `lead:${t.key}`, phase: 'Team merge', schema: LEAD_SCHEMA },
  )
}))

const leads = []
TEAMS.forEach((t, i) => {
  const hadProbes = probeResults.some((r) => r.team === t.key)
  if (leadRaw[i]) leads.push({ ...leadRaw[i], team: t.key })
  else if (hadProbes) stageFailures.lead.push(t.key)
})
const absentTeams = TEAMS.map((t) => t.key).filter((k) => !leads.some((l) => l.team === k))
if (absentTeams.length) log(`警告：以下团队本轮无立场（MISSING_OWNER）：${absentTeams.join(', ')}`)
for (const l of leads) log(`${l.team}: ${l.position}`)

// 独立命名空间 CLM-*，避免与仓库工作项 HW-*/MODEL-* 撞名
const allClaims = []
for (const l of leads) {
  const t = TEAMS.find((x) => x.key === l.team)
  ;(l.claims || []).forEach((c, i) => {
    allClaims.push({ ...c, source_id: c.claim_id, claim_id: `CLM-${t.prefix}-${String(i + 1).padStart(2, '0')}`, owner: l.team })
  })
}
log(`共 ${allClaims.length} 条原子 claim，其中 blocker ${allClaims.filter((c) => c.severity === 'blocker').length} 条`)

// ---------- Phase 3: interface pairs ----------
phase('Interface pairs')
const grouped = Object.entries(INTERFACES).map(([key, def]) => {
  const claims = allClaims.filter((c) => (c.interfaces || []).includes(key))
  const teams = Array.from(new Set(claims.map((c) => c.owner)))
  return { key, def, claims, teams, missingSides: def.sides.filter((s) => !teams.includes(s)) }
})
for (const g of grouped) {
  if (g.missingSides.length) log(`接口 ${g.key} 缺少声明方 ${g.missingSides.join(', ')}（单边或空接口）`)
}
const pairable = grouped.filter((g) => g.teams.length >= 2)
const unpairedInterfaces = grouped.filter((g) => g.teams.length < 2).map((g) => ({ interface: g.key, teams: g.teams }))
log(`接口配对：${pairable.length}/${grouped.length} 个接口有 ≥2 个团队的 claim`)

const pairRaw = await parallel(pairable.map((g) => () =>
  agent(
    `你是跨团队接口核验 agent，负责接口 ${g.key}：${g.def.desc}。\n声明双方：${g.def.sides.join(' × ')}；实际提交 claim 的团队：${g.teams.join(', ')}${g.missingSides.length ? `；缺席的声明方：${g.missingSides.join(', ')}，请在 interface_verdict 中说明缺边对结论的影响` : ''}。\n\n${TOPIC}\n\n该接口上的 claim（claim_id 由脚本统一分配，引用时必须原样使用）：\n${JSON.stringify(g.claims, null, 2)}\n\n任务：\n- 只核验这一条接口，不要扩张到其他接口。可以读仓库任何文件来核验（只读）。\n- 找出双方数字在接口处是否真的对得上：一方是否把另一方的 peak 当成了 sustained、是否假定了对方并未承诺的带宽/时延、是否把目标 1000 的余量当成门槛 1050 的余量、单位或口径是否不一致。\n- 一方向另一方提出的需求（例如要求对方给出逐算子数字）若对方 claim 中没有回应，单独列一条 finding，relations 填 assume，并写明"未回应"。\n- 每条 finding 必须给出可核查反证（文件路径:行号），或者明确指出"这是未被证据支持的假设"。\n- 对不上且会改变门槛结论的标 blocker，余量不足或口径瑕疵标 gap，对得上标 ok。blocker 要从严：只有单独就能翻转 1050 门槛结论的才算。\n- 被标到本接口、实际不跨越本接口的 claim 写进 mislabeled_claims。\n\n硬性规则：\n- ${RULES}`,
    { label: `pair:${g.key}`, phase: 'Interface pairs', schema: PAIR_SCHEMA },
  )
))
pairable.forEach((g, i) => { if (!pairRaw[i]) stageFailures.pair.push(g.key) })
if (stageFailures.pair.length) log(`警告：接口核验失败 ${stageFailures.pair.join(', ')}，这些接口在 ledger 中标为 UNVERIFIED_INTERFACE`)

const pairFindings = []
const interfaceVerdicts = []
const mislabeled = []
pairable.forEach((g, i) => {
  const r = pairRaw[i]
  if (!r) return
  interfaceVerdicts.push({ interface: g.key, verdict: r.interface_verdict, missing_sides: g.missingSides })
  for (const p of r.pairs || []) pairFindings.push({ ...p, interface: g.key })
  for (const id of r.mislabeled_claims || []) mislabeled.push({ interface: g.key, claim_id: id })
})

// ---------- Phase 4: adversarial ----------
phase('Adversarial')
const blockerHits = {}
for (const p of pairFindings) {
  if (p.severity !== 'blocker') continue
  for (const id of p.claim_ids || []) blockerHits[id] = (blockerHits[id] || 0) + 1
}
// blocker 一律核验，不设上限；只被接口判 blocker 的非 blocker claim 按团队轮转取样
const mustVerify = allClaims.filter((c) => c.severity === 'blocker')
const interfaceOnly = allClaims.filter((c) => c.severity !== 'blocker' && blockerHits[c.claim_id])
const SAMPLE_CAP = 6
const queues = TEAMS.map((t) => interfaceOnly.filter((c) => c.owner === t.key).sort((a, b) => (blockerHits[b.claim_id] || 0) - (blockerHits[a.claim_id] || 0)))
const sampled = []
for (let round = 0; sampled.length < SAMPLE_CAP; round++) {
  let added = false
  for (const q of queues) {
    if (q[round] && sampled.length < SAMPLE_CAP) { sampled.push(q[round]); added = true }
  }
  if (!added) break
}
const selected = [...mustVerify, ...sampled]
const selectedIds = new Set(selected.map((c) => c.claim_id))
const unverifiedContested = interfaceOnly.filter((c) => !selectedIds.has(c.claim_id))
log(`blocker ${mustVerify.length} 条全量核验；仅被接口判 blocker 的 ${interfaceOnly.length} 条中轮转取样 ${sampled.length} 条`)
TEAMS.forEach((t) => {
  const n = mustVerify.filter((c) => c.owner === t.key).length + interfaceOnly.filter((c) => c.owner === t.key).length
  if (n) log(`  ${t.key}: 核验 ${selected.filter((c) => c.owner === t.key).length}/${n}`)
})
if (unverifiedContested.length) log(`未核验 ${unverifiedContested.length} 条（均非 blocker），已写入 ledger.unverified_contested：${unverifiedContested.map((c) => c.claim_id).join(', ')}`)

const jobs = selected.flatMap((c) => LENSES.map((lens) => ({ c, lens })))
const verdictRaw = await parallel(jobs.map(({ c, lens }) => () =>
  agent(verifyPrompt(c, lens), { label: `verify:${c.claim_id}:${lens.key}`, phase: 'Adversarial', schema: VERDICT_SCHEMA })
))
stageFailures.verify = verdictRaw.filter((v) => !v).length
if (stageFailures.verify) log(`警告：${stageFailures.verify} 个核验 agent 失败，相关 claim 标为 incomplete`)

const collectVotes = (js, raw, id, idKey) => js
  .map((j, i) => ({ j, v: raw[i] }))
  .filter(({ j }) => j.c[idKey] === id)
  .map(({ j, v }) => ({ lens: j.lens.key, returned: !!v, refuted: v ? v.refuted : null, basis: v ? v.basis : 'AGENT_FAILED' }))

const adversarial = selected.map((c) => {
  const votes = collectVotes(jobs, verdictRaw, c.claim_id, 'claim_id')
  return { claim_id: c.claim_id, owner: c.owner, severity: c.severity, statement: c.statement, ...judge(votes), votes }
})
const tally = (arr, s) => arr.filter((a) => a.status === s).length
log(`对抗核验：survived ${tally(adversarial, 'survived')}，split ${tally(adversarial, 'split')}，killed ${tally(adversarial, 'killed')}，incomplete ${tally(adversarial, 'incomplete')}`)

// ---------- Phase 5: council ----------
phase('Council')
const ledger = {
  absent_teams: absentTeams,
  uncovered_responsibilities: uncoveredResponsibilities,
  external_dependencies: EXTERNAL_DEPS,
  stage_failures: stageFailures,
  unpaired_interfaces: unpairedInterfaces,
  mislabeled_claims: mislabeled,
  claims: allClaims,
  team_positions: leads.map((l) => ({ team: l.team, position: l.position, gap_estimate: l.gap_estimate, blockers: l.blockers, internal_conflicts: l.internal_conflicts })),
  interface_verdicts: interfaceVerdicts,
  interface_findings: pairFindings,
  adversarial,
  unverified_contested: unverifiedContested.map((c) => ({ claim_id: c.claim_id, owner: c.owner, statement: c.statement, severity: c.severity })),
}

const councilOut = await agent(
  `你是 Architecture Council，负责跨团队集成与 ADR。\n\n${TOPIC}\n\n下面是本轮全部机器可读输入（ledger）：\n${JSON.stringify(ledger, null, 2)}\n\n你的任务（写进 report）：\n1. 给出当前 P1 候选距离 1050 TPS/usr 冻结门槛的差距结论，并说明它建立在哪些证据上、哪些还是假设；若差距来自未在约束内重新搜索的外推，必须写明是上界/下界。\n2. 把差距逐项归因到 Hardware / Software / Model / V&V / Council 的具体项，每项给 owner 与可核查的交付指标。\n3. 出 ADR 要点草案（decision、status、consequences），明确哪些现在就能定、哪些必须等证据；涉及团队间 owner 争议（如 FP8 KV 精度归属）的，只能写成 ADR 待决项，不得直接裁决。\n4. 保留 dissent，不要强行统一；明确哪些项记为 blocker 而不是放行。\n\n必须显式处理的 ledger 字段：\n- absent_teams / uncovered_responsibilities / external_dependencies / stage_failures / unpaired_interfaces：逐项声明本轮缺了什么；缺席团队与未覆盖职责相关项标 MISSING_OWNER，仓库外依赖标 EXTERNAL_DEPENDENCY，不得用其他团队结论代填。\n- adversarial：status=killed 的不得作为结论依据；status=split 的只能作为"有争议"列出，写明反驳视角与反驳理由，不得根据单票收窄、改写或推翻原 claim；incomplete 视同未核验。\n- unverified_contested：以它们为依据的项必须标注"未经对抗核验"。\n- mislabeled_claims：说明路由错误是否影响了某个接口的结论。\n\n新增项规则：ledger 中不存在的结论、数字或 blocker，一律写进 new_items（item_id 用 CLM-NEW-NN），report 中只能以"CLM-NEW-NN（PENDING，待回核）"身份引用，不得作为冻结结论依据。它们会在你之后被独立回核。\n\nblocker 去重：同一根因的 blocker 只保留一条，其余写成"见 X"，不得重复计数。\n\n验收线规则：只能出**一套**验收线。要么给联合分配（各项之和不超过 1050 门槛的实际余量，并写明未计入的项），要么只给单项盈亏点并明确声明"单项验收线不能同时压线"。不得两套并列。\n\n治理约束：不得写入 PASS / D_GATE_PASSED 字面量；不得把软件纸面收益当已验证收益；不得把硬件 peak 当 sustained；不得把目标 1000 的余量当门槛 1050 的余量；K3 形状只能来自 teams/model/src/design_engine.js 的 preset。\n只读，不要修改任何文件。`,
  { label: 'council:integration', phase: 'Council', schema: COUNCIL_SCHEMA },
)
const council = councilOut ? councilOut.report : 'COUNCIL_FAILED'
const newItems = councilOut ? councilOut.new_items || [] : []
log(`Council 提出 ${newItems.length} 条 ledger 外新增项，进入回核`)

// ---------- Phase 6: recheck council new items ----------
phase('Council recheck')
const recheckJobs = newItems.flatMap((c) => LENSES.map((lens) => ({ c, lens })))
const recheckRaw = await parallel(recheckJobs.map(({ c, lens }) => () =>
  agent(verifyPrompt(c, lens), { label: `recheck:${c.item_id}:${lens.key}`, phase: 'Council recheck', schema: VERDICT_SCHEMA })
))
stageFailures.recheck = recheckRaw.filter((v) => !v).length
const newItemVerdicts = newItems.map((c) => {
  const votes = collectVotes(recheckJobs, recheckRaw, c.item_id, 'item_id')
  return { ...c, ...judge(votes), votes }
})
log(`新增项回核：survived ${tally(newItemVerdicts, 'survived')}，split ${tally(newItemVerdicts, 'split')}，killed ${tally(newItemVerdicts, 'killed')}，incomplete ${tally(newItemVerdicts, 'incomplete')}`)

let addendum = null
if (newItemVerdicts.some((v) => v.status !== 'survived')) {
  addendum = await agent(
    `你是 Architecture Council。你上一版集成报告中的 ledger 外新增项已被独立回核，结果如下：\n${JSON.stringify(newItemVerdicts, null, 2)}\n\n你的上一版报告：\n${council}\n\n请只输出一份简短增补（Markdown）：\n1. 列出 killed 的新增项，并说明报告中哪些结论、blocker、验收线因此撤回或改写。\n2. 列出 split / incomplete 的新增项，改标为"有争议/未核验"，说明对结论的影响。\n3. 给出修订后的 blocker 清单（只含 ledger 内经核验存活或未被否掉的项，以及回核 survived 的新增项）。\n不要重写整份报告。只读，不要修改任何文件。`,
    { label: 'council:addendum', phase: 'Council recheck' },
  )
}

// ---------- Phase 7: critic ----------
phase('Critic')
const critic = await agent(
  `你是 Completeness critic，唯一任务是找出集成报告和本轮流程**漏掉了什么**。\n\n${TOPIC}\n\n本轮 ledger：\n${JSON.stringify(ledger, null, 2)}\n\nCouncil 集成报告：\n${council}\n\nCouncil 新增项回核结果：\n${JSON.stringify(newItemVerdicts.map((v) => ({ item_id: v.item_id, statement: v.statement, status: v.status })), null, 2)}\n\nCouncil 增补：\n${addendum || '（无，新增项全部存活或没有新增项）'}\n\n请回答：\n1. 哪些 claim 从未被任何核验视角碰过？对照 claims 全集、interface_findings 的 claim_ids、adversarial 覆盖。\n2. 哪个接口没有配对成功或只有单边、哪些接口需求未被回应？\n3. 有没有哪条结论在报告里被写成了定论，但证据只是 flip_evidence 还没出现的假设？有没有 split 项被单票改写？\n4. 报告是否只有一套验收线？有没有把同一份余量分配给多条验收线、或混用 1000 与 1050 口径？\n5. uncovered_responsibilities 与 external_dependencies 是否被正确处理？\n6. 本轮没有跑到的角度是什么？\n7. 你的发现构成下一轮该派什么 agent 的清单。\n\n只读，不要修改任何文件。中文输出，直接给漏项清单，不要复述报告。`,
  { label: 'critic:gaps', phase: 'Critic' },
)

return { leads, claims: allClaims, interfaceVerdicts, pairFindings, mislabeled, adversarial, unverifiedContested, uncoveredResponsibilities, stageFailures, absentTeams, unpairedInterfaces, council, newItemVerdicts, addendum, critic }
