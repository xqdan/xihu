export const meta = {
  name: 'design-explore',
  description: 'K3 设计的受控逃生口（X 组）：单个策略实例、无并行、无检点、无门控。用于走一遍正规 workflow 不值得、但确实需要一次自由探索的问题。产物只落 scratch/explore_<runId>.md，明文不得写 out/、不得进 ledger、不得作为任何 claim 的证据',
  whenToUse: 'X 组。需要 args.brief（stage=explore）与 args.runId。**这是例外通道，不是捷径**：能把问题放进正规 workflow 的就放进去。运行前先问一句"这个结论将来会被谁引用"——如果答案不是"没有人，只是我自己要看"，本格就用错了。',
  phases: [
    { title: 'Explore', detail: '单个实例自由探索；无并行、无检点、无门控' },
    { title: 'Scratch landing', detail: '只落 scratch/；脚本侧硬拒任何 out/ 路径' },
  ],
}

// ---------------------------------------------------------------------------
// X 组 explore。计划 §5.3 定义的**受控逃生口**。
//
// 原文："单个策略实例，无并行、无检点；明文规定只许写 scratch/，
//        不许写 out/、不许进 ledger、不许作为任何 claim 的证据；
//        每次运行必须落盘一份 scratch/explore_<runId>.md 记录读了什么、判断了什么。"
//
// ---------------------------------------------------------------------------
// 为什么需要这样一个东西
//
// 正规 workflow 的每一格都要付代价：并行实例、独立检点、门控证据、ledger 条目。
// 这些代价换来的是结论可被引用。但设计过程中确实存在一类问题——
// "这个方向大概走不通吧"、"这两个方案哪个更像个坑"——它们需要一次自由探索，
// 却完全不值得为此跑一遍四阶段流水线。
//
// 没有逃生口的后果不是"省下探索"，而是**探索会伪装成正规产物**：
// 一个 agent 在自己那格里顺手把这事想一遍，结论混进了别的阶段的输出，
// 于是它既没有正规产物的证据链，又享受着正规产物的权威。
// 逃生口存在的意义，就是让这类探索有一个**明确标记为不可引用**的去处。
//
// ---------------------------------------------------------------------------
// 三条禁令是本格的全部安全性所在
//
// 1. 不许写 out/           —— out/ 里的一切都可被引用。探索结论一旦落进去，
//                            就获得了它不该有的证据地位。
// 2. 不许进 ledger         —— ledger 是跨阶段的状态载体，唯一条目都会影响后续判断。
// 3. 不许作为任何 claim 的证据 —— 这条靠前两条保证，但也要写在产物里，
//                            因为读产物的人可能不知道它是什么。
//
// 脚本侧的硬保证是第 1 条：返回的 files[].path 只要不含 /scratch/，
// 或者含 /out/，本格直接抛错而不是落盘。prompt 里的规则是请求，脚本里的规则是事实——
// 这一条在整个 S7 里出现三次（verify / audit / explore 的 intake），
// 每次都是为了同一件事：把安全边界从"被相信"变成"被强制"。
//
// 与另外三格的另一个区别：**没有 ok 门**。
// verify / audit / backflow 都在"结论不自洽"时返回 files: [] 不落盘。
// 本格必须落盘——§5.3 要求"每次运行必须落盘一份 scratch/explore_<runId>.md"。
// 一份探索记录的价值恰恰在于它记下了**走过的弯路**；探索失败时尤其需要它。
// 因此这里不设通过条件，只设落盘位置的强制。
// ---------------------------------------------------------------------------

const REPO = args.repo || '.'
const STAGE = 'explore'
const BRIEF = args.brief
const RUN_ID = args.runId
const QUESTION = args.question
const AGENT_ID = args.agentId || 'architect'
const READ_PATHS = Array.isArray(args.readPaths) ? args.readPaths : []

if (!BRIEF) throw new Error('design.explore 需要 args.brief（stage=explore 的 DesignBrief）')
if (BRIEF.stage !== STAGE) {
  throw new Error(`brief.stage=${BRIEF.stage}，与 design.explore 不符；契约串了`)
}
if (!RUN_ID) {
  // runId 不是装饰：产物文件名由它决定，而"每次运行落一份记录"是 §5.3 的硬要求。
  // 允许缺省就会得到一份覆盖上一次的探索记录——那等于没有记录。
  throw new Error('design.explore 需要 args.runId：产物文件名是 scratch/explore_<runId>.md，'
    + '缺了它两次探索会互相覆盖，而探索记录的价值正在于它留下了哪一次')
}
if (!QUESTION) {
  throw new Error('design.explore 需要 args.question：探索必须有一个具体的问题。'
    + '没有问题的探索不会产出可以用或否的东西，只会产出一段文字')
}

// 策略实例。默认 architect——大多数逃生口探索是方向性的。
// 允许换，但必须在 args 里显式给出，且必须是 roster 里的策略名。
const KNOWN_STRATEGIES = [
  'architect', 'integrator', 'invariant-checker', 'framing-critic', 'gate-keeper', 'verifier',
  'compute-expert', 'memory-expert', 'comm-expert', 'software-expert', 'physical-expert', 'model-expert',
]
if (!KNOWN_STRATEGIES.includes(AGENT_ID)) {
  throw new Error(`design.explore 的 agentId=${AGENT_ID} 不是 roster 里的策略；`
    + `可选：${KNOWN_STRATEGIES.join(', ')}`)
}

// ---------------------------------------------------------------------------
// 产物路径。只有一个，写死在 scratch/ 下。
//
// 这里刻意不提供任何覆写入口：一旦允许调用方传 outputPath，
// 逃生口就会变成一条绕过 intake 检查的旁路——
// 而"S7 的产物全部落在 scratch/"正是本格的验收判据。
// ---------------------------------------------------------------------------
const SCRATCH_DIR = `${REPO}/scratch`
const EXPLORE_PATH = `${SCRATCH_DIR}/explore_${RUN_ID}.md`

// 冗余但必要的自检。路径是拼出来的，拼错了这里会当场发现，
// 而不是等到主循环把一份探索记录写进 out/ 之后。
if (EXPLORE_PATH.includes('/out/') || !EXPLORE_PATH.includes('/scratch/')) {
  throw new Error(`design.explore 的产物路径必须落在 scratch/ 下，实际为 ${EXPLORE_PATH}；`
    + '探索结论不得写进 out/——那里的一切都可被引用')
}

const BRIEF_JSON = JSON.stringify(BRIEF, null, 2)
const READ_LIST = READ_PATHS.length
  ? READ_PATHS.map((p) => `  ${p}`).join('\n')
  : '  （未指定；由你自行决定读什么，并在产物里逐条列出实际读了哪些）'

const HEAD = [
  `仓库根目录：${REPO}`,
  `本 workflow：design.explore（stage=${STAGE}，runId=${RUN_ID}）——**受控逃生口**`,
  `你是一个策略实例。先读你的策略正文：${REPO}/teams/council/strategies/${AGENT_ID}.md`,
  '那份文件是本角色的判断规则、判据、证据规则、取舍规则与禁止事项，逐条遵守。',
  '以下运行时上下文由 workflow 注入；注入内容与策略正文冲突时，注入内容优先。',
  '你没有文件系统写权限。把该写的东西作为返回值交回，由 workflow 落盘。',
  '不得输出 TPS/usr 或任何全局性能指标。',
  '',
  '**你的产物是一份探索记录，不是设计结论。** 它落在 scratch/ 下，',
  '明文规定：不写 out/、不进 ledger、不得作为任何 claim 的证据。',
  '这不是谦辞——这是这份东西能被允许自由探索的前提。',
  '一个被引用的探索结论必须重新走正规 workflow 把它证一遍；',
  '而那也正是它应该被引用的唯一方式。',
].join('\n')

phase('Explore')

// 单个实例，没有 parallel、没有检点、没有门控——这是 §5.3 的定义。
// 不加检点不是偷懒：加一个检点者，探索就要为它自己的中间结论负责，
// 而探索的全部价值在于可以中途走错。走错的路要记下来，不要被审掉。
const exploration = await agent(
  `${HEAD}\n\n`
  + `brief：\n${BRIEF_JSON}\n\n`
  + `本次探索的问题：\n${QUESTION}\n\n`
  + `建议的读入范围（你可以读别的，但必须逐条记录实际读了什么）：\n${READ_LIST}\n\n`
  + `任务：就上面的问题做一次自由探索。规则：\n`
  + `1. **先写下你读了什么**：文件路径，以及从每一处得到了什么。`
  + `   没有读入记录的探索无法被判断，也无法被接着往下做。\n`
  + `2. **再写下你判断了什么**：结论、以及每条结论的底气从哪来。`
  + `   底气是"某个 ADR 这么写的"就写 ADR 编号；是"我推断的"就写"推断"，`
  + `   不要给推断套上一个不存在的出处。\n`
  + `3. **写下你走到这一步时否掉了什么**：走过的弯路和否掉的方案。`
  + `   逃生口的产物最有价值的部分通常在这里——正规 workflow 只记被否项，`
  + `   而探索过程中"想过但不可行"的东西往往连被否项都算不上。\n`
  + `4. **写下下一步**：如果要把它做成结论，该走哪个 workflow、补什么证据。`
  + `   这一条是你这份记录的出口。没有它，这份记录就只是笔记。\n`
  + `5. 不确定就写不确定。这份记录的读者是将来要决定"值不值得立个项"的人，`
  + `   把不确定写清楚比给出一个勉强确定的结论有用得多。\n`
  + `6. **不要试图产出可引用的结论**：不得写 PASS/FAIL 这类字眼，`
  + `   不要给门控意见，不要把某个方向判成可行或不可行当成结论交给别人——`
  + `   你可以说"我倾向于……，但依据只有 X"。\n`
  + `把你写的整份记录作为 markdown 正文返回：它就是 scratch/explore_${RUN_ID}.md 的内容。`,
  {label: `explore:${RUN_ID}`, phase: 'Explore', effort: 'high'})

if (exploration === null) {
  throw new Error(`design.explore 的实例未产出（runId=${RUN_ID}）。`
    + '§5.3 要求每次运行必须落盘一份探索记录——连"这次没产出"也需要被记下来，'
    + '否则同一个问题下次会被重新探索一遍')
}

phase('Scratch landing')

const body = typeof exploration === 'string'
  ? exploration
  : JSON.stringify(exploration, null, 2)

const header = [
  '# 探索记录（不可引用）',
  '',
  `- runId：${RUN_ID}`,
  `- 策略实例：${AGENT_ID}`,
  `- sourceCommit：${BRIEF.sourceCommit}`,
  `- 问题：${QUESTION}`,
  '',
  '> 本文件是一份探索记录，不是设计产物。',
  '> 明文规定：不写 `out/`、不进 ledger、**不得作为任何 claim 的证据**。',
  '> 任何引用这里的结论都必须先走正规 workflow 重新证明。',
  '',
  '---',
  '',
].join('\n')

const content = `${header}${body}\n`

log(`design.explore 落盘 ${EXPLORE_PATH}（scratch/ 下的探索记录；不写 out/、不进 ledger、不作为证据）`)

// 落盘只有这一条路径。没有第二个文件，没有 run_record——ledger 不进，门控不管，
// 一份 run record 会诱使人把它当成流程里的一环，而它不是。
return {
  stage: STAGE,
  runId: RUN_ID,
  agentId: AGENT_ID,
  question: QUESTION,
  readPaths: READ_PATHS,
  // 显式的自我声明。下游任何拿到这个返回值的东西都能看到这三条禁令，
  // 不需要去读 §5.3 才知道这份产物不可引用。
  quotableAsEvidence: false,
  goesToLedger: false,
  writesToOut: false,
  landedUnder: 'scratch/',
  nextActions: [
    '若这次探索该变成结论：走对应的正规 workflow（方向性问题走 design.direction，'
    + '候选级走 C 组，产物级走 design.verify）并补齐证据；本记录本身不构成证据',
    `如需复核本次探索读了什么：读 ${EXPLORE_PATH}`,
  ],
  files: [
    {path: EXPLORE_PATH, content},
  ],
}
