'use strict';
// Stage A candidates are recomputed independently from the planning workload and
// the stored K3 calibration with the planning token-time formula.
const assert = require('assert');
const fs = require('fs');
const TT = require('../models/planning/token_time');
const RES = require('../models/planning/resource_profiles');
const read = p => JSON.parse(fs.readFileSync(p,'utf8').replace(/^﻿/,''));
const score = read('data/direction/directional_tps_scorecard.json');
const workload = read('data/workload/planning_operator_workload.json');
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
 close(row.rawLatencyUsPerToken, Math.max(t.memoryUs * workload.calibration.kMemory, t.computeUs * workload.calibration.kCompute + t.commUs), 'raw');
 close(row.e2eLatencyUsPerToken, row.rawLatencyUsPerToken * TT.MARGIN, 'e2e');
 close(row.tpsPerUser, 1e6 / row.e2eLatencyUsPerToken, 'TPS/usr');
 assert.strictEqual(row.bottleneck, t.bound);
 assert.strictEqual(row.status, 'PLANNING_ESTIMATE');
}
assert(comparable > 0);
// Historical calibrated baseline remains independently tested in test_design_baseline.
console.log(`PASS directional SI units: ${comparable} candidate rows recomputed with the calibrated planning token time`);
