'use strict';
// L1-b requirement frontier and candidate budget contracts (teams/council/docs/23_DESIGN_QUESTION_WORKFLOW_PROPOSAL.md,
// L1-b). The frontier is rebuilt through the production models and must equal the stored one; its
// closed-form planning lines must agree with token_time.js, and every candidate contract must hold
// the budget under both models at its own point, so a contract can never promise what the models deny.
const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const R = require('../../integration/planning/requirement_frontier.js');
const TT = require('../../integration/planning/token_time.js');
const RES = require('../../teams/hardware/src/resource_profiles');

const sha256 = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const near = (a, b, what, tol = 1e-9) => assert(Math.abs(a - b) <= tol * Math.max(1, Math.abs(b)), `${what}: ${a} vs ${b}`);

assert(fs.existsSync(R.OUT_FILE), `${R.OUT_FILE} is missing; run npm run budget:frontier`);
const stored = JSON.parse(fs.readFileSync(R.OUT_FILE, 'utf8'));
for (const a of stored.inputs.sourceArtifacts) {
  assert.strictEqual(a.sha256, sha256(a.path), `${R.OUT_FILE} was built from a different ${a.path}; run npm run budget:frontier`);
}
const ctx = R.context();
const frontier = R.build({context: ctx});
// Round-trip through JSON so the comparison sees what the generator wrote.
assert.deepStrictEqual(stored, JSON.parse(JSON.stringify(frontier)), `${R.OUT_FILE} is stale; run npm run budget:frontier`);
assert.strictEqual(frontier.schemaVersion, R.SCHEMA_VERSION);
assert(/^MODEL/.test(frontier.status), 'the frontier must declare its evidence level');
assert(!/\bPASS\b/.test(JSON.stringify(frontier)), 'the frontier may not carry a gate-like literal');

const budgetUs = frontier.target.rawBudgetUs;
near(budgetUs, 1e6 / (frontier.target.tpsPerUser * TT.MARGIN), 'raw budget = target and margin');
near(frontier.gateBudgetUs, 1e6 / (frontier.target.architectureGate * TT.MARGIN), 'gate budget is reported separately');
assert(frontier.gateBudgetUs < budgetUs, 'the 1050 gate is tighter than the 1000 target');

// Planning lines: the bandwidth floor puts the memory lane exactly on the budget, and tau at
// computeScale 1 is token_time.maxTauForTarget wherever the memory lane holds.
const refPayload = RES.mcProfiles.MC640.payloadGBsPerCube;
for (const {model, slots} of frontier.planning.models) {
  for (const s of slots) {
    const atFloor = R.planningAt(ctx, model, s.tp, {...ctx.published, mcGBs: s.bandwidthMin.mcPayloadGBsPerCube});
    near(atFloor.memoryLaneUs, budgetUs, `${model} TP${s.tp}: memory lane at the bandwidth floor`);
    assert.strictEqual(s.bandwidthMin.withinMC640, s.bandwidthMin.mcPayloadGBsPerCube <= refPayload);
    const tau1 = s.tauMaxByComputeScale.find(t => t.computeScale === 1).tauMaxUs;
    const slot = {tp: s.tp, physicalProfile: 'P1', mcProfile: 'MC640'};
    if (s.bandwidthMin.withinMC640) {
      const tt = TT.maxTauForTarget(ctx.planning[model], slot, ctx.workload.calibration, frontier.target.tpsPerUser);
      if (tt === null) assert.strictEqual(tau1, null, `${model} TP${s.tp}: both say tau cannot reach`);
      else near(tau1, tt, `${model} TP${s.tp}: tauMax at computeScale 1`);
    }
    // computeScaleMin and tauMax are the same line read both ways.
    for (const {tauUs, computeScaleMin} of s.computeScaleMinByTau) {
      if (computeScaleMin === null || tauUs < s.serial.collectiveBandwidthFloorUs) continue;
      const back = (budgetUs - s.serial.flopUs / computeScaleMin - s.serial.fixedUs - s.serial.tmaExposedUs) / s.serial.collectivesPerToken;
      near(back, tauUs, `${model} TP${s.tp}: computeScaleMin(${tauUs}) inverts tauMax`, 1e-6);
    }
  }
}

// Single-axis room: the tighter of the planning and the detailed bound, and the published point inside it.
for (const [axis, b] of Object.entries(frontier.singleAxis)) {
  const pick = axis === 'tauUs' ? Math.min : Math.max;
  near(b.value, pick(b.planning.value, b.detailed.value), `${axis}: single-axis room is the tighter bound`);
  assert(b.binding === 'detailed:K3' ? b.value === b.detailed.value : b.binding === `planning:${b.planning.binding}`, `${axis}: binding names the tighter model`);
  assert(axis === 'tauUs' ? b.value >= ctx.published.tauUs : b.value <= ctx.published[axis], `${axis}: the published point is inside the room`);
}

// Candidate contracts.
assert.deepStrictEqual(frontier.splits.map(s => s.splitId), R.SPLITS.map(s => s.splitId));
const ids = ['B-MEM-BW', 'B-SERIAL-CMP', 'B-TAU', 'B-SRAM-CAP', 'B-AREA'];
for (const {splitId, relaxes, contract: c} of frontier.splits) {
  assert.strictEqual(c.schemaVersion, R.CONTRACT_SCHEMA);
  assert.strictEqual(c.splitId, splitId);
  assert.strictEqual(c.layer, 'L1');
  assert.strictEqual(c.evidenceLevel, 'MODEL');
  assert.strictEqual(c.scope.tp, R.CONTRACT_TP);
  assert.deepStrictEqual(c.split.map(e => e.id), ids, `${splitId}: budget entries`);
  for (const e of c.split) {
    assert(e.ownerAgent && /-expert$/.test(e.ownerAgent), `${splitId}/${e.id}: owner agent`);
    assert((e.min === undefined) !== (e.max === undefined), `${splitId}/${e.id}: exactly one of min / max`);
  }
  const v = Object.fromEntries(c.split.map(e => [e.id, e.min !== undefined ? e.min : e.max]));
  assert.strictEqual(v['B-MEM-BW'], c.point.mcGBs);
  assert.strictEqual(v['B-SERIAL-CMP'], c.point.computeScale);
  assert.strictEqual(v['B-TAU'], c.point.tauUs);
  // The contract holds at its own point under both models, recomputed here.
  assert(c.check.holds, `${splitId}: the kernel offered a split that misses the budget`);
  for (const model of ctx.active) {
    assert(R.planningAt(ctx, model, R.CONTRACT_TP, c.point).rawUs <= budgetUs, `${splitId}: planning ${model} holds`);
  }
  const d = R.detailedAt(ctx, c.point);
  assert(d.feasible && d.rawUs <= budgetUs, `${splitId}: detailed K3 holds`);
  // The SRAM floor is the smallest grid value that holds, and the one below it does not.
  const sram = c.split.find(e => e.id === 'B-SRAM-CAP');
  const i = R.SHARED_GRID.indexOf(sram.min);
  assert(i >= 0 && R.detailedAt(ctx, c.point, {sharedMiB: sram.min}).rawUs <= budgetUs, `${splitId}: SRAM floor holds`);
  if (i > 0) {
    const below = R.detailedAt(ctx, c.point, {sharedMiB: R.SHARED_GRID[i - 1]});
    assert(!below.feasible || below.rawUs > budgetUs, `${splitId}: the grid value below the SRAM floor misses`);
  }
  // A split relaxes only the axes it names.
  for (const axis of ['tauUs', 'computeScale', 'mcGBs']) {
    if (!relaxes.includes(axis)) assert.strictEqual(c.point[axis], ctx.published[axis], `${splitId}: ${axis} stays published`);
  }
}
const point = id => frontier.splits.find(s => s.splitId === id).contract.point;
assert.strictEqual(point('S-TAU').tauUs, frontier.singleAxis.tauUs.value);
assert.strictEqual(point('S-CMP').computeScale, frontier.singleAxis.computeScale.value);
assert.strictEqual(point('S-BW').mcGBs, frontier.singleAxis.mcGBs.value);
assert(point('S-BW').mcGBs > RES.mcProfiles.MC320.payloadGBsPerCube && point('S-BW').mcGBs < refPayload, 'S-BW sits between MC320 and MC640');
const share = frontier.splits.find(s => s.splitId === 'S-BAL').contract.split[0].bound.share;
assert(share > 0 && share < 1, `S-BAL gives up a proper share of every axis: ${share}`);

console.log(`PASS budget frontier: stored = rebuilt; planning lines match token_time; ${frontier.splits.length} contracts hold under planning and detailed K3 at their own point`);
