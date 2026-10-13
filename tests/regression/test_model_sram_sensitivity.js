'use strict';

const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const S = require('../../integration/planning/model_sram_sensitivity');

const root = path.resolve(__dirname, '../..');
const file = 'out/workload/model_sram_sensitivity.json';
const read = p => JSON.parse(fs.readFileSync(path.join(root, p), 'utf8'));
const hash = p => crypto.createHash('sha256').update(fs.readFileSync(path.join(root, p))).digest('hex');
const artifact = read(file);
assert.strictEqual(artifact.schemaVersion, 'model-sram-sensitivity-v0.1');
assert.strictEqual(artifact.evidenceClass, S.EVIDENCE);
assert.strictEqual(artifact.status, 'PLANNING_DERIVED');
assert.strictEqual(artifact.runs.length, 300);
assert.deepStrictEqual(artifact.sweep.sharedSramMiBPerDie, S.SRAM_MIB);
assert.deepStrictEqual(artifact.sweep.effectiveBandwidthScale, S.BANDWIDTH_SCALES);
assert.strictEqual(artifact.provenance.operatorLedgersSha256, hash(S.LEDGER_FILE));
assert.strictEqual(artifact.provenance.coreReplaySha256, hash(S.CORE_FILE));
assert.strictEqual(artifact.provenance.manifestSha256, hash(S.MANIFEST_FILE));
assert.strictEqual(artifact.provenance.sourceSha256, hash('integration/planning/model_sram_sensitivity.js'));

for (const run of artifact.runs) {
  assert(['GLM-5.2', 'DeepSeek-V4-Pro'].includes(run.modelId));
  assert([16, 32].includes(run.tp));
  assert(['MC320', 'MC640'].includes(run.mcProfile));
  assert(Number.isFinite(run.capacityMiBPerDie) && Number.isFinite(run.bandwidthScale));
  assert.deepStrictEqual(Object.keys(run.state.byClass).sort(), ['EXPERT_STAGING', 'KV_STATE', 'MTP_BRANCH_STATE', 'SPARSE_INDEX_CACHE']);
  assert.strictEqual(run.state.byClass.MTP_BRANCH_STATE.capacityBound, false);
  assert.strictEqual(run.state.byClass.MTP_BRANCH_STATE.residentMiBPerDie, 0);
  assert.strictEqual(run.service.tps, null);
  assert.strictEqual(run.service.p95Us, null);
  assert.strictEqual(run.service.p99Us, null);
  assert(Number.isFinite(run.service.serviceUs) && run.service.serviceUs >= 0);
  assert(['compute', 'memory', 'network'].includes(run.service.bottleneck));
}

const pick = (modelId, variantId, tp, mcProfile, capacity, bandwidthScale) => artifact.runs.find(run => run.modelId === modelId && run.variantId === variantId && run.tp === tp && run.mcProfile === mcProfile && run.capacityMiBPerDie === capacity && run.bandwidthScale === bandwidthScale);
const low = pick('GLM-5.2', null, 32, 'MC640', 4, 1);
const base = pick('GLM-5.2', null, 32, 'MC640', 16, 1);
const wide = pick('GLM-5.2', null, 32, 'MC640', 16, 1.5);
assert(low.state.overflowMiBPerDie >= base.state.overflowMiBPerDie);
assert(wide.service.memoryUs <= base.service.memoryUs);
assert(low.service.serviceUs >= base.service.serviceUs);
const dsActive = pick('DeepSeek-V4-Pro', 'activeParams', 32, 'MC640', 16, 1);
const dsTotal = pick('DeepSeek-V4-Pro', 'totalParams', 32, 'MC640', 16, 1);
assert(dsActive && dsTotal && dsActive.variantId !== dsTotal.variantId);
const rebuilt = S.build();
assert.deepStrictEqual(rebuilt.runs, artifact.runs, 'artifact is stale; run npm run model:sram-sensitivity');
console.log('PASS model SRAM sensitivity: KV/index/expert/MTP state classes, capacity and bandwidth sweeps, variant isolation and provenance are explicit');
