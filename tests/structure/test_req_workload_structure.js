'use strict';

// L1-a 的一格：design.req.workload（每 token 的工作量与算术强度）。
//
// 它原先是 D 组的 B1（design.detail.workload），验收判据写在
// tests/structure/test_s6_workflow_structure.js 的 §9 里。P6 把它前移到 L1——
// 排在 design.intake 之后、design.req.budget 之前，因为预算切分要知道工作量，
// 而不是等域设计完了再回头算工作量。判据整段跟着文件搬过来，没有删掉任何一条；
// 新增的是前移本身带来的那几条：它读的是内核产物而非自己重算、
// 集合通信是并列的一域、以及它不再落在 out/detailed/。
//
// 这份测试守的是：
//   * 语法：按运行时的真实形态解析（包一层函数），而不是直接 node --check
//   * 阶段顺序：phase() 序列与 meta.phases 一致，且算子 DAG 先于 sizing
//   * 契约守卫与 §9.2 的"缺输入必有出路"
//   * 检点收尾：最后一格 agent 调用是 invariant-checker，落盘受它门控
//   * B1 的三条验收点：三条 sizing 比 / 算子的五个登记字段 / 算子状态有取值域
//   * 前移带来的三条：算术强度与 Roofline 取自内核产物（不得重算）、
//     集合通信是三位申报人之一、落盘在 out/requirements/workload/
//   * 裁决消费、策略版本与策略正文的对齐
//
// 它不比较策略正文，也不比较 prompt 的措辞。

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const os = require('os');
const {spawnSync} = require('child_process');

const root = path.resolve(__dirname, '../..');
const wfDir = path.join(root, 'integration/orchestration');
const strategyDir = path.join(root, 'teams/council/strategies');

const FILE = 'design.req.workload.workflow.js';
const META_NAME = 'design-req-workload';
const STAGE = 'req.workload';
const PHASES = ['Operator inventory', 'Roofline and sizing', 'Merge', 'Invariant check'];
const LANDING_PREFIX = '/out/requirements/workload/';

const src = fs.readFileSync(path.join(wfDir, FILE), 'utf8');
const roster = JSON.parse(fs.readFileSync(path.join(root, 'teams/council/inputs/agent_roster.json'), 'utf8').replace(/^﻿/, ''));
const rosterById = new Map(roster.strategies.map((s) => [s.agentId, s]));

// 从 openIdx 处的开括号起扫到同类括号配平的闭括号。逐字符走是必要的：
// prompt 里全是模板字面量（`${...}`），正则会在那里被括号骗住。
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

function objectBody(text, anchor) {
  const start = text.indexOf(anchor);
  assert(start >= 0, `missing \`${anchor}\``);
  const body = balancedBody(text, text.indexOf('{', start));
  assert(body !== null, `\`${anchor}\` is unterminated`);
  return body;
}

// 每一个顶层 `return { ... }` 的块体，按出现顺序。§9.2 的"缺输入必有 nextActions"
// 只能按 return 块查——按整个文件查会被别处的字符串蒙混过去。
function returnBodies(text) {
  const out = [];
  for (let i = text.indexOf('return {'); i >= 0; i = text.indexOf('return {', i + 1)) {
    const body = balancedBody(text, text.indexOf('{', i));
    if (body !== null) out.push({start: i, body});
  }
  return out;
}

// 剥掉注释，返回只含代码的文本：有一类注释专门解释"为什么不这么做"，
// 否定断言若扫全文，就会把最该保留的那段解释判成违规。
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

const code = stripComments(src);

// workflow 里出现的策略 id。两种写法都要收：head('architect') 的直接指名，
// 与 {agentId: 'compute-expert', ...} 的申报表条目——只收前者会漏掉整个申报组，
// 而"调用过但没记版本"这条断言恰恰要靠它们才会触发。
const strategyRefs = (text) => [...new Set([
  ...[...text.matchAll(/head\('([a-z][a-z0-9-]*)'\)/g)].map((m) => m[1]),
  ...[...text.matchAll(/\bagentId:\s*'([a-z][a-z0-9-]*)'/g)].map((m) => m[1]),
])].sort();

// ---------------------------------------------------------------------------
// 1. 语法。直接 node --check 会报 `Illegal return statement`——
//    workflow 脚本在运行时是包在一个函数里执行的，顶层 return 合法。
// ---------------------------------------------------------------------------
{
  const wrapped = `async function __workflow__() {\n${src.replace(/^export const meta/m, 'const meta')}\n}\n`;
  const tmp = path.join(os.tmpdir(), `req-workload-${process.pid}.mjs`);
  fs.writeFileSync(tmp, wrapped);
  try {
    const parsed = spawnSync(process.execPath, ['--check', tmp], {encoding: 'utf8'});
    assert.strictEqual(parsed.status, 0, `${FILE} 语法错误（按运行时形态包装后仍不通过）：\n${parsed.stderr}`);
  } finally {
    try { fs.unlinkSync(tmp); } catch (_) {}
  }
}

// ---------------------------------------------------------------------------
// 2. meta 形态与阶段顺序。phase 顺序是编排：改顺序等于改了各格看到的东西——
//    把 sizing 挪到算子清单之前，三域就先去算一份随时可能被推翻的算子表。
// ---------------------------------------------------------------------------
assert(/export const meta = \{/.test(src), `${FILE} 必须导出 meta`);
assert(new RegExp(`name: '${META_NAME}'`).test(src), `${FILE} 的 meta.name 必须是 ${META_NAME}`);
assert(/description: '[^']+'/.test(src), `${FILE} 的 meta.description 不得为空`);
assert(/whenToUse: '[^']+'/.test(src), `${FILE} 的 meta.whenToUse 必须写明何时用它与需要哪些 args`);

{
  const order = [...src.matchAll(/^phase\('([^']+)'\)/gm)].map((m) => m[1]);
  assert.deepStrictEqual(order, PHASES, `${FILE} 的 phase 顺序不符`);
  const metaBlock = src.slice(0, src.indexOf('\n}'));
  const declared = [...metaBlock.matchAll(/title:\s*'([^']+)'/g)].map((m) => m[1]);
  assert.deepStrictEqual(declared, PHASES, `${FILE} 的 meta.phases 必须与 phase() 调用逐项一致`);
  assert.strictEqual(new Set(declared).size, declared.length, `${FILE} 的 meta.phases 有重复标题`);
}

// Q1 先于 Q2：算子清单没定，逐个算子的强度就没有对象。
{
  const invIdx = src.indexOf("phase('Operator inventory')");
  const sizIdx = src.indexOf("phase('Roofline and sizing')");
  assert(invIdx >= 0 && sizIdx > invIdx,
    'design.req.workload 必须先定算子 DAG 再算 sizing：并行会让两侧去算一份可能被推翻的算子表');
}

// ---------------------------------------------------------------------------
// 3. 契约守卫。brief 必给、内核产物必给、brief.stage 必须与本格一致。
//    第三守卫是契约串了时的唯一防线——拿 intake 的 brief 去跑本格，
//    守卫不拦就会用错阶段的输入跑出一份看起来正常的产物。
// ---------------------------------------------------------------------------
assert(/if \(!BRIEF\) throw new Error/.test(src), `${FILE} 必须守卫 args.brief`);
assert(new RegExp(`const STAGE = '${STAGE.replace('.', '\\.')}'`).test(src), `${FILE} 的 STAGE 必须是 ${STAGE}`);
assert(/BRIEF\.stage !== STAGE/.test(src), `${FILE} 必须守卫 brief.stage 与本格一致`);
assert(/UNVERIFIED/.test(src), `${FILE} 必须把取不到的出处记成 UNVERIFIED，而不是留空或补值`);
// 前移后它与 req.budget 是前后依赖：工作量是预算切分的输入，所以 brief 里
// 的预算数字只是硬约束，工作量必须来自内核产物，不能由本格自己估。
assert(/WORKLOAD_REQUIREMENTS\s*&&\s*WORKLOAD_ARTIFACT|!WORKLOAD_REQUIREMENTS \|\| !WORKLOAD_ARTIFACT/.test(src),
  'design.req.workload 必须守卫 args.workloadRequirements 与 args.workloadArtifact（内核产物由主循环生成）');

// ---------------------------------------------------------------------------
// 4. §9.2：缺输入必有出路。缺输入时必须以 BLOCKED_CONFIG（或同类终止裁决）
//    收场并给出 nextActions——不得静默补全，也不得只留一句 reason 就走。
// ---------------------------------------------------------------------------
{
  const all = returnBodies(src);
  const guards = all.slice(0, -1);
  assert(guards.length > 0, `${FILE} 至少要有一条缺输入时的早退分支`);
  const terminating = guards.filter((r) =>
    /'BLOCKED_CONFIG'|'DIRECTION_BACKFLOW'|'DELTA_UNEXPLAINED'/.test(r.body));
  assert(terminating.length > 0, `${FILE} 至少要有一条终止性分支（缺输入时不落盘）`);
  for (const [i, {body}] of terminating.entries()) {
    assert(/nextActions\s*:/.test(body),
      `${FILE} 的第 ${i + 1} 条终止分支缺 nextActions：缺输入时给出下一步，不得只写 reason`);
    assert(/files:\s*\[\]/.test(body),
      `${FILE} 的第 ${i + 1} 条终止分支必须 files: []，不得"标注一下仍然落盘"`);
  }
}

// ---------------------------------------------------------------------------
// 5. 检点收尾与门控。最后一格 agent 调用必须是 invariant-checker，
//    且落盘受它门控——末步是总结而不是检点，违规项就会被"总结"掉。
// ---------------------------------------------------------------------------
{
  const calls = [...src.matchAll(/head\('([a-z][a-z0-9-]*)'\)/g)];
  assert(calls.length > 0, `${FILE} 必须调用策略实例`);
  assert.strictEqual(calls[calls.length - 1][1], 'invariant-checker',
    `${FILE} 的最后一格 agent 调用必须是 invariant-checker`);

  const gate = src.match(/const\s+([A-Za-z_$][\w$]*)\s*=\s*check\s*&&\s*check\.verdict\s*===\s*'INVARIANT_OK'/);
  assert(gate, '必须以 `check && check.verdict === \'INVARIANT_OK\'` 的形式给检点裁决赋值');
  const ret = src.slice(src.lastIndexOf('return {')).replace(/\s+/g, '');
  assert(new RegExp(`files:${gate[1]}\\?`).test(ret),
    `${FILE} 落盘的 files 必须由检点裁决门控`);
  const emptyFirst = new RegExp(`files:${gate[1]}\\?\\[\\]:`).test(ret);
  const emptyLast = new RegExp(`files:${gate[1]}\\?\\[[\\s\\S]+?\\]:\\[\\],?\\}`).test(ret);
  assert(emptyFirst || emptyLast, `${FILE} 检点不通过的那一支必须是 files: []，不得仍然落盘`);
}

// ---------------------------------------------------------------------------
// 6. 只读与确定性。workflow 没有文件系统，也不能取时间或随机数。
// ---------------------------------------------------------------------------
assert(!/\brequire\s*\(/.test(src), `${FILE} 不得 require；workflow 脚本没有文件系统权限`);
assert(!/\bfs\./.test(src), `${FILE} 不得使用 fs；落盘由主循环完成`);
assert(!/Date\.now\(|Math\.random\(|new Date\(\)/.test(src), `${FILE} 不得取时间或随机数；会破坏 resume`);

// 产物落在 out/requirements/workload/ 下：内核的产物在 out/requirements/*.json，
// 本格落盘的两份放进子目录，互不覆盖——同一目录里既有生成器产物又有 workflow 产物，
// 清理与复现都说不清哪一个是谁写的。
{
  const paths = [...src.matchAll(/path: `\$\{REPO\}([^`]+)`/g)].map((m) => m[1]);
  assert(paths.length > 0, `${FILE} 必须声明落盘路径`);
  for (const p of paths) {
    assert(p.startsWith(LANDING_PREFIX),
      `${FILE} 的落盘路径 ${p} 不在 ${LANDING_PREFIX} 下（内核产物另在 out/requirements/ 根下）`);
  }
  const landing = fs.readFileSync(path.join(root, 'integration/orchestration/runtime/land.js'), 'utf8');
  assert(new RegExp(`'req\\.workload': \\['out/requirements/workload/'\\]`).test(landing),
    `runtime/land.js 的 LANDING_POLICY 必须给 req.workload 放行 out/requirements/workload/`);
}

// ---------------------------------------------------------------------------
// 7. B1 的三条验收点（《22 号文档》§4），随文件前移，一条不删：
//   (a) 三条 sizing 比齐备（compute / bandwidth / network）——只报 compute 比
//       就说 sizing 做完了，网络受限的算子就没人看过；
//   (b) 每个算子五个字段齐全；
//   (c) 算子状态有取值域，不得发明新状态。
// 这三条比在数组里是带引号的（'requiredToAvailableRatio',），
// 所以每个片段都要连引号写，否则在引号处断掉。
// ---------------------------------------------------------------------------
assert(/const RATIO_FIELDS = \[[\s\S]*?'requiredToAvailableRatio',[\s\S]*?'requiredToAvailableBandwidthRatio',[\s\S]*?'requiredToAvailableNetworkRatio',/.test(src),
  'design.req.workload 必须钉住三条 sizing 比（compute / bandwidth / network）');
assert(/const OPERATOR_FIELDS = \['operatorId', 'coreClass', 'status', 'confidence', 'source'\]/.test(src),
  'design.req.workload 必须钉住算子的五个登记字段');
assert(/const OPERATOR_STATES = \[/.test(src),
  'design.req.workload 必须给算子状态一个取值域，而不是接受任意字符串');
assert(/sizingGaps\.length/.test(src),
  'design.req.workload 的退出条件必须由脚本对账（算子字段、三条比、状态），不由 agent 自律');
assert(/head\('integrator'\)/.test(src) && /INTEGRATION_OK/.test(src),
  'design.req.workload 必须调用 integrator 并消费其裁决');

// ---------------------------------------------------------------------------
// 8. 前移带来的三条判据。
// ---------------------------------------------------------------------------

// (a) 强度、Roofline 与三条比一律由内核算好并绑在产物里。本格与任何 agent
//     都不产生这些数字；边缘 4 的落点就在这里——agent 一旦"自己算一遍"，
//     这一格就又有了一套与内核不同的强度。
assert(/requirement_workload\.js|workload_requirements\.json/.test(src),
  'design.req.workload 必须指向内核产物（requirement_workload.js 的 out/requirements/workload_requirements.json）');
assert(/不得重算|逐字转抄/.test(src),
  'design.req.workload 必须写明强度/Roofline/三条比逐字转抄内核产物，不得重算');

// (b) 集合通信是并列的一域：第三位申报人是 comm-expert，不是由 memory-expert 兼管。
//     次数与字节两口径并列（reference-393 / repo-510，ADR-0004）。
assert(/\{agentId: 'comm-expert'/.test(src),
  'design.req.workload 的申报组必须含 comm-expert：集合通信在本格是并列的一域，不由内存侧兼管');
assert(/reference-393/.test(src) || /repo-510/.test(src),
  'design.req.workload 必须写明集合通信次数的两口径（ADR-0004）');

// (c) 三域各自独立申报，互不可见：看见彼此的结论就会把一份结论抄三遍。
assert(/await parallel\(DECLARANTS\.map/.test(src),
  'design.req.workload 的三域申报必须并行，互不可见，而不是串行');

// 缺席的一侧不能当作"没有意见"：它是三个域中的一个问题没人回答。
assert(/absent\.length|absentLateral/.test(src),
  'design.req.workload 必须把缺席的一域作为缺口拦下，而不是当成"那一域没问题"');

// ---------------------------------------------------------------------------
// 9. 裁决消费。roster 里每个策略的每个 verdictEnum 取值，必须满足二者之一：
//      (a) 被某个 design.*.workflow.js 消费
//      (b) 在 roster.pendingConsumption 里登记了到期切片
//    这条判据与 tools/check_agent_strategy.js 同源；这里把它钉在结构测试里，
//    让本格的验收不依赖治理组是否跑过。
// ---------------------------------------------------------------------------
const allWorkflowText = fs.readdirSync(wfDir)
  .filter((n) => /^design\..*\.workflow\.js$/.test(n))
  .map((n) => fs.readFileSync(path.join(wfDir, n), 'utf8'))
  .join('\n');

// 裁决名是 [A-Z0-9_]+，`\b` 在 `_` 处不成立，子串匹配会把 GATE_BLOCKED
// 判成被 GATE_BLOCKED_EXTRA 消费。边界必须手写。
const mentions = (blob, v) =>
  new RegExp(`(?<![A-Z0-9_])${v.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![A-Z0-9_])`).test(blob);

{
  const pending = new Map((roster.pendingConsumption || []).map((e) => [e.verdict, e]));
  for (const s of roster.strategies) {
    for (const v of s.verdictEnum) {
      if (mentions(allWorkflowText, v)) {
        assert(!pending.has(v), `${v} 已被 workflow 消费，但仍在 pendingConsumption 里；请删除这条过期记账`);
        continue;
      }
      const entry = pending.get(v);
      assert(entry, `${s.agentId} 的裁决 ${v} 未在任何 design.*.workflow.js 中被消费`);
      assert.strictEqual(entry.owner, s.agentId,
        `pendingConsumption.${v} 的 owner 写作 ${entry.owner}，实际由 ${s.agentId} 声明`);
      assert(entry.slice, `pendingConsumption.${v} 必须写明到期切片`);
    }
  }
}

// 本格消费的四个裁决必须都在 switch/分支里被接住。
assert(/LOCAL_DETAIL_FIX/.test(src) && /DIRECTION_BACKFLOW/.test(src) && /BLOCKED_CONFIG/.test(src),
  'design.req.workload 必须消费三位申报人的三个裁决');
assert(/DELTA_UNEXPLAINED/.test(src),
  'design.req.workload 必须消费 integrator 的 DELTA_UNEXPLAINED');
// 方向回流要在合并之前拦下：继续走只会产出一份建立在错前提上的账本，
// 而后面每一格都读它。
assert(/backflow\.length/.test(src) && src.indexOf('backflow.length') < src.indexOf("phase('Merge')"),
  'design.req.workload 必须在合并前拦下方向回流与配置缺口');

// ---------------------------------------------------------------------------
// 10. 策略版本与正文对齐。ledger 的 strategyVersions 是重跑差异的唯一解释依据。
// ---------------------------------------------------------------------------
{
  const versions = objectBody(src, 'strategyVersions: {');
  const pairs = [...versions.matchAll(/(?:'([a-z][a-z0-9-]*)'|([a-z][a-z0-9-]*)):\s*'([^']+)'/g)];
  const declared = new Map(pairs.map((m) => [m[1] || m[2], m[3]]));
  for (const [id, ver] of declared) {
    const entry = rosterById.get(id);
    assert(entry, `${FILE} 的 strategyVersions 含 roster 未定义的策略 ${id}`);
    assert.strictEqual(ver, entry.strategyVersion,
      `${FILE} 把 ${id} 记成 ${ver}，roster 记的是 ${entry.strategyVersion}`);
  }
  for (const id of strategyRefs(src)) {
    assert(declared.has(id), `${FILE} 调用了 ${id} 但未把它写进 strategyVersions`);
  }
}

for (const id of strategyRefs(src)) {
  const p = path.join(strategyDir, `${id}.md`);
  assert(fs.existsSync(p), `${FILE} 调用 ${id}，但缺策略正文 ${id}.md`);
  const text = fs.readFileSync(p, 'utf8');
  const entry = rosterById.get(id);
  assert(text.includes(`策略版本：${entry.strategyVersion}`),
    `${id}.md 声明的版本号必须与 roster 的 ${entry.strategyVersion} 一致`);
  assert(/## 禁止/.test(text) && /## 裁决/.test(text), `${id}.md 必须声明禁止事项与裁决枚举`);
  for (const v of entry.verdictEnum) {
    assert(text.includes(v), `${id}.md` + ` 的裁决一节必须覆盖 roster 声明的 ${v}`);
  }
}

// ---------------------------------------------------------------------------
// 11. 门控结论字面量。本格不得出现 PASS / D_GATE_PASSED / Q_GATE_PASSED 作为
//     自己的产出。禁止句里提到字面量是允许的（要能说明"不得写它"），
//     所以带否定词的行走白名单——这与 check_agent_strategy.js 的口径一致。
// ---------------------------------------------------------------------------
for (const [i, line] of src.split(/\r?\n/).entries()) {
  if (!/PASS/.test(line)) continue;
  assert(/不得|禁止|不判|严禁|不是|而非/.test(line), `${FILE}:${i + 1} 出现门控结论字面量：${line.trim()}`);
}
// 名义上禁止还不够：这条断言查的是它真的没在代码路径里产出 TPS/usr。
assert(!/tpsPerUser\s*:/.test(code), `${FILE} 不得输出 TPS/usr：本格只报算子级工作量与瓶颈归属`);

console.log(`PASS L1-a structure: ${FILE} parses as the runtime parses it, orders the operator DAG before sizing, `
  + `ends on the invariant check, keeps the three sizing ratios and the five operator fields, `
  + `and reads its intensities from the kernel artifact instead of recomputing them`);
