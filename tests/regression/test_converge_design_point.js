'use strict';

// design.converge reads the design point the stages after L3 read (design_point.js, doc 23 §7.3)
// and runs it against a mock runtime: what the workflow RETURNS is checked, not its text.
//
// What this pins:
//   * without args.designPoint the run does not start (a launch error, not a verdict);
//   * a joint point that departs from the baseline is a BLOCKED_CONFIG decided before any agent:
//     the D group's artifacts are Stage B's, built on the baseline, so they describe another point;
//     the departing fields are named and the way out is an ADR plus baseline:sync;
//   * at the published point the experts are called and the run record names the point;
//   * the main loop hands converge exactly what design_point.js resolves.

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const DP = require('../../integration/pipelines/design_point.js');
const {compileWorkflow} = require('../../integration/orchestration/runtime/core.js');
const {fromSchema} = require('../../integration/orchestration/runtime/backends/mock.js');

const root = path.resolve(__dirname, '../..');
const text = fs.readFileSync(path.join(root, DP.BASELINE_FILE), 'utf8');
const coupling = JSON.parse(fs.readFileSync(path.join(root, 'out/detailed/coupling_candidates.json'), 'utf8'));
const row = coupling.candidates.find(c => c.feasible);
const landed = {optionId: row.optionId, values: JSON.stringify(row), provenance: 'test', x: row.x, opt: row.opt, model: row.model};
const joint = DP.resolve({point: 'joint', baselineText: text, jointPoint: landed, runRecord: {candidateSetSha256: coupling.candidateSetSha256}, artifact: coupling});
const published = DP.resolve({point: 'published', baselineText: text});

const DETAIL = ['detail.freeze', 'detail.workload', 'detail.events', 'detail.execute', 'detail.integrate']
  .map(s => `out/detailed/${s.replace('.', '_')}.json`);
const baseArgs = {brief: {stage: 'converge', sourceCommit: 'test'}, detailArtifacts: DETAIL, relevantExperts: ['compute-expert']};

async function run(args) {
  const labels = [];
  const agent = async (prompt, options = {}) => {
    labels.push(options.label || '');
    return fromSchema(options.schema, '');
  };
  const result = await compileWorkflow(root, 'converge')(args, agent, fns => Promise.all(fns.map(f => f())), () => {}, () => {});
  return {result, labels};
}

(async () => {
  await assert.rejects(run({...baseArgs}), /args\.designPoint/, 'a run without a design point does not start');

  assert(joint.departsFromPublished, 'the joint point departs from the baseline');
  const blocked = await run({...baseArgs, designPoint: joint});
  assert.strictEqual(blocked.result.verdict, 'BLOCKED_CONFIG');
  assert.deepStrictEqual(blocked.labels, [], 'decided before any agent');
  assert.deepStrictEqual(blocked.result.files, [], 'nothing to land');
  assert.strictEqual(blocked.result.designPoint.optionId, row.optionId);
  assert.strictEqual(blocked.result.designPoint.sha256, joint.sha256);
  assert(blocked.result.reason.includes('model.controlUs'), 'the departing fields are named');
  assert(blocked.result.nextActions.some(a => a.includes('baseline:sync')), 'the way out is an ADR plus baseline:sync');

  const open = await run({...baseArgs, designPoint: published});
  assert(open.labels.includes('residual:compute-expert'), 'at the published point the experts are called');
  const record = (open.result.files || []).find(f => f.path.endsWith('converge_run_record.json'));
  assert(record, 'the published-point run lands a run record');
  assert.strictEqual(JSON.parse(record.content).designPoint.sha256, published.sha256, 'the run record names the point');

  // The main loop's resolution: before design.coupling lands a joint point it is the published one.
  if (!fs.existsSync(path.join(root, DP.JOINT_FILE))) assert.strictEqual(DP.resolve().kind, 'published');

  console.log(`PASS converge design point: joint ${row.optionId} blocked before any agent `
    + `(${['x', 'opt', 'model'].map(p => `${p} ${joint.departures[p].length}`).join(', ')} departing fields); published point runs `
    + `(${open.labels.length} agent calls, verdict ${open.result.verdict})`);
})().catch(error => {
  console.error(error);
  process.exit(1);
});
