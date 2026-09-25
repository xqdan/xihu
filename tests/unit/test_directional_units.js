'use strict';
// Stage A candidates are recomputed independently from the planning workload and
// the stored K3 calibration with the planning token-time formula.
const assert = require('assert');
const fs = require('fs');
const TT = require('../../integration/planning/token_time');
const RES = require('../../teams/hardware/src/resource_profiles');
const read = p => JSON.parse(fs.readFileSync(p,'utf8').replace(/^﻿/,''));
const score = read('out/direction/directional_tps_scorecard.json');
const workload = read('out/workload/planning_operator_workload.json');
const close = (a, b, label) => assert(Math.abs(a - b) <= 1e-9 * Math.max(1, Math.abs(b)), `${label}: ${a} != ${b}`);
let comparable = 0;
for (const row of score.candidates) {
 const model = TT.planningModel(workload, row.modelId);
 if (!model) {
  assert.strictEqual(row.status, 'BLOCKED_CONFIG');
  assert.strictEqual(row.tpsPerUser, null);
  assert(row.blocker);
  continue;
 }
 comparable++;
 const slot = {tp: row.tp, physicalProfile: row.physicalProfile, mcProfile: row.mcProfile};
 const t = TT.slotTime(model, slot, workload.calibration);
 const w = row.workloadUnits;
 const nonCollective = model.rows.filter(r => r[4] !== 'collective');
 close(w.flopsPerToken, model.rows.reduce((s, r) => s + r[2], 0) / row.tp, 'flops per rank');
 close(w.memoryBytesPerToken, nonCollective.reduce((s, r) => s + r[3], 0) / row.tp, 'memory bytes per rank');
 assert.strictEqual(w.scope, 'model_total_per_rank');
 assert.strictEqual(w.effectiveBytesPerSecond, RES.mcProfiles[row.mcProfile].effectiveBytesPerSecond);
 close(row.memoryTimeUs, w.memoryBytesPerToken / w.effectiveBytesPerSecond * 1e6, 'memory time');
 close(row.memoryTimeUs, t.memoryUs, 'memory time vs token time');
 close(row.computeTimeUs, t.computeUs, 'compute time');
 close(row.commTimeUs, t.collectivesPerToken * Math.max(TT.TAU_US, t.perCollectiveUs), 'collective time');
 // Split calibration (ADR-0008): expert re-reads on routed bytes; FLOP, per-layer fixed and exposed TMA terms.
 const c = workload.calibration;
 const expertBytes = model.rows.filter(r => r[4] === 'expert').reduce((s, r) => s + r[3], 0) / row.tp;
 close(row.expertMemoryTimeUs, expertBytes / w.effectiveBytesPerSecond * 1e6, 'expert memory time');
 const memoryLane = c.kMemory * (row.memoryTimeUs + c.expertReread * row.expertMemoryTimeUs);
 const serialCompute = c.kFlop * row.computeTimeUs + c.fixedPerLayerUs * workload.layers[row.modelId] + c.kTmaExposedUsPerGB * w.memoryBytesPerToken / 1e9;
 close(row.memoryLaneUs, memoryLane, 'memory lane');
 close(row.serialComputeUs, serialCompute, 'serial compute');
 close(row.rawLatencyUsPerToken, Math.max(memoryLane, serialCompute + row.commTimeUs), 'raw');
 // tau sensitivity: the first column is the point estimate; TPS/usr never rises with tau.
 assert.deepStrictEqual(row.tauSensitivity.map(x => x.tauUs), TT.TAU_SENSITIVITY_US);
 close(row.tauSensitivity[0].tpsPerUser, row.tpsPerUser, 'tau point estimate');
 assert(row.tauSensitivity.every((x, i, xs) => i === 0 || x.tpsPerUser <= xs[i - 1].tpsPerUser + 1e-9), 'TPS/usr must not rise with tau');
 const count = model.collectivesPerToken;
 const wireUs = model.rows.filter(r => r[4] === 'collective').reduce((s, r) => s + r[3], 0) / row.tp / count / RES.networkBandwidth * 1e6;
 for (const x of row.tauSensitivity) {
  close(x.tpsPerUser, 1e6 / (Math.max(memoryLane, serialCompute + count * Math.max(x.tauUs, wireUs)) * TT.MARGIN), `tau ${x.tauUs}`);
 }
 // maxTauUsForTarget: the target is met exactly at that tau; null means no tau reaches it.
 const tpsAtTau = tauUs => TT.slotTime(model, slot, workload.calibration, {...TT.NOMINAL, tauUs}).tpsPerUser;
 if (row.maxTauUsForTarget === null) assert(tpsAtTau(0) < score.targetTpsPerUser - 1e-9, 'null max tau but target reachable');
 else {
  assert(Math.abs(tpsAtTau(row.maxTauUsForTarget) - score.targetTpsPerUser) < 1e-6 || (tpsAtTau(row.maxTauUsForTarget) >= score.targetTpsPerUser && tpsAtTau(row.maxTauUsForTarget + 1e-6) < score.targetTpsPerUser), 'max tau is the target boundary');
  assert(tpsAtTau(row.maxTauUsForTarget + 1e-3) < score.targetTpsPerUser, 'target still met above max tau');
 }
 // Re-read sensitivity: prediction accuracy 0.7 / 0.8 / 0.9; the 0.8 column equals the point estimate.
 assert.deepStrictEqual(row.rereadSensitivity.map(x => x.prediction), TT.PREDICTION_SENSITIVITY);
 for (const x of row.rereadSensitivity) {
  const lane = c.kMemory * (row.memoryTimeUs + (1 - x.prediction) * row.expertMemoryTimeUs);
  close(x.tpsPerUser, 1e6 / (Math.max(lane, serialCompute + row.commTimeUs) * TT.MARGIN), `reread ${x.prediction}`);
 }
 close(row.rereadSensitivity.find(x => x.prediction === 0.8).tpsPerUser, row.tpsPerUser, 'reread point estimate');
 // Shape range covers the point estimate and every declared variant.
 const variantIds = Object.keys((workload.variants || {})[row.modelId] || {});
 assert.deepStrictEqual(row.shapeVariants.map(v => v.variant), variantIds);
 assert(row.tpsPerUserShapeRange.min <= row.tpsPerUser && row.tpsPerUserShapeRange.max >= row.tpsPerUser);
 assert(row.dtypePolicy && row.dtypePolicy.includes(workload.dtypePolicy[row.modelId].attentionAndDenseProjections));
 close(row.e2eLatencyUsPerToken, row.rawLatencyUsPerToken * TT.MARGIN, 'e2e');
 close(row.tpsPerUser, 1e6 / row.e2eLatencyUsPerToken, 'TPS/usr');
 assert.strictEqual(row.bottleneck, t.bound);
 assert.strictEqual(row.status, 'PLANNING_ESTIMATE');
}
assert(comparable > 0);
// The K3 FP8-dense comparison is recomputed and never enters candidates or ranking.
assert.strictEqual(score.comparisonRows.length, 6 * Object.keys(workload.comparisons).length);
for (const row of score.comparisonRows) {
 assert.strictEqual(row.ranked, false);
 const t = TT.slotTime(workload.comparisons[row.comparisonId], row, workload.calibration);
 close(row.tpsPerUser, t.tpsPerUser, `${row.comparisonId} TPS/usr`);
 assert(!score.candidates.some(c => c.modelId === row.comparisonId));
}
// Historical calibrated baseline remains independently tested in test_design_baseline.
console.log(`PASS directional SI units: ${comparable} candidate rows recomputed with the calibrated planning token time`);
