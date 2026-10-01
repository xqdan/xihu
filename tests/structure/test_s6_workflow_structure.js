'use strict';

// S6 的六个 workflow：detail.freeze / detail.workload / detail.events /
// detail.execute / detail.integrate / converge.
//
// 它们与 S4、S5 都不同，所以两份既有测试都不覆盖它们：
//   * S4 的 test_design_workflow_skeleton.js 的 DOMAINS 写死了四域（C 组骨架）；
//   * S5 的 test_s5_workflow_structure.js 只列了 contract / direction / dgate。
// 这份测试补的正是这两份空出来的那一段。
//
// 它守的是 S6 的验收判据（《22 号文档》§9.1/§9.2）与四条硬边界在各格上的落点：
//
//   * 语法：按运行时的真实形态解析（包一层函数），而不是直接 node --check
//   * 阶段顺序：六个 workflow 各自的 phase() 序列与 meta.phases 一致
//   * 检点收尾：最后一格 agent 调用是检点类策略，落盘受它（及其合取）门控
//   * 缺输入必有出路：§9.2 要求 D 组任一步骤缺输入时输出 BLOCKED_CONFIG + nextActions，
//     不得静默补全——这条按 return 块逐个查，不靠措辞
//   * 裁决消费：roster 里每个策略的 verdictEnum 都要有 workflow 接，
//     或挂在 pendingConsumption 上（当前为空，即全部必须被消费）
//   * 策略版本：ledgerPatch.strategyVersions 必须与 roster 一致，且调用过的策略都在表里
//   * 各格的验收点：B0 无 integrator、B1 三条 sizing 比、B2 共享 manifest hash 与五条守恒、
//     B3 的 PPA_DIRECTION_BACKFLOW 专线与零容差面积守恒、B4 的 18 个观察位与
//     "delta 由脚本算、原因由 architect 给"、A0 的收敛路由与"提案不是门控结论"
//
// 它不比较策略正文，也不比较 prompt 的措辞——那些是预期会不同的部分。

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const os = require('os');
const {spawnSync} = require('child_process');

const root = path.resolve(__dirname, '../..');
const wfDir = path.join(root, 'integration/orchestration');
const strategyDir = path.join(root, 'teams/council/strategies');

const roster = JSON.parse(fs.readFileSync(path.join(root, 'teams/council/inputs/agent_roster.json'), 'utf8').replace(/^﻿/, ''));
const rosterById = new Map(roster.strategies.map((s) => [s.agentId, s]));
const read = (f) => fs.readFileSync(path.join(wfDir, f), 'utf8');

const FILE = {
  freeze: 'design.detail.freeze.workflow.js',
  workload: 'design.detail.workload.workflow.js',
  events: 'design.detail.events.workflow.js',
  execute: 'design.detail.execute.workflow.js',
  integrate: 'design.detail.integrate.workflow.js',
  converge: 'design.converge.workflow.js',
};
const META_NAME = {
  freeze: 'design-detail-freeze',
  workload: 'design-detail-workload',
  events: 'design-detail-events',
  execute: 'design-detail-execute',
  integrate: 'design-detail-integrate',
  converge: 'design-converge',
};
const S6 = Object.keys(FILE);
const src = Object.fromEntries(S6.map((k) => [k, read(FILE[k])]));

// 从 openIdx 处的开括号起扫到同类括号配平的闭括号。
// 逐字符走是必要的：这些对象里混着字符串、注释与**模板字面量**
// （prompt 里全是 `${...}`），正则会在那里被括号骗住。
// 括号种类可传，因为数组字面量（EXPERT_POOL）也要按同一套规则取。
function balancedBody(text, openIdx, open = '{', close = '}') {
  let depth = 0;
  let quote = null;
  for (let k = openIdx; k < text.length; k++) {
    const ch = text[k];
    if (quote) {
      if (ch === '\\') k++;
      else if (ch === quote) quote = null;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') { quote = ch; continue; }
    if (ch === '/' && text[k + 1] === '/') { while (k < text.length && text[k] !== '\n') k++; continue; }
    if (ch === '/' && text[k + 1] === '*') { const e = text.indexOf('*/', k); k = e < 0 ? text.length : e + 1; continue; }
    if (ch === open) depth++;
    else if (ch === close) { depth--; if (depth === 0) return text.slice(openIdx + 1, k); }
  }
  return null;
}

const braceBody = (text, openIdx) => balancedBody(text, openIdx, '{', '}');

function objectBody(text, anchor) {
  const start = text.indexOf(anchor);
  assert(start >= 0, `missing \`${anchor}\``);
  const body = braceBody(text, text.indexOf('{', start));
  assert(body !== null, `\`${anchor}\` is unterminated`);
  return body;
}

// 取数组字面量的内容。对象版助手（objectBody）会去找锚点后的下一个 `{`，
// 拿它取数组会从数组**之后**的某个对象开始截——截出来的东西看起来像回事，
// 但里面一个池子成员都没有。
function arrayBody(text, anchor) {
  const start = text.indexOf(anchor);
  assert(start >= 0, `missing \`${anchor}\``);
  const open = text.indexOf('[', start);
  assert(open >= 0, `\`${anchor}\` 后面没有数组字面量`);
  const body = balancedBody(text, open, '[', ']');
  assert(body !== null, `\`${anchor}\` 的数组字面量未配平`);
  return body;
}

// 每一个顶层 `return { ... }` 的块体，按出现顺序。§9.2 的"缺输入必有 nextActions"
// 只能按 return 块查——按整个文件查会被别处的字符串蒙混过去。
function returnBodies(text) {
  const out = [];
  for (let i = text.indexOf('return {'); i >= 0; i = text.indexOf('return {', i + 1)) {
    const body = braceBody(text, text.indexOf('{', i));
    if (body !== null) out.push({start: i, body});
  }
  return out;
}

// 剥掉注释，返回只含代码的文本。
//
// 存在的理由：这些 workflow 里有一类注释专门解释**为什么不这么做**
// （freeze 的头部写着"没有 integrator……而 integrator 的判据
// INTEGRATION_OK / DELTA_UNEXPLAINED 在这里无从判定"）。否定断言若扫全文，
// 就会把最该保留的那段解释判成违规，逼着人删掉设计理由。
// 所以"不得出现 X"一律只看代码。
//
// 它不追求词法正确——只要求：字符串与模板字面量的**内容**原样保留
// （断言里有按字面量匹配的），注释被换成等长空白（行号不错位）。
function stripComments(text) {
  let out = '';
  let quote = null;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quote) {
      if (ch === '\\') { out += ch + (text[i + 1] || ''); i++; continue; }
      if (ch === quote) quote = null;
      out += ch;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') { quote = ch; out += ch; continue; }
    if (ch === '/' && text[i + 1] === '/') {
      while (i < text.length && text[i] !== '\n') { out += ' '; i++; }
      out += '\n';
      continue;
    }
    if (ch === '/' && text[i + 1] === '*') {
      const end = text.indexOf('*/', i + 2);
      const stop = end < 0 ? text.length : end + 2;
      for (; i < stop; i++) out += text[i] === '\n' ? '\n' : ' ';
      i--;
      continue;
    }
    out += ch;
  }
  return out;
}

const code = Object.fromEntries(S6.map((k) => [k, stripComments(src[k])]));

// workflow 里出现的策略 id。两种写法都要收：
//   head('architect')                —— 直接指名的调用
//   {agentId: 'compute-expert', ...} —— 扇出表里的条目
// 只收前者会漏掉整个申报组：freeze 的两位、events 的三位、
// workload 的两位都是 head(d.agentId) 调用的，id 写在 DECLARANTS 表里。
// 漏了它们，"调用过但没记版本"这条断言就永远不会触发——而这正是它要抓的错。
const strategyRefs = (text) => [...new Set([
  ...[...text.matchAll(/head\('([a-z][a-z0-9-]*)'\)/g)].map((m) => m[1]),
  ...[...text.matchAll(/\bagentId:\s*'([a-z][a-z0-9-]*)'/g)].map((m) => m[1]),
])].sort();

// ---------------------------------------------------------------------------
// 1. 语法。直接 node --check 会报 `Illegal return statement`——
//    workflow 脚本在运行时是包在一个函数里执行的，顶层 return 合法。
//    所以按运行时的真实形态还原：剥掉 `export`，外面包一层 async 函数。
// ---------------------------------------------------------------------------
for (const k of S6) {
  const wrapped = `async function __workflow__() {\n${src[k].replace(/^export const meta/m, 'const meta')}\n}\n`;
  const tmp = path.join(os.tmpdir(), `s6-${k}-${process.pid}.mjs`);
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
//    phase 顺序是编排：改顺序等于改了各格看到的东西——
//    例如把 events 的守恒对账挪到申报之前，三路就先把结论交了再对账。
// ---------------------------------------------------------------------------
const PHASES = {
  freeze: ['Freeze declaration', 'Freeze assembly', 'Invariant check'],
  workload: ['Operator inventory', 'Roofline and sizing', 'Merge', 'Invariant check'],
  events: ['Event declaration', 'Conservation', 'Invariant check'],
  execute: ['Software and PPA declaration', 'Merge', 'Invariant check'],
  integrate: ['Merge', 'Delta attribution', 'Independent verification', 'Invariant check'],
  converge: ['Backflow intake', 'Framing review', 'Gate evidence', 'Architect convergence', 'Invariant check'],
};
for (const k of S6) {
  const t = src[k];
  assert(/export const meta = \{/.test(t), `${FILE[k]} 必须导出 meta`);
  assert(new RegExp(`name: '${META_NAME[k]}'`).test(t), `${FILE[k]} 的 meta.name 必须是 ${META_NAME[k]}`);
  assert(/description: '[^']+'/.test(t), `${FILE[k]} 的 meta.description 不得为空`);
  assert(/whenToUse: '[^']+'/.test(t), `${FILE[k]} 的 meta.whenToUse 必须写明何时用它与需要哪些 args`);

  const order = [...t.matchAll(/^phase\('([^']+)'\)/gm)].map((m) => m[1]);
  assert.deepStrictEqual(order, PHASES[k], `${FILE[k]} 的 phase 顺序不符`);

  const metaBlock = t.slice(0, t.indexOf('\n}'));
  const declared = [...metaBlock.matchAll(/title:\s*'([^']+)'/g)].map((m) => m[1]);
  assert.deepStrictEqual(declared, PHASES[k], `${FILE[k]} 的 meta.phases 必须与 phase() 调用逐项一致`);
  assert.strictEqual(new Set(declared).size, declared.length, `${FILE[k]} 的 meta.phases 有重复标题`);
}

// ---------------------------------------------------------------------------
// 3. 契约守卫。六个文件都以同一组三守卫开头：brief 必给、产物路径必给、
//    brief.stage 必须与本格一致。第三守卫是契约串了时的唯一防线——
//    拿 detail.workload 的 brief 去跑 detail.events，守卫不拦就会
//    用错阶段的输入跑出一份看起来正常的产物。
// ---------------------------------------------------------------------------
for (const k of S6) {
  const t = src[k];
  assert(/if \(!BRIEF\) throw new Error/.test(t), `${FILE[k]} 必须守卫 args.brief`);
  assert(/const STAGE = '/.test(t), `${FILE[k]} 必须声明 STAGE 常量`);
  assert(/BRIEF\.stage !== STAGE/.test(t), `${FILE[k]} 必须守卫 brief.stage 与本格一致`);
  assert(/UNVERIFIED/.test(t), `${FILE[k]} 必须把取不到的出处记成 UNVERIFIED，而不是留空或补值`);
}

// ---------------------------------------------------------------------------
// 4. §9.2：缺输入必有出路。D 组任一步骤缺输入时，必须以 BLOCKED_CONFIG（或
//    与之同类的终止裁决）收场，并给出 nextActions——不得静默补全，也不得
//    只留一句 reason 就走。这里按 return 块逐个查，不靠措辞。
// ---------------------------------------------------------------------------
// 终止分支是**落盘之前**那些早退：缺输入就退，不写任何东西。
// 最后一个 return 是正常出口（要么落盘、要么因检点不过而不落盘），
// 它自己那条 else 支路在 §5 里单独查，不归这里。
for (const k of S6) {
  const all = returnBodies(src[k]);
  const guards = all.slice(0, -1);
  assert(guards.length > 0, `${FILE[k]} 至少要有一条缺输入时的早退分支`);
  const terminating = guards.filter((r) =>
    /'BLOCKED_CONFIG'|'DIRECTION_BACKFLOW'|'PPA_DIRECTION_BACKFLOW'|'DELTA_UNEXPLAINED'/.test(r.body));
  assert(terminating.length > 0, `${FILE[k]} 至少要有一条终止性分支（缺输入时不落盘）`);
  for (const [i, {body}] of terminating.entries()) {
    assert(/nextActions\s*:/.test(body),
      `${FILE[k]} 的第 ${i + 1} 条终止分支缺 nextActions：§9.2 要求缺输入时给出下一步，不得只写 reason`);
    assert(/files:\s*\[\]/.test(body),
      `${FILE[k]} 的第 ${i + 1} 条终止分支必须 files: []，不得"标注一下仍然落盘"`);
  }
}

// ---------------------------------------------------------------------------
// 5. 检点收尾。每个 workflow 的最后一格 agent 调用必须是检点类策略，
//    且落盘受它门控——末步是总结而不是检点，违规项就会被"总结"掉。
// ---------------------------------------------------------------------------
// 门控变量可能是 okInvariants 本身，也可能由它合取出来：integrate 把
// 检点、独立验证与"delta 全部归因"三者合成一个 `ok`，因为三者任一不成立
// 都不该落盘。所以这里先找检点裁决被赋给了哪个变量，再沿 `const X = <含已知变量>` 求传递闭包。
function gateVars(t) {
  const direct = t.match(/const\s+([A-Za-z_$][\w$]*)\s*=\s*check\s*&&\s*check\.verdict\s*===\s*'INVARIANT_OK'/);
  assert(direct, '必须以 `check && check.verdict === \'INVARIANT_OK\'` 的形式给检点裁决赋值');
  const set = new Set([direct[1]]);
  const decls = [...t.matchAll(/const\s+([A-Za-z_$][\w$]*)\s*=\s*([^\n]*)/g)];
  let changed = true;
  while (changed) {
    changed = false;
    for (const [, name, expr] of decls) {
      if (set.has(name)) continue;
      for (const known of set) {
        if (new RegExp(`(?<![\\w$])${known}(?![\\w$])`).test(expr)) { set.add(name); changed = true; break; }
      }
    }
  }
  return set;
}

for (const k of S6) {
  const t = src[k];
  const calls = [...t.matchAll(/head\('([a-z][a-z0-9-]*)'\)/g)];
  assert(calls.length > 0, `${FILE[k]} 必须调用策略实例`);
  assert.strictEqual(calls[calls.length - 1][1], 'invariant-checker',
    `${FILE[k]} 的最后一格 agent 调用必须是 invariant-checker`);

  const gates = gateVars(t);
  // 只看最后一处 return（落盘处），避免匹配到前面终止分支里的 files: []。
  const ret = t.slice(t.lastIndexOf('return {')).replace(/\s+/g, '');
  const gate = [...gates].find((g) => new RegExp(`files:${g}\\?`).test(ret));
  assert(gate, `${FILE[k]} 落盘的 files 必须由检点裁决（或其合取）门控；已知候选：${[...gates].join(', ')}`);

  // 两种写法都合法，取决于三元的方向。要断言的是同一件事：
  // 有一支是空数组，另一支不是——不通过就不写，不是"标注一下仍然写"。
  const emptyFirst = new RegExp(`files:${gate}\\?\\[\\]:`).test(ret);
  const emptyLast = new RegExp(`files:${gate}\\?\\[[\\s\\S]+?\\]:\\[\\],?\\}`).test(ret);
  assert(emptyFirst || emptyLast,
    `${FILE[k]} 检点不通过的那一支必须是 files: []，不得仍然落盘`);
}

// ---------------------------------------------------------------------------
// 6. 只读与确定性。workflow 没有文件系统，也不能取时间或随机数。
// ---------------------------------------------------------------------------
for (const k of S6) {
  const t = src[k];
  assert(!/\brequire\s*\(/.test(t), `${FILE[k]} 不得 require；workflow 脚本没有文件系统权限`);
  assert(!/\bfs\./.test(t), `${FILE[k]} 不得使用 fs；落盘由主循环完成`);
  assert(!/Date\.now\(|Math\.random\(|new Date\(\)/.test(t), `${FILE[k]} 不得取时间或随机数；会破坏 resume`);
}

// 六格的产物都落在 out/detailed/ 下——同一阶段的产物聚在一处，
// 下一格才有一条稳定的引用路径。散到各处会让引用随实现漂移。
// （不是 out/detail/：out/ 的目录表里只有 out/detailed/ 这一行。）
for (const k of S6) {
  const paths = [...src[k].matchAll(/path: `\$\{REPO\}([^`]+)`/g)].map((m) => m[1]);
  assert(paths.length > 0, `${FILE[k]} 必须声明落盘路径`);
  for (const p of paths) {
    assert(p.startsWith('/out/detailed/'),
      `${FILE[k]} 的落盘路径 ${p} 不在 out/detailed/ 下；S6 六格共用这一处产物目录`);
  }
}

// ---------------------------------------------------------------------------
// 7. 裁决消费。这是 S6 的真正验收点。
//
//    roster 里每个策略的每个 verdictEnum 取值，必须满足二者之一：
//      (a) 被某个 design.*.workflow.js 消费
//      (b) 在 roster.pendingConsumption 里登记了到期切片
//    除此之外没有第三条路：一个没有任何 workflow 消费的枚举值，
//    等于写了一个没人接的分支，agent 报出来也不会有人处理。
//
//    pendingConsumption 当前是空数组——也就是说 16 个枚举值必须全部被消费。
//    这条判据与 tools/check_agent_strategy.js 同源，但那边由治理组调用；
//    这里把它钉在结构测试里，让 S6 的验收不依赖治理组是否跑过。
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

// ---------------------------------------------------------------------------
// 8. 策略版本对齐。ledger 的 strategyVersions 是重跑差异的唯一解释依据：
//    版本对不上，两次跑出不同结果就无法归因。所以这里查两件事：
//       (a) workflow 声明的版本与 roster 一致
//       (b) workflow 调用过的每个策略都在表里（漏一个就是漏一条归因线索）
// ---------------------------------------------------------------------------
for (const k of S6) {
  const versions = objectBody(src[k], 'strategyVersions: {');
  // converge 的专家条目由 RELEVANT_EXPERTS 展开，静态扫不到——
  // 那种情况下另有专门的断言（见 §11）。
  const pairs = [...versions.matchAll(/(?:'([a-z][a-z0-9-]*)'|([a-z][a-z0-9-]*)):\s*'([^']+)'/g)];
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
for (const k of S6) {
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
// 9. 各格的验收点。
// ---------------------------------------------------------------------------

// B0 freeze（19 号文档 §3）：三件事。
//   (a) 没有 integrator——freeze 是"抄录 + 核验"，合并语义（多份结论汇成一个）
//       在这里无从判定，配 integrator 它会退化成橡皮图章；
//   (b) 冻结字段清单是常量，不从产物里读；
//   (c) manifest 状态是三个枚举，不是"看起来像 planning 就放行"。
assert(!/head\('integrator'\)/.test(code.freeze),
  'design.detail.freeze 不得调用 integrator：B0 只有一个确定性输入，没有可合并的多份结论');
assert(!/INTEGRATION_OK|DELTA_UNEXPLAINED/.test(code.freeze),
  'design.detail.freeze 不得消费 integrator 的裁决枚举——它不使用该策略');
assert(/const FREEZE_FIELDS = \[[\s\S]*?'seed',[\s\S]*?\]/.test(src.freeze),
  'design.detail.freeze 的冻结字段清单必须是常量数组，且含 seed');
assert(/const MANIFEST_STATES = \['FROZEN', 'PLANNING', 'BLOCKED_CONFIG'\]/.test(src.freeze),
  'design.detail.freeze 的 manifest 状态必须是三个枚举');
assert(/notFrozen\.length \|\| badStates\.length/.test(src.freeze),
  'design.detail.freeze 必须由脚本对账字段覆盖，而不是靠 agent 自律');
assert(!/head\('verifier'\)/.test(src.freeze),
  'design.detail.freeze 不得调用 verifier：B0 的产物是配置抄录，没有可回放的物理量');

// B1 workload（§4）：三件事。
//   (a) 三条 sizing 比齐备（compute / bandwidth / network）——只报 compute 比
//       就说 sizing 做完了，网络受限的算子就没人看过；
//   (b) 每个算子五个字段齐全；
//   (c) 算子状态有取值域，不得发明新状态。
// 这三条比在数组里是带引号的（'requiredToAvailableRatio',），
// 所以每个片段都要连引号写，否则在引号处断掉。
assert(/const RATIO_FIELDS = \[[\s\S]*?'requiredToAvailableRatio',[\s\S]*?'requiredToAvailableBandwidthRatio',[\s\S]*?'requiredToAvailableNetworkRatio',/.test(src.workload),
  'design.detail.workload 必须钉住三条 sizing 比（compute / bandwidth / network）');
assert(/const OPERATOR_FIELDS = \['operatorId', 'coreClass', 'status', 'confidence', 'source'\]/.test(src.workload),
  'design.detail.workload 必须钉住算子的五个登记字段');
assert(/const OPERATOR_STATES = \[/.test(src.workload),
  'design.detail.workload 必须给算子状态一个取值域，而不是接受任意字符串');
assert(/sizingGaps\.length/.test(src.workload),
  'design.detail.workload 的退出条件必须由脚本对账（算子字段、三条比、状态），不由 agent 自律');
assert(/head\('integrator'\)/.test(src.workload) && /INTEGRATION_OK/.test(src.workload),
  'design.detail.workload 必须调用 integrator 并消费其裁决');
// Q1 先于 Q2：算子清单没定，逐个算子的强度就没有对象。
const invIdx = src.workload.indexOf("phase('Operator inventory')");
const sizIdx = src.workload.indexOf("phase('Roofline and sizing')");
assert(invIdx >= 0 && sizIdx > invIdx,
  'design.detail.workload 必须先定算子 DAG 再算 sizing：并行会让两侧去算一份可能被推翻的算子表');

// B2 events（§5）：三件事。
//   (a) 三路并行且共享同一 manifest hash——hash 不一致，跨域对账就没有意义；
//   (b) 五条守恒由脚本重算，agent 写的 met 与 lhs/rhs 必须自洽；
//   (c) 无出处的全局加速比/利用率乘子必须被禁止并主动扫。
// 注意名字在数组里是带引号的（'byteConservation',），
// 所以匹配时必须连引号一起写：只写 byteConservation, 会在引号处断掉，
// 断言永远不成立——而它看起来像在检查，实际什么都没查。
assert(/const CONSERVATIONS = \[[\s\S]*?'byteConservation',[\s\S]*?'flopConservation',[\s\S]*?'transactionConservation',[\s\S]*?'bufferLifetime',[\s\S]*?'creditConservation',[\s\S]*?\]/.test(src.events),
  'design.detail.events 必须钉住五条守恒：byte / flop / transaction / bufferLifetime / credit');
assert(/const EVENT_TRACE_FIELDS = \['operatorId', 'layerId', 'tileId', 'manifestHash'\]/.test(src.events),
  'design.detail.events 必须钉住事件的四个追溯字段');
assert(/await parallel\(DECLARANTS\.map/.test(src.events),
  'design.detail.events 的三域申报必须并行，而不是串行');
assert(/hashes\.length !== 1/.test(src.events),
  'design.detail.events 必须核对三路共享同一 manifest hash 后才进入合并');
assert(/conservationErrors/.test(src.events),
  'design.detail.events 必须由脚本重算五条守恒，而不是相信 agent 写的 met');
assert(/MULTIPLIER_PATTERN/.test(src.events) && /multiplierHits/.test(src.events),
  'design.detail.events 必须主动扫无出处的加速比/利用率乘子');
assert(/SYNTHETIC_PLACEHOLDER/.test(src.events),
  'design.detail.events 必须写明重放产物里的占位事件不得作为证据');
assert(/DIRECTION_BACKFLOW/.test(src.events) && /BLOCKED_CONFIG/.test(src.events),
  'design.detail.events 必须消费三域的两个回流/缺口裁决');

// B3 execute（§6）：三件事。
//   (a) physical-expert 的 PPA_DIRECTION_BACKFLOW 走专线回 A0，不与软件回流摊平；
//   (b) 面积守恒容差为 0；
//   (c) 卡功耗两套口径不得混用（差 45.5141376 W）。
assert(/PPA_DIRECTION_BACKFLOW/.test(src.execute),
  'design.detail.execute 必须消费 physical-expert 的 PPA_DIRECTION_BACKFLOW');
assert(/d\.verdict === 'PPA_DIRECTION_BACKFLOW'/.test(src.execute),
  'design.detail.execute 必须把 PPA 回流与软件回流分开上报——两类证据的重定方向不同');
assert(/const AREA_TOLERANCE_MM2 = 0\b/.test(src.execute),
  'design.detail.execute 的面积守恒容差必须是 0：它是一条等式，不是不等式');
assert(/const POWER_CALIBERS = \['MEMORY_DOMAIN', 'PHYSICAL_DOMAIN'\]/.test(src.execute),
  'design.detail.execute 必须钉住两套卡功耗口径');
assert(/45\.5141376/.test(src.execute),
  'design.detail.execute 必须写明两套卡功耗口径的差值，否则混用无法被发现');
assert(/const SOFTWARE_SCHEMA = declarationSchema\(\['LOCAL_DETAIL_FIX', 'DIRECTION_BACKFLOW', 'BLOCKED_CONFIG'\]\)/.test(src.execute)
  && /const PHYSICAL_SCHEMA = declarationSchema\(\['LOCAL_DETAIL_FIX', 'PPA_DIRECTION_BACKFLOW', 'BLOCKED_CONFIG'\]\)/.test(src.execute),
  'design.detail.execute 的两域裁决枚举必须按 roster 各自给：只有 physical-expert 有 PPA_DIRECTION_BACKFLOW');
assert(/await parallel\(DECLARANTS\.map/.test(src.execute),
  'design.detail.execute 的 Q6/Q7 必须并行，互不可见');

// B4 integrate（§7）——S6 的头条验收："粗估-细估 delta 有归因"。
//   (a) 18 个观察位由常量推导，不是从产物里读（读了等于让被测者定考题）；
//   (b) delta 的**数值**由脚本算，**原因**由 architect 给——两件事分开；
//   (c) 每一个非零 delta 都必须归位，没有"小于 x% 可以不解释"的宽容线；
//   (d) verifier 只看落盘产物，不看 agent 的申报散文。
assert(/const OBSERVATION_MODELS = \['GLM-5\.2', 'DeepSeek-V4-Pro', 'Kimi-K3'\]/.test(src.integrate),
  'design.detail.integrate 的三个模型必须是常量');
assert(/const OBSERVATION_TP = \[8, 16, 32\]/.test(src.integrate) && /const OBSERVATION_MC = \['MC320', 'MC640'\]/.test(src.integrate),
  'design.detail.integrate 的 TP 三档与 MC 两档必须是常量');
assert(/const OBSERVATION_COUNT = OBSERVATION_MODELS\.length \* OBSERVATION_TP\.length \* OBSERVATION_MC\.length/.test(src.integrate),
  'design.detail.integrate 的 18 位必须由常量相乘得出，不得从产物里读');
assert(/const OBSERVATION_STATES = \['MODEL_OBSERVED', 'PENDING_MODEL_RUN', 'BLOCKED_CONFIG', 'SILICON_OBSERVED'\]/.test(src.integrate),
  'design.detail.integrate 的观察状态必须是四个枚举');
assert(/const deltaBySlot = new Map/.test(src.integrate) && /deltaPct/.test(src.integrate),
  'design.detail.integrate 的 delta 百分比必须由脚本相减得出，不由任何 agent 产生');
assert(/silentDeltas/.test(src.integrate),
  'design.detail.integrate 必须抓住"未被提及的 delta"——不设宽容线，非零就要归位');
assert(/head\('architect'\)/.test(src.integrate),
  'design.detail.integrate 必须由 architect 做归因裁决（解释权不在合并者手里）');
assert(/综合因素/.test(src.integrate),
  'design.detail.integrate 必须显式禁止"综合因素"式假归因');
assert(/head\('verifier'\)/.test(src.integrate),
  'design.detail.integrate 必须调用 verifier 独立验证 18 位的数值产物');
assert(/你\*\*不\*\*看任何 agent 的申报过程|不看任何 agent 的申报/.test(src.integrate),
  'design.detail.integrate 的 verifier 必须只拿落盘产物，不拿申报散文');
assert(/okInvariants && okVerified/.test(src.integrate),
  'design.detail.integrate 的落盘必须同时受检点与独立验证门控');

// A0 converge（§8）：三件事。
//   (a) D 组的五格必须到齐——少一格，"每格都合规、合起来不成立"的缺口就可能藏在没到的那一格；
//   (b) 收敛路由是数据：ARCH_FREEZE / D_GATE_PROPOSAL 可往下走，DIRECTION_BACKFLOW 终止；
//   (c) **提案不是门控结论**：PASS 只由 evaluate_gates.js 计算。
assert(/const REQUIRED_STAGES = \[[\s\S]*?'detail\.freeze', 'detail\.workload', 'detail\.events', 'detail\.execute', 'detail\.integrate',[\s\S]*?\]/.test(src.converge),
  'design.converge 必须要求 D 组五格到齐');
assert(/missingStages\.length/.test(src.converge),
  'design.converge 必须在缺格时拒绝给出裁决，而不是照常收敛');
assert(/const CONVERGENCE_ROUTE = \{/.test(src.converge) && /proceed: false/.test(src.converge),
  'design.converge 必须把裁决到"能否往下走"的映射写成数据');
assert((src.converge.match(/'ARCH_FREEZE'|ARCH_FREEZE:/g) || []).length > 0 && /D_GATE_PROPOSAL/.test(src.converge),
  'design.converge 必须消费 architect 的三个裁决，含 ARCH_FREEZE');
assert(/routeContradictions/.test(src.converge),
  'design.converge 必须夹取"裁决与证据自相矛盾"的提案（判 ARCH_FREEZE 却留着 openItems 等）');
assert(/head\('framing-critic'\)/.test(src.converge) && /head\('gate-keeper'\)/.test(src.converge),
  'design.converge 必须调用 framing-critic 与 gate-keeper');
assert(/isGateConclusion: false/.test(src.converge) && /evaluate_gates\.js/.test(src.converge),
  'design.converge 的产物必须明写"这不是门控结论"，并指向 evaluate_gates.js');
assert(/RELEVANT_EXPERTS\.length < 1 \|\| RELEVANT_EXPERTS\.length > 3/.test(src.converge),
  'design.converge 必须把相关专家限定在 1–3 位：固定召集浪费，全召集等于隔一次全员会议');
assert(/const EXPERT_POOL = \[/.test(src.converge),
  'design.converge 的相关专家必须取自一个有定义的池，而不是任意 agentId');
// converge 的专家条目由 RELEVANT_EXPERTS 展开，静态扫不到——这里单独把池子里的
// 每一个都对齐 roster，补上 §8 那条断言覆盖不到的部分。
{
  const pool = [...arrayBody(src.converge, 'const EXPERT_POOL = [').matchAll(/'([a-z][a-z0-9-]*)'/g)].map((m) => m[1]);
  assert(pool.length > 0, 'design.converge 的 EXPERT_POOL 不得为空');
  for (const id of pool) {
    assert(rosterById.has(id), `design.converge 的 EXPERT_POOL 含 roster 未定义的策略 ${id}`);
  }
  assert(/\.\.\.Object\.fromEntries\(RELEVANT_EXPERTS\.map\(\(a\) => \[a, '1\.0'\]\)\)/.test(src.converge),
    'design.converge 必须把召集到的每位专家都记进 strategyVersions');
}

// ---------------------------------------------------------------------------
// 10. 门控结论字面量。任何一个 S6 文件都不得出现 PASS / D_GATE_PASSED /
//     Q_GATE_PASSED 作为**自己的产出**。禁止句里提到字面量是允许的
//     （策略与 workflow 都要能说明"不得写它"），所以带否定词的行走白名单——
//     这与 check_agent_strategy.js 的口径一致。
// ---------------------------------------------------------------------------
for (const k of S6) {
  for (const [i, line] of src[k].split(/\r?\n/).entries()) {
    if (!/PASS/.test(line)) continue;
    assert(/不得|禁止|不判|严禁|不是|而非/.test(line),
      `${FILE[k]}:${i + 1} 出现门控结论字面量：${line.trim()}`);
  }
}

// converge 的 gate-keeper 只能报证据完备性，不许报"通过"。
assert(/GATE_EVIDENCE_COMPLETE/.test(src.converge) && /GATE_BLOCKED/.test(src.converge),
  'design.converge 的 gate-keeper 必须消费两个门控证据裁决');
assert(/不是你的产出/.test(src.converge) || /不得输出 PASS/.test(src.converge),
  'design.converge 必须显式写明 PASS 不是 gate-keeper 的产出');

console.log(`PASS S6 structure: ${S6.length} workflows (${S6.join(', ')}) parse as the runtime parses them, `
  + `end on the invariant check, carry nextActions on every blocked exit, `
  + `and consume every roster verdict with no stale pending entry`);
