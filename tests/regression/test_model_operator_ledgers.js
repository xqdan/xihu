'use strict';

const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const O = require('../../teams/model/src/operator_ledger');

const root = path.resolve(__dirname, '../..');
const file = 'out/workload/model_operator_ledgers.json';
const read = p => JSON.parse(fs.readFileSync(path.join(root, p), 'utf8'));
const hash = p => crypto.createHash('sha256').update(fs.readFileSync(path.join(root, p))).digest('hex');
const artifact = read(file);

assert.strictEqual(artifact.schemaVersion, 'model-operator-ledgers-v0.1');
assert.strictEqual(artifact.generatedBy, 'integration/pipelines/generate_model_operator_ledgers.js');
assert.strictEqual(artifact.provenance.manifestSha256, hash(O.MANIFEST_FILE));
assert.strictEqual(artifact.provenance.operatorLedgerSourceSha256, hash('teams/model/src/operator_ledger.js'));
assert.strictEqual(artifact.provenance.evidenceClass, O.EVIDENCE);
assert.strictEqual(artifact.provenance.status, 'PLANNING_DERIVED');

const ledgers = [
  artifact.models['GLM-5.2'],
  artifact.models['DeepSeek-V4-Pro'].variants.activeParams,
  artifact.models['DeepSeek-V4-Pro'].variants.totalParams
];
assert.strictEqual(ledgers.length, 3);
for (const ledger of ledgers) {
  assert.strictEqual(ledger.schemaVersion, O.FORMAT);
  assert.strictEqual(ledger.evidenceClass, O.EVIDENCE);
  assert.strictEqual(ledger.status, 'PLANNING_DERIVED');
  assert(ledger.rows.length > 0);
  for (const row of ledger.rows) {
    for (const field of ['operatorId', 'layerClass', 'coreClass', 'dtype', 'flopsPerLayer', 'bytesPerLayer', 'bytesClass', 'basis', 'source']) {
      assert(Object.prototype.hasOwnProperty.call(row, field), `${ledger.modelId}: missing ${field}`);
    }
    for (const field of ['flopsPerLayer', 'bytesPerLayer', 'globalFlopsPerToken', 'globalBytesPerToken']) {
      assert(Number.isFinite(row[field]) && row[field] >= 0, `${ledger.modelId}/${row.operatorId}: invalid ${field}`);
    }
  }
  for (const field of ['globalFlopsPerToken', 'globalBytesPerToken', 'parameterCount', 'parameterStorageBytes']) {
    assert(Number.isFinite(ledger.totals[field]) && ledger.totals[field] >= 0, `${ledger.modelId}: invalid total ${field}`);
  }
  assert(!ledger.rows.some(row => /dispatch|mtp/i.test(row.operatorId)), `${ledger.modelId}: implicit dispatch/MTP row`);
}

const glm = ledgers[0];
assert.strictEqual(glm.shape.fullIndexerLayers.length, 21);
assert.strictEqual(glm.rows.length, 42);
const layerCounts = new Map(glm.rows.map(row => [row.layerClass, row.layerCount]));
assert.strictEqual((layerCounts.get('full_dense') || 0) + (layerCounts.get('full_moe') || 0), 21);
assert.strictEqual(layerCounts.get('shared_moe'), 57);
assert.strictEqual(glm.rows.find(row => row.operatorId === 'collective_reduce').invocationsPerToken, 333);

const active = ledgers[1];
const total = ledgers[2];
assert.strictEqual(active.rows.length, 32);
assert.strictEqual(total.rows.length, 32);
assert.strictEqual(active.selectedVariant, 'activeParams');
assert.strictEqual(total.selectedVariant, 'totalParams');
assert.strictEqual(active.rows.find(row => row.operatorId === 'collective_reduce').invocationsPerToken, 305);
assert.strictEqual(total.rows.find(row => row.operatorId === 'collective_reduce').invocationsPerToken, 305);
assert.notStrictEqual(active.derivation.expertHidden, total.derivation.expertHidden);
assert.deepStrictEqual(
  active.rows.filter(row => !/expert|router/i.test(row.operatorId)).map(row => [row.operatorId, row.flopsPerLayer, row.bytesPerLayer]),
  total.rows.filter(row => !/expert|router/i.test(row.operatorId)).map(row => [row.operatorId, row.flopsPerLayer, row.bytesPerLayer])
);

const regenerated = O.buildAll();
assert.deepStrictEqual(regenerated.models, artifact.models, 'artifact is stale; run npm run model:operator-ledgers');
console.log('PASS model operator ledgers: GLM full/shared rows, DeepSeek active/total variants, provenance and conservation fields');
