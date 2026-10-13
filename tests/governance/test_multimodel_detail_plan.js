'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '../..');
const planPath = path.join(root, 'teams/model/inputs/multimodel_detail_plan.json');
const plan = JSON.parse(fs.readFileSync(planPath, 'utf8'));
const models = ['GLM-5.2', 'DeepSeek-V4-Pro'];
const teams = new Set(['Model', 'Hardware', 'Software', 'V&V', 'Architecture Council']);
const ids = new Set();

assert.strictEqual(plan.schemaVersion, 'multimodel-detail-plan-v0.1');
assert.strictEqual(plan.status, 'BLOCKED_CONFIG');
assert.deepStrictEqual(plan.scope.models, models);
assert.deepStrictEqual(plan.scope.tpValues, [8, 16, 32]);
assert.strictEqual(plan.scope.contextTokens, 1048576);
assert.strictEqual(plan.scope.metricPolicy.includes('validated TPS'), true);

for (const model of models) {
  const lane = plan.modelLanes[model];
  assert(lane, `${model}: missing detail lane`);
  assert(lane.source && lane.source.includes('formal_model_manifests.json'));
  assert.strictEqual(lane.shapeHashRequired, true);
  assert(Array.isArray(lane.distinctRisks) && lane.distinctRisks.length >= 4);
  assert(Array.isArray(lane.requiredVariants) && lane.requiredVariants.length >= 2);
}

for (const item of plan.workItems) {
  assert(/^(MODEL|HW|SW|VV|ARCH)-[A-Z0-9-]+$/.test(item.workItem), `invalid work item id ${item.workItem}`);
  assert(!ids.has(item.workItem), `duplicate work item ${item.workItem}`);
  ids.add(item.workItem);
  assert(teams.has(item.team), `${item.workItem}: unknown team`);
  assert(item.ownerStrategy, `${item.workItem}: missing strategy`);
  assert(item.models.length > 0 && item.models.every(model => models.includes(model)), `${item.workItem}: invalid model lane`);
  assert(Array.isArray(item.inputs) && item.inputs.length > 0, `${item.workItem}: inputs`);
  assert(Array.isArray(item.requiredOutputs) && item.requiredOutputs.length > 0, `${item.workItem}: outputs`);
  assert(Array.isArray(item.acceptance) && item.acceptance.length >= 3, `${item.workItem}: acceptance`);
  assert(Array.isArray(item.blockedWhen) && item.blockedWhen.length > 0, `${item.workItem}: blockedWhen`);
  assert(Array.isArray(item.dependsOn));
  assert(!JSON.stringify(item).match(/TPS\/usr|PASS|FAIL|D_GATE_PASSED/), `${item.workItem}: plan must not encode a gate/result or TPS claim`);
}

const required = [
  'MODEL-GLM-QUAL-01', 'MODEL-DS-QUAL-01', 'MODEL-OP-LEDGER-01', 'MODEL-COLLECTIVE-LEDGER-01',
  'HW-MULTIMODEL-REPLAY-01', 'HW-MULTIMODEL-SRAM-01', 'HW-MULTIMODEL-NET-01',
  'SW-MULTIMODEL-DEPLOY-01', 'VV-MULTIMODEL-VERIFY-01', 'ARCH-MULTIMODEL-INTEGRATION-01'
];
for (const id of required) assert(ids.has(id), `missing required work item ${id}`);

const byId = id => plan.workItems.find(item => item.workItem === id);
assert(byId('MODEL-COLLECTIVE-LEDGER-01').dependsOn.includes('MODEL-OP-LEDGER-01'));
assert(byId('HW-MULTIMODEL-NET-01').dependsOn.includes('MODEL-COLLECTIVE-LEDGER-01'));
assert(byId('VV-MULTIMODEL-VERIFY-01').dependsOn.includes('HW-MULTIMODEL-SRAM-01'));
assert(byId('ARCH-MULTIMODEL-INTEGRATION-01').dependsOn.includes('VV-MULTIMODEL-VERIFY-01'));

assert.deepStrictEqual(plan.exitStates.map(x => x.state), ['BLOCKED_CONFIG', 'MODEL_WITH_ASSUMPTIONS', 'VALIDATED_REPLAY', 'SILICON_OBSERVED']);
console.log(`PASS multi-model detail plan: ${plan.workItems.length} work items, two independent model lanes, explicit dependencies and no unqualified performance claims`);
