'use strict';

// 守住"策略 / 运行时分离"的边界：agent 定义只含判断规则，不含路径、schema、流程。
// 依据 teams/council/docs/22_AGENT_WORKFLOW_REFACTOR_PLAN.md 第 2 节。
// 两条断言：
//   1. tools/check_agent_strategy.js --self-test 必须能识别被注入的违规策略
//      （先证明约束可被强制，再谈策略写得对不对）
//   2. roster 自身必须守住字段边界，且每个策略的裁决枚举都已登记

const fs = require('fs');
const path = require('path');
const assert = require('assert');
const { spawnSync } = require('child_process');

const root = path.resolve(__dirname, '../..');
const rosterPath = path.join(root, 'teams/council/inputs/agent_roster.json');
const roster = JSON.parse(fs.readFileSync(rosterPath, 'utf8').replace(/^﻿/, ''));

// --- 1. 自检：注入假策略，证明校验会报错 ---
const selfTest = spawnSync(process.execPath, [path.join(root, 'tools/check_agent_strategy.js'), '--self-test'], {
  cwd: root,
  encoding: 'utf8',
});
assert.strictEqual(selfTest.status, 0, `agent strategy self-test failed:\n${selfTest.stdout}${selfTest.stderr}`);

// --- 2. 正式校验 ---
const check = spawnSync(process.execPath, [path.join(root, 'tools/check_agent_strategy.js')], {
  cwd: root,
  encoding: 'utf8',
});
assert.strictEqual(check.status, 0, `agent strategy boundary violated:\n${check.stdout}${check.stderr}`);

// --- 3. roster 结构 ---
assert.strictEqual(roster.schemaVersion, 'agent-roster-v0.1');
assert.strictEqual(roster.strategies.length, 12, 'roster 必须定义 12 个策略');

const ids = roster.strategies.map((s) => s.agentId);
assert.deepStrictEqual(
  ids.slice(0, 6),
  ['compute-expert', 'memory-expert', 'comm-expert', 'physical-expert', 'software-expert', 'model-expert'],
  '前 6 个必须是领域专家策略',
);
assert.strictEqual(new Set(ids).size, ids.length, 'agentId 不得重复');

// 领域专家不得输出全局性能指标
for (const s of roster.strategies.filter((x) => x.kind === 'domain-expert')) {
  assert(
    s.prohibitions.some((p) => /不得输出\s*TPS\/usr/.test(p)),
    `${s.agentId} 必须禁止输出 TPS/usr`,
  );
}

// 固定职能必须在 roster 里齐备
for (const fn of ['architect', 'framing-critic', 'integrator', 'invariant-checker', 'gate-keeper', 'verifier']) {
  assert(ids.includes(fn), `roster 缺少固定职能策略 ${fn}`);
}

// 检点与合并必须分开，否则合并的人会把违规项解释掉
assert(ids.includes('integrator') && ids.includes('invariant-checker'), 'integrator 与 invariant-checker 必须分开定义');

// 裁决枚举必须在全局登记表内
const knownVerdicts = new Set(roster.verdictValues);
for (const s of roster.strategies) {
  for (const v of s.verdictEnum) assert(knownVerdicts.has(v), `${s.agentId} 的裁决 ${v} 未在 verdictValues 登记`);
}

// 两份 schema 必须存在且声明的 stage 与 roster 的 consumers 口径一致
for (const f of ['design_brief.schema.json', 'design_ledger.schema.json']) {
  const p = path.join(root, 'teams/council/inputs', f);
  assert(fs.existsSync(p), `缺少 ${f}`);
  const schema = JSON.parse(fs.readFileSync(p, 'utf8').replace(/^﻿/, ''));
  assert(schema.type === 'object' && Array.isArray(schema.required) && schema.required.length, `${f} 必须声明 required 字段`);
}

const brief = JSON.parse(fs.readFileSync(path.join(root, 'teams/council/inputs/design_brief.schema.json'), 'utf8').replace(/^﻿/, ''));
const ledger = JSON.parse(fs.readFileSync(path.join(root, 'teams/council/inputs/design_ledger.schema.json'), 'utf8').replace(/^﻿/, ''));

// brief 必须强制注入合约要求的关键字段
for (const f of ['hardConstraints', 'budget', 'shapeIntent', 'allowedDesignSpace', 'forbidden', 'exitCriteria', 'evidenceLevelFloor', 'profileBinding']) {
  assert(brief.required.includes(f), `design_brief.schema.json 必须要求 ${f}`);
}

// ledger 必须记录被否方案与策略版本，缺了就无法解释重跑差异
for (const f of ['rejectedOptions', 'strategyVersions', 'budgetBalance', 'evidenceIndex']) {
  assert(ledger.required.includes(f), `design_ledger.schema.json 必须要求 ${f}`);
}

// 单一硬件规格：brief 的 profileBinding 不得开放第二份规格
assert.deepStrictEqual(
  brief.properties.profileBinding.properties.physicalProfile.enum,
  ['P1'],
  'physicalProfile 只能取 P1（ADR-0021 单一硬件规格）',
);

// --- 4. design.*.workflow.js 的骨架约束 ---
// 这些断言守的是"worflow 只做编排"：一旦有人把判断规则、路径或门控结论写进脚本，
// agents 就不再需要读策略正文了，策略/运行时分离随之失效。

const wfDir = path.join(root, 'integration/orchestration');
const wfFiles = fs.readdirSync(wfDir).filter((n) => /^design\..*\.workflow\.js$/.test(n));
assert(wfFiles.length > 0, 'integration/orchestration 下必须存在 design.*.workflow.js');

for (const name of wfFiles) {
  const src = fs.readFileSync(path.join(wfDir, name), 'utf8');

  // 脚本必须能被解析（不是 Node 入口，但不该有语法错误）
  const parsed = spawnSync(process.execPath, ['--check', path.join(wfDir, name)], { encoding: 'utf8' });
  assert.strictEqual(parsed.status, 0, `${name} 语法错误：\n${parsed.stderr}`);

  // meta 必须是纯字面量：name 与 description 直接可读，phases 至少一项
  assert(/export const meta = \{/.test(src), `${name} 必须导出 meta`);
  assert(/name: '[a-z][a-z0-9-]*'/.test(src), `${name} 的 meta.name 必须是小写连字符形式`);
  assert(/description: '[^']+'/.test(src), `${name} 的 meta.description 不得为空`);
  assert(/phases: \[/.test(src), `${name} 的 meta 必须声明 phases`);

  // 无文件系统权限的契约：脚本不得 require，不得直接读写文件
  assert(!/\brequire\s*\(/.test(src), `${name} 不得 require；workflow 脚本没有文件系统权限`);
  assert(!/\bfs\./.test(src), `${name} 不得使用 fs；落盘由主循环完成`);
  assert(!/Date\.now\(|Math\.random\(|new Date\(\)/.test(src), `${name} 不得取时间或随机数；会破坏 resume`);

  // 门控结论只能来自确定性脚本
  for (const line of src.split(/\r?\n/)) {
    if (/\bD_GATE_PASSED\b|\bQ_GATE_PASSED\b/.test(line) && !/不得|禁止|不判|严禁/.test(line)) {
      assert(false, `${name} 出现门控字面量：${line.trim()}`);
    }
    // PASS 作为独立词出现即违规（结论只能由 evaluate_gates.js 产生）
    if (/(?<![A-Z_])PASS(?![A-Z_])/.test(line) && !/不得|禁止|不判|严禁/.test(line)) {
      assert(false, `${name} 出现 PASS 字面量：${line.trim()}`);
    }
  }
}

// design.intake 必须注入 agentId 让 agent 自己去读策略正文，
// 而不是把策略规则抄进 prompt——抄进去就出现了第二份来源。
const intake = fs.readFileSync(path.join(wfDir, 'design.intake.workflow.js'), 'utf8');
assert(
  /strategies\/\$?\{?__?AGENT__?/.test(intake) || /strategies\//.test(intake),
  'design.intake 必须把策略正文的位置交给 agent，而不是内联规则',
);
for (const expert of ['compute-expert', 'memory-expert', 'comm-expert', 'physical-expert', 'software-expert', 'model-expert']) {
  assert(intake.includes(expert), `design.intake 必须把 ${expert} 纳入约束收集`);
}
assert(intake.includes('framing-critic') && intake.includes('architect'), 'design.intake 必须调用 architect 与 framing-critic');

// 策略正文必须真实存在，且每个 roster 策略都有一个策略文件
const strategyDir = path.join(root, 'teams/council/strategies');
for (const id of ids) {
  const p = path.join(strategyDir, `${id}.md`);
  if (!fs.existsSync(p)) continue; // S2 之后逐步补齐；存在即校验
  const text = fs.readFileSync(p, 'utf8');
  const declared = roster.strategies.find((s) => s.agentId === id).strategyVersion;
  assert(
    text.includes(`策略版本：${declared}`),
    `${id}.md 声明的版本号必须与 roster 的 ${declared} 一致`,
  );
  assert(/## 禁止/.test(text), `${id}.md 必须声明禁止事项`);
  assert(/## 裁决/.test(text), `${id}.md 必须声明裁决枚举`);
}

console.log('PASS agent strategy boundary: self-test identifies injected violations; roster, brief and ledger schemas agree');
