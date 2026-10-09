'use strict';

// S5 的两个 workflow：contract / arch.direction.
//
// 它们不是 C 组骨架的副本——contract 与 arch.direction 没有"搜索策略 → 确定性搜索"两步，
// 后者的候选也不是某个域的设计空间取值，而是**形态宏参数**（L/H 算力配比、
// 片上 SRAM 总量与 local/shared 切分、MC 档位、die 数、TP），由主循环侧的
// stage_a.js 确定性枚举后作为产物传进来。所以 S4 的
// test_design_workflow_skeleton.js 既不能覆盖它们，也不该被它们拓宽
// （那份测试的 DOMAINS 是写死的四域，这是刻意的）。这份测试补的正是 S4 空出来的那一段。
//
// 本组从三个收成两个：direction 与 dgate 合并成 arch.direction。
// 拆两格曾经的理由是"路线选择"与"门控放行"是两件事，但两格读的是同一份打分卡、
// 同一份包络，第二格除了把第一格刚核过的门槛再核一遍之外没有新输入。合并之后
// 路线与门控在一格里闭合，门槛证据只核一次。
//
// 它守的是 S5 的验收判据与四条硬边界各自在本组 workflow 上的落点：
//
//   * 语法：按运行时的真实形态解析（包一层函数），而不是直接 node --check
//   * 阶段顺序：两个 workflow 各自的 phase() 序列与 meta.phases 一致
//   * 检点收尾：每个 workflow 的最后一个 agent 调用是检点类策略，且返回值受它门控
//   * 裁决消费：roster 里每个策略的 verdictEnum，要么被某个 workflow 消费，要么在
//     pendingConsumption 里有明确到期切片——没有第三条路，否则就是写了个没人接的分支
//   * 策略版本：workflow 写进 ledgerPatch 的 strategyVersions 必须与 roster 一致，
//     且它调用过的每个策略都必须在表里
//   * S5 判据：arch.direction 的 ≤3 收敛、门槛条数固定为 8、
//     门槛核验只开**一个** gate-keeper 实例、以及"不自行判定结论"
//
// 它不比较策略正文，也不比较 prompt 的措辞——那些是预期会不同的部分。

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const {spawnSync} = require('child_process');

const root = path.resolve(__dirname, '../..');
const wfDir = path.join(root, 'integration/orchestration');
const strategyDir = path.join(root, 'teams/council/strategies');

const roster = JSON.parse(fs.readFileSync(path.join(root, 'teams/council/inputs/agent_roster.json'), 'utf8').replace(/^﻿/, ''));
const rosterById = new Map(roster.strategies.map((s) => [s.agentId, s]));
const read = (f) => fs.readFileSync(path.join(wfDir, f), 'utf8');

const FILE = {
  contract: 'design.contract.workflow.js',
  'arch.direction': 'design.arch.direction.workflow.js',
};
const S5 = Object.keys(FILE);
// meta.name 是阶段名的连字形式：design.arch.direction → design-arch-direction。
const META_NAME = {
  contract: 'design-contract',
  'arch.direction': 'design-arch-direction',
};
const src = Object.fromEntries(S5.map((k) => [k, read(FILE[k])]));

// 从 `const STRATEGY_VERSIONS = {` 起扫到大括号配平的 `}`。
// 逐字符走是必要的：这个对象里混着字符串、注释与**模板字面量**
// （architect 的条目后跟着一条含 ${} 的注释），正则会在那里被括号骗住。
function objectBody(text, anchor) {
  const start = text.indexOf(anchor);
  assert(start >= 0, `missing \`${anchor}\``);
  let i = text.indexOf('{', start);
  let depth = 0;
  let quote = null;
  for (let k = i; k < text.length; k++) {
    const ch = text[k];
    if (quote) {
      if (ch === '\\') k++;
      else if (ch === quote) quote = null;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') { quote = ch; continue; }
    if (ch === '/' && text[k + 1] === '/') { while (k < text.length && text[k] !== '\n') k++; continue; }
    if (ch === '/' && text[k + 1] === '*') { const e = text.indexOf('*/', k); k = e < 0 ? text.length : e + 1; continue; }
    if (ch === '{') depth++;
    else if (ch === '}') { depth--; if (depth === 0) return text.slice(i + 1, k); }
  }
  assert.fail(`\`${anchor}\` is unterminated`);
}

// workflow 里出现的策略 id，两种写法都要收：
//   head('architect')        —— 直接指名的调用
//   {agentId: 'compute-expert', ...} —— 扇出表里的条目
// 只收前者会漏掉整个 declare 组：contract 的四个（现在是五个）申报人是
// head(d.agentId) 调用的，id 写在 DOMAINS 表里。漏了它们，
// "调用过但没记版本"这条断言就永远不会触发——而这正是它要抓的错。
const strategyRefs = (text) => [...new Set([
  ...[...text.matchAll(/head\('([a-z][a-z0-9-]*)'\)/g)].map((m) => m[1]),
  ...[...text.matchAll(/\bagentId:\s*'([a-z][a-z0-9-]*)'/g)].map((m) => m[1]),
])].sort();

// ---------------------------------------------------------------------------
// 1. 语法。直接 node --check 会报 `Illegal return statement`——
//    workflow 脚本在运行时是包在一个函数里执行的，顶层 return 合法。
//    所以按运行时的真实形态还原：剥掉 `export`，外面包一层 async 函数。
//    不这么做，这三个文件与 C 组四个文件都会"看起来"语法错误。
// ---------------------------------------------------------------------------
for (const k of S5) {
  const wrapped = `async function __workflow__() {\n${src[k].replace(/^export const meta/m, 'const meta')}\n}\n`;
  const tmp = path.join(require('os').tmpdir(), `s5-${k}-${process.pid}.mjs`);
  fs.writeFileSync(tmp, wrapped);
  try {
    const parsed = spawnSync(process.execPath, ['--check', tmp], {encoding: 'utf8'});
    assert.strictEqual(parsed.status, 0, `${FILE[k]} 语法错误（按运行时形态包装后仍不通过）：\n${parsed.stderr}`);
  } finally {
    try { fs.unlinkSync(tmp); } catch (_) {}
  }
}

// ---------------------------------------------------------------------------
// 2. meta 形态与阶段顺序。meta 必须是纯字面量，phases 与 phase() 调用一一对应。
//    phase 顺序是编排，改顺序等于改了各格看到的东西。
// ---------------------------------------------------------------------------
const PHASES = {
  contract: ['Interface declaration', 'Contract convergence', 'Independent verification', 'Invariant check'],
  'arch.direction': ['Candidate evaluation', 'Convergence', 'Framing review', 'Gate evidence', 'Evidence assembly', 'Invariant check'],
};
for (const k of S5) {
  const t = src[k];
  assert(/export const meta = \{/.test(t), `${FILE[k]} 必须导出 meta`);
  assert(new RegExp(`name: '${META_NAME[k]}'`).test(t), `${FILE[k]} 的 meta.name 必须是 ${META_NAME[k]}`);
  assert(/description: '[^']+'/.test(t), `${FILE[k]} 的 meta.description 不得为空`);

  const order = [...t.matchAll(/^phase\('([^']+)'\)/gm)].map((m) => m[1]);
  assert.deepStrictEqual(order, PHASES[k], `${FILE[k]} 的 phase 顺序不符`);

  const metaBlock = t.slice(0, t.indexOf('\n}'));
  const declared = [...metaBlock.matchAll(/title:\s*'([^']+)'/g)].map((m) => m[1]);
  assert.deepStrictEqual(declared, PHASES[k], `${FILE[k]} 的 meta.phases 必须与 phase() 调用逐项一致`);
  assert.strictEqual(new Set(declared).size, declared.length, `${FILE[k]} 的 meta.phases 有重复标题`);
}

// ---------------------------------------------------------------------------
// 3. 检点收尾。每个 workflow 的最后一个 agent 调用必须是检点类策略，
//    且落盘受它的裁决门控——末步是总结而不是检点，违规项就会被"总结"掉。
// ---------------------------------------------------------------------------
// 门控变量可能是 `okInvariants` 本身，也可能是由它合成出来的变量：
// contract 与 direction 都把检点与另一个裁决并成一个 `blocked`
// （因为"检点过了但独立验证没过"同样不该落盘），所以这里不写死变量名，
// 先找出检点裁决被赋给了哪个变量，再沿着 `= !那个变量` 找最终的落盘闸门。
function gateVar(t) {
  const direct = t.match(/const\s+([A-Za-z_$][\w$]*)\s*=\s*check\s*&&\s*check\.verdict\s*===\s*'INVARIANT_OK'/);
  assert(direct, '必须以 `check && check.verdict === \'INVARIANT_OK\'` 的形式给检点裁决赋值');
  const name = direct[1];
  const composed = t.match(new RegExp(`const\\s+([A-Za-z_$][\\w$]*)\\s*=\\s*!${name}\\b`));
  return composed ? composed[1] : name;
}

for (const k of S5) {
  const t = src[k];
  const calls = [...t.matchAll(/head\('([a-z][a-z0-9-]*)'\)/g)];
  assert(calls.length > 0, `${FILE[k]} 必须调用策略实例`);
  assert.strictEqual(calls[calls.length - 1][1], 'invariant-checker',
    `${FILE[k]} 的最后一个 agent 调用必须是 invariant-checker`);

  const gate = gateVar(t);
  // 只看 return 的那一段，避免匹配到前面早退分支里的 files: []。
  const ret = t.slice(t.lastIndexOf('return {'));
  const flat = ret.replace(/\s+/g, '');

  const use = new RegExp(`files:${gate}\\?`).exec(flat);
  assert(use, `${FILE[k]} 检点不通过时必须不落盘：return 里的 files 必须由 ${gate} 三元门控`);

  // 两种写法都合法，取决于三元的方向（`blocked ? [] : [...]` 与 `okInvariants ? [...] : []`）。
  // 要断言的是同一件事：有一支是空数组，另一支不是——不通过就不写，不是"标注一下仍然写"。
  const emptyFirst = new RegExp(`files:${gate}\\?\\[\\]:`).test(flat);
  const emptyLast = new RegExp(`files:${gate}\\?\\[[\\s\\S]+?\\]:\\[\\],?\\}`).test(flat);
  assert(emptyFirst || emptyLast,
    `${FILE[k]} 检点不通过的那一支必须是 files: []，不得仍然落盘`);
}
// arch.direction 的门槛核验只开**一个** gate-keeper 实例，一次核完 8 条并逐条输出。
//
// 这条曾经是反的：拆成 direction + dgate 时，dgate 为每条门槛各起一个独立实例，
// 理由是"一个 agent 查八条，宽松会传染"。但 8 条门槛读的是同一份打分卡与同一份包络，
// 彼此之间没有信息屏障要维护（候选评估要互相看不见，是因为看得见就会对齐措辞；
// 门槛核验没有这个问题）。开 8 个实例换来的不是独立性，是同一份产物被读 8 遍，
// 以及"8 条之间的交叉引用没人负责"这个缺口。收成一个实例、输出逐条数组之后，
// 宽松不会跨条传染——因为每条仍各自给 status / evidenceLevel / evidence / blocker——
// 而交叉引用落进了同一个实例。
// 所以这里断言的是反面：不得扇出，且必须逐条。
assert(!/parallel\(\s*D_GATE_THRESHOLDS\.map/.test(src['arch.direction']),
  'design.arch.direction 不得为每条门槛各起一个 gate-keeper 实例；门槛核验是一个实例逐条输出');
assert.strictEqual([...src['arch.direction'].matchAll(/head\('gate-keeper'\)/g)].length, 1,
  'design.arch.direction 必须恰好调用一次 gate-keeper：一次核完 8 条，逐条给证据');
// 逐条输出是这一条的落地方式：给了总体 status 就等于把 8 条合成 1 条。
assert(/required:\s*\[[^\]]*'thresholds'/.test(src['arch.direction']) && /逐条/.test(src['arch.direction']),
  'design.arch.direction 的 gate-keeper 必须输出逐条数组，不得合成一条总体结论');

// ---------------------------------------------------------------------------
// 4. 只读与确定性。workflow 没有文件系统，也不能取时间或随机数。
// ---------------------------------------------------------------------------
for (const k of S5) {
  const t = src[k];
  assert(!/\brequire\s*\(/.test(t), `${FILE[k]} 不得 require；workflow 脚本没有文件系统权限`);
  assert(!/\bfs\./.test(t), `${FILE[k]} 不得使用 fs；落盘由主循环完成`);
  assert(!/Date\.now\(|Math\.random\(|new Date\(\)/.test(t), `${FILE[k]} 不得取时间或随机数；会破坏 resume`);
}

// ---------------------------------------------------------------------------
// 5. 裁决消费。这是 S5 的真正验收点。
//
//    roster 里每个策略的每个 verdictEnum 取值，必须满足二者之一：
//      (a) 被某个 design.*.workflow.js 消费——workflow 的 switch 处理它
//      (b) 在 roster.pendingConsumption 里登记了到期切片
//    除此之外没有第三条路：一个没有任何 workflow 消费的枚举值，
//    等于写了一个没人接的分支，agent 报出来也不会有人处理。
//
//    这条判据与 tools/check_agent_strategy.js 同源，但那边跑在 tools/ 下、
//    由治理组调用；这里把它钉在结构测试里，让 S5 的验收不依赖治理组是否跑过。
// ---------------------------------------------------------------------------
const allWorkflowText = fs.readdirSync(wfDir)
  .filter((n) => /^design\..*\.workflow\.js$/.test(n))
  .map((n) => fs.readFileSync(path.join(wfDir, n), 'utf8'))
  .join('\n');

// 裁决名是 [A-Z0-9_]+，`\b` 在 `_` 处不成立，子串匹配会把 GATE_BLOCKED 判成被
// GATE_BLOCKED_EXTRA 消费。边界必须手写：两侧不得再是 [A-Z0-9_]。
const mentions = (blob, v) =>
  new RegExp(`(?<![A-Z0-9_])${v.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![A-Z0-9_])`).test(blob);

const pending = new Map((roster.pendingConsumption || []).map((e) => [e.verdict, e]));
for (const s of roster.strategies) {
  for (const v of s.verdictEnum) {
    if (mentions(allWorkflowText, v)) {
      assert(!pending.has(v),
        `${v} 已被 workflow 消费，但仍在 pendingConsumption 里；请删除这条过期记账`);
      continue;
    }
    const entry = pending.get(v);
    assert(entry, `${s.agentId} 的裁决 ${v} 未在任何 design.*.workflow.js 中被消费；workflow switch 必须处理它`);
    assert.strictEqual(entry.owner, s.agentId,
      `pendingConsumption.${v} 的 owner 写作 ${entry.owner}，实际由 ${s.agentId} 声明`);
    assert(entry.slice, `pendingConsumption.${v} 必须写明到期切片`);
  }
}

// S5 之后这两个裁决必须真的被消费，不能再挂在暂缓表上——这是本切片的验收点之一。
// 门控证据枚举在 arch.direction 里被 switch 消费。
assert(/GATE_EVIDENCE_COMPLETE/.test(src['arch.direction']) && /GATE_BLOCKED/.test(src['arch.direction']),
  'design.arch.direction 必须消费 gate-keeper 的两个门控证据裁决');
assert(/okGate|gate\.verdict === 'GATE_EVIDENCE_COMPLETE'/.test(src['arch.direction']),
  'design.arch.direction 的落盘必须受门控证据裁决门控');

// 方向回流的两个枚举必须被 design.contract 消费。contract 是最早的一格，
// 它一旦带着方向级矛盾往下走，后面每一格都会建在这个矛盾上。
assert(/DIRECTION_BACKFLOW/.test(src.contract) && /PPA_DIRECTION_BACKFLOW/.test(src.contract),
  'design.contract 必须消费 DIRECTION_BACKFLOW 与 PPA_DIRECTION_BACKFLOW');
assert(/backflowDeclarants\.length/.test(src.contract),
  'design.contract 必须在收敛前拦下方向回流，而不是把它当普通结果往下传');

// ---------------------------------------------------------------------------
// 6. 策略版本对齐。ledger 的 strategyVersions 是重跑差异的唯一解释依据：
//    版本对不上，两次跑出不同结果就无法归因。所以这里查两件事：
//       (a) workflow 声明的版本与 roster 一致
//       (b) workflow 调用过的每个策略都在表里（漏一个就是漏一条归因线索）
// ---------------------------------------------------------------------------
for (const k of S5) {
  const versions = objectBody(src[k], 'strategyVersions: {');
  const pairs = [...versions.matchAll(/(?:'([a-z][a-z0-9-]*)'|([a-z][a-z0-9-]*)):\s*'([^']+)'/g)];
  assert(pairs.length > 0, `${FILE[k]} 的 strategyVersions 必须至少声明一项`);

  const declared = new Map(pairs.map((m) => [m[1] || m[2], m[3]]));
  for (const [id, ver] of declared) {
    const entry = rosterById.get(id);
    assert(entry, `${FILE[k]} 的 strategyVersions 含 roster 未定义的策略 ${id}`);
    assert.strictEqual(ver, entry.strategyVersion,
      `${FILE[k]} 把 ${id} 记成 ${ver}，roster 记的是 ${entry.strategyVersion}`);
  }
  for (const id of strategyRefs(src[k])) {
    assert(declared.has(id), `${FILE[k]} 调用了 ${id} 但未把它写进 strategyVersions`);
  }
}

// 每个被调用的策略都必须有正文文件——workflow 传的是 agentId，
// agent 靠它去读策略正文；文件不存在，这一格就没有判断规则可依据。
for (const k of S5) {
  for (const id of strategyRefs(src[k])) {
    const p = path.join(strategyDir, `${id}.md`);
    assert(fs.existsSync(p), `${FILE[k]} 调用 ${id}，但缺策略正文 ${id}.md`);
    const text = fs.readFileSync(p, 'utf8');
    const entry = rosterById.get(id);
    assert(text.includes(`策略版本：${entry.strategyVersion}`),
      `${id}.md 声明的版本号必须与 roster 的 ${entry.strategyVersion} 一致`);
    assert(/## 禁止/.test(text) && /## 裁决/.test(text),
      `${id}.md 必须声明禁止事项与裁决枚举`);
    // 裁决正文必须逐条覆盖 roster 的枚举——正文少写一条，agent 就不会知道那个值怎么用。
    for (const v of entry.verdictEnum) {
      assert(text.includes(v), `${id}.md 的裁决一节必须覆盖 roster 声明的 ${v}`);
    }
  }
}

// ---------------------------------------------------------------------------
// 7. S5 的两条验收判据。
//
//    (a)《22 号文档》§9.1/§9.2：从 6–12 候选收敛到 ≤3。
//       §4.1 的表格里写的是"只留 winner"，与 §9 冲突。以 §9 为准，证据是确定性的：
//       evaluate_gates.js 的 candidateCountLe3 就是 ≤3，stage_a.js 的
//       selectCandidates 也是至多三个正式候选。验收判据按可复算的那一份走。
//
//    (b) 门控结论不由这一格产生。这条不是靠措辞保证的，是靠三层结构：
//        一个 gate-keeper 只能报**逐条证据**状态（不得合并成总体结论）、
//        architect 只能转抄脚本的 decision、invariant-checker 专门核验转抄是否
//        逐字一致且没有自行判定。
// ---------------------------------------------------------------------------
const MAX = src['arch.direction'].match(/const MAX_CANDIDATES = args\.maxCandidates \|\| (\d+)/);
assert(MAX, 'design.arch.direction 必须接受 args.maxCandidates');
const maxN = Number(MAX[1]);
assert(maxN >= 6 && maxN <= 12, `design.arch.direction 的候选上限应在 6–12 之间（验收判据的起点），当前 ${maxN}`);
assert(/CANDIDATES\.slice\(0, MAX_CANDIDATES\)/.test(src['arch.direction']),
  'design.arch.direction 必须在评估前对候选集切片，收敛上界不能靠 agent 自律');
assert(/\.filter\(\(r\) => r\.rank <= 3\)/.test(src['arch.direction']),
  'design.arch.direction 必须把正式候选截到 3 个以内');
assert(/candidateCountLe3/.test(src['arch.direction']),
  'design.arch.direction 的记录里必须指明 ≤3 由 evaluate_gates.js 的 candidateCountLe3 复核');
assert(/convergence:\s*\{/.test(src['arch.direction']), 'design.arch.direction 的 runRecord 必须记录收敛前后计数');
assert(/from: sliced\.length[\s\S]{0,80}to: formal\.length/.test(src['arch.direction']),
  'design.arch.direction 的收敛记录必须同时给出收敛前与收敛后的实际计数');

// 门槛条数必须是常量，不能从产物里读——用被测数据决定核验范围，等于让被测者定考题。
assert(/const THRESHOLDS = args\.thresholds \|\| 8/.test(src['arch.direction']),
  'design.arch.direction 的门槛条数必须是常量 8');
assert(/THRESHOLDS !== D_GATE_THRESHOLDS\.length/.test(src['arch.direction']),
  'design.arch.direction 必须在门槛条数与文档不符时抛错，而不是跑少几条');
assert(/DG-8/.test(src['arch.direction']) && /不超过 3 个候选/.test(src['arch.direction']),
  'design.arch.direction 注入的门槛正文必须含第 8 条（≤3 候选）；它与收敛判据是同一件事的两个落点');
// architect 只能转抄，不能推断。
assert(/gateDecision/.test(src['arch.direction']) && /照抄|逐字一致/.test(src['arch.direction']),
  'design.arch.direction 必须要求 architect 照抄脚本的 decision，并要求检点核验逐字一致');
assert(/不得因|推断/.test(src['arch.direction']),
  'design.arch.direction 必须显式禁止"证据齐了就推断结论"这一路径。');

// 任何一个 S5 文件都不得出现门控结论字面量。
// 禁止句里提到字面量是允许的（策略与 workflow 都要能说明"不得写它"），
// 所以带否定词的行走白名单——这与 check_agent_strategy.js 的口径一致。
for (const k of S5) {
  for (const [i, line] of src[k].split(/\r?\n/).entries()) {
    if (!/PASS/.test(line)) continue;
    assert(/不得|禁止|不判|严禁/.test(line),
      `${FILE[k]}:${i + 1} 出现门控结论字面量：${line.trim()}`);
  }
}

console.log(`PASS S5 structure: ${S5.length} workflows (${S5.join(', ')}) parse as the runtime parses them, `
  + `end on the invariant check, and consume every roster verdict with no stale pending entry`);
