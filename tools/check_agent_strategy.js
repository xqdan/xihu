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

const PATH_LIKE = [
  /\b(?:out|teams|integration|docs|archive|references|tests|tools)\/[A-Za-z0-9_.@/-]+/,
  /\b[A-Za-z0-9_.@/-]+\.(?:json|js|md|html|pdf|csv|yaml|yml)\b/,
  /(?:^|\s)\/Users\//,
  /(?:^|\s)\.\/[A-Za-z0-9_]/,
];

// 只判"指示读/写某个路径"这类不可判定的违规。
// 策略里引用规格文件或 ADR 作为证据来源是必要的（如“面积须取自 k3_mc_baseline.json”），
// 那不是编排逻辑，所以不能见到路径就报错——否则会把正确的策略也判违规。
const PATH_DIRECTIVE = [
  /(?:读|读取|打开|加载|扫|扫描|遍历|看)\s*[`"']?[A-Za-z0-9_./-]*\//,
  /(?:写|写入|落盘|保存|产出到|输出到|生成到)\s*[`"']?[A-Za-z0-9_./-]*\//,
  /\b(?:read|load|open|scan|write|save|dump|emit)\s+into\s+[A-Za-z0-9_./-]+\//,
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

const GATE_LITERAL = /\b(?:PASS|D_GATE_PASSED|Q_GATE_PASSED)\b/;

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
    if (GATE_LITERAL.test(line) && !/不得|禁止|不判|严禁/.test(line)) {
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

function knownVerdicts(roster) {
  return new Set(roster.verdictValues);
}

// ---- 4. --self-test：注入假策略，证明校验会报错 ----

function selfTest() {
  const probeDir = STRATEGY_DIRS[0];
  const created = [];
  try {
    fs.mkdirSync(probeDir, { recursive: true });
    const cases = [
      {
        name: '__selftest_path_leak.md',
        body: '跑之前先读 out/direction/architecture_candidates.json 拿到候选。\n',
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
    for (const c of cases) {
      const p = path.join(probeDir, c.name);
      fs.writeFileSync(p, c.body);
      created.push(p);
    }

    const roster = loadRoster();
    const { strategies } = checkRosterFields(roster);
    for (const p of created) checkStrategyFile(p);

    const caught = new Set(failures.map((f) => f.split(':')[0]));
    const expected = new Set(created.map((p) => path.relative(root, p)));
    const missed = [...expected].filter((e) => !caught.has(e));
    if (missed.length) {
      console.error('SELF-TEST FAILED：以下被注入的策略未被识别为违规');
      for (const m of missed) console.error(`  MISSED ${m}`);
      return 1;
    }
    console.log(`SELF-TEST PASS：4 类注入全部被识别（路径泄漏 / 契约泄漏 / 门控字面量 / 代码块）`);
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
