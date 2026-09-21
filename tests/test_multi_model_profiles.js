'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const profilePath = path.join(root, 'data/workload/model_profiles.json');
const profiles = JSON.parse(fs.readFileSync(profilePath, 'utf8'));

assert.strictEqual(profiles.schemaVersion, 'multi-model-workload-v0.1');
assert.strictEqual(profiles.profiles.length, 3);
assert.deepStrictEqual(profiles.profiles.map(p => p.id), ['K3', 'GLM-5.2', 'DeepSeek-V4-Pro']);

for (const profile of profiles.profiles) {
  assert(profile.contextTokens >= 1048576, `${profile.id}: context missing`);
  assert.strictEqual(profile.acceptance.targetTpsPerUser, 1000);
  assert.strictEqual(profile.acceptance.architectureGateTpsPerUser, 1050);
  assert.strictEqual(profile.acceptance.rawLatencyUsPerToken, 854.7008547);
  assert(profile.features.length >= 3, `${profile.id}: feature list too small`);
  assert(profile.evidence.length >= 1, `${profile.id}: evidence missing`);
}

const glm = profiles.profiles.find(p => p.id === 'GLM-5.2');
assert.strictEqual(glm.reportedParameterCountB, 753);
assert.strictEqual(glm.reportedArchitectureSignals.indexShareGroupSize, 4);
assert.strictEqual(glm.reportedArchitectureSignals.reportedFlopReductionAt1MContext, 2.9);
assert.strictEqual(glm.reportedArchitectureSignals.reportedMtpAcceptanceGainMax, 0.2);
assert.strictEqual(glm.status, 'MODEL_PENDING_CONFIG_CONFIRMATION');

const deepseek = profiles.profiles.find(p => p.id === 'DeepSeek-V4-Pro');
assert.strictEqual(deepseek.reportedParameterCountB, 1600);
assert.strictEqual(deepseek.reportedActiveParameterCountB, 49);
assert.strictEqual(deepseek.layerCount, 61);
assert.strictEqual(deepseek.reportedArchitectureSignals.routedExperts, 384);
assert.strictEqual(deepseek.reportedArchitectureSignals.activeExpertsPerToken, 6);
assert.strictEqual(deepseek.reportedArchitectureSignals.sharedExperts, 1);
assert.strictEqual(deepseek.status, 'MODEL_PENDING_LICENSE_AND_CONFIG_CONFIRMATION');

const multiModelDoc = fs.readFileSync(path.join(root, 'docs/design/13_MULTI_MODEL_ARCHITECTURE.md'), 'utf8');
for (const required of ['GLM-5.2', 'DeepSeek-V4-Pro', 'EXPERT_DISPATCH', 'MTP_ROLLBACK', 'index cache', '384 expert']) {
  assert(multiModelDoc.includes(required), `multi-model doc missing ${required}`);
}

console.log('PASS multi-model profiles: K3, GLM-5.2, DeepSeek-V4-Pro schemas and acceptance gates');