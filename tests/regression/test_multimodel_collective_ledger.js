'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const C = require('../../teams/model/src/collective_ledger');
const N = require('../../integration/planning/network_requirements');
const root = path.resolve(__dirname, '../..');
const read = p => JSON.parse(fs.readFileSync(path.join(root, p), 'utf8'));

const glm = C.load('GLM-5.2');
const deepseek = C.load('DeepSeek-V4-Pro');
assert.strictEqual(glm.countByLayerClass.total, 21 * 5 + 57 * 4);
assert.strictEqual(deepseek.countByLayerClass.total, 61 * 5);
assert.strictEqual(deepseek.variants.length, 2);
assert.notStrictEqual(deepseek.variants[0].parameterBasis, deepseek.variants[1].parameterBasis);

for (const modelId of ['GLM-5.2', 'DeepSeek-V4-Pro']) {
  for (const tp of [16, 32]) {
    const p = C.protocol(modelId, tp);
    assert.strictEqual(p.countPerToken, modelId === 'GLM-5.2' ? 333 : 305);
    assert.strictEqual(p.totals.routedLogicalBytesPerRank, p.totals.logicalPayloadBytesPerRank * (tp - 1));
    assert(p.totals.protocolWireBytesPerRank >= p.totals.logicalPayloadBytesPerRank);
    assert(p.totals.requestsPerRank > 0 && p.totals.maxWorkspaceBytesPerRank > 0);
    assert(p.rows.every(row => row.protocolWireBytesPerCollectivePerRank >= row.logicalBytesPerRank));
    if (modelId === 'DeepSeek-V4-Pro') assert.deepStrictEqual(p.variants.map(v => v.variantId), ['activeParams', 'totalParams']);
  }
}

const artifact = read(N.OUT_FILE);
for (const id of ['glm52-decode-b1-c1m-tp32', 'glm52-decode-b1-c1m-tp16', 'deepseek-v4-pro-decode-b1-c1m-tp32', 'deepseek-v4-pro-decode-b1-c1m-tp16']) {
  const scenario = artifact.scenarios.find(s => s.scenarioId === id);
  assert(scenario && scenario.status === 'MODEL_WITH_ASSUMPTIONS', `${id} should have model protocol projection`);
  assert(scenario.mapping.collectiveLedger, `${id}: missing collective ledger summary`);
  if (id.startsWith('deepseek')) assert.deepStrictEqual(scenario.mapping.collectiveLedger.variants.map(v => v.variantId), ['activeParams', 'totalParams']);
  assert.strictEqual(scenario.mapping.collectiveLedger.conservation.routedEqualsLogicalTimesPeers, true);
  assert.strictEqual(scenario.mapping.collectiveLedger.conservation.wireAtLeastLogical, true);
  const expectedHeads = id.startsWith('glm52') ? (id.endsWith('tp16') ? 4 : 2) : (id.endsWith('tp16') ? 8 : 4);
  assert.strictEqual(scenario.mapping.lseHeadsPerRank, expectedHeads);
  assert.strictEqual(scenario.runtimeLatencyUs, undefined);
}
for (const id of ['glm52-decode-b4-c32k-tp32', 'deepseek-v4-pro-decode-b4-c32k-tp32']) {
  const scenario = artifact.scenarios.find(s => s.scenarioId === id);
  assert.strictEqual(scenario.status, 'BLOCKED_CONFIG');
}
assert.deepStrictEqual(N.build().scenarios.map(s => [s.scenarioId, s.status]), artifact.scenarios.map(s => [s.scenarioId, s.status]));
console.log('PASS multimodel collective ledgers: independent GLM/DeepSeek payloads, variants and conservation');
