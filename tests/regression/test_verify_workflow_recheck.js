'use strict';

// Executes design.verify against a scripted agent and pins the deterministic recheck:
// a verifier's self-reported `verdict: VERIFIED` is only believed when its own item
// list backs it (non-empty, every item `passed`, no gaps). Otherwise the script
// downgrades it, keeps the claim in `reportedVerdict`, and the run lands nothing.
// Also: a duplicated check id cannot stand in for a missing one.

const assert = require('assert');
const path = require('path');
const {compileWorkflow} = require('../../integration/orchestration/runtime/core.js');

const root = path.resolve(__dirname, '../..');
const run = compileWorkflow(root, 'verify');

const ARGS = {
  repo: '.',
  runId: 'recheck-probe',
  brief: {stage: 'verify', sourceCommit: 'abc123'},
  artifacts: ['out/governance/gate_status.json'],
  gateStatusArtifact: 'out/governance/gate_status.json',
};

const passedItem = {item: 'conservation', result: 'passed', locator: 'out/x.json:1', detail: 'sum=1 recomputed'};

// `check(id)` builds the verifier reply for one check class.
async function execute(check) {
  const agent = async (prompt, options = {}) => {
    const label = options.label || '';
    if (label.startsWith('verify:')) return check(label.slice('verify:'.length));
    if (label === 'gate-keeper') return {gateDecision: 'UNVERIFIED', gateDecisionSource: 'integration/governance/evaluate_gates.js', items: [], verdict: 'GATE_EVIDENCE_COMPLETE'};
    if (label === 'architect') return {conclusion: 'send', basis: [], openItems: [], directionLevelFindings: [], verdict: 'D_GATE_PROPOSAL'};
    throw new Error(`unexpected agent call ${label}`);
  };
  return run(ARGS, agent, (fns) => Promise.all(fns.map((fn) => fn())), () => {}, () => {});
}

const good = (id) => ({checkId: id, name: id, checks: [passedItem], gaps: [], verdict: 'VERIFIED'});

(async () => {
  // Baseline: honest, fully backed checks land.
  const ok = await execute(good);
  assert.strictEqual(ok.verdict, 'D_GATE_PROPOSAL', 'backed checks are believed');
  assert(ok.files.length > 0);

  // 1. VERIFIED with an empty item list proves nothing.
  const empty = await execute((id) => ({...good(id), checks: id === 'V-PROFILE' ? [] : [passedItem]}));
  assert.notStrictEqual(empty.verdict, 'D_GATE_PROPOSAL');
  assert.deepStrictEqual(empty.files, [], 'nothing lands when a check has no items');
  assert.deepStrictEqual(empty.failedChecks.map((c) => c.checkId), ['V-PROFILE']);

  // 2. VERIFIED while one item failed or was unverifiable.
  for (const result of ['failed', 'unverifiable']) {
    const bad = await execute((id) => ({...good(id), checks: id === 'V-MATRIX' ? [passedItem, {...passedItem, result}] : [passedItem]}));
    assert.notStrictEqual(bad.verdict, 'D_GATE_PROPOSAL', `an item that is ${result} cannot be reported as VERIFIED`);
    assert.deepStrictEqual(bad.files, []);
    assert.deepStrictEqual(bad.failedChecks.map((c) => c.checkId), ['V-MATRIX']);
  }

  // 3. VERIFIED while carrying gaps ("could not check" is not a pass).
  const gap = await execute((id) => ({...good(id), gaps: id === 'V-REPLAY' ? [{what: 'golden trace', why: 'missing', owner: 'UNVERIFIED'}] : []}));
  assert.notStrictEqual(gap.verdict, 'D_GATE_PROPOSAL');
  assert.deepStrictEqual(gap.files, []);

  // 4. A reported VERIFY_FAILED stays failed even if its items all passed.
  const selfFailed = await execute((id) => ({...good(id), verdict: id === 'V-SYNTHETIC' ? 'VERIFY_FAILED' : 'VERIFIED'}));
  assert.notStrictEqual(selfFailed.verdict, 'D_GATE_PROPOSAL');

  // 5. A duplicated id cannot cover for a missing one.
  const first = (await execute(good)).checks.map((c) => c.checkId)[0];
  const dup = await execute((id) => good(id === 'V-REPLAY' ? first : id));
  assert.strictEqual(dup.verdict, 'BLOCKED_CONFIG');
  assert(dup.absentChecks.includes('V-REPLAY'));

  console.log('PASS design.verify recheck: self-reported VERIFIED needs non-empty, all-passed, gap-free items; duplicated ids do not cover missing checks');
})().catch((error) => { console.error(error); process.exit(1); });
