'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const matrix = JSON.parse(fs.readFileSync(path.join(root, 'data/workload/multi_model_tp_matrix.json'), 'utf8'));
const profiles = JSON.parse(fs.readFileSync(path.join(root, 'data/workload/model_profiles.json'), 'utf8'));
const profileById = new Map(profiles.profiles.map(profile => [profile.id, profile]));

assert.strictEqual(matrix.schemaVersion, 'multi-model-tp-matrix-v0.1');
assert.deepStrictEqual(matrix.topologyRules.tpValues, [8, 16, 32]);
assert.strictEqual(matrix.cases.length, 9);

const expectedModels = ['K3', 'GLM-5.2', 'DeepSeek-V4-Pro'];
for (const modelId of expectedModels) {
  const cases = matrix.cases.filter(testCase => testCase.modelId === modelId);
  assert.strictEqual(cases.length, 3, `${modelId}: expected TP8/TP16/TP32 cases`);
  assert.deepStrictEqual(cases.map(testCase => testCase.tp).sort((a, b) => a - b), [8, 16, 32]);
  for (const testCase of cases) {
    assert.strictEqual(testCase.workloadClass, 'decode');
    assert.strictEqual(testCase.sharding.weight, 'tensor_parallel');
    assert.strictEqual(testCase.sharding.kvState, 'tensor_parallel');
    assert(profileById.has(testCase.modelId), `${testCase.caseId}: unknown model`);
  }
}

const expectedPackages = new Map();
for (const testCase of matrix.cases) {
  const expected = {
    packageCount: testCase.tp,
    computeDieCount: testCase.tp * matrix.topologyRules.computeDiesPerPackage,
    memoryCubeCount: testCase.tp * matrix.topologyRules.memoryCubesPerPackage,
    dataSramMiB: testCase.tp * matrix.topologyRules.dataSramMiBPerPackage,
    memoryCapacityGB: testCase.tp * matrix.topologyRules.memoryCapacityGBPerPackage,
    scaleOutPayloadGBs: testCase.tp * matrix.topologyRules.packageScaleOutPayloadGBs
  };
  expectedPackages.set(testCase.caseId, expected);

  assert.strictEqual(matrix.common.batch, 1);
  assert.strictEqual(matrix.common.contextTokens, 1048576);
  assert.strictEqual(matrix.common.pp, 1);
  assert(testCase.tp === 8 || testCase.tp === 16 || testCase.tp === 32);
  assert(expected.computeDieCount > 0);
  assert(expected.memoryCubeCount > 0);
  assert(expected.dataSramMiB > 0);
  assert(expected.memoryCapacityGB > 0);
  assert(expected.scaleOutPayloadGBs > 0);

  const model = profileById.get(testCase.modelId);
  assert.strictEqual(model.acceptance.targetTpsPerUser, matrix.common.targetTpsPerUser);
  assert.strictEqual(model.acceptance.architectureGateTpsPerUser, matrix.common.architectureGateTpsPerUser);

  if (testCase.modelId === 'K3') {
    assert.strictEqual(testCase.expected.indexCache, false);
    assert.strictEqual(testCase.expected.mtpBranch, false);
    assert.strictEqual(testCase.expected.lseMerge, true);
  } else {
    assert.strictEqual(testCase.expected.indexCache, true);
    assert.strictEqual(testCase.expected.mtpBranch, true);
    assert.strictEqual(testCase.expected.rollback, true);
  }

  if (testCase.modelId === 'DeepSeek-V4-Pro') {
    assert.strictEqual(testCase.expected.expertCount, 384);
    assert.strictEqual(testCase.expected.activeExpertsPerToken, 6);
    assert.strictEqual(testCase.sharding.expertWeights, 'expert_parallel');
  }
}

assert.strictEqual(expectedPackages.get('K3-TP8-DECODE-1M').computeDieCount, 64);
assert.strictEqual(expectedPackages.get('K3-TP16-DECODE-1M').computeDieCount, 128);
assert.strictEqual(expectedPackages.get('K3-TP32-DECODE-1M').computeDieCount, 256);
assert.strictEqual(expectedPackages.get('DeepSeek-V4-Pro-TP32-DECODE-1M').memoryCapacityGB, 8192);

console.log('PASS multi-model TP matrix: 3 models x TP8/TP16/TP32, topology arithmetic and feature contracts');