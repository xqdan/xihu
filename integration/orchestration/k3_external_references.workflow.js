export const meta = {
  name: 'k3-external-references',
  description: '给主 workflow 的 Premises 系数清单找外部参照系：同样的假设在公开资料里落在什么区间，只在隔离命名空间输出，不作为任何 claim 的证据',
  phases: [
    { title: 'Research', detail: '按领域分派，每个领域一个 agent，联网检索公开数据' },
    { title: 'Synthesis', detail: '合并成一份参照系文档 + 结构化条目，隔离标注' },
  ],
}

// 这个 workflow 是 k3_multiteam_review.workflow.js 的旁路，不是它的下游。
// 它回答的问题只有一类：
//   "本项目当作给定条件的那些系数，在公开资料里处于什么区间？"
// 它**不回答**"本项目的数字对不对"——那必须回到仓库文件核验。
//
// 硬性隔离（写进每个 agent 的 prompt，也写进返回值的 note）：
// 1. 外部数字不得作为任何 claim 的 evidence。claim 的 evidence 只能是 文件路径:行号 或 UNVERIFIED。
// 2. 外部数字不得覆盖、修正或被用来重算仓库里的基线值。
// 3. 没有可核查来源、仅凭模型记忆的条目，必须标 evidence_kind=model_memory，并在合成阶段列为 unusable。
// 4. 每条必须写 not_comparable_when：什么情况下这条参照系不适用于本项目。没写边界的参照系是有害的。

const TOPIC = 'K3 P1 候选（TP32 / PP1 / B=1 / Context=1M，目标 1000 TPS/usr、架构冻结门槛 1050 TPS/usr）的冻结门槛评审。本 workflow 只负责为评审中"当作给定条件"的系数找外部参照系。'

const ISOLATION_RULES = [
  '你产出的所有数字都只是**参照系**，不是证据。严禁把它写成"本项目的 X 等于 Y"，只能写成"公开资料显示同类系统的 X 落在 [区间]"。',
  '严禁用外部数字覆盖、修正或重算本项目的任何基线值。本项目当前取值只能原样引用，不得改动。',
  '每条必须有可核查来源（名称 + 年份 + 链接）。拿不到链接的，evidence_kind 必须填 model_memory，并说明这是模型记忆而非检索到的资料。',
  '每条必须写 not_comparable_when：说明这条参照系在什么条件下不适用于本项目（拓扑、规模、精度、负载类型等差异）。写不出边界说明你没想清楚，不要收录。',
  '宁可少而实，不要多而虚。查不到就写 UNVERIFIED 并说明缺什么，不要用相邻领域的数字凑数。',
].join('\n- ')

// 输入：主 workflow 的 premises 字段（推荐），或一串自由文本问题（便于单独试跑）
const rawPremises = (() => {
  const p = args?.premises
  if (Array.isArray(p)) return p
  if (p && Array.isArray(p.premises)) return p.premises
  if (Array.isArray(args?.questions)) {
    return args.questions.map((q, i) => ({ premise_id: `Q${i + 1}`, premise: String(q), current_value: 'UNVERIFIED' }))
  }
  return []
})()
if (!rawPremises.length) {
  throw new Error(
    '需要输入。传 args.premises = 主 workflow 返回值里的 premises 数组（或其整个 premises 对象），' +
    '或传 args.questions = ["系数1叫什么", ...] 便于单独试跑。',
  )
}

// 按领域路由。顺序敏感：先匹配先归属，兜底 other 收剩余项。
const DOMAINS = [
  { key: 'memory', title: '内存子系统与互联效率', match: /MC|HBM|DRAM|带宽|sustained|UCIe|互联|延迟|latency|τ|tau|效率|efficiency/i },
  { key: 'ppa', title: '面积、功耗与封装效率', match: /面积|功耗|power|area|matrix density|TF\/mm|PPA|液冷|散热|封装|floorplan|reticle/i },
  { key: 'model', title: '模型侧参数与量化', match: /MoE|专家|命中率|hit rate|activeParams|精度|precision|FP8|BF16|KV|量化|quant/i },
  { key: 'method', title: '门槛设定与验证方法学', match: /margin|门槛|gate|证据分级|验证|容差|tolerance|baseline|回标/i },
  { key: 'other', title: '其他前提', match: null },
]
const routed = DOMAINS.map((d) => ({ ...d, items: [] }))
for (const p of rawPremises) {
  const text = `${p.premise || ''} ${p.current_value || ''} ${p.refutable_by || ''}`
  const hit = DOMAINS.find((d) => d.match && d.match.test(text))
  const target = hit ? routed.find((r) => r.key === hit.key) : routed.find((r) => r.key === 'other')
  target.items.push(p)
}
const active = routed.filter((d) => d.items.length)
log(`前提 ${rawPremises.length} 条，路由到 ${active.length} 个领域：${active.map((d) => `${d.key}(${d.items.length})`).join('、')}`)

const ENTRY_SCHEMA = {
  type: 'array',
  items: {
    type: 'object',
    properties: {
      ref_id: { type: 'string', description: '形如 REF-MEM-01' },
      topic: { type: 'string', description: '这条参照系回答哪个前提，一句话' },
      premise_ids: { type: 'array', items: { type: 'string' }, description: '对应输入里的 premise_id；对应不上则空数组' },
      typical_range: { type: 'string', description: '公开来源给出的典型区间，带单位；查不到写 UNVERIFIED' },
      common_value: { type: 'string', description: '最常见落点；不确定写 UNVERIFIED' },
      project_value: { type: 'string', description: '本项目当前取值（原样引用输入，不得改动）' },
      relation: { type: 'string', enum: ['within_range', 'at_edge', 'outside_range', 'no_comparable_data'] },
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
      evidence_kind: { type: 'string', enum: ['public_measurement', 'vendor_datasheet', 'industry_survey', 'model_memory'], description: 'model_memory = 没有可核查来源，仅凭模型记忆' },
      not_comparable_when: { type: 'string', description: '什么情况下这条参照系不适用于本项目（必填，不得留空）' },
      actionable: { type: 'string', description: '据此该做什么：去要数据 / 假设合理可保留 / 需要重新推导' },
    },
    required: ['ref_id', 'topic', 'premise_ids', 'typical_range', 'common_value', 'project_value', 'relation', 'sources', 'evidence_kind', 'not_comparable_when', 'actionable'],
  },
}

const researchPrompt = (d) =>
  `你是外部资料调研 agent，负责领域：**${d.title}**。\n\n${TOPIC}\n\n需要找参照系的前提：\n${JSON.stringify(d.items, null, 2)}\n\n任务：\n1. 先用 WebSearch / WebFetch 检索公开资料（厂商数据表、PHY 实测报告、学术论文、行业调研）。如果检索工具不可用，把 search_available 填 false，并且所有条目的 evidence_kind 一律填 model_memory——绝对不要假装检索过。\n2. 对每条前提，给出公开资料中同类系统的取值区间和常见落点。区间要带单位和适用条件。\n3. 填 relation：本项目的取值落在区间内 / 在边缘 / 在区间外 / 没有可比数据。这是本 workflow 最核心的输出——它决定"该不该花力气去要实测数据"。\n4. 每条必须写 not_comparable_when，说明拓扑、规模、精度或负载类型上的差异为什么可能让这条参照系失效。\n5. 如果 references/sota/ 下已有本领域文件，先读它，避免重复调研，只补它没覆盖的缺口，并在 document 里说明哪部分来自已有文件。\n\n不要做的事：\n- 不要评价本项目的结论对不对，那不是你的任务。\n- 不要用外部数字去算本项目的 TPS/usr 或任何派生量。\n- 不要因为"看起来合理"就省略来源。\n\n硬性规则：\n- ${ISOLATION_RULES}`

// 合成必须等所有领域都回来，这里的屏障是必要的
phase('Research')
const researchRaw = await parallel(active.map((d) => () =>
  agent(researchPrompt(d), {
    label: `research:${d.key}`,
    phase: 'Research',
    effort: 'medium',
    schema: {
      type: 'object',
      properties: {
        domain: { type: 'string' },
        entries: ENTRY_SCHEMA,
        search_available: { type: 'boolean', description: '本轮是否真的能联网检索；不能则必须为 false' },
      },
      required: ['domain', 'entries', 'search_available'],
    },
  }),
))
const researchFailures = active.filter((d, i) => !researchRaw[i]).map((d) => d.key)
const research = researchRaw.filter(Boolean)
if (researchFailures.length) log(`警告：以下领域调研失败 ${researchFailures.join(', ')}，对应前提在本轮没有参照系`)

const allEntries = research.flatMap((r) => r.entries || [])
const searched = research.filter((r) => r.search_available).length
log(`调研返回 ${allEntries.length} 条参照系；${searched}/${research.length} 个领域确认可联网检索`)

phase('Synthesis')
const synthesis = await agent(
  `你是参照系合成 agent。把各领域的调研结果合并成一份文档和一组结构化条目。\n\n${TOPIC}\n\n各领域原始输出：\n${JSON.stringify(research, null, 2)}\n\n处理要求：\n1. 按主题（不是按领域）重组文档分节，把讲同一件事的条目合到一起。\n2. **把只有模型记忆、没有可核查来源的条目单独列出 ref_id 放进 unusable**，并说明为什么不采纳。文档正文只保留有来源的条目。\n3. 对每条前提，明确指出它有没有拿到参照系；拿不到的写进 coverage 并说明为什么（太新/太专有/无可比公开数据）。\n4. 条目里 relation=outside_range 或 at_edge 的，在文档里置顶——这些是"该去要实测数据"的信号。\n5. 每条都要保留 not_comparable_when，不得在合成时丢掉适用边界。\n6. 不改动任何 project_value，不新增任何对本项目结论的判断。\n\n硬性规则：\n- ${ISOLATION_RULES}`,
  {
    label: 'synthesis:references',
    phase: 'Synthesis',
    effort: 'medium',
    schema: {
      type: 'object',
      properties: {
        document: { type: 'string', description: 'Markdown 参照系文档，按主题分节' },
        entries: ENTRY_SCHEMA,
        coverage: { type: 'string', description: '哪些前提拿到了参照系、哪些没有、为什么' },
        confidence_summary: { type: 'string', description: '整体可信度：可联网检索的领域几个、只有模型记忆的几条' },
        unusable: { type: 'array', items: { type: 'string' }, description: '只有模型记忆、不可采纳的 ref_id 及其原因' },
      },
      required: ['document', 'entries', 'coverage', 'confidence_summary', 'unusable'],
    },
  },
)
if (!synthesis) throw new Error('合成 agent 失败，本轮没有参照系产出')

const externalReferences = {
  // 隔离命名空间：这个对象不是 ledger 的一部分，任何 agent 都不得把它当 claim 证据引用
  namespace: 'external_references',
  kind: 'reference_only',
  not_evidence: true,
  note: '本对象只用于判断"本项目假设的系数在公开资料中处于什么区间"，不得作为任何 claim 的 evidence，不得覆盖或重算仓库基线。',
  search_available: searched > 0 && searched === research.length,
  domains_researched: research.map((r) => r.domain),
  domains_failed: researchFailures,
  entries: synthesis.entries || [],
  document: synthesis.document,
  coverage: synthesis.coverage,
  confidence_summary: synthesis.confidence_summary,
  unusable: synthesis.unusable || [],
  input_premise_ids: rawPremises.map((p) => p.premise_id),
}

log(`参照系：${externalReferences.entries.length} 条可用，${externalReferences.unusable.length} 条因只有模型记忆被排除`)
log(`落在区间外或边缘的：${externalReferences.entries.filter((e) => e.relation === 'outside_range' || e.relation === 'at_edge').map((e) => e.ref_id).join(', ') || '无'}`)

return externalReferences
