export const meta = {
  name: 'design-learn',
  description: '一次性学习：每个学习单元总结本领域的 SOTA/经典方案，产出待落盘的 references/sota/ 知识卡。知识不是证据，不进 ledger，只在领域专家实例的 prompt 里作参照',
  whenToUse: 'X/L 组的一次性脚本，不参与常规阶段链。学完把产物落盘到 references/sota/，之后各领域 workflow 直接读档注入，不再联网。刷新某个领域用 args.units 只跑那几个单元。',
  phases: [
    { title: 'Learn', detail: '按学习单元分派，每个单元联网调研本领域 SOTA 与经典方案' },
    { title: 'Synthesize', detail: '合并成知识库文档 + 结构化卡片，剔除无来源条目' },
  ],
}

// 这是一个**一次性**脚本：学完把产物落盘到 references/sota/，之后各领域 workflow 直接读档注入，不再联网。
// 想刷新某个领域时重跑，用 args.units 只跑那几个单元。
//
// 为什么需要它
// ------------
// 各阶段的核验视角（arithmetic / evidence-chain / basis-consistency）只能验**证据**，
// 验不了"这个假设是否偏离行业常规"。于是出现一种盲区：
//   τ=1.15、MC 效率 0.7、UCIe 0.8 这些系数，既没有出处（所以标 UNVERIFIED），
//   也不知道离常规有多远（所以不知道该不该花力气去要实测）。
// 本脚本补的是后半句：给每个领域的专家实例一份"行业通常怎么做、通常取多少"的底稿。
//
// 硬性边界（写进每个 agent 的 prompt）
// -----------------------------------
// 1. 知识点**不是证据**。它没有 path:line，过不了任何核验视角，永远不得作为任何 claim 的 evidence。
// 2. 不得用外部数字覆盖、修正或重算仓库基线。
// 3. 没有可核查来源的条目必须标 confidence=model_memory，合成阶段列入 unusable 并剔除。
// 4. 每条必须写 not_applicable_when：什么情况下这条不适用于本项目。写不出边界的知识是有害的
//    ——没有边界的前沿方案会被当成万能类比，反而降低结论质量。
//
// 产物去向与绑定（这条是本节的重点）
// ---------------------------------
// 本脚本落 references/sota/README.md + references/sota/<unit>.md。
// "落盘"本身不产生价值——**有人读才算**。所以每个单元都登记了它被哪一格注入：
//
//   memory-subsystem         → design.sram / design.mc / design.arch.direction 的 memory-expert 实例
//   interconnect-collective  → design.comm / design.arch.direction 的 comm-expert 实例
//   compute-core             → design.compute / design.arch.direction 的 compute-expert 实例
//   model-workload           → design.req.workload / design.arch.direction 的 model-expert 实例
//   package-ppa              → design.physical / design.arch.direction 的 physical-expert 实例
//   sustained-tps            → design.arch.direction 的 architect 实例
//   evidence-governance      → design.audit 的 verifier 实例
//
// 注入的是**文件路径**，不是正文内容。理由与策略正文相同：注入路径，实例自己去读，
// 全文只有一份来源；把几千字知识抄进 prompt，就出现了第二份会各自漂移的来源。
//
// 与 design.audit 那一段外部参照系的分工
// -------------------------------------
//   design.audit 的参照系阶段：按**前提**临时调研，服务于某一轮复核，回答"这个系数偏离常规吗"。
//   design.learn              ：按**agent**一次性沉淀，服务于长期，回答"这个领域通常怎么做"。
// 前者每轮可能重跑，后者学一次存档；前者输入是 premises，后者输入是学习单元。

const TOPIC =
  'K3 P1 候选：7-reticle 单芯片，TP32 / PP1 / B=1 / Context=1M，目标 1000 TPS/usr，架构冻结门槛 1050 TPS/usr。' +
  '部署 GLM-5.2 与 DeepSeek-V4-Pro 这类 MoE 大模型，关注 compute、memory、NoC、collective、PPA、精度与证据治理。'

// as_of：脚本里取不到当前时间（取时间会破坏 resume），所以日期只能从 args 传入。
// 拿不到就写 UNVERIFIED，不猜。
const AS_OF = typeof args?.as_of === 'string' && args.as_of ? args.as_of : 'UNVERIFIED'
// 每条知识的复审周期（月）。到期后该单元值得重跑，避免知识库悄悄过期。
const REVIEW_DUE_MONTHS = Number.isInteger(args?.review_due_months) ? args.review_due_months : 12

const ISOLATION_RULES = [
  '你产出的所有内容都是**知识**，不是**证据**。严禁写成"本项目的 X 等于 Y"，只能写成"公开资料/行业实践中，同类问题的常规做法与典型取值是……"。',
  '严禁用你查到的数字覆盖、修正或重算本项目的任何基线值。本项目取值只能原样引用，不得改动，也不得据此下"本项目对不对"的结论。',
  '每条必须有可核查来源（名称 + 年份 + 链接）。拿不到链接的，confidence 必须填 model_memory，并说明这是模型记忆而非检索到的资料。',
  '每条必须写 not_applicable_when：说明这条知识在什么条件下不适用于本项目（拓扑、规模、精度、负载类型、代际差异等）。写不出边界的条目不要收录——没有边界的参照系会被当成万能类比。',
  '宁可少而实，不要多而虚。查不到就写 UNVERIFIED 并说明缺什么，不要用相邻领域的数字凑数。',
  '不许把"某厂商声称"写成"业界共识"。厂商自述、论文实测、行业调研要分开标 confidence。',
].join('\n- ')

// 学习单元 = 各领域 workflow 里专家实例真正会来查的问题域。
// 不按 12 个策略角色拆：角色粒度太细会得到一堆互相重复的文档，
// 而单元粒度正好是"运行时真正会来查的知识"。
// consumedBy 是这张表存在的理由——学出来的东西没人读，等于没学。
const UNITS = [
  {
    key: 'memory-subsystem',
    title: '内存子系统与 MC 效率',
    as_of: '2026-01',
    consumedBy: 'design.sram / design.mc / design.arch.direction 的 memory-expert 实例',
    focus:
      'HBM/DRAM 控制器的 sustained 效率（raw→effective 折扣的实际分布）、命令混合与 refresh 的影响、' +
      'bank/row 冲突下的可达带宽、QoS 与多租户干扰、容量与带宽的权衡、' +
      '如何从 datasheet 的 peak 推出可承诺的 sustained（行业上通行的做法与折减区间）',
    premises: 'MC 效率 0.7、MC 档位 320/400/480/560/640 GB/s/颗',
  },
  {
    key: 'interconnect-collective',
    title: '互联、Die-to-Die 与集合通信',
    as_of: '2026-01',
    consumedBy: 'design.comm / design.arch.direction 的 comm-expert 实例',
    focus:
      'UCIe/Die-to-Die 的协议效率与有效带宽折减、PHY/SerDes 每 hop 时延的典型量级、' +
      'ring 与 hierarchical allreduce 的 hop/链路数与可达时延、TP 规模扩大时 collective 的占比演化、' +
      '通信与计算 overlap 的成熟度与失效条件、RDMA/scale-out 的时延构成',
    premises: 'τ=1.15、UCIe 0.8、TP32 下的 allreduce 开销',
  },
  {
    key: 'compute-core',
    title: 'AI Core、阵列利用率与片上存储',
    as_of: '2026-01',
    consumedBy: 'design.compute / design.arch.direction 的 compute-expert 实例',
    focus:
      'peak 到 sustained 的算力折减（阵列填充率、kernel 级利用率的实测分布）、' +
      '脉动阵列/张量核在 MoE 与 attention 上的实际利用率、tiling 与数据复用对有效算力的影响、' +
      'TMA/DMA 与计算的 overlap 程度、local/shared SRAM 的带宽与容量权衡、SRAM 带宽随精度切换的变化',
    premises: 'matrix density 3.2、阵列填充率、shared SRAM 余量依赖 FP8 KV',
  },
  {
    key: 'model-workload',
    title: 'MoE 推理的模型侧参数与量化',
    as_of: '2026-01',
    consumedBy: 'design.req.workload / design.arch.direction 的 model-expert 实例',
    focus:
      'MoE 专家预测命中率的公开实测区间、activeParams 与路由分布对吞吐的影响、' +
      'FP8/BF16 混合精度下 KV cache 与权重的实际开销、量化的精度-吞吐权衡与失效模式、' +
      '长上下文（1M 级）下的 KV 管理与稀疏化方案',
    premises: '专家命中率 0.8、activeParams、FP8 KV',
  },
  {
    key: 'sustained-tps',
    title: '推理系统的端到端吞吐账与 SLO 口径',
    as_of: '2026-01',
    consumedBy: 'design.arch.direction 的 architect 实例（方向级粗估的口径参照）',
    focus:
      'TPS/usr 这类指标在公开资料里的定义分歧、batch=1 与 batch>1 的口径差异、' +
      'decode 阶段的内存带宽下界估算方法（bytes/token 推导）、' +
      '为什么端到端吞吐几乎总是 memory-bound、以及行业上如何声明与验证 sustained 吞吐',
    premises: '1000 目标 vs 1050 门槛、B=1、Memory-bound 判断',
  },
  {
    key: 'evidence-governance',
    title: '门槛设定、余量与证据分级方法学',
    as_of: '2026-01',
    consumedBy: 'design.audit 的 verifier 实例（判定"出处的性质撑不撑得起结论"时的行业参照）',
    focus:
      '工程余量（margin）在架构冻结门槛上的通行取法与依据、' +
      '硬件项目里证据分级（实测/仿真/纸面推算）的组织方式与签核规则、' +
      '假设未取证时如何记账（ASS/U待办机制）、' +
      '哪些量在行业实践中被认为必须实测而不能靠推算放行',
    premises: 'engineeringMargin 1.17、门槛 1050 的语义、UNVERIFIED 项的处理',
  },
  {
    key: 'package-ppa',
    title: '封装、面积、功耗与热',
    as_of: '2026-01',
    consumedBy: 'design.physical / design.arch.direction 的 physical-expert 实例',
    focus:
      '多 die/多 reticle 封装的面积与 RDL/PHY 开销占比、' +
      '面积受限时提高内存带宽的可行路径（堆叠、封装内互联、外挂）、' +
      '高功耗密度下的液冷可制造性边界、' +
      '功耗/热约束如何反过来锁死 MC 档位与核心数',
    premises: '7-reticle、封装面积锁死 MC 颗数、液冷前提',
  },
]

const ONLY = Array.isArray(args?.units) ? args.units : null
if (ONLY) {
  if (!ONLY.length) throw new Error('args.units 为空数组；省略该参数表示学全部单元')
  const unknown = ONLY.filter((k) => !UNITS.some((u) => u.key === k))
  if (unknown.length) {
    throw new Error(`args.units 含未知单元：${unknown.join(', ')}；可选：${UNITS.map((u) => u.key).join(', ')}`)
  }
}
const ACTIVE = ONLY ? UNITS.filter((u) => ONLY.includes(u.key)) : UNITS

// 额外追问：args.questions 里的问题会附加到每个单元，供一次性补课用
const EXTRA = Array.isArray(args?.questions) ? args.questions.filter((q) => typeof q === 'string' && q.trim()) : []
log(`学习单元 ${ACTIVE.length} 个：${ACTIVE.map((u) => u.key).join('、')}；as_of=${AS_OF}${EXTRA.length ? `；附加追问 ${EXTRA.length} 条` : ''}`)

const CARD_SCHEMA = {
  type: 'array',
  items: {
    type: 'object',
    properties: {
      card_id: { type: 'string', description: '形如 SOTA-MEM-01，前缀按单元，编号从 01 起' },
      topic: { type: 'string', description: '这条知识解决什么问题，一句话' },
      approach: { type: 'string', description: '方案名（如 ring allreduce、HBM3e pseudo-channel 模式）' },
      what_it_is: { type: 'string', description: '方案本身是什么，2-3 句，让没读过的 agent 能懂' },
      who_uses_it: { type: 'string', description: '谁在用，用在哪一代/什么规模的系统上' },
      typical_numbers: { type: 'string', description: '公开资料给出的典型取值或区间，带单位和适用条件；查不到写 UNVERIFIED' },
      applies_when: { type: 'string', description: '什么条件下这个方案适用' },
      not_applicable_when: { type: 'string', description: '什么条件下不适用于本项目（必填，不得留空）' },
      project_premises: { type: 'string', description: '本项目哪个假设与之相关（原样引用输入里的系数名，不改动取值）' },
      what_to_check_here: { type: 'string', description: '据此本项目该去核什么：找谁要数据、核哪一行、重算哪个量' },
      sources: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            name: { type: 'string', description: '来源名称（厂商文档/论文/行业报告）' },
            year: { type: 'string' },
            url: { type: 'string', description: '可访问链接；拿不到写 UNVERIFIED' },
          },
          required: ['name', 'year', 'url'],
        },
      },
      confidence: {
        type: 'string',
        enum: ['public_measurement', 'vendor_datasheet', 'industry_survey', 'model_memory'],
        description: 'model_memory = 没有可核查来源，仅凭模型记忆',
      },
      relative_validity: { type: 'string', description: '相对有效期：这条结论半衰期多长（如"约 2 年，随 HBM 代际变化"）；不确定写 UNVERIFIED' },
    },
    required: [
      'card_id', 'topic', 'approach', 'what_it_is', 'who_uses_it', 'typical_numbers',
      'applies_when', 'not_applicable_when', 'project_premises', 'what_to_check_here',
      'sources', 'confidence', 'relative_validity',
    ],
  },
}

const learnPrompt = (u) =>
  `你是本领域的技术调研 agent，负责领域：**${u.title}**。\n\n${TOPIC}\n\n` +
  `知识 horizon（as_of）：**${u.as_of}**。只收录该日期及以前公开发布的资料；document 的 as_of 处原样写这个值，` +
  `查不到发布日期就按它写，**不要自己另选一个日期**。\n\n` +
  `本项目在该领域当作给定条件的系数/假设（**原样引用，不得改动**）：${u.premises}\n\n` +
  `需要你总结的方向：\n${u.focus}\n\n` +
  (EXTRA.length ? `额外追问（本轮必须覆盖）：\n- ${EXTRA.join('\n- ')}\n\n` : '') +
  `任务：\n` +
  `1. 先用 WebSearch / WebFetch 检索公开资料（厂商数据表、论文、行业报告、开源实现文档）。` +
  `如果检索工具不可用，把 search_available 填 false，且所有条目 confidence 一律填 model_memory——绝对不要假装检索过。\n` +
  `2. 总结本领域的**SOTA 方案**与**经典方案**（经典方案同样重要：很多项目的假设其实来自上一代通行做法，知道它就能判断"是不是落后了"）。\n` +
  `3. 每条的 typical_numbers 要给带单位和适用条件的区间，不要只给一个数。\n` +
  `4. what_to_check_here 是给后续专家实例用的行动项：本项目该去核哪个文件、找哪个供应商、重算哪个量。写成可执行的，不要写"需要注意"。\n` +
  `5. 如果 references/sota/ 下已有本领域的文件，先读它，避免重复调研，只补它没覆盖的缺口，并在 document 里说明哪部分沿用已有文件。\n\n` +
  `不要做的事：\n` +
  `- 不要评价本项目结论对不对，那不是你的任务。\n` +
  `- 不要用外部数字去算本项目的 TPS/usr 或任何派生量。\n` +
  `- 不要因为"看起来合理"就省略来源。\n\n` +
  `硬性规则：\n- ${ISOLATION_RULES}`

phase('Learn')
// 各单元互不依赖，但合成需要全部到齐，所以这里用 barrier 是对的
const raw = await parallel(
  ACTIVE.map((u) => () =>
    agent(learnPrompt(u), {
      label: `learn:${u.key}`,
      phase: 'Learn',
      effort: 'medium',
      schema: {
        type: 'object',
        properties: {
          unit: { type: 'string' },
          title: { type: 'string' },
          document: { type: 'string', description: '该领域的知识文档（Markdown），按方案分节；供 references/sota/<unit>.md 直接落盘' },
          cards: CARD_SCHEMA,
          search_available: { type: 'boolean', description: '本轮是否真的能联网检索；不能则必须为 false' },
          unresolved: { type: 'string', description: '本领域公开资料里查不到、只能靠实测或供应商确认的部分' },
        },
        required: ['unit', 'title', 'document', 'cards', 'search_available', 'unresolved'],
      },
    }),
  ),
)

const failed = ACTIVE.filter((u, i) => !raw[i]).map((u) => u.key)
const learned = raw.filter(Boolean)
if (failed.length) log(`警告：以下单元学习失败 ${failed.join(', ')}，本轮对应领域没有知识产出`)
const searched = learned.filter((r) => r.search_available).length
log(`${learned.length}/${ACTIVE.length} 个单元返回；${searched} 个确认可联网检索；共 ${learned.reduce((n, r) => n + (r.cards || []).length, 0)} 条卡片`)

phase('Synthesize')
const synthesis = await agent(
  `你是知识库合成 agent。把各领域的调研结果整理成一份可落盘的知识库。\n\n${TOPIC}\n\n` +
  `各领域原始输出：\n${JSON.stringify(learned, null, 2)}\n\n` +
  `处理要求：\n` +
  `1. 产出 index_document：一份总索引（Markdown），说明本知识库是什么、**不是证据**、怎么用（供各领域专家实例作参照，不得当 evidence），` +
  `列出每个领域文件及其覆盖范围；各单元的知识 horizon 是 ${[...new Set(ACTIVE.map((u) => u.as_of))].join(' / ')}，` +
  `逐文件写明，不要给全库一个统一日期（各领域资料的时效不同）。\n` +
  `2. 每个领域的 document 原样保留（可修错别字、去掉内部矛盾），作为 references/sota/<unit>.md 的内容。\n` +
  `3. **把 confidence=model_memory 的卡片单独列出 card_id 放进 quarantined**，说明为什么不采纳。` +
  `正文与结构化卡片里都要剔除它们——这是防止模型记忆被当成行业事实的关键一步。\n` +
  `4. 合并重复卡片：不同单元讲同一件事的，保留信息更全的一条，其余在 deduped 里说明并入了谁。\n` +
  `5. 保留每条的 not_applicable_when，不得在合成时丢掉适用边界。\n` +
  `6. 不改动任何 project_premises 里的取值，不新增任何对本项目结论的判断。\n` +
  `7. 挑出 8-15 条最该优先核实的 what_to_check_here，按"核实后能否改变 1050 结论"排序，放进 first_checks。\n\n` +
  `硬性规则：\n- ${ISOLATION_RULES}`,
  {
    label: 'synthesis:knowledge',
    phase: 'Synthesize',
    effort: 'high',
    schema: {
      type: 'object',
      properties: {
        index_document: { type: 'string', description: '知识库总索引（Markdown），含 as_of 与使用边界' },
        documents: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              unit: { type: 'string', description: '单元 key，文件名用 references/sota/<unit>.md' },
              title: { type: 'string' },
              content: { type: 'string', description: '该领域知识文档正文（Markdown）' },
            },
            required: ['unit', 'title', 'content'],
          },
        },
        cards: CARD_SCHEMA,
        first_checks: { type: 'array', items: { type: 'string' }, description: '最该优先核实的行动项，按影响力排序' },
        coverage: { type: 'string', description: '哪些单元产出了、哪些没有、各自覆盖了什么' },
        confidence_summary: { type: 'string', description: '整体可信度：几个单元可联网检索、几条只有模型记忆' },
        quarantined: { type: 'array', items: { type: 'string' }, description: '因只有模型记忆而被剔除的 card_id 及原因' },
        deduped: { type: 'array', items: { type: 'string' }, description: '被合并掉的重复卡片说明' },
      },
      required: ['index_document', 'documents', 'cards', 'first_checks', 'coverage', 'confidence_summary', 'quarantined', 'deduped'],
    },
  },
)
if (!synthesis) throw new Error('合成 agent 失败，本轮没有知识产出')

// 落盘说明：脚本本身没有文件系统权限，workflow agent 也只读。
// 主循环拿到这个对象后，按 files 数组写入 references/sota/，再提交。
const files = [
  {
    path: 'references/sota/README.md',
    content: synthesis.index_document,
  },
  ...(synthesis.documents || []).map((d) => ({
    path: `references/sota/${d.unit}.md`,
    content: d.content,
  })),
]

const knowledgeBase = {
  namespace: 'sota_knowledge',
  kind: 'knowledge_not_evidence',
  not_evidence: true,
  as_of: AS_OF,
  unit_as_of: Object.fromEntries(learned.map((r) => [r.unit, ACTIVE.find((u) => u.key === r.unit)?.as_of || AS_OF])),
  review_due_months: REVIEW_DUE_MONTHS,
  note:
    '本对象是**知识**不是**证据**。它没有 path:line，不得作为任何 claim 的 evidence，不得覆盖或重算仓库基线，' +
    '只能在领域专家/verifier 实例的 prompt 里以**路径**形式注入，作为"行业通常怎么做"的参照。有疑问时以仓库文件为准。',
  // 绑定登记：哪个单元的产物被哪一格注入。落盘只是前提，被读到才算数。
  // 各领域 workflow 按这张表注入路径；表与实现不一致时以各 workflow 的注入点为准。
  binding: Object.fromEntries(ACTIVE.map((u) => [u.key, u.consumedBy])),
  units_learned: learned.map((r) => r.unit),
  units_failed: failed,
  search_available: searched > 0 && searched === learned.length,
  files,
  cards: synthesis.cards || [],
  first_checks: synthesis.first_checks || [],
  coverage: synthesis.coverage,
  confidence_summary: synthesis.confidence_summary,
  quarantined: synthesis.quarantined || [],
  deduped: synthesis.deduped || [],
  unresolved: learned.map((r) => ({ unit: r.unit, unresolved: r.unresolved })),
}

log(`知识库：${knowledgeBase.files.length} 个待落盘文件，${knowledgeBase.cards.length} 条可用卡片，${knowledgeBase.quarantined.length} 条因只有模型记忆被隔离`)
log(`落盘目标：${files.map((f) => f.path).join('、')}`)
log(`优先核实项 ${knowledgeBase.first_checks.length} 条`)

return knowledgeBase
