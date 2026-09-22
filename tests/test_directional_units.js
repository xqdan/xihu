'use strict';
const assert = require('assert');
const fs = require('fs');
const read = p => JSON.parse(fs.readFileSync(p,'utf8').replace(/^\uFEFF/,''));
const score = read('data/direction/directional_tps_scorecard.json');
const workload = read('data/workload/planning_operator_workload.json');
for (const row of score.candidates) {
 const w = row.workloadUnits;
 const ops = workload.operators[row.modelId];
 assert.strictEqual(w.flopsPerToken, ops.find(x=>x[0]===w.computeOperatorId)[2]/row.tp);
 assert.strictEqual(w.bytesPerToken, ops.find(x=>x[0]===w.bandwidthOperatorId)[3]/row.tp);
 assert.strictEqual(w.scope,'dominant_operator_per_rank_not_model_total');
 assert(Math.abs(row.computeTimeUs-w.flopsPerToken/w.effectiveFlopsPerSecond*1e6)<1e-8);
 assert(Math.abs(row.memoryTimeUs-w.bytesPerToken/w.effectiveBytesPerSecond*1e6)<1e-8);
 assert(Math.abs(row.tpsPerUser-1e6/Math.max(row.computeTimeUs,row.memoryTimeUs))<1e-8);
 assert.strictEqual(row.status,'PLANNING_ESTIMATE');
}
// Historical calibrated baseline remains independently tested in test_design_baseline.
console.log('PASS directional SI units and independent planning workload conservation');
