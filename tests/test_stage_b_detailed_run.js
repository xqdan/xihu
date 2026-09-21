'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const detailPath = path.join(root, 'data/detailed/detailed_architecture_run.json');
const detail = JSON.parse(fs.readFileSync(detailPath, 'utf8').replace(/^\uFEFF/, ''));
const reportPath = path.join(root, 'reports/detailed/stage_b_detailed_run_20260921.md');
const report = fs.readFileSync(reportPath, 'utf8');

assert(detail.runId, 'runId must exist');
assert.strictEqual(detail.stage, 'quantification');
assert.strictEqual(detail.agentId, 'Q1-Q9');
assert.strictEqual(detail.sourceDirectionalRunId, 'stage-a-20260921105239');
assert.strictEqual(detail.selectedCandidates.length, 3);
assert.deepStrictEqual(detail.selectedCandidates, [
  'P0-7R-balanced-MC320-TP8',
  'P0-7R-balanced-MC320-TP16',
  'P0-7R-balanced-MC320-TP32'
]);

assert.strictEqual(detail.manifestStatus.K3, 'PLANNING_MANIFEST');
assert.strictEqual(detail.manifestStatus['GLM-5.2'], 'BLOCKED_CONFIG');
assert.strictEqual(detail.manifestStatus['DeepSeek-V4-Pro'], 'BLOCKED_CONFIG');

assert.strictEqual(detail.operatorLedger.length, 15);
assert(detail.operatorLedger.every(row => row.modelId === 'K3'));
assert.deepStrictEqual([...new Set(detail.operatorLedger.map(row => row.tp))].sort((a, b) => a - b), [8, 16, 32]);
assert.deepStrictEqual([...new Set(detail.operatorLedger.map(row => row.physicalProfile))], ['P0']);
assert.deepStrictEqual([...new Set(detail.operatorLedger.map(row => row.mcProfile))], ['MC320']);
assert.deepStrictEqual([...new Set(detail.operatorLedger.map(row => row.status))], ['PLANNING_ESTIMATE']);
assert.deepStrictEqual([...new Set(detail.operatorLedger.map(row => row.confidence))], ['E1']);

for (const row of detail.operatorLedger) {
  assert(Number.isFinite(row.arithmeticIntensity) && row.arithmeticIntensity > 0);
  assert(Number.isFinite(row.ridgePoint) && row.ridgePoint > 0);
  assert(['bandwidth', 'compute'].includes(row.rooflineBound));
  assert(Number.isFinite(row.requiredEffectiveFlops) && row.requiredEffectiveFlops > 0);
  assert(Number.isFinite(row.requiredPeakFlops) && row.requiredPeakFlops > 0);
  assert(Number.isFinite(row.availablePeakFlops) && row.availablePeakFlops > 0);
  assert(Number.isFinite(row.requiredToAvailableRatio) && row.requiredToAvailableRatio > 0);
  assert(row.bytes && Number.isFinite(row.bytes.total) && row.bytes.total > 0);
}

assert.strictEqual(detail.blockedCases.length, 6);
const blockedByModel = detail.blockedCases.reduce((acc, item) => {
  (acc[item.modelId] ??= []).push(item.tp);
  assert.strictEqual(item.status, 'BLOCKED_CONFIG');
  assert.strictEqual(item.confidence, 'E0');
  assert.strictEqual(item.physicalProfile, 'P0');
  assert.strictEqual(item.mcProfile, 'MC320');
  return acc;
}, {});
assert.deepStrictEqual(blockedByModel['GLM-5.2'].sort((a, b) => a - b), [8, 16, 32]);
assert.deepStrictEqual(blockedByModel['DeepSeek-V4-Pro'].sort((a, b) => a - b), [8, 16, 32]);

assert.strictEqual(detail.summary.length, 1);
assert.strictEqual(detail.summary[0].modelId, 'K3');
assert.strictEqual(detail.summary[0].operatorCount, 15);
assert.strictEqual(detail.summary[0].worstOperator, 'routed_moe');
assert.strictEqual(detail.summary[0].status, 'PLANNING_ESTIMATE');
assert(Number.isFinite(detail.summary[0].maxRequiredToAvailableRatio));

assert.strictEqual(detail.sizing.targetTpsPerUser, 1000);
assert.strictEqual(detail.sizing.utilizationAssumption, 0.6);
assert.strictEqual(detail.sizing.dutyCycleAssumption, 0.85);
assert(detail.sizing.availablePeakFlops.L > 0);
assert(detail.sizing.availablePeakFlops.REDUCE > 0);

assert.strictEqual(detail.qGate.manifestCompleteOrBlocked, true);
assert.strictEqual(detail.qGate.tp8Tp16Tp32Executable, true);
assert.strictEqual(detail.qGate.sharedManifestAcrossRooflineAndReplay, false);
assert.strictEqual(detail.qGate.p0P1Separated, true);
assert.strictEqual(detail.qGate.mc320Mc640Separated, true);
assert.strictEqual(detail.qGate.provenanceComplete, true);
assert.strictEqual(detail.qGate.decision, 'BLOCKED_BY_MANIFEST_AND_EVENT_MODEL');

assert(report.includes(detail.runId));
assert(report.includes('Q-GATE BLOCKED'));
assert(report.includes('routed_moe'));
assert(report.includes('GLM-5.2'));
assert(report.includes('DeepSeek-V4-Pro'));

console.log('PASS stage B detailed run: K3 Q2 ledger, blocked configs, sizing fields and blocked Q-Gate recorded');

