'use strict';

// 校验 agent 策略定义是否守住了"策略 / 运行时分离"的边界。
// 依据：teams/council/docs/22_AGENT_WORKFLOW_REFACTOR_PLAN.md 第 2 节
//
// 它守的是四条硬边界：
//   1. agent 定义不得出现输出契约（schema / outputs / contract）
//   2. agent 定义不得出现文件路径
//   3. 裁决枚举必须被某个 workflow 消费
//   4. 策略里不得出现决定性数字来源不明的门控结论（PASS 等字面量）
//
// Usage:
//   node tools/check_agent_strategy.js             校验仓库现状
//   node tools/check_agent_strategy.js --self-test 先注入一个假策略，证明校验能报错

const fs = require('fs');
const path = require('path');

// 门控字面量的判据只有一处定义：evaluate_gates.js 的 FORBIDDEN_GATE_LITERALS。
// 这里不再自己写正则——同一判据两份实现，改一份另一份不动，而这个检查的失效
// 方式正是"某个字面量不再被拦"。
const { gateLiteralPattern } = require('../integration/governance/evaluate_gates');

const root = path.resolve(__dirname, '..');
const ROSTER = path.join(root, 'teams/council/inputs/agent_roster.json');
const STRATEGY_DIRS = [
  path.join(root, 'teams/council/strategies'),
  path.join(root, 'integration/strategies'),
];
const WORKFLOW_DIR = path.join(root, 'integration/orchestration');

const failures = [];
const warnings = [];

function fail(where, message) {
  failures.push(`${where}: ${message}`);
}

function warn(where, message) {
  warnings.push(`${where}: ${message}`);
}

// ---- 1. roster 自身结构 ----

function loadRoster() {
  const raw = fs.readFileSync(ROSTER, 'utf8').replace(/^﻿/, '');
  return JSON.parse(raw);
}

// roster 的字段名本身就是契约：出现被禁字段说明编排逻辑回流了。
function checkRosterFields(roster) {
  const forbidden = new Set(roster.forbiddenFields);
  const required = roster.requiredFields;

  const walk = (value, trail) => {
    if (Array.isArray(value)) return value.forEach((v, i) => walk(v, `${trail}[${i}]`));
    if (value && typeof value === 'object') {
      for (const [k, v] of Object.entries(value)) {
        // 顶层的 forbiddenFields / injectedAtRuntime 是规范声明，不是策略字段，跳过
        if (trail === '' && (k === 'forbiddenFields' || k === 'injectedAtRuntime')) continue;
        if (forbidden.has(k)) {
          fail('agent_roster.json', `${trail}.${k} 是被禁字段：编排逻辑不得出现在策略定义里`);
        }
        walk(v, trail ? `${trail}.${k}` : k);
      }
    }
  };
  walk(roster, '');

  if (!Array.isArray(roster.strategies) || !roster.strategies.length) {
    fail('agent_roster.json', 'strategies 必须是非空数组');
    return;
  }

  const knownVerdicts = new Set(roster.verdictValues);
  const seen = new Set();

  for (const s of roster.strategies) {
    const id = s.agentId || '<missing agentId>';
    if (seen.has(id)) fail('agent_roster.json', `agentId 重复：${id}`);
    seen.add(id);

    for (const f of required) {
      const v = s[f];
      if (v === undefined || v === null) fail(id, `缺少必填字段 ${f}`);
    }
    for (const f of forbidden) {
      if (s[f] !== undefined) fail(id, `出现被禁字段 ${f}`);
    }
    for (const f of ['judgmentRules', 'correctnessDef', 'evidenceRules', 'tradeoffRules', 'prohibitions', 'verdictEnum', 'consumers']) {
      if (!Array.isArray(s[f]) || s[f].length === 0) fail(id, `${f} 必须是非空数组`);
    }
    if (!/^\d+\.\d+$/.test(String(s.strategyVersion))) {
      fail(id, `strategyVersion 必须是 x.y 形式，当前为 ${JSON.stringify(s.strategyVersion)}`);
    }
    for (const v of s.verdictEnum || []) {
      if (!knownVerdicts.has(v)) fail(id, `verdictEnum 含未登记裁决 ${v}；先在 agent_roster.json#verdictValues 登记`);
    }
    // 裁决必须有 workflow 消费，否则等于写了个没人接的分支
    for (const c of s.consumers || []) {
      if (!/^design\./.test(c) && !/^scratch$/.test(c)) {
        fail(id, `consumers 含非 workflow 目标 ${c}；策略只能在 workflow 内实例化`);
      }
    }
  }
  return { knownVerdicts, strategies: roster.strategies };
}

// ---- 2. 策略正文文件的边界 ----

// 路径形态：带目录的路径，或带已知扩展名的裸文件名。
// 裸文件名这一支是必要的——"读 k3_mc_baseline.json" 一样是编排指令，
// 与"读 out/xxx.json"没有区别。曾经这里要求路径里必须有 `/`，
// 于是裸文件名一律漏网；12 份策略正文当时恰好一个文件名都没写，
// 所以那个洞没被触发，但它是敞着的。
const PATH_SHAPE = '(?:[A-Za-z0-9_./-]+\\/)?[A-Za-z0-9_.-]+\\.(?:json|js|md|html|pdf|csv|yaml|yml|txt)\\b';

// 只判"指示读/写某个路径"这类不可判定的违规。
// 策略里引用规格文件或 ADR 作为证据来源是必要的（如“面积须取自 k3_mc_baseline.json”），
// 那不是编排逻辑，所以不能见到路径就报错——否则会把正确的策略也判违规。
// 判据因此落在**动词**上：有没有读写动词，而不是有没有文件名。
const PATH_READ_VERB = '(?:读|读取|打开|加载|扫|扫描|遍历|看)';
const PATH_WRITE_VERB = '(?:写|写入|落盘|保存|产出到|输出到|生成到)';

const PATH_DIRECTIVE = [
  new RegExp(`${PATH_READ_VERB}\\s*[\`"']?${PATH_SHAPE}`),
  new RegExp(`${PATH_WRITE_VERB}\\s*[\`"']?${PATH_SHAPE}`),
  /\b(?:read|load|open|scan)\s+(?:the\s+)?[A-Za-z0-9_./-]*\/[A-Za-z0-9_./-]+/,
  /\b(?:write|save|dump|emit)\s+(?:to\s+|into\s+)?[A-Za-z0-9_./-]*\/[A-Za-z0-9_./-]+/,
  /(?:^|\s)\/Users\//,
];

// 输出契约描述：这些一律是硬违规，输出什么由 workflow 注入。
const CONTRACT_DIRECTIVE = [
  /^\s*outputs?\s*:/i,
  /^\s*inputs?\s*:/i,
  /^\s*schema\s*:/i,
  /^\s*(?:readPaths|writePaths|allowedPaths|outputPath)\s*:/,
  /\b(?:readPaths|writePaths|allowedPaths|outputPath)\b/,
];

function strategyFiles() {
  const files = [];
  for (const dir of STRATEGY_DIRS) {
    if (!fs.existsSync(dir)) continue;
    for (const name of fs.readdirSync(dir)) {
      if (/\.(md|txt|js|json)$/.test(name)) files.push(path.join(dir, name));
    }
  }
  return files;
}

function checkStrategyFile(file) {
  const rel = path.relative(root, file);
  const text = fs.readFileSync(file, 'utf8');
  const lines = text.split(/\r?\n/);

  lines.forEach((line, i) => {
    const at = `${rel}:${i + 1}`;
    if (gateLiteralPattern().test(line) && !/不得|禁止|不判|严禁/.test(line)) {
      fail(at, '出现 PASS / *_GATE_PASSED 字面量；门控结论只能由 evaluate_gates.js 产生');
    }
    if (/^\s*```/.test(line)) {
      fail(at, '策略文件不得包含代码块；代码块是编排逻辑藏身之处');
    }
    if (CONTRACT_DIRECTIVE.some((re) => re.test(line))) {
      fail(at, '出现输出/输入契约描述；输出什么必须由 workflow 注入');
    }
    if (PATH_DIRECTIVE.some((re) => re.test(line))) {
      fail(at, '出现读写路径指示；读什么应由 brief 决定、写哪里应由 workflow 决定');
    }
  });
}

// ---- 3. 裁决枚举必须被 workflow 消费 ----

// 裁决名是 [A-Z0-9_]+，`\b` 在 `_` 处不成立，所以子串匹配会把 A 判成被 B 消费。
// 边界必须手写：两侧不得再是 [A-Z0-9_]。
function mentionsVerdict(blob, verdict) {
  const esc = verdict.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(?<![A-Z0-9_])${esc}(?![A-Z0-9_])`).test(blob);
}

function knownVerdicts(roster) {
  return new Set(roster.verdictValues);
}

function checkVerdictConsumption(strategies, roster) {
  if (!fs.existsSync(WORKFLOW_DIR)) return;
  const workflows = fs.readdirSync(WORKFLOW_DIR).filter((n) => /^design\..*\.workflow\.js$/.test(n));
  if (!workflows.length) {
    warnings.push(`尚未存在 design.*.workflow.js；跳过裁决消费检查（S3 后此项应转为强制）`);
    return;
  }
  const blob = workflows.map((n) => fs.readFileSync(path.join(WORKFLOW_DIR, n), 'utf8')).join('\n');

  // 暂缓表是记账，不是豁免：每条必须写明到期切片，且一旦该裁决真的被消费了，
  // 这条暂缓记录就过期了——过期记账不清，暂缓表会慢慢变成永久豁免名单。
  const pending = new Map();
  for (const e of roster.pendingConsumption || []) {
    if (!e || !e.verdict) continue;
    if (!knownVerdicts(roster).has(e.verdict)) {
      fail('agent_roster.json', `pendingConsumption 含未登记裁决 ${e.verdict}`);
      continue;
    }
    if (!e.slice) fail('agent_roster.json', `pendingConsumption.${e.verdict} 未写明到期切片`);
    pending.set(e.verdict, e);
  }

  for (const s of strategies) {
    for (const v of s.verdictEnum || []) {
      const consumed = mentionsVerdict(blob, v);
      if (consumed) {
        if (pending.has(v)) {
          fail('agent_roster.json', `${v} 已被 workflow 消费，但仍在 pendingConsumption 里；请删除这条过期记账`);
        }
        continue;
      }
      const entry = pending.get(v);
      if (!entry) {
        fail(s.agentId, `裁决 ${v} 未在任何 design.*.workflow.js 中被消费；workflow switch 必须处理它`);
        continue;
      }
      if (entry.owner !== s.agentId) {
        fail('agent_roster.json', `pendingConsumption.${v} 的 owner 写作 ${entry.owner}，实际由 ${s.agentId} 声明`);
      }
      warnings.push(`${v}（${s.agentId}）尚无 workflow 消费，记账到期切片 ${entry.slice}`);
    }
  }
}

// ---- 4. --self-test：注入假策略，证明校验会报错、且不误报 ----

function selfTest() {
  const probeDir = STRATEGY_DIRS[0];
  const created = [];
  try {
    fs.mkdirSync(probeDir, { recursive: true });

    // 违规样本：每一个都必须被识别。改判据时这一组只会变长，不会变短。
    const violating = [
      {
        name: '__selftest_path_leak.md',
        body: '跑之前先读 out/direction/architecture_candidates.json 拿到候选。\n',
      },
      {
        // 裸文件名与带目录的路径一样是编排指令。这一条曾经漏网：
        // 旧判据要求路径里必须有 `/`，而"读 x.json"没有。
        name: '__selftest_bare_filename.md',
        body: '跑之前先读 k3_mc_baseline.json 拿到 estimatedAreaMm2。\n',
      },
      {
        name: '__selftest_write_directive.md',
        body: '结论写入 ledger.json。\n',
      },
      {
        name: '__selftest_contract_leak.md',
        body: 'outputs: ["tile_events", "memory_events"]\n',
      },
      {
        name: '__selftest_gate_literal.md',
        body: '检查完毕，结论 D_GATE_PASSED。\n',
      },
      {
        name: '__selftest_code_block.md',
        body: '参考实现：\n```js\nif (x) return PASS\n```\n',
      },
    ];

    // 合法样本：每一个都必须放行。这一组守的是**误报**。
    // 误报的代价不是"多报几条"：正文被判违规之后，所有人会去关掉这个检查，
    // 而不是去改策略，于是检查本身消失。所以"不误伤"和"能拦住"一样是判据的一部分。
    const legal = [
      {
        // 硬线第 2 条允许引用规格文件作为证据来源（见 PATH_DIRECTIVE 上方注释）。
        // 判据落在动词上：这句话里没有读写动词，所以放行。
        name: '__selftest_legal_evidence_ref.md',
        body: '- 面积须取自 k3_mc_baseline.json 的 estimatedAreaMm2，不得手工估值。\n',
      },
      {
        name: '__selftest_legal_adr_ref.md',
        body: '- 必须引用唯一硬件规格文件（ADR-0021）。出现第二份规格即为违规。\n',
      },
      {
        // 禁止句里必须能提到门控字面量——12 份正文都这么写。
        // 这一条守的是豁免规则（!/不得|禁止|不判|严禁/），不是字面量检查本身。
        name: '__selftest_legal_prohibition.md',
        body: '## 禁止\n\n- 不得输出 TPS/usr，不得写 PASS 或 D_GATE_PASSED 字面量。\n',
      },
      {
        // 有读动词但没有路径：说的是"不许读什么"，不是"去读哪里"。
        name: '__selftest_legal_verb_without_path.md',
        body: '- 不得读设计过程的中间产物，只能读已落盘的最终产物。\n',
      },
      {
        name: '__selftest_legal_prose.md',
        body: '- 频率、电压、面积密度必须引用规格文件的字段，不得手工估值。\n',
      },
    ];

    const all = [...violating, ...legal];
    for (const c of all) {
      const p = path.join(probeDir, c.name);
      fs.writeFileSync(p, c.body);
      created.push(p);
    }

    const roster = loadRoster();
    checkRosterFields(roster);
    for (const p of created) checkStrategyFile(p);

    const rel = (c) => path.relative(root, path.join(probeDir, c.name));
    const caught = new Set(failures.map((f) => f.split(':')[0]));
    const missed = violating.map(rel).filter((e) => !caught.has(e));
    const falsePositives = legal.map(rel).filter((e) => caught.has(e));

    if (missed.length || falsePositives.length) {
      console.error('SELF-TEST FAILED');
      for (const m of missed) console.error(`  MISSED        ${m}（应拦未拦）`);
      for (const f of falsePositives) console.error(`  FALSE POSITIVE ${f}（合法却被拦）`);
      if (falsePositives.length) {
        console.error('  该文件命中的判据：');
        for (const line of failures) {
          if (falsePositives.some((f) => line.startsWith(`${f}:`))) console.error(`    ${line}`);
        }
      }
      return 1;
    }
    console.log(`SELF-TEST PASS：${violating.length} 类注入全部被识别`
      + `（路径泄漏 / 裸文件名 / 写指令 / 契约泄漏 / 门控字面量 / 代码块），`
      + `${legal.length} 类合法正文全部放行`);
    return 0;
  } finally {
    for (const p of created) { try { fs.unlinkSync(p); } catch (_) {} }
  }
}

// ---- main ----

if (process.argv.includes('--self-test')) process.exit(selfTest());

const roster = loadRoster();
const { strategies } = checkRosterFields(roster);
for (const f of strategyFiles()) checkStrategyFile(f);
checkVerdictConsumption(strategies, roster);

for (const w of warnings) console.log(`WARN  ${w}`);
if (failures.length) {
  console.error(`FAIL agent strategy boundary: ${failures.length} violation(s)`);
  for (const f of failures) console.error(`  ${f}`);
  process.exit(1);
}
console.log(`PASS agent strategy boundary: ${strategies.length} strategies, ${roster.verdictValues.length} registered verdicts`);
