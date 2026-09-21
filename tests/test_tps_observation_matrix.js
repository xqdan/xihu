'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const matrix = JSON.parse(fs.readFileSync(path.join(root, 'data/workload/tps_observation_matrix.json'), 'utf8'));
const casesDoc = JSON.parse(fs.readFileSync(path.join(root, 'data/workload/multi_model_tp_matrix.json'), 'utf8'));
const cases = casesDoc.cases;
const baseline = JSON.parse(fs.readFileSync(path.join(root, 'docs/design/spec/k3_mc_baseline.json'), 'utf8'));

assert.strictEqual(matrix.schemaVersion, 'tps-observation-matrix-v0.1');
assert.strictEqual(matrix.metric.id, 'decode_tps_per_user');
assert.strictEqual(matrix.metric.unit, 'tokens/s/user');
assert.strictEqual(matrix.metric.targetTpsPerUser, 1000);
assert.strictEqual(matrix.metric.architectureGateTpsPerUser, 1050);
assert.strictEqual(matrix.observations.length, 18);
assert.deepStrictEqual(matrix.requiredCoverage.models, ['K3', 'GLM-5.2', 'DeepSeek-V4-Pro']);
assert.deepStrictEqual(matrix.requiredCoverage.tp, [8, 16, 32]);
assert.deepStrictEqual(matrix.requiredCoverage.mcProfiles, ['MC320', 'MC640']);

for (const observation of matrix.observations) {
  assert(matrix.requiredCoverage.models.includes(observation.modelId));
  assert(matrix.requiredCoverage.tp.includes(observation.tp));
  assert(matrix.requiredCoverage.mcProfiles.includes(observation.mcProfile));
  assert.strictEqual(observation.metric, matrix.metric.id);
  assert.strictEqual(observation.unit, matrix.metric.unit);
  assert(cases.some(testCase => testCase.caseId === observation.caseId), `${observation.observationId}: missing test case`);
  if (observation.status === 'PENDING_MODEL_RUN') {
    assert.strictEqual(observation.tpsPerUser, null);
    assert(observation.blocker);
  }
}

const k3Mc320 = matrix.observations.find(o => o.observationId === 'K3-TP32-DECODE-1M-MC320');
const k3Mc640 = matrix.observations.find(o => o.observationId === 'K3-TP32-DECODE-1M-MC640');
assert.strictEqual(k3Mc320.status, 'MODEL_OBSERVED');
assert.strictEqual(k3Mc640.status, 'MODEL_OBSERVED');
assert.strictEqual(k3Mc320.tpsPerUser, baseline.modelResults.referenceMc320GBs.tpsPerUser);
assert.strictEqual(k3Mc640.tpsPerUser, baseline.modelResults.stretchMc640GBs.tpsPerUser);
assert(k3Mc320.tpsPerUser < matrix.metric.targetTpsPerUser);
assert(k3Mc640.tpsPerUser < matrix.metric.targetTpsPerUser);
assert.strictEqual(matrix.currentCoverage.modelObserved, 2);
assert.strictEqual(matrix.currentCoverage.siliconObserved, 0);

console.log('PASS TPS observation matrix: 18 model/TP/MC slots, explicit targets, states and K3 baseline linkage');