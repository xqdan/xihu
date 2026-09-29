export const meta = {
  name: 'k3-multiteam-review',
  description: '五团队 probe+lead，CLM 独立编号，六接口配对，blocker 全量三视角核验，Council 新增项回核，critic 查漏',
  phases: [
    { title: 'Probe', detail: '7 个窄探针，按团队串成 probe→lead 链，团队之间不设屏障' },
    { title: 'Team merge', detail: '5 个 lead 合并本团队 claim，脚本统一编号 CLM-*' },
    { title: 'Interface pairs', detail: '6 个接口按声明双方配对，缺边显式登记' },
    { title: 'Premises', detail: '三个未回标系数 + 门槛本身：被推翻时结论往哪走' },
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

// 一次性学习沉淀下来的领域知识（references/sota/）。它**不是证据**：
// 没有 path:line，过不了三视角核验，不得作为任何 claim 的 evidence、不得覆盖仓库基线。
// 用途只有一个——判断某个假设是否偏离行业常规，从而知道该不该花力气去要实测。
const SOTA_READS = 'references/sota/（若存在：领域 SOTA/经典方案知识库。仅供判断"本项目的假设是否偏离常规"，引用时必须标为知识而非证据，且不得用它改写任何仓库数字）'

const TEAMS = [
  { key: 'hardware', prefix: 'HW', owns: ['Package/floorplan', 'AI Core', 'SRAM/TMA', 'MC', 'NoC/Die-to-Die', 'Collective/RDMA', 'Comm Core', 'PPA/RAS'] },
  { key: 'software', prefix: 'SW', owns: ['Deployment/runtime', 'compiler', 'kernels', 'fusion', 'collective overlap', 'scheduler', 'profiler'] },
  { key: 'model', prefix: 'MODEL', owns: ['Model manifest', 'workload/operator ledger', 'scenarios', 'routing/sparsity', 'golden traces', 'model KPI'] },
  { key: 'vv', prefix: 'VV', owns: ['schema', 'conservation', 'traceability', 'regression', 'Q-Gate'] },
  { key: 'council', prefix: 'ARCH', owns: ['Requirements', 'contracts', 'ADR', 'candidate integration', 'D-Gate'] },
]
// smoke test 开关：args.teams 只跑指定团队；args.stopAfter === 'merge' 在 lead 合并后直接返回，不进下游阶段
const ONLY = Array.isArray(args?.teams) ? args.teams : null
if (ONLY) {
  if (!ONLY.length) throw new Error('args.teams 为空数组；省略该参数表示跑全部团队')
  const unknown = ONLY.filter((k) => !TEAMS.some((t) => t.key === k))
  if (unknown.length) throw new Error(`args.teams 含未知团队：${unknown.join(', ')}；可选：${TEAMS.map((t) => t.key).join(', ')}`)
}
const ACTIVE_TEAMS = ONLY ? TEAMS.filter((t) => ONLY.includes(t.key)) : TEAMS
const ACTIVE_PROBES_FILTER = (p) => ACTIVE_TEAMS.some((t) => t.key === p.team)
const STOP_AFTER_MERGE = args?.stopAfter === 'merge'

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

// 7 个探针。HW-A 拆成 HW-MC（决定门槛结论的瓶颈项）与 HW-A（余量项），
// 因为 MC 档位是唯一能翻转 1050 结论的变量，不该和一个管四条 ownership 的探针挤 6 条 claim。
// 集合通信并入 HW-MC：它的带宽账与 MC sustained 是同一笔账（不新增第 8 个探针），
// 但 ownership 上归 HW-05 NoC/Die-to-Die，且 τ 的物理拆分是 blocker B-008 的直接取证方向。
// covers 仍按 AGENTS.md 的 ownership 全覆盖。
const PROBES = [
  { team: 'hardware', id: 'HW-MC', covers: ['MC', 'NoC/Die-to-Die', 'Collective/RDMA', 'Comm Core'],
    task: '内存子系统、互联与集合通信：这是本议题的瓶颈域，必须深入，不要与其他硬件单元混谈。第一，把当前 P1 候选的 MC sustained 带宽算出来（不是 peak）：raw 带宽、效率折扣、sustained、有效 DMA 占用，逐项给出处；效率折扣（如 0.7）如果没有供应商或 PHY 实测支撑，明确标 UNVERIFIED 并说明缺什么。第二，给出 MC 各档位（320/400/480/560/640 GB/s/颗）对应的 TPS/usr 与对 1050 门槛的余量，写明是 MODEL 推算还是有模拟点支撑；指出盈亏点带宽。第三，UCIe/NoC 端口带宽是否构成约束，给出与 MC sustained 的比值。第四，明确列出 Hardware 给 Software 和 Model 的内存侧契约：带宽、时延、容量各是多少，是 peak 还是 sustained，余量多少——Software/Model 会拿这些数字直接算。第五，MC 颗数是否受封装面积锁死，能否靠加颗数补带宽。第六，集合通信（collective）单独拆开算，它是同一笔带宽账的另一半，不能只当余量项：把通信时延 τ 的物理构成逐项拆出来（hop 数、单 hop PHY/SerDes 时延、协议开销、交换级数），每项给出处，推不出来的明确写 UNVERIFIED 并说明需要哪一份实测；给出 TP32 下 allreduce 的算法与拓扑选择（ring / hierarchical / 全互联）分别需要多少 hop、多少条链路、在 MC sustained 上占多大比例；指出 collective 与计算/DMA 能否 overlap，以及不可 overlap 的部分对 TPS/usr 的影响。第七，集合通信的控制路径（HW-07 Comm Core）：读 out/detailed/comm_core_design.json（搜索选出的最终方案）和设计空间 teams/hardware/inputs/comm_core_design_space.json，核验每类集合通信的协议时间加控制路径（触发、graph 读取、WQE 下发、doorbell、完成通知）是否仍低于 spec τ、raw 预算内的控制路径上限是多少；控制路径 cycle 数是 ASSUMPTION 还是有 RTL/周期模型支撑；固件或 AI Core 是否出现在每次集合通信的关键路径上；设计空间是否漏掉了应比较的备选方案。',
    reads: 'teams/hardware/inputs/k3_mc_baseline.json、teams/hardware/src/、teams/hardware/contract.json、teams/hardware/docs/ 中 MC/NoC/Die-to-Die/Collective/RDMA 相关文档、teams/council/adr/（ADR-0019、ADR-0005、ADR-0022）、teams/hardware/inputs/comm_core_design_space.json、out/detailed/comm_core_design.json' },
  { team: 'hardware', id: 'HW-A', covers: ['AI Core', 'SRAM/TMA'],
    task: '算力与片上存储：sustained 算力与 SRAM/TMA 的对外契约。第一，把 P1 候选的 sustained 算力算出来（不是 peak），必须说明 peak 到 sustained 的折扣依据和出处；如果同一份硬件存在两套 sustained 口径，一并列出并说明差异。第二，核验阵列填充率、kernel 级利用率是否有实测或波形支撑，还是固定假设；发布点 compute 时间与 DMA 时间的比值是多少。第三，片上 shared SRAM 容量与带宽的余量，以及该余量依赖哪个精度前提（如 FP8 KV）；换精度后是否还成立。第四，明确列出 Memory 侧以外的硬件契约数字（算力、TMA、SRAM 带宽）是 peak 还是 sustained。第五，Matrix:Vector 配比：读 out/detailed/matrix_vector_balance.json，按核类（L/H）核验 vector 工作（解包、KV/index key 反量化、softmax、indexer top-k）能否被同 kernel 的矩阵时间掩盖；指出当前配比下哪些 kernel 掩盖不住、暴露多少 µs，结论依赖的前提（原生 FP8/MXFP4 张量输入 O-012、exp SFU、vector 操作计数）和支持的模型范围（只有 K3 还是三模型）。',
    reads: 'teams/hardware/inputs/（硬件基线规格）、teams/hardware/src/resource_profiles.js、teams/hardware/contract.json、teams/hardware/docs/02_*.md 到 07_*.md、out/detailed/matrix_vector_balance.json' },
  { team: 'hardware', id: 'HW-P', covers: ['Package/floorplan', 'PPA/RAS'],
    task: 'Package / Power / PPA 账。给出 P1 候选的封装面积、die 面积、卡功耗、SRAM 面积占比、冷却前提各自的预算与当前值及余量（写明出处），说明哪些档位（MC 数量/速率、SRAM 容量、AI Core 数）受面积或功耗卡死；并判断 MC480 以上档位在面积/功耗/冷却上是否可制造。明确 open issue O-015 及类似 PPA 项当前是否有 owner 与证据。',
    reads: 'teams/hardware/docs/09_PACKAGE_POWER_RAS.md、teams/hardware/inputs/、teams/hardware/contract.json、teams/council/adr/（ADR-0019、ADR-0005）、docs/architecture/OPEN_ISSUES.md' },

  { team: 'software', id: 'SW-A', covers: ['Deployment/runtime', 'compiler', 'kernels', 'fusion', 'collective overlap', 'scheduler', 'profiler'],
    task: '策略开关、实现前提与证据分级（原 SW-A + SW-C 合并）。第一，列出当前软件优化策略的状态，每项给出收益（单项回退值）与它需要的实现前提（编译期/运行期、依赖哪个硬件特性）。第二，明确你算性能时假定的带宽/时延取自哪里，是 peak 还是 sustained——如果拿的是 peak，直接说明这是未声明假设。第三，把软件收益分级：已被代码或测试证明 / 仅纸面估计 / 需要重测。',
    reads: 'teams/software/docs/、teams/software/contract.json、teams/software/src/（若有）、integration/、out/、tests/ 中与软件收益相关的部分' },

  { team: 'model', id: 'MODEL-A', covers: ['Model manifest', 'workload/operator ledger', 'scenarios', 'routing/sparsity', 'golden traces', 'model KPI'],
    task: '形状单一来源 + 负载账本 + 模型侧 KPI 前提（原 MODEL-A + MODEL-C + MODEL-R 合并，注意本体量大，控制在 6 条 claim 内）。第一，核验 K3 形状是否只能来自 teams/model/src/design_engine.js 的 preset，有没有被 manifest/profile/planning workload 绕过的路径，测试是否真的强制了一致性。第二，核验 operator ledger / scenario matrix 是否自洽，列出仍标记为 UNVERIFIED_PLANNING_MANIFEST 或 MISSING_SOURCE 的字段，说明每个字段影响哪些结论。第三，核验 MoE 专家预测命中率（如 0.8）、activeParams、专家路由分布这些影响 TPS/usr 的参数的出处：是来自 golden trace/实测，还是硬编码常数（给出文件:行号）；并给出它们对 1050 门槛余量的敏感度（写明口径）。',
    reads: 'teams/model/src/design_engine.js、teams/model/inputs/、teams/model/docs/deployment/OPERATOR_LEDGER.md、SCENARIO_MATRIX.md、integration/detailed/k3_operator_sram_sim.js、tests/ 中强制 model 一致性的用例' },

  { team: 'vv', id: 'VV-A', covers: ['schema', 'conservation', 'traceability', 'regression', 'Q-Gate'],
    task: '不变量、可绕过规则与不可证伪清单（原 VV-A + VV-C 合并）。第一，列出当前测试真正锁住的不变量，以及哪些规则在结构上可被绕过（团队依赖规则、model 一致性规则、gate 字面量规则）。第二，针对本议题，明确列出哪些声明在原理上无法被现有测试证实（给出被绕过的机制或缺失的回归），并说明为什么现有测试覆盖不到。',
    reads: 'teams/vv/、tests/（含 tests/structure/test_project_structure.js）、integration/governance/、integration/pipelines/、package.json' },

  { team: 'council', id: 'ARCH-A', covers: ['Requirements', 'contracts', 'ADR', 'candidate integration', 'D-Gate'],
    task: 'Council 侧的门槛与余量账。核验：(1) 门槛 1050 在 gate 计算链中的真实语义——stage_a.js、evaluate_gates.js、gate_status.json 里 meetsArchitectureGate / directionGate / D-Gate 各按什么口径判定，是否考虑档位能否制造；(2) engineeringMargin 1.17 等决定门槛预算的系数的出处；(3) 面积/封装余量、冷却前提与交付代价，以及现有 ADR（尤其 ADR-0019、ADR-0005）对候选的约束。',
    reads: 'teams/council/adr/、teams/council/docs/、teams/council/inputs/、integration/governance/、integration/pipelines/stage_a.js、out/governance/、docs/architecture/21_TPS_DESIGN_BASELINE.md、docs/architecture/OPEN_ISSUES.md' },
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

// ---------- Phase 1+2: 每团队 probe → lead 串成一条独立链 ----------
// 不用 parallel 屏障：任一团队的探针跑完就立刻进 lead，不等其他团队。
// 已完成的 agent 会写进 journal，中途被打断后续跑可命中缓存。
phase('Probe')
const ACTIVE_PROBES = PROBES.filter(ACTIVE_PROBES_FILTER)
if (ONLY) log(`smoke test：只跑团队 ${ACTIVE_TEAMS.map((t) => t.key).join(', ')}${STOP_AFTER_MERGE ? '，lead 合并后停止' : ''}`)
log(`${ACTIVE_PROBES.length} 个窄探针按 ${ACTIVE_TEAMS.length} 个团队串联，团队之间不设屏障`)

const teamChains = await pipeline(
  ACTIVE_TEAMS,
  // 阶段 1：本团队的全部探针并行
  (t) => parallel(PROBES.filter((p) => p.team === t.key).map((p) => () =>
    agent(
      `你是本项目 ${p.team} 团队的探针 agent（编号 ${p.id}）。\n\n${TOPIC}\n\n你只负责回答这一个问题：\n${p.task}\n\n先读透：${p.reads}\n需要时再读共享材料（只读）：${SHARED_READS}\n领域参照（若已落盘，只读）：${SOTA_READS}\n\n输出要求：\n- claims 最多 6 条，每条只讲一个结论。claim_id 用 ${p.id}1、${p.id}2 这样编号，owner 一律填 ${p.team}。\n- interfaces 只标该 claim 真正跨越的接口，标错会导致路由失效。可选接口：\n${INTERFACE_LIST}\n- severity：无法承诺的未满足前提填 blocker，影响结论的差距填 gap，背景事实填 info。\n- 当某个系数没有仓库出处（UNVERIFIED）时，如果 references/sota/ 显示它明显偏离行业常规，在 statement 里写明"该取值偏离常规区间，值得优先取证"——但**不得引用外部数字作为 evidence**，evidence 仍然只能写 UNVERIFIED。\n- 不要写综述，不要铺垫。证据拿不到就写 UNVERIFIED 并说缺什么。\n\n硬性规则：\n- ${RULES}\n- references/sota/ 是知识不是证据：不得作为 claim 的 evidence，不得覆盖或重算仓库数字。`,
      { label: `probe:${p.id}`, phase: 'Probe', schema: PROBE_SCHEMA, effort: 'medium' },
    ).then((r) => (r ? { ...r, team: p.team, probe: p.id } : null))
  )),
  // 阶段 2：本团队 lead 合并（不等其他团队）
  (raws, t) => {
    const mine = (raws || []).filter(Boolean)
    const got = new Set(mine.map((r) => r.probe))
    const lost = PROBES.filter((p) => p.team === t.key && !got.has(p.id)).map((p) => p.id)
    if (!mine.length && !lost.length) return { team: t.key, lead: null, probes: [] }
    // 探针失败的团队照样进 lead，但必须让 lead 知道自己缺了哪一块
    const coverage = lost.length
      ? `\n\n注意：本团队探针 ${lost.join(', ')} 本轮未返回任何结果，你手上的输入**不完整**。必须在 position 里明确写出"因 ${lost.join(', ')} 缺失，本团队立场未覆盖 X"，缺的那部分写进 blockers（owner 填 ${t.key}，说明需补跑哪个探针）或 internal_conflicts，不得用现有材料推断代替，也不要把它写成一条正常结论。`
      : ''
    return agent(
      `你是本项目 ${t.key} 团队的 lead，负责把本团队探针的结论合并成团队正式立场。\n\n${TOPIC}\n\n本团队探针原始输出：\n${JSON.stringify(mine, null, 2)}${coverage}\n\n任务：\n1. 合并去重：同一结论只保留一条，冲突的按证据强弱裁决，把裁决过程写进 internal_conflicts。\n2. claims 上限 12 条，owner 一律填 ${t.key}。claim_id 随便填，脚本会统一重编为 CLM-${t.prefix}-NN（这是 claim 命名空间，与仓库工作项 ${t.prefix}-* 编号无关，不要混用）。\n3. 复核每条 claim 的 interfaces：只保留它真正跨越的接口。接口定义：\n${INTERFACE_LIST}\n4. 重新评定 severity，blocker 从严：只有"未满足且单独就能翻转 1050 门槛结论"或"被现行 ADR 明令禁止"的前提才算 blocker；其余影响结论的差距为 gap，背景事实为 info。探针自评的 blocker 不必保留。\n5. 只输出本团队能负责的结论，不要替其他团队说话；需要别人做的事写进 blockers。\n6. position 一句话说清：差距多大、卡在谁身上。\n\n不得引入探针里没有的新结论；需要新结论请写进 blockers 并说明缺什么证据。\n\n硬性规则：\n- ${RULES}`,
      { label: `lead:${t.key}`, phase: 'Team merge', schema: LEAD_SCHEMA, effort: 'medium' },
    ).then((lead) => ({ team: t.key, lead, probes: mine }))
  },
)

const chains = teamChains.filter(Boolean)
const probeResults = chains.flatMap((c) => c.probes)

const returnedProbeIds = new Set(probeResults.map((r) => r.probe))
ACTIVE_PROBES.forEach((p) => { if (!returnedProbeIds.has(p.id)) stageFailures.probe.push(p.id) })
if (stageFailures.probe.length) log(`警告：探针未返回 ${stageFailures.probe.join(', ')}，对应团队覆盖不完整`)

// 职责覆盖：absent_teams 只按团队名单算，这里按 AGENTS.md 的 ownership 逐项算
const coveredBy = {}
for (const r of probeResults) {
  const p = PROBES.find((x) => x.id === r.probe)
  if (p) for (const own of p.covers) (coveredBy[`${p.team}:${own}`] ||= []).push(p.id)
}
const uncoveredResponsibilities = ACTIVE_TEAMS.flatMap((t) => t.owns.filter((r) => !coveredBy[`${t.key}:${r}`]).map((r) => ({ team: t.key, responsibility: r })))
if (uncoveredResponsibilities.length) log(`职责未被探针覆盖：${uncoveredResponsibilities.map((u) => `${u.team}/${u.responsibility}`).join('、')}`)

phase('Team merge')
log(`${ACTIVE_TEAMS.length} 个 lead 随各自团队链完成，不互相等待`)

const leads = []
for (const c of chains) {
  if (c.lead) leads.push({ ...c.lead, team: c.team })
  else stageFailures.lead.push(c.team)
}
const absentTeams = ACTIVE_TEAMS.map((t) => t.key).filter((k) => !leads.some((l) => l.team === k))
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

if (STOP_AFTER_MERGE) {
  log('stopAfter=merge：跳过接口配对、对抗核验、Council 与 Critic')
  return { leads, claims: allClaims, uncoveredResponsibilities, stageFailures, absentTeams }
}

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
    { label: `pair:${g.key}`, phase: 'Interface pairs', schema: PAIR_SCHEMA, effort: 'high' },
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

// ---------- Phase 3.5: premises ----------
// 结论建立在若干未回标的系数与门槛本身上。这一阶段不改写任何 claim，
// 只回答"如果某个前提被推翻，结论往哪个方向走、走多少、还有没有能过门槛的区间"。
phase('Premises')
const PREMISE_SCHEMA = {
  type: 'object',
  properties: {
    premises: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          premise_id: { type: 'string', description: '形如 PREM-01' },
          premise: { type: 'string', description: '被当作给定的前提，写清它当前的取值与出处' },
          held_by: { type: 'array', items: { type: 'string' }, description: '依赖它的 claim_id 列表' },
          current_value: { type: 'string', description: '当前取值 + 单位 + 口径（1000 目标还是 1050 门槛）' },
          if_weaker: { type: 'string', description: '这个前提比现在差时，门槛结论怎么变；给方向和量级' },
          if_stronger: { type: 'string', description: '比现在好时怎么变；给方向和量级' },
          flip_point: { type: 'string', description: '使结论翻转到达到/达不到门槛的临界取值；算不出写 UNVERIFIED 并说明缺什么' },
          refutable_by: { type: 'string', description: '什么样的证据能推翻或坐实它（供应商数据表 / PHY 实测 / 综合结果 / 回归测试）' },
          action: { type: 'string', description: '要不要去要这个证据；要的话谁去要、要什么' },
          direction: { type: 'string', enum: ['premise_may_be_wrong', 'premise_holds', 'unknown'] },
        },
        required: ['premise_id', 'premise', 'held_by', 'current_value', 'if_weaker', 'if_stronger', 'flip_point', 'refutable_by', 'action', 'direction'],
      },
    },
    threshold_question: { type: 'string', description: '门槛 1050 本身是不是问对了：它现在挡住的差距是真实能力差距，还是系数不确定性的产物' },
    reachable_window: { type: 'string', description: '在所有前提都取有证据支持的取值时，可达 TPS/usr 的区间；写明是界还是点' },
  },
  required: ['premises', 'threshold_question', 'reachable_window'],
}
const premiseOut = await agent(
  `你是敏感性分析 agent，任务是质疑本轮结论所依赖的**前提**，而不是复核结论本身。\n\n${TOPIC}\n\n本轮全部 claim（claim_id 原样引用）：\n${JSON.stringify(allClaims, null, 2)}\n\n本轮对抗核验结果：\n${JSON.stringify(adversarial.map((a) => ({ claim_id: a.claim_id, status: a.status })), null, 2)}\n\n任务：\n1. 列出被当作给定条件、但本身没有回标的系数与前提。至少覆盖：MC sustained 效率 0.7（无供应商实测）、UCIe 效率 0.8、engineeringMargin 1.17、PPA matrix density 3.2 TF/mm²、τ=1.15 µs、MoE 专家命中率。仓库里还有别的就一并列出。\n2. 对每个前提，用现有数字做敏感性：它比现在差/好时，1050 门槛结论往哪个方向走、大致走多少。算术必须写出步骤，不要只给结论。\n3. 对每个前提给出 flip_point：使它翻转到"达到门槛"的临界取值是多少——这个数才决定"我们是在追一个够得着的目标，还是在追一个系数假设"。算不出就写 UNVERIFIED 并说明缺哪个输入。\n4. 回答 threshold_question：结合 reachable_window，1050 这个门槛当前挡住的，是真实的能力差距，还是主要是系数不确定性。\n5. 你**不修改任何 claim**，也不新增 blocker；你的产出是敏感性结论和证据需求，供 Council 与 Critic 使用。\n\n只读，不要修改任何文件。\n硬性规则：\n- ${RULES}`,
  { label: 'premises:sensitivity', phase: 'Premises', schema: PREMISE_SCHEMA, effort: 'high' },
)
const premises = premiseOut || { premises: [], threshold_question: 'PREMISES_FAILED', reachable_window: 'PREMISES_FAILED' }
if (!premiseOut) stageFailures.premises = 1
log(`前提敏感性：${(premises.premises || []).length} 条前提，其中 ${(premises.premises || []).filter((p) => p.direction === 'premise_may_be_wrong').length} 条可能站不住`)

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
  agent(verifyPrompt(c, lens), { label: `verify:${c.claim_id}:${lens.key}`, phase: 'Adversarial', schema: VERDICT_SCHEMA, effort: 'high' })
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

// ---------- Phase 4.5: evidence requests ----------
// blocker 的性质基本是"求证据"而不是"改代码"：要供应商数据表、PHY 实测、综合结果。
// 把这些 flip_evidence 聚合成一张可派发的清单，这才是"补差距"这个动作的输入。
phase('Evidence requests')
const blockClaims = allClaims.filter((c) => c.severity === 'blocker')
const arithHits = new Set(adversarial.filter((a) => a.status === 'killed').map((a) => a.claim_id))
const evReqRaw = blockClaims.length
  ? await agent(
    `你是证据需求整理 agent。本轮 blocker 的翻转条件（flip_evidence）散落在各条 claim 上，请把它们聚合成一张可派发的"取证清单"。\n\n${TOPIC}\n\n本轮全部 blocker：\n${JSON.stringify(blockClaims, null, 2)}\n\n前提敏感性分析（含每条前提的 refutable_by 与 flip_point）：\n${JSON.stringify(premises, null, 2)}\n\n对抗核验中已 killed 的 blocker（这些不必再取证，直接标注即可）：\n${JSON.stringify(Array.from(arithHits))}\n\n任务：\n- 同一份证据能同时解决多条 blocker 的，合并成一条需求，claim_ids 列全，不要重复开单。\n- 每单必须写清：要什么数据（具体到字段/测试项）、找谁要（供应商/封装厂/实测/综合/仓库内）、拿到后哪个数字会变成什么、没有它结论卡在哪。\n- 按"没有它就无法冻结"排序，只把真正的关键路径标 critical=true。\n- 不给建议、不复述 claim，只出清单。\n\n只读，不要修改任何文件。硬性规则：\n- ${RULES}`,
    {
      label: 'evidence:requests',
      phase: 'Evidence requests',
      effort: 'medium',
      schema: {
        type: 'object',
        properties: {
          requests: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                request_id: { type: 'string', description: '形如 EVID-01' },
                item: { type: 'string', description: '要什么，具体到字段或测试项' },
                source: { type: 'string', description: '供应商 / 封装厂 / PHY 实测 / 综合结果 / 仓库内可补' },
                who: { type: 'string', description: '建议的 owner 团队（hardware/software/model/vv/council）' },
                claim_ids: { type: 'array', items: { type: 'string' } },
                unblocks: { type: 'string', description: '拿到后哪个数字会变成什么' },
                blocked_without: { type: 'string', description: '没有它，结论卡在哪一步' },
                critical: { type: 'boolean' },
              },
              required: ['request_id', 'item', 'source', 'who', 'claim_ids', 'unblocks', 'blocked_without', 'critical'],
            },
          },
          killed_blockers: { type: 'array', items: { type: 'string' }, description: '核验已 killed、无需取证的 blocker claim_id' },
        },
        required: ['requests', 'killed_blockers'],
      },
    },
  )
  : null
const evidenceRequests = evReqRaw ? evReqRaw.requests || [] : []
if (blockClaims.length && !evReqRaw) stageFailures.evidenceRequests = 1
log(`取证清单：${evidenceRequests.length} 条需求，其中关键路径 ${evidenceRequests.filter((r) => r.critical).length} 条`)

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
  premises,
  evidence_requests: evidenceRequests,
  unverified_contested: unverifiedContested.map((c) => ({ claim_id: c.claim_id, owner: c.owner, statement: c.statement, severity: c.severity })),
}

const councilOut = await agent(
  `你是 Architecture Council，负责跨团队集成与 ADR。\n\n${TOPIC}\n\n下面是本轮全部机器可读输入（ledger）：\n${JSON.stringify(ledger, null, 2)}\n\n你的任务（写进 report）：\n1. 给出当前 P1 候选距离 1050 TPS/usr 冻结门槛的差距结论，并说明它建立在哪些证据上、哪些还是假设；若差距来自未在约束内重新搜索的外推，必须写明是上界/下界。\n2. 把差距逐项归因到 Hardware / Software / Model / V&V / Council 的具体项，每项给 owner 与可核查的交付指标。\n3. 出 ADR 要点草案（decision、status、consequences），明确哪些现在就能定、哪些必须等证据；涉及团队间 owner 争议（如 FP8 KV 精度归属）的，只能写成 ADR 待决项，不得直接裁决。\n4. 保留 dissent，不要强行统一；明确哪些项记为 blocker 而不是放行。\n\n必须显式处理的 ledger 字段：\n- absent_teams / uncovered_responsibilities / external_dependencies / stage_failures / unpaired_interfaces：逐项声明本轮缺了什么；缺席团队与未覆盖职责相关项标 MISSING_OWNER，仓库外依赖标 EXTERNAL_DEPENDENCY，不得用其他团队结论代填。\n- adversarial：status=killed 的不得作为结论依据；status=split 的只能作为"有争议"列出，写明反驳视角与反驳理由，不得根据单票收窄、改写或推翻原 claim；incomplete 视同未核验。\n- unverified_contested：以它们为依据的项必须标注"未经对抗核验"。\n- premises：每条前提的 direction=premise_may_be_wrong 时，必须说明依赖它的结论要不要降级；threshold_question 与 reachable_window 必须正面回答——如果 1050 当前挡住的差距主要是系数不确定性而不是能力差距，必须在 report 里明说，并给出需要回标的系数清单，不得只报差距数字。\n- evidence_requests：这是本轮的交付物之一，必须在 report 里以清单形式给出，标明关键路径项；report 的"下一步"只能由它和 next_actions 构成。\n- next_actions：每条必须带 owner、交付指标、依赖的 evidence_request（若有），可被直接派发。不得写"继续观察"这类无法验收的项。\n- mislabeled_claims：说明路由错误是否影响了某个接口的结论。\n\n新增项规则：ledger 中不存在的结论、数字或 blocker，一律写进 new_items（item_id 用 CLM-NEW-NN），report 中只能以"CLM-NEW-NN（PENDING，待回核）"身份引用，不得作为冻结结论依据。它们会在你之后被独立回核。\n\nblocker 去重：同一根因的 blocker 只保留一条，其余写成"见 X"，不得重复计数。\n\n验收线规则：只能出**一套**验收线。要么给联合分配（各项之和不超过 1050 门槛的实际余量，并写明未计入的项），要么只给单项盈亏点并明确声明"单项验收线不能同时压线"。不得两套并列。\n\n治理约束：不得写入 PASS / D_GATE_PASSED 字面量；不得把软件纸面收益当已验证收益；不得把硬件 peak 当 sustained；不得把目标 1000 的余量当门槛 1050 的余量；K3 形状只能来自 teams/model/src/design_engine.js 的 preset。\n只读，不要修改任何文件。`,
  { label: 'council:integration', phase: 'Council', schema: COUNCIL_SCHEMA, effort: 'high' },
)
const council = councilOut ? councilOut.report : 'COUNCIL_FAILED'
const newItems = councilOut ? councilOut.new_items || [] : []
log(`Council 提出 ${newItems.length} 条 ledger 外新增项，进入回核`)

// ---------- Phase 6: recheck council new items ----------
phase('Council recheck')
const recheckJobs = newItems.flatMap((c) => LENSES.map((lens) => ({ c, lens })))
const recheckRaw = await parallel(recheckJobs.map(({ c, lens }) => () =>
  agent(verifyPrompt(c, lens), { label: `recheck:${c.item_id}:${lens.key}`, phase: 'Council recheck', schema: VERDICT_SCHEMA, effort: 'high' })
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
    { label: 'council:addendum', phase: 'Council recheck', effort: 'medium' },
  )
}

// ---------- Phase 7: critic ----------
phase('Critic')
const critic = await agent(
  `你是 Completeness critic，唯一任务是找出集成报告和本轮流程**漏掉了什么**。\n\n${TOPIC}\n\n本轮 ledger：\n${JSON.stringify(ledger, null, 2)}\n\nCouncil 集成报告：\n${council}\n\nCouncil 新增项回核结果：\n${JSON.stringify(newItemVerdicts.map((v) => ({ item_id: v.item_id, statement: v.statement, status: v.status })), null, 2)}\n\nCouncil 增补：\n${addendum || '（无，新增项全部存活或没有新增项）'}\n\n请回答：\n1. 哪些 claim 从未被任何核验视角碰过？对照 claims 全集、interface_findings 的 claim_ids、adversarial 覆盖。\n2. 哪个接口没有配对成功或只有单边、哪些接口需求未被回应？\n3. 有没有哪条结论在报告里被写成了定论，但证据只是 flip_evidence 还没出现的假设？有没有 split 项被单票改写？\n4. 报告是否只有一套验收线？有没有把同一份余量分配给多条验收线、或混用 1000 与 1050 口径？\n5. uncovered_responsibilities 与 external_dependencies 是否被正确处理？\n6. premises 里 direction=premise_may_be_wrong 的前提，报告有没有如实降级结论？threshold_question 有没有被正面回答，还是绕开了？\n7. evidence_requests 与报告里的"下一步"对得上吗？有没有 report 里承诺了但清单里没有的取证，或清单里有而 report 没提的关键路径？是否有 blocker 没有任何取证单覆盖？\n8. 本轮没有跑到的角度是什么？\n9. 你的发现构成下一轮该派什么 agent 的清单。\n\n只读，不要修改任何文件。中文输出，直接给漏项清单，不要复述报告。`,
  { label: 'critic:gaps', phase: 'Critic', effort: 'high' },
)

// run_id 必须确定性：脚本里不能用 Date.now()/Math.random()，否则 resume 失效。
// 用 claim 内容算一个短哈希，内容相同则 run_id 相同，跨轮对比才成立。
const fingerprint = (s) => {
  let h = 2166136261
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619) }
  return (h >>> 0).toString(16).padStart(8, '0')
}
const runId = 'k3rev-' + fingerprint(JSON.stringify({ c: allClaims.map((c) => [c.claim_id, c.statement, c.severity]), a: adversarial.map((a) => [a.claim_id, a.status]), p: (premises.premises || []).map((p) => [p.premise_id, p.direction]) }))

return { runId, claims_hash: runId.slice(6), leads, claims: allClaims, interfaceVerdicts, pairFindings, mislabeled, adversarial, premises, evidenceRequests, unverifiedContested, uncoveredResponsibilities, stageFailures, absentTeams, unpairedInterfaces, council, newItemVerdicts, addendum, critic }
