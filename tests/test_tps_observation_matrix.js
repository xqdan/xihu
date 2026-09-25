'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const root = path.resolve(__dirname, '..');
const matrix = JSON.parse(fs.readFileSync(path.join(root, 'data/workload/tps_observation_matrix.json'), 'utf8'));
const casesDoc = JSON.parse(fs.readFileSync(path.join(root, 'data/workload/multi_model_tp_matrix.json'), 'utf8'));
const cases = casesDoc.cases;
assert.strictEqual(matrix.schemaVersion, 'tps-observation-matrix-v0.1');
const workload = JSON.parse(fs.readFileSync(path.join(root, 'data/workload/planning_operator_workload.json'), 'utf8'));
const blocked = id => workload.provenance[id].status === 'BLOCKED_CONFIG';
assert.strictEqual(matrix.status, Object.keys(workload.provenance).some(blocked) ? 'PLANNING_ESTIMATES_WITH_BLOCKED_CONFIG' : 'PLANNING_ESTIMATES_COMPLETE');
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
  assert.strictEqual(observation.physicalProfile, 'P0');
  assert(observation.source);
  assert(observation.sourceSelector);
  assert(observation.manifestHash);
  assert(observation.runId);
  if (blocked(observation.modelId)) {
    // No config, no TPS: the slot is accounted for and carries its blocker.
    assert.strictEqual(observation.status, 'BLOCKED_CONFIG');
    assert.strictEqual(observation.evidenceKind, 'NONE');
    assert.strictEqual(observation.tpsPerUser, null);
    assert.strictEqual(observation.rawLatencyUsPerToken, null);
    assert.strictEqual(observation.e2eLatencyUsPerToken, null);
    assert.strictEqual(observation.boundingOperatorId, null);
    assert(observation.blocker && observation.blocker.startsWith('BLOCKED_CONFIG'));
    continue;
  }
  assert.strictEqual(observation.status, 'PLANNING_ESTIMATE');
  assert.strictEqual(observation.evidenceKind, 'CALIBRATED_PLANNING_TOKEN_TIME');
  assert(['memory_bandwidth', 'compute', 'collective_latency'].includes(observation.boundingResource));
  assert(Number.isFinite(observation.tpsPerUser) && observation.tpsPerUser > 0);
  assert(Number.isFinite(observation.rawLatencyUsPerToken) && observation.rawLatencyUsPerToken > 0);
  assert(Number.isFinite(observation.e2eLatencyUsPerToken) && observation.e2eLatencyUsPerToken > 0);
  assert(observation.boundingOperatorId);
  assert.strictEqual(observation.blocker, null);
}
// Slots must scale with TP and MC profile in the expected direction (comparable models only).
const slot = (model, tp, mc) => matrix.observations.find(o => o.modelId === model && o.tp === tp && o.mcProfile === mc);
for (const model of matrix.requiredCoverage.models.filter(id => !blocked(id))) {
  assert(slot(model, 8, 'MC320').tpsPerUser < slot(model, 32, 'MC320').tpsPerUser, `${model}: TP32 bound must exceed TP8 bound`);
  assert(slot(model, 32, 'MC320').tpsPerUser <= slot(model, 32, 'MC640').tpsPerUser, `${model}: MC640 bound must not be below MC320`);
}
assert.notStrictEqual(slot('K3', 32, 'MC320').tpsPerUser, slot('K3', 32, 'MC640').tpsPerUser);
assert.strictEqual(matrix.currentCoverage.modelObserved, 0);
assert.strictEqual(matrix.currentCoverage.siliconObserved, 0);
const planned = matrix.observations.filter(o => o.status === 'PLANNING_ESTIMATE').length;
const blockedSlots = matrix.observations.filter(o => o.status === 'BLOCKED_CONFIG').length;
assert.strictEqual(planned + blockedSlots, 18);
assert.strictEqual(matrix.currentCoverage.planningEstimated, planned);
assert.strictEqual(matrix.currentCoverage.blockedConfig, blockedSlots);
assert.strictEqual(matrix.currentCoverage.pendingModelRun, planned);
assert(Math.abs(matrix.currentCoverage.planningPercentComplete - planned / 18 * 100) < 0.05);
console.log(`PASS TPS matrix: ${planned} calibrated planning estimates, ${blockedSlots} BLOCKED_CONFIG slots without TPS, zero validated observations`);
