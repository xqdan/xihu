'use strict';

const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const R = require('../../integration/planning/model_core_replay');

const root = path.resolve(__dirname, '../..');
const file = 'out/workload/model_core_replay.json';
const read = p => JSON.parse(fs.readFileSync(path.join(root, p), 'utf8'));
const hash = p => crypto.createHash('sha256').update(fs.readFileSync(path.join(root, p))).digest('hex');
const artifact = read(file);
assert.strictEqual(artifact.schemaVersion, 'model-core-replay-v0.1');
assert.strictEqual(artifact.evidenceClass, R.EVIDENCE);
assert.strictEqual(artifact.status, 'PLANNING_DERIVED');
assert.strictEqual(artifact.provenance.operatorLedgerSha256, hash(R.LEDGER_FILE));
assert.strictEqual(artifact.provenance.resourceProfileSha256, hash('teams/hardware/inputs/k3_mc_baseline.json'));
assert.strictEqual(artifact.provenance.replaySourceSha256, hash('integration/planning/model_core_replay.js'));
assert.strictEqual(artifact.runs.length, 12);

for (const run of artifact.runs) {
  assert(['GLM-5.2', 'DeepSeek-V4-Pro'].includes(run.modelId));
  assert([16, 32].includes(run.tp));
  assert(['MC320', 'MC640'].includes(run.mcProfile));
  assert.strictEqual(run.physicalProfile, 'P1');
  assert.strictEqual(run.diesPerPackage, 8);
  assert.strictEqual(run.criticalPath.tps, null);
  assert.strictEqual(run.criticalPath.p95Us, null);
  assert.strictEqual(run.criticalPath.p99Us, null);
  assert.deepStrictEqual(run.resources.map(row => row.coreClass), ['L', 'H', 'INDEXER', 'REDUCE', 'V']);
  assert(run.rows.length > 0);
  assert(run.rows.every(row => Number.isFinite(row.nominalCycles) && row.nominalCycles >= 0));
  assert(run.rows.every(row => ['L', 'H', 'INDEXER', 'REDUCE'].includes(row.coreClass)));
  assert(run.rows.some(row => row.dtype.toLowerCase() === 'fp8' && row.dequantOpsPerDie > 0));
  if (run.modelId === 'DeepSeek-V4-Pro') assert(run.rows.some(row => row.dtype.toLowerCase() === 'fp4' && row.dequantOpsPerDie > 0));
  assert(['compute', 'memory', 'network'].includes(run.criticalPath.bottleneck));
  assert(run.criticalPath.serviceUs >= 0 && Number.isFinite(run.criticalPath.serviceUs));
}

const glm16 = artifact.runs.find(run => run.modelId === 'GLM-5.2' && run.tp === 16 && run.mcProfile === 'MC320');
const glm32 = artifact.runs.find(run => run.modelId === 'GLM-5.2' && run.tp === 32 && run.mcProfile === 'MC320');
const glm640 = artifact.runs.find(run => run.modelId === 'GLM-5.2' && run.tp === 16 && run.mcProfile === 'MC640');
assert(glm16.criticalPath.serviceUs >= glm32.criticalPath.serviceUs, 'lower TP must not reduce per-die work');
assert(glm640.criticalPath.memoryUs <= glm16.criticalPath.memoryUs, 'MC640 must not have lower bandwidth than MC320');
const replayed = R.build();
assert.deepStrictEqual(replayed.runs, artifact.runs, 'artifact is stale; run npm run model:core-replay');
console.log('PASS model core replay: L/H/INDEXER/REDUCE/V resources, dequant/scale/accumulation and TP/MC sensitivity are explicit');
