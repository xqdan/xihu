'use strict';

// S7 的四个 workflow：design.verify / design.backflow / design.audit / design.explore
// （E 组 3 个横切格 + X 组的受控逃生口）。
//
// 它守的是 S7 的验收判据（《22 号文档》§9.1/§9.2）：
//
//   "verify/audit 的策略无法读到设计阶段产物（prompt 约束 + 抽查验证）；
//    design.explore 产物全部落在 scratch/。"
//
// 这两句都不能靠读 prompt 措辞来验，得验到结构上：
//
//   * "无法读到设计阶段产物" —— 落成两条**脚本侧**的硬拦：
//     (a) 注入面只有 args 里的白名单字段（多一个入口就少一道防线）；
//     (b) 产物只以**路径数组**注入，不是序列化的设计对象；
//         且路径必须落在 out/ 下，scratch/ 等三处非证据目录直接拒收。
//     prompt 里那句禁令是给人看的，脚本里这两条才是给运行时的。
//   * "产物全部落在 scratch/" —— 落成：explore 只有一条落盘路径、
//     写死为 scratch/explore_<runId>.md、且没有任何覆写入口。
//
// 与 S5/S6 两份测试的三处结构性差异，都不是风格问题：
//
//   1. **E 组不以检点收尾。** 末格是 architect（verify/backflow）或 verifier（audit）。
//      roster §4.2 给 verify 的实例里没有 invariant-checker，这不是遗漏：
//      verify 的终端检查就是 verifier 本身，再叠一个检点者会得到两个互相参考的检查者。
//      所以 S6 的两条断言（末格是 invariant-checker、落盘受 okInvariants 门控）在这里
//      必须换成"落盘受本格自己的终裁门控"，不能照抄。
//   2. **explore 没有终止分支。** 它在缺 runId / 缺 question 时**抛错**而不是早退，
//      且无论探索成败都必须落盘（§5.3"每次运行必须落盘一份"）。
//      一份探索记录的价值恰恰在于它记下了走过的弯路——失败时尤其需要它。
//   3. **audit 的四个视角不是 roster 策略。** §4.2 写的
//      evidence-chain / basis-consistency / arithmetic / coverage 不在 12 个策略里，
//      它们是注入给 verifier 实例的检查口径。见第 11 节。

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
  verify: 'design.verify.workflow.js',
  backflow: 'design.backflow.workflow.js',
  audit: 'design.audit.workflow.js',
  explore: 'design.explore.workflow.js',
};
const META_NAME = {
  verify: 'design-verify',
  backflow: 'design-backflow',
  audit: 'design-audit',
  explore: 'design-explore',
};
const S7 = Object.keys(FILE);
const src = Object.fromEntries(S7.map((k) => [k, read(FILE[k])]));

// ---------------------------------------------------------------------------
// 取块体的助手。与 S6 的那套同源：这些文件里混着字符串、注释与模板字面量
// （prompt 全是 `${...}`），正则会在括号上被骗住，所以逐字符扫平配平。
// ---------------------------------------------------------------------------
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

function returnBodies(text) {
  const out = [];
  for (let i = text.indexOf('return {'); i >= 0; i = text.indexOf('return {', i + 1)) {
    const body = braceBody(text, text.indexOf('{', i));
    if (body !== null) out.push({start: i, body});
  }
  return out;
}

// 剥注释，只留代码。"不得出现 X"一律只看代码：这些文件的注释里有一类专门解释
// **为什么不这么做**（audit 的头部整段在讲"为什么四个视角不是四个策略"，
// 里头写满了不在 roster 里的名字）。否定断言若扫全文，就会把最该保留的那段
// 设计理由判成违规，逼着人删掉解释。字符串与模板字面量的内容原样保留
// （断言里有按字面量匹配的），注释换成等长空白（行号不错位）。
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

const code = Object.fromEntries(S7.map((k) => [k, stripComments(src[k])]));

const strategyRefs = (text) => [...new Set([
  ...[...text.matchAll(/head\('([a-z][a-z0-9-]*)'\)/g)].map((m) => m[1]),
  ...[...text.matchAll(/\bagentId:\s*'([a-z][a-z0-9-]*)'/g)].map((m) => m[1]),
])].sort();

// ---------------------------------------------------------------------------
// 1. 语法。workflow 脚本在运行时是包在一个函数里执行的，顶层 return 合法；
//    直接 node --check 会报 `Illegal return statement`。还原运行时的真实形态。
// ---------------------------------------------------------------------------
for (const k of S7) {
  const wrapped = `async function __workflow__() {\n${src[k].replace(/^export const meta/m, 'const meta')}\n}\n`;
  const tmp = path.join(os.tmpdir(), `s7-${k}-${process.pid}.mjs`);
  fs.writeFileSync(tmp, wrapped);
  try {
    const parsed = spawnSync(process.execPath, ['--check', tmp], {encoding: 'utf8'});
    assert.strictEqual(parsed.status, 0, `${FILE[k]} 语法错误（按运行时形态包装后仍不通过）：\n${parsed.stderr}`);
  } finally {
    try { fs.unlinkSync(tmp); } catch (_) {}
  }
}

// ---------------------------------------------------------------------------
// 2. meta 形态与阶段顺序。
// ---------------------------------------------------------------------------
const PHASES = {
  verify: ['Landed artifact intake', 'Independent checks', 'Gate evidence', 'Architect sign-off'],
  backflow: ['Attribution triage', 'Expert claim', 'Direction ruling', 'Framing check'],
  audit: ['Landed artifact intake', 'Four lenses', 'Consolidation', 'External reference frame'],
  explore: ['Explore', 'Scratch landing'],
};
for (const k of S7) {
  const t = src[k];
  assert(/export const meta = \{/.test(t), `${FILE[k]} 必须导出 meta`);
  assert(new RegExp(`name: '${META_NAME[k]}'`).test(t), `${FILE[k]} 的 meta.name 必须是 ${META_NAME[k]}`);
  assert(/description: '[^']+'/.test(t), `${FILE[k]} 的 meta.description 不得为空`);
  assert(/whenToUse: '[^']+'/.test(t), `${FILE[k]} 的 meta.whenToUse 必须写明何时用它与需要哪些 args`);

  // 允许缩进：可选阶段（如 design.audit 的外部参照系）本身就是条件执行的，
  // 它的 phase() 调用必须写在 if 块里。要求"必须在行首"会把这类阶段误判成缺失。
  const order = [...t.matchAll(/^\s*phase\('([^']+)'\)/gm)].map((m) => m[1]);
  assert.deepStrictEqual(order, PHASES[k], `${FILE[k]} 的 phase 顺序不符`);

  const metaBlock = t.slice(0, t.indexOf('\n}'));
  const declared = [...metaBlock.matchAll(/title:\s*'([^']+)'/g)].map((m) => m[1]);
  assert.deepStrictEqual(declared, PHASES[k], `${FILE[k]} 的 meta.phases 必须与 phase() 调用逐项一致`);
  assert.strictEqual(new Set(declared).size, declared.length, `${FILE[k]} 的 meta.phases 有重复标题`);
}

// ---------------------------------------------------------------------------
// 3. 契约守卫。四格都以同一组守卫开头：brief 必给、brief.stage 与本格一致。
//    第三守卫是契约串了时的唯一防线——拿 detail.integrate 的 brief 去跑 design.audit，
//    守卫不拦就会用错阶段的输入跑出一份看起来正常的复核报告。
// ---------------------------------------------------------------------------
for (const k of S7) {
  const t = src[k];
  assert(/if \(!BRIEF\) throw new Error/.test(t), `${FILE[k]} 必须守卫 args.brief`);
  assert(/const STAGE = '/.test(t), `${FILE[k]} 必须声明 STAGE 常量`);
  assert(/BRIEF\.stage !== STAGE/.test(t), `${FILE[k]} 必须守卫 brief.stage 与本格一致`);
}

// 出处纪律：verify/backflow/audit 三格都要"取不到就记 UNVERIFIED"。
// explore 不在其列，且规则正好相反：它不做验证、不给可引用的结论，
// 它要防的是**给推断套一个不存在的出处**（探索记录里编造出处比写"不确定"危险得多）。
for (const k of ['verify', 'backflow', 'audit']) {
  assert(/UNVERIFIED/.test(src[k]),
    `${FILE[k]} 必须把取不到的出处记成 UNVERIFIED，而不是留空或补值`);
}
assert(/不要给推断套上一个不存在的出处/.test(src.explore),
  'design.explore 必须禁止给推断套一个不存在的出处：探索记录里编造出处比写"不确定"危险得多');

// ---------------------------------------------------------------------------
// 4. §9.2 在 E 组的形态：缺输入必有出路，且**不落盘**。
//
//    verify / audit 还多一条**没有可验证对象时不运行**：产物列表为空直接抛错。
//    这一条与 D 组的"缺输入输出 BLOCKED_CONFIG"不同——D 组缺的是某个输入字段，
//    还能把缺什么写下来；这里缺的是验证对象本身，没有对象就没有报告可写。
// ---------------------------------------------------------------------------
for (const k of ['verify', 'audit']) {
  assert(/if \(!ARTIFACTS\.length\)/.test(src[k]),
    `${FILE[k]} 必须守卫 args.artifacts：没有产物就没有可验证/可复核的对象，不得空跑一轮`);
}

for (const k of ['verify', 'backflow', 'audit']) {
  const all = returnBodies(src[k]);
  // 最后一个 return 是落盘处（受终裁门控），它自己那条 else 支路在第 6 节单独查。
  const guards = all.slice(0, -1);
  assert(guards.length > 0, `${FILE[k]} 至少要有一条缺输入时的早退分支`);
  for (const [i, {body}] of guards.entries()) {
    assert(/nextActions\s*:/.test(body),
      `${FILE[k]} 的第 ${i + 1} 条早退分支缺 nextActions：§9.2 要求缺输入时给出下一步，不得只写 reason`);
    assert(/files:\s*\[\]/.test(body),
      `${FILE[k]} 的第 ${i + 1} 条早退分支必须 files: []，不得"标注一下仍然落盘"`);
  }
}

// backflow 的三条缺输入路径都要在，且各自的判据不同：
//   无归因（NOOP）           —— 细化与方向一致，本格不该运行
//   归纳未产出              —— 没有可消费的候选
//   认领不完整              —— 归因没有全部被认领
assert(/DIRECTION_BACKFLOW_NOOP/.test(src.backflow),
  'design.backflow 必须把"无归因可回流"当成一个合法结论（NOOP），而不是空跑一轮');
assert(/!triage/.test(src.backflow), 'design.backflow 必须守卫 integrator 归纳未产出');
assert(/claims\.length < cappedOwners\.length/.test(src.backflow),
  'design.backflow 必须守卫认领不完整：归因没全部被认领，回流提案就不成立');

// ---------------------------------------------------------------------------
// 5. 无事可做是合法结论。
//
//    这是 E 组与 C/D 组最不同的一条：回流的默认答案应当是"不需要回流"。
//    一个只会说"要回流"的回流器，会把每个细化瑕疵都升级成一次方向重做。
//    所以"全部够不上方向级 → INTEGRATION_OK 早退"这条分支必须在，且必须在
//    专家认领**之前**——先让专家认领一遍再判"其实不用回流"，
//    等于让每个专家为一件不会发生的事写一份材料。
// ---------------------------------------------------------------------------
assert(/triage\.verdict === 'INTEGRATION_OK' \|\| !candidates\.length/.test(src.backflow),
  'design.backflow 必须支持"归因全部够不上方向级 → 不回流"的早退');
assert(/notDirectionLevel/.test(src.backflow),
  'design.backflow 必须把"够不上方向级的条目"与候选分开记：回流器最常见的失效是全都往上报');
{
  const earlyIdx = src.backflow.indexOf("triage.verdict === 'INTEGRATION_OK'");
  const claimIdx = src.backflow.indexOf("phase('Expert claim')");
  assert(earlyIdx >= 0 && claimIdx > earlyIdx,
    'design.backflow 的"不回流"早退必须在专家认领之前：否则每个专家都要为不会发生的事写材料');
}

// ---------------------------------------------------------------------------
// 6. 落盘门控。E 组的末格不是 invariant-checker（见文件头注 1），
//    所以这里查的是同一件事的另一种形态：最后一次 return 里凡有 files，
//    其条件必须是一个**已声明的合成变量**，且它合取的每一项都是某个实例的终裁。
//    不通过的判据写死在文件里，测试只验"落盘受它门控"这个形状。
// ---------------------------------------------------------------------------
for (const k of ['verify', 'backflow', 'audit']) {
  const all = returnBodies(src[k]);
  const landing = all[all.length - 1].body;

  // 落盘有两种合法形态：
  //   (a) files: <gate> ? [...] : []   —— 门控贴在落盘处（verify / backflow）
  //   (b) files: [...a, ...b]          —— 每类各自具名声明（audit：报告 + 参照系）
  // (b) 允许存在，是因为"报告受门控、参照系不受门控"是刻意的划分。但它把门控挪出了
  // landing，所以要顺着名字摸回声明——否则这一节会静默地什么都不验，比红更坏。
  //
  // 判据是**写不写 out/**，不是"是不是三元"：audit 的两类都是三元
  // （reportFiles 受 ok，referenceFiles 受 externalReferences），拿三元形状当门控判据
  // 会把参照系也当成一道证据门。真正的分界线是 out/ 下的产物会被下一轮当依据引用
  // （intake 门只收 out/ 下的产物），references/ 下的不会。
  // 于是：写 out/ 的那类必须受合取门控，不写 out/ 的那类必须只写 references/。
  const direct = (landing.match(/files:\s*([A-Za-z_$][\w$]*)\s*\?/) || [])[1];
  const spread = direct ? null : (landing.match(/files:\s*\[([^\]]*)\]/) || [])[1];
  assert(direct || spread,
    `${FILE[k]} 的落盘 files 既不是门控三元也不是展开数组，无法判定是否受门控`);

  // 每一类落盘取两条信息：它的门控条件，以及它声明里写了哪些路径。
  const classes = [];
  if (direct) {
    const m = new RegExp(`files:\\s*${direct}\\s*\\?([\\s\\S]*):\\s*\\[\\]`).exec(landing);
    assert(m, `${FILE[k]} 检点不通过的那一支必须是 []，不得仍然落盘`);
    classes.push({name: direct, cond: null, body: m[1]});
  } else {
    const names = [...spread.matchAll(/\.\.\.\s*([A-Za-z_$][\w$]*)/g)].map((m) => m[1]);
    assert(names.length, `${FILE[k]} 的落盘展开数组里没有具名成员，无法判定门控`);
    for (const n of names) {
      const d = new RegExp(`const\\s+${n}\\s*=\\s*([\\s\\S]*?)\\n\\n`).exec(src[k]);
      assert(d, `${FILE[k]} 的落盘成员 ${n} 必须在落盘前声明`);
      const decl = d[1];
      const q = decl.indexOf('?');
      assert(q >= 0,
        `${FILE[k]} 的落盘成员 ${n} 必须是门控三元——不受控的落盘会让不成立的结论也写下去`);
      assert(/:\s*\[\]\s*$/.test(decl),
        `${FILE[k]} 的落盘成员 ${n} 不通过的那一支必须是 []，不得仍然落盘`);
      classes.push({name: n, cond: decl.slice(0, q), body: decl});
    }
  }

  // 证据必须真的落下来：一类都不写 out/ 时，本格跑完等于什么也没留下。
  const evidence = classes.filter((c) => /out\//.test(c.body));
  assert(evidence.length, `${FILE[k]} 至少要有一类落盘写 out/，否则本格跑完不留证据`);

  for (const c of evidence) {
    // 门控必须合取**多个**条件：E 组的每一格都有"检查结果"与"裁决意见"两条独立来源，
    // 只受其中一条门控，另一条就形同虚设。
    // 合取可能写在门控变量自己的声明上（形态 a），也可能写在它引用的上游变量上
    // （形态 b：reportFiles = ok ? ...，真正的 && 在 ok 上），所以穿透一层。
    // 只穿一层：需要穿两层说明门控链已经绕到读不懂，那时该改代码而不是改测试。
    const seen = new Set([c.name]);
    let expr = c.cond || (new RegExp(`const\\s+${c.name}\\s*=\\s*([^\\n]*)`).exec(src[k]) || ['', ''])[1];
    while (!/&&/.test(expr)) {
      const next = (expr.match(/(?<![.\w$])([A-Za-z_$][\w$]*)\s*(?:&&|\?|$)/) || [])[1];
      if (!next || seen.has(next)) break;
      const up = new RegExp(`const\\s+${next}\\s*=\\s*([^\\n]*)`).exec(src[k]);
      if (!up) break;
      seen.add(next);
      expr = up[1];
    }
    assert(/&&/.test(expr), `${FILE[k]} 的落盘 ${c.name} 必须由多个条件合取，不得只看单一信号`);
  }

  // 不写 out/ 的那一类（参照系）只能写 references/ 下的路径。
  // 这条把 design.audit 的做法变成规矩，不是给它开后门：绕开门控之所以可接受，
  // 唯一理由是它到不了证据位。
  for (const c of classes.filter((x) => !/out\//.test(x.body))) {
    assert(/references\//.test(c.body),
      `${FILE[k]} 的不受门控落盘 ${c.name} 必须只写 references/ 下的路径——它不能是可被引作依据的证据`);
  }
}

// 三格各自的门控必须真的把"结论与事实自相矛盾"算进去。
// 少了这一条，"检查说失败、意见说通过"就会静默落盘——这是 E 组最危险的失效：
// 产物本身是完整的、格式合法的，只有把两份结果放在一起看才发现对不上。
assert(/routeContradictions/.test(src.verify),
  'design.verify 必须夹取"签署意见与检查结果自相矛盾"的组合');
assert(/contradictions/.test(src.backflow) && /contradictions/.test(src.audit),
  'design.backflow 与 design.audit 必须夹取结论自相矛盾的组合');
assert(/lensSelfContradictions/.test(src.audit) && /droppedFindings/.test(src.audit),
  'design.audit 必须对账"视角裁决与 findings 严重度不符"与"汇总丢失 blocking 发现"两类不自洽');

// ---------------------------------------------------------------------------
// 7. §9.2 头条 (a)：verify / audit 的策略注入里不得含设计中间产物。
//
//    这条是 S7 的真正验收点，也是唯一一条不能靠读 prompt 措辞来验的。
//    落成三层，每层都能在结构上查：
//
//      第一层 注入面白名单 —— 调用方能塞进来的东西只有 args 里这几个字段。
//              多一个入口就少一道防线：将来若有人加一句 args.candidates 进 prompt，
//              这一层当场失败。
//      第二层 只注入路径    —— 产物以路径数组注入，不是序列化的设计对象。
//              把候选/申报/草稿序列化进 prompt，验证者就会顺着写者的理由接受结论。
//      第三层 脚本侧硬拦    —— 不在 out/ 下的路径直接抛错，scratch/ 等三处非证据目录拒收。
//              prompt 里的规则是请求，脚本里的规则是事实。
// ---------------------------------------------------------------------------
const ARGS_ALLOW = {
  verify: ['repo', 'brief', 'runId', 'artifacts', 'gateStatusArtifact', 'registerArtifact', 'gateCommand'],
  // audit 多一个 premises：合并 k3_external_references 时带进来的可选入口。
  // 它**不**进四个视角与汇总的 prompt——那两类只吃 out/ 下的已落盘产物（见第三层硬拦）。
  // premises 只喂给可选的外部参照系阶段，那一阶段不产出裁决、不落 out/。
  // 换句话说它是注入面白名单上的一格，不是 §9.2 那条边界的一个例外：
  // 边界管的是"策略能不能读到设计中间产物"，而 premises 是调用方声明的**给定条件**。
  audit: ['repo', 'brief', 'runId', 'artifacts', 'referenceArtifact', 'baselineArtifact', 'premises'],
};
for (const [k, allow] of Object.entries(ARGS_ALLOW)) {
  const used = [...new Set([...src[k].matchAll(/\bargs\.([A-Za-z_$][\w$]*)/g)].map((m) => m[1]))];
  for (const a of used) {
    assert(allow.includes(a),
      `${FILE[k]} 读了 args.${a}，但 ${k} 的注入面白名单里没有它。`
      + 'E 组的注入面是安全边界：加一个入口就得同步加它的守卫与来源说明');
  }
  // 白名单里的每一项都要真的被用到——白名单本身也会过期。
  for (const a of allow) {
    assert(used.includes(a), `${FILE[k]} 的注入面白名单列了 args.${a}，但文件里没用到；白名单过期了`);
  }
}

for (const k of ['verify', 'audit']) {
  const t = src[k];
  // 第二层：产物只以路径注入。
  assert(/ARTIFACT_LIST = ARTIFACTS\.map\(\(p\) => /.test(t),
    `${FILE[k]} 必须把产物作为**路径**注入（ARTIFACT_LIST），而不是序列化的设计对象`);
  assert(!/JSON\.stringify\(ARTIFACTS/.test(t),
    `${FILE[k]} 不得把产物数组整体序列化进 prompt：那等于把注入面从路径放大成内容`);
  // 第三层：脚本侧硬拦。
  assert(/const LANDED_MARK = '\/out\/'/.test(t),
    `${FILE[k]} 必须定义"落盘产物"的判据（out/ 下），而不是靠调用方自觉`);
  assert(/const NOT_EVIDENCE_DIRS = \['\/scratch\/', '\/probes\/', '\/\.probe-tmp\/'\]/.test(t),
    `${FILE[k]} 必须显式拒收 scratch/ 等非证据目录`);
  assert(/notLanded\.length \|\| notEvidence\.length \|\| duplicated\.length/.test(t),
    `${FILE[k]} 的 intake 必须由脚本对账并抛错，不能只写在 prompt 里`);
  // prompt 侧的同一条禁令也要在（脚本拦不住的部分：仓库里的规格正文该读、对话不该读）。
  assert(/不得读设计过程的中间产物/.test(t),
    `${FILE[k]} 的注入头部必须写明不得读设计过程的中间产物`);
}
// "自述不是证据"这条在两格里的措辞不同（verify 说"不得以设计者自述作为验证依据"，
// audit 说"设计者的自述不是依据——它是待复核的对象"），但指的是同一条规则：
// 顺着写者的理由走，独立验证就退化成盖章。断言认这两句，不认措辞。
for (const k of ['verify', 'audit']) {
  assert(/不得以设计者自述作为验证依据|设计者的自述不是依据/.test(src[k]),
    `${FILE[k]} 必须写明设计者自述是待验证的输入、不是证据`);
}

// run record 里要留下这次验证**到底看了哪些文件**——事后复核一份验证结论时，
// 第一个要问的就是这个。空数组字段在这里不是装饰，是这个问题唯一的答案。
for (const k of ['verify', 'audit']) {
  assert(/injectedDesignIntermediates: \[\]/.test(src[k]),
    `${FILE[k]} 的 run record 必须显式记下"注入了零个设计中间产物"这一事实`);
  assert(/artifactsVerified: ARTIFACTS\.slice\(\)\.sort\(\)|artifactsAudited: ARTIFACTS\.slice\(\)\.sort\(\)/.test(src[k]),
    `${FILE[k]} 的 run record 必须记下落盘产物的完整清单（排序后），供事后复核`);
}

// ---------------------------------------------------------------------------
// 8. 语法无关但语义有关的确定性约束。workflow 没有文件系统，也不能取时间或随机数。
// ---------------------------------------------------------------------------
for (const k of S7) {
  const t = src[k];
  assert(!/\brequire\s*\(/.test(t), `${FILE[k]} 不得 require；workflow 脚本没有文件系统权限`);
  assert(!/\bfs\./.test(t), `${FILE[k]} 不得使用 fs；落盘由主循环完成`);
  assert(!/Date\.now\(|Math\.random\(|new Date\(\)/.test(t), `${FILE[k]} 不得取时间或随机数；会破坏 resume`);
}

// ---------------------------------------------------------------------------
// 9. 落盘位置。三格各归一处，explore 单独处理（第 10 节）。
//    E 组的产物目录不是新的：verification/ 与 governance/ 在 out/ 的目录表里
//    本来就有行，verify/audit 的报告与既有产物同处一处，靠 stage 字段区分。
// ---------------------------------------------------------------------------
const LANDING_DIR = {
  verify: '/out/verification/',
  backflow: '/out/governance/',
  audit: '/out/verification/',
};
for (const [k, dir] of Object.entries(LANDING_DIR)) {
  const paths = [...src[k].matchAll(/path: `\$\{REPO\}([^`]+)`/g)].map((m) => m[1]);
  assert(paths.length > 0, `${FILE[k]} 必须声明落盘路径`);

  // 产物分两类，位置就是这两类的分界：
  //   out/<stage>/  —— 证据位。下一轮会被当依据读（intake 门只收 out/ 下的产物），
  //                    所以它必须落在本格自己的目录里，且受门控（第 6 节）。
  //   references/   —— 参照系位。它是"同类系统取值区间"，不是本项目的依据，
  //                    进不了 intake 门，因此可以不受门控、可以跨轮留存。
  // 别的目录一律不行：scratch/probes 是非证据目录，落那儿等于悄悄丢产物。
  const evidence = paths.filter((p) => p.startsWith(dir));
  const frame = paths.filter((p) => !p.startsWith(dir));
  assert(evidence.length > 0, `${FILE[k]} 没有任何落盘路径在 ${dir} 下——本格跑完不留证据`);
  for (const p of frame) {
    assert(p.startsWith('/references/'),
      `${FILE[k]} 的落盘路径 ${p} 既不在 ${dir} 下也不在 /references/ 下；`
      + '产物只有两个去处：证据位（out/ 本格目录）或参照系位（references/）');
  }
  // 参照系位不是"第二个证据位"：谁都能往里写就等于绕开了上面那道门。
  // 目前只有 audit 需要它（外部参照系随前提每轮调研），别的格要加就得同时说明理由。
  assert(frame.length <= 1,
    `${FILE[k]} 声明了 ${frame.length} 条参照系落盘路径；参照系位至多一处，多了就成了绕开证据门的旁路`);
}

// verify 与 audit 都落 out/verification/，所以两者的文件名必须不同——
// 同一目录下重名会让后跑的覆盖先跑的，而两份报告回答的是不同的问题。
{
  const names = (k) => [...src[k].matchAll(/path: `\$\{REPO\}\/out\/verification\/([^`]+)`/g)]
    .map((m) => m[1].replace(/\$\{STAGE\}/g, k));
  const v = names('verify');
  const a = names('audit');
  assert(v.length && a.length, 'verify 与 audit 都必须落 out/verification/');
  for (const n of v) {
    assert(!a.includes(n), `verify 与 audit 的产物重名：${n}；两份报告回答不同的问题，不得互相覆盖`);
  }
}

// ---------------------------------------------------------------------------
// 10. §9.2 头条 (b)：design.explore 的产物全部落在 scratch/。
//
//     这一格与其余三格反着来：它**没有**落盘门控（§5.3 要求每次运行必须落盘），
//     却有一个更硬的位置约束。所以测试也反过来查：
//       不是"什么条件下才落盘"，而是"无论成败都落盘，且只能落这一个地方"。
// ---------------------------------------------------------------------------
{
  const t = src.explore;

  // 单实例、无并行、无检点——§5.3 的定义。
  assert.strictEqual((t.match(/await agent\(/g) || []).length, 1,
    'design.explore 必须是单个策略实例：不加第二个 agent（加了就要为中间结论负责，而探索的价值在于可以走错）');
  assert(!/\bparallel\(/.test(t), 'design.explore 不得并行：§5.3 明文"无并行"');
  assert(!/head\('invariant-checker'\)/.test(code.explore),
    'design.explore 不得调用 invariant-checker：§5.3 明文"无检点"');

  // 落盘路径写死在 scratch/ 下，且没有覆写入口。
  assert(/const SCRATCH_DIR = `\$\{REPO\}\/scratch`/.test(t),
    'design.explore 的产物目录必须写死为 scratch/');
  assert(/const EXPLORE_PATH = `\$\{SCRATCH_DIR\}\/explore_\$\{RUN_ID\}\.md`/.test(t),
    'design.explore 的产物必须是 scratch/explore_<runId>.md：文件名带 runId，两次探索才不互相覆盖');
  assert(!/args\.outputPath|args\.outDir|args\.artifactPath/.test(t),
    'design.explore 不得提供产物路径的覆写入口：一旦能覆写，逃生口就成了绕过 intake 的旁路');
  assert(!/\/out\//.test([...code.explore.matchAll(/path:\s*[^,\n]+/g)].map((m) => m[0]).join('\n')),
    'design.explore 的落盘路径不得出现 out/');

  // 路径自检：拼错了当场发现，而不是等主循环把探索记录写进 out/ 之后。
  assert(/EXPLORE_PATH\.includes\('\/out\/'\) \|\| !EXPLORE_PATH\.includes\('\/scratch\/'\)/.test(t),
    'design.explore 必须自检产物路径落在 scratch/ 下');

  // 落盘只有一条路径，且无条件。
  const all = returnBodies(t);
  assert.strictEqual(all.length, 1, 'design.explore 只有一个 return（落盘处），没有早退分支');
  const landing = all[0].body;
  assert(/files:\s*\[\s*\{path: EXPLORE_PATH/.test(landing),
    'design.explore 的落盘只有 scratch/explore_<runId>.md 这一条路径');
  assert(!/files:\s*[A-Za-z_$][\w$]*\s*\?/.test(landing),
    'design.explore 的落盘不得受条件门控：§5.3 要求每次运行必须落盘一份探索记录，失败时尤其需要它');

  // 缺 runId / 缺 question 时抛错，不是早退。缺 runId 会让两次探索互相覆盖，
  // 而探索记录的价值正在于它留下了哪一次。
  assert(/if \(!RUN_ID\)/.test(t) && /if \(!QUESTION\)/.test(t),
    'design.explore 必须守卫 args.runId 与 args.question');
  assert(/探针|覆盖/.test(t) || /两次探索会互相覆盖/.test(t),
    'design.explore 必须写明缺 runId 的具体后果（两次探索互相覆盖）');

  // 三条禁令必须在返回值里**显式声明**，而不是只写在注释或 prompt 里：
  // 读这个返回值的东西（主循环、将来的任何消费者）不需要去翻 §5.3 才知道它不可引用。
  assert(/quotableAsEvidence: false/.test(t) && /goesToLedger: false/.test(t) && /writesToOut: false/.test(t),
    'design.explore 必须在返回值里声明 quotableAsEvidence/goesToLedger/writesToOut 三条禁令');
  assert(/landedUnder: 'scratch\/'/.test(t),
    'design.explore 必须声明产物落在 scratch/ 下');

  // 只有 scratch/ 下的路径，不许进 ledger、不许作为证据——这三条是逃生口的全部安全性所在。
  assert(/不得作为任何 claim 的证据/.test(t),
    'design.explore 必须写明产物不得作为任何 claim 的证据');
  assert(/不进 ledger/.test(t) && /不写 `out\/`|不写 out\//.test(t),
    'design.explore 必须写明产物不进 ledger、不写 out/');
}

// ---------------------------------------------------------------------------
// 11. audit 的四个视角**不是** roster 策略。
//
//     §4.2 把 design.audit 的实例写成
//       evidence-chain / basis-consistency / arithmetic / coverage 各×1 · verifier×1 汇总，
//     但这四个名字不在 12 个策略里（roster 是 compute/memory/comm/physical/software/
//     model/architect/integrator/invariant-checker/framing-critic/gate-keeper/verifier）。
//
//     实现取的是"四个视角注入给四个 verifier 实例"，理由（写在 audit 文件头）是：
//     视角是**运行时**的取用方式，不是策略定义。这条原则与仓库的
//     "agent 只有在 workflow 里运行时才参与设计"是同一条。
//
//     本节的断言守两边：四个视角必须在（否则 §4.2 的覆盖少了），
//     且它们不得被当成策略调用（否则 roster 会从 12 漂成 16，而
//     tests/governance/test_agent_strategy_boundary.js 钉死了 12）。
// ---------------------------------------------------------------------------
{
  const IDS = ['A-EVIDENCE-CHAIN', 'A-BASIS-CONSISTENCY', 'A-ARITHMETIC', 'A-COVERAGE'];
  assert(/const VERIFY_LENSES = \[/.test(src.audit),
    'design.audit 必须把四个复核视角写成常量数组（常量而非从产物里读：让被测数据决定考题等于没有考题）');
  for (const id of IDS) {
    assert(src.audit.includes(`id: '${id}'`), `design.audit 必须钉住复核视角 ${id}`);
  }
  // 四个视角都要有自己的失效模式与检查范围——否则"四个视角"会退化成一个视角跑四遍。
  const lensBlock = src.audit.slice(src.audit.indexOf('const VERIFY_LENSES = ['),
    src.audit.indexOf('const LENS_SCHEMA'));
  assert.strictEqual((lensBlock.match(/failureMode:/g) || []).length, IDS.length,
    'design.audit 的每个视角都必须写明自己的失效模式：冗余的检查者只能发现同一类问题四次');
  assert.strictEqual((lensBlock.match(/scope: \[/g) || []).length, IDS.length,
    'design.audit 的每个视角都必须有一份检查范围清单');

  // 四个视角不得被当作策略调用：它们没有策略正文文件。
  for (const id of IDS) {
    assert(!new RegExp(`head\\('${id}'\\)`).test(src.audit),
      `design.audit 不得把视角 ${id} 当策略调用：它不是 roster 里的 agentId，没有策略正文`);
    assert(!rosterById.has(id),
      `${id} 出现在 roster 里——若真把它提升为策略，要同步改 agent_roster.json、`
      + 'teams/council/strategies/ 下的 .md 与 test_agent_strategy_boundary.js 的 12 条断言');
  }
  // 四个视角实例都是 verifier。
  assert.strictEqual((src.audit.match(/head\('verifier'\)/g) || []).length, 2,
    'design.audit 的四个视角与汇总都必须是 verifier 实例（2 处 head 调用：并行体 + 汇总）');
}

// ---------------------------------------------------------------------------
// 12. 各格的验收点。
// ---------------------------------------------------------------------------

// verify：7 类独立检查，类别是常量不从产物里读；注入面只有落盘产物；
// gate-keeper 只核证据完备性、只照抄门控结论。
assert(/const VERIFY_CHECKS = \[/.test(src.verify),
  'design.verify 必须把 7 类检查写成常量数组');
for (const id of ['V-SCHEMA', 'V-CONSERVATION', 'V-PROVENANCE', 'V-PROFILE', 'V-MATRIX', 'V-REPLAY', 'V-SYNTHETIC']) {
  assert(src.verify.includes(`id: '${id}'`), `design.verify 必须钉住检查 ${id}`);
}
assert(/await parallel\(VERIFY_CHECKS\.map/.test(src.verify),
  'design.verify 的 7 类检查必须并行：一个实例看到另一个的结论，7 类就退化成一个检查加六次附和');
assert(/VERIFY_CHECKS\.every\(\(c\) => reportedChecks\.filter\(\(r\) => r\.checkId === c\.id\)\.length === 1\)/.test(src.verify),
  'design.verify 必须在检查不完整时拒绝落盘：漏掉的那一类读起来会像"那一类也没问题"');
assert(/照抄/.test(src.verify),
  'design.verify 的 gate-keeper 必须照抄门控结论原文，不得改写、不得推断');
assert(/gateDecisionSource/.test(src.verify),
  'design.verify 必须记下门控结论的来源（evaluate_gates.js）');
assert(/eft?ort: 'high'|effort: 'high'/.test(src.verify) || /effort: 'high'/.test(src.verify),
  'design.verify 的检查实例必须用高推理档：独立验证是本流程里最不能省的一环');
// 18 个槽位的覆盖是 verify 的一条独立检查（V-MATRIX），必须写明不得以"其余同理"带过。
assert(/其余同理/.test(src.verify) && /18 个槽位/.test(src.verify),
  'design.verify 的回归矩阵检查必须写明 18 个槽位与"不得以其余同理带过"');
// 合成数据不得签核。
assert(/SYNTHETIC_PLACEHOLDER/.test(src.verify),
  'design.verify 必须写明合成/占位数据不得支撑任何结论');

// backflow：回流是例外不是常态；专家的 localFix 与 directionImpact 同等重要；
// 被拒候选不得静默丢弃；产出的 reworkScope 只做定性描述。
assert(/回流是一条很贵的路/.test(src.backflow) || /举证责任在"要回流"这一边/.test(src.backflow),
  'design.backflow 必须把举证的偏向写死在注入里：说不出被动摇的是哪条方向级假设，就不该走这条路');
assert(/localFix/.test(src.backflow) && /directionImpact/.test(src.backflow),
  'design.backflow 的专家必须同时给 localFix 与 directionImpact：只会往上报的专家等于没有把关');
assert(/一个只会往上报的专家/.test(src.backflow),
  'design.backflow 必须显式点破"只会往上报"这种失效');
assert(/不得静默丢弃/.test(src.backflow),
  'design.backflow 的被拒候选必须写明去处，不得静默丢弃（丢了下一轮会重新发现同一个问题）');
assert(/estimatedCost: \{ type: 'string'/.test(src.backflow) && /不得给工时或 TPS 数字/.test(src.backflow),
  'design.backflow 的重做范围只做定性描述，不得给决定性数字');
assert(/cappedOwners|slice\(0, 3\)/.test(src.backflow),
  'design.backflow 的被归因专家必须限定在 1–3 位（§4.2）');
assert(/expertsWithoutInstance: droppedOwners/.test(src.backflow),
  'design.backflow 超出实例上限的归因主体必须记进 run record，不得静默吞掉');
assert(/supersedesDirectionFeedback: false/.test(src.backflow),
  'design.backflow 必须声明它不改写 direction_feedback.json：那份文件由脚本确定性生成');
assert(/isGateConclusion: false/.test(src.backflow),
  'design.backflow 的产物必须明写"这不是门控结论"');

// framing-critic 在 backflow 里检的是**框定**，不是结论。
assert(/head\('framing-critic'\)/.test(src.backflow),
  'design.backflow 必须调用 framing-critic');
{
  const fIdx = src.backflow.indexOf("head('framing-critic')");
  const prompt = src.backflow.slice(fIdx, fIdx + 3000);
  assert(/回流的框定/.test(prompt),
    'design.backflow 的 framing-critic 必须检"回流的框定本身"，而不是给技术判断投一次票');
  assert(/范围是不是过大|重做范围是不是过大/.test(prompt),
    'design.backflow 的 framing-critic 必须检重做范围：过大把局部返工升格成方向重做');
  assert(/你的否决是否决\*\*这次框定\*\*/.test(prompt) || /否决\*\*这次框定\*\*/.test(prompt),
    'design.backflow 必须写明 framing-critic 否决的是这一次框定，不是某条技术判断');
}

// audit：四个视角互不可见；汇总不得改判严重度；覆盖度视角必须要求 clean 清单。
assert(/await parallel\(VERIFY_LENSES\.map/.test(src.audit),
  'design.audit 的四个视角必须并行且互不可见');
assert(/\*\*你不得改判严重度、不得否掉任何一条发现、不得重做复核/.test(src.audit),
  'design.audit 的汇总者不得改判严重度或否决单路发现：它的职责是合并与关联，不是裁决');
assert(/空数组会被读成"这个视角没查"，而不是"这个视角没问题"/.test(src.audit),
  'design.audit 必须要求每个视角给出 clean 清单：空数组是"没查"而不是"没问题"');
assert(/省略是覆盖度审计里最严重的失效/.test(src.audit),
  'design.audit 的覆盖度视角必须点明"省略"这一类失效');
assert(/不得以"其余同理"带过/.test(src.audit),
  'design.audit 的覆盖度视角必须禁止"其余同理"');
assert(/两组 card-power 口径/.test(src.audit) && /45\.5141376|共享端口项/.test(src.audit),
  'design.audit 的依据一致性视角必须点名卡功耗的两套口径：这是本仓库最容易被混用的量');
assert(/你复算时用的是产物里的裸值，不是产物里的比例/.test(src.audit),
  'design.audit 的算术视角必须要求用裸值复算：用别人算好的比例验算，只能验出抄写错误');

// verify 与 audit 的分工必须写在文件里——否则两者会退化成同一件事跑两遍。
assert(/audit 查的是关系，verify 查的是个体/.test(src.audit),
  'design.audit 必须写明与 design.verify 的分工（面向依据 vs 面向产物）');

// ---------------------------------------------------------------------------
// 13. 裁决消费。roster 里每个策略的每个 verdictEnum 都要被某个 workflow 消费
//     （pendingConsumption 当前为空，即 16 个枚举值全部必须被消费）。
//
//     这一节与 S6 §7 同源，但 S7 必须自己再查一遍：E 组的四格是 E 组裁决的
//     主要落点，S6 那边绿说明的是"有人接了"，这里要说明的是"E 组接了哪些"。
//     两份断言不重复：S6 查全仓覆盖，这里查 E 组的归属是否对得上 §4.2。
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

// E 组各格必须消费到 §4.2 分给它的那几个策略的裁决。
const E_CONSUMPTION = {
  verify: {'verifier': ['VERIFIED', 'VERIFY_FAILED'], 'gate-keeper': ['GATE_EVIDENCE_COMPLETE', 'GATE_BLOCKED'], 'architect': ['D_GATE_PROPOSAL', 'DIRECTION_BACKFLOW']},
  backflow: {'integrator': ['INTEGRATION_OK', 'DELTA_UNEXPLAINED'], 'architect': ['DIRECTION_BACKFLOW', 'ARCH_FREEZE'], 'framing-critic': ['FRAMING_OK', 'FRAMING_INSUFFICIENT']},
  audit: {'verifier': ['VERIFIED', 'VERIFY_FAILED']},
};
for (const [k, byAgent] of Object.entries(E_CONSUMPTION)) {
  for (const [agentId, verdicts] of Object.entries(byAgent)) {
    for (const v of verdicts) {
      assert(mentions(src[k], v), `${FILE[k]} 调用了 ${agentId}，必须消费它的裁决 ${v}`);
    }
  }
}

// 专家裁决在 E 组的落点：backflow 认领的是被归因专家，枚举按 roster 各自给——
// 只有 physical-expert 有 PPA_DIRECTION_BACKFLOW，不能摊平成一个枚举表。
assert(/LOCAL_DETAIL_FIX', 'DIRECTION_BACKFLOW', 'PPA_DIRECTION_BACKFLOW', 'BLOCKED_CONFIG'/.test(src.backflow),
  'design.backflow 的专家认领必须按 roster 给足四个专家裁决，含 PPA_DIRECTION_BACKFLOW');

// ---------------------------------------------------------------------------
// 14. 策略版本对齐与策略正文存在性。
//     ledger 的 strategyVersions 是重跑差异的唯一解释依据：版本对不上，
//     两次跑出不同结果就无法归因。
//
//     explore 不在其列，且**必须**不在：它的产物不进 ledger（§5.3），
//     一份 strategyVersions 会诱使人把它当成流程里的一环，而它不是。
// ---------------------------------------------------------------------------
for (const k of ['verify', 'backflow', 'audit']) {
  const versions = objectBody(src[k], 'strategyVersions');
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
assert(!/strategyVersions/.test(src.explore),
  'design.explore 不得产出 strategyVersions：它的产物不进 ledger，那一份表会诱使人把它当成流程里的一环');

// 每个被调用的策略都必须有正文文件，且版本号与 roster 一致、裁决一节覆盖 roster 的枚举。
for (const k of S7) {
  for (const id of strategyRefs(src[k])) {
    const p = path.join(strategyDir, `${id}.md`);
    assert(fs.existsSync(p), `${FILE[k]} 调用 ${id}，但缺策略正文 ${id}.md`);
    const text = fs.readFileSync(p, 'utf8');
    const entry = rosterById.get(id);
    assert(text.includes(`策略版本：${entry.strategyVersion}`),
      `${id}.md 声明的版本号必须与 roster 的 ${entry.strategyVersion} 一致`);
    for (const v of entry.verdictEnum) {
      assert(text.includes(v), `${id}.md 的裁决一节必须覆盖 roster 声明的 ${v}`);
    }
  }
}

// explore 的策略实例可以换，但必须是 roster 里的策略——否则它会去读一份不存在的正文。
{
  assert(/const KNOWN_STRATEGIES = \[/.test(src.explore),
    'design.explore 必须把可用的策略实例写成一个有定义的列表');
  const list = [...balancedBody(src.explore, src.explore.indexOf('const KNOWN_STRATEGIES = [') , '[', ']')
    .matchAll(/'([a-z][a-z0-9-]*)'/g)].map((m) => m[1]);
  assert(list.length > 0, 'design.explore 的 KNOWN_STRATEGIES 不得为空');
  for (const id of list) {
    assert(rosterById.has(id), `design.explore 的 KNOWN_STRATEGIES 含 roster 未定义的策略 ${id}`);
  }
  assert(/KNOWN_STRATEGIES\.includes\(AGENT_ID\)/.test(src.explore),
    'design.explore 必须校验 agentId 在策略列表里，否则它会去读一份不存在的正文');
  // 默认实例要在列表里——默认值写错了，不传 agentId 就必然失败。
  const dflt = (src.explore.match(/const AGENT_ID = args\.agentId \|\| '([a-z][a-z0-9-]*)'/) || [])[1];
  assert(dflt && list.includes(dflt), `design.explore 的默认策略实例 ${dflt} 不在 KNOWN_STRATEGIES 里`);
}

// ---------------------------------------------------------------------------
// 15. 门控结论字面量。四个文件都不得出现 PASS 作为**自己的产出**。
//     禁止句里提到字面量是允许的（策略与 workflow 都要能说明"不得写它"），
//     所以带否定词的行走白名单——与 check_agent_strategy.js 的口径一致。
// ---------------------------------------------------------------------------
for (const k of S7) {
  for (const [i, line] of src[k].split(/\r?\n/).entries()) {
    if (!/PASS/.test(line)) continue;
    assert(/不得|禁止|不判|严禁|不是|而非/.test(line),
      `${FILE[k]}:${i + 1} 出现门控结论字面量：${line.trim()}`);
  }
}

// E 组三格都必须指向 evaluate_gates.js：门控结论只由它算。
// explore 不在此列：它压根不产生门控意见（§5.3 的三条禁令里就写着不许写 PASS），
// 强行在它里面引一句 evaluate_gates.js 只会制造"它参与了门控"的错觉。
for (const k of ['verify', 'backflow', 'audit']) {
  assert(/evaluate_gates\.js/.test(src[k]),
    `${FILE[k]} 必须指向 integration/governance/evaluate_gates.js：门控结论只由它计算`);
}

console.log(`PASS S7 structure: ${S7.length} workflows (${S7.join(', ')}) — `
  + 'verify/audit inject only landed artifact paths (args allowlist + out/-only intake), '
  + 'backflow treats "no backflow" as a legitimate answer, '
  + 'explore lands solely under scratch/, and every E-group verdict is consumed');
