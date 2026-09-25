'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const IDS = require('../../integration/planning/run_ids');
const root = path.resolve(__dirname, '../..');
const read = relativePath => JSON.parse(fs.readFileSync(path.join(root, relativePath), 'utf8').replace(/^﻿/, ''));
const detail = read('out/detailed/detailed_architecture_run.json');
const gate = read('out/governance/gate_status.json');
const replay = read('out/detailed/formal_event_replay.json');
const register = read('out/governance/candidate_register.json');
const matrix = read('out/workload/tps_observation_matrix.json');
const report = fs.readFileSync(path.join(root, IDS.stageBReport), 'utf8');
// Fail fast when the committed detailed run predates the current runner or resource profiles.
const hashFile = p => require('crypto').createHash('sha256').update(fs.readFileSync(path.join(root, p))).digest('hex');
assert.strictEqual(detail.provenance.inputHashes.resourceProfiles, hashFile('teams/hardware/src/resource_profiles.js'),
  'detailed_architecture_run.json was generated with a different resource_profiles.js; run `npm run model:planning`');
assert.strictEqual(detail.provenance.inputHashes.runner, hashFile('integration/pipelines/stage_b.js'),
  'detailed_architecture_run.json was generated with a different stage_b.js; run `npm run model:planning`');
assert.strictEqual(detail.runId, IDS.stageBRunId);
assert.strictEqual(detail.stage, 'quantification');
assert.strictEqual(detail.provenance.inputHashes.tokenTime, hashFile('integration/planning/token_time.js'),
  'detailed_architecture_run.json was generated with a different token_time.js; run `npm run model:planning`');
const formal = register.decisionState === 'D_GATE_PASSED';
const sweep = (register.exploratorySweeps || []).find(x => x.active);
assert.strictEqual(detail.runMode, formal ? 'PLANNING_QUANTIFICATION' : 'EXPLORATORY_AFTER_BLOCKED_D_GATE');
assert.strictEqual(detail.agentId, 'Q1-Q9-orchestrator');
// Candidates come from the register, never from the runner.
assert.deepStrictEqual(detail.selectedCandidates, register.formalSelectedCandidates);
assert.strictEqual(detail.candidateSelection.source, 'out/governance/candidate_register.json');
assert.strictEqual(detail.candidateSelection.formal, formal);
assert.strictEqual(detail.candidateSelection.exploratory, !formal);
// A blocked D-Gate studies the active exploratory sweep and never records a formal selection.
assert.deepStrictEqual(detail.studiedCandidates, formal ? register.formalSelectedCandidates : sweep.candidateIds);
if (!formal) {
  assert.deepStrictEqual(detail.selectedCandidates, []);
  assert.strictEqual(detail.candidateSelection.exploratorySweep, sweep.sweepId);
  assert.strictEqual(detail.candidateSelection.decisionRecord, sweep.decisionRecord);
}
assert.strictEqual(detail.candidateSelection.decision, register.decisionState);
const workload = read('out/workload/planning_operator_workload.json');
const manifestModels = read('teams/model/inputs/formal_model_manifests.json').models;
const blockedIds = manifestModels.filter(m => workload.provenance[m.modelId].status === 'BLOCKED_CONFIG').map(m => m.modelId);
const comparableIds = manifestModels.map(m => m.modelId).filter(id => !blockedIds.includes(id));
assert.deepStrictEqual(detail.manifestStatus, Object.fromEntries(manifestModels.map(m => [m.modelId, m.status])));
for (const id of blockedIds) assert.strictEqual(detail.manifestStatus[id], 'BLOCKED_CONFIG');
// BLOCKED_CONFIG models have no ledger rows: comparable models x 5 operators x 12 slots.
assert.strictEqual(detail.operatorLedger.length, comparableIds.length * 5 * 12);
assert.deepStrictEqual([...new Set(detail.operatorLedger.map(row => row.modelId))].sort(), [...comparableIds].sort());
assert(detail.operatorLedger.every(row => !('ep' in row)), 'TP-only slots carry no EP field');
assert.deepStrictEqual([...new Set(detail.operatorLedger.map(row => row.physicalProfile))].sort(), ['P0', 'P1']);
assert.deepStrictEqual([...new Set(detail.operatorLedger.map(row => row.mcProfile))].sort(), ['MC320', 'MC640']);
assert.deepStrictEqual([...new Set(detail.operatorLedger.map(row => row.tp))].sort((a, b) => a - b), [8, 16, 32]);
for (const row of detail.operatorLedger) {
  assert(Number.isFinite(row.arithmeticIntensity) && row.arithmeticIntensity > 0);
  assert(Number.isFinite(row.ridgePoint) && row.ridgePoint > 0);
  assert(['bandwidth', 'compute'].includes(row.rooflineBound));
  assert(Number.isFinite(row.requiredPeakFlops) && row.requiredPeakFlops > 0);
  assert(Number.isFinite(row.availablePeakFlops) && row.availablePeakFlops > 0);
  assert(Number.isFinite(row.requiredToAvailableRatio) && row.requiredToAvailableRatio > 0);
  assert(Number.isFinite(row.requiredMemoryBandwidth) && row.requiredMemoryBandwidth > 0);
  assert(Number.isFinite(row.availableMemoryBandwidth) && row.availableMemoryBandwidth > 0);
  assert(Number.isFinite(row.requiredToAvailableBandwidthRatio) && row.requiredToAvailableBandwidthRatio > 0);
  assert(row.bytes && Number.isFinite(row.bytes.total) && row.bytes.total > 0);
  assert(row.workloadStatus, 'ledger rows must carry the workload provenance status');
  assert(Number.isFinite(row.computeTimeUs) && Number.isFinite(row.memoryTimeUs));
}
// P0 and P1 ledger rows must use each profile's own peak capacity (from teams/hardware/src/resource_profiles.js).
const RES = require('../../teams/hardware/src/resource_profiles');
for (const profile of ['P0', 'P1']) {
  for (const row of detail.operatorLedger.filter(r => r.physicalProfile === profile)) {
    assert.strictEqual(row.availablePeakFlops, RES.coreProfiles[profile].peakByCore[row.coreClass], `${profile} ${row.operatorId} peak is stale; rerun npm run model:planning`);
  }
  for (const core of ['L', 'H', 'V']) {
    assert.strictEqual(detail.sizing.availableResources[profile][core].peakFlops, RES.coreProfiles[profile].peakByCore[core]);
  }
}
assert.deepStrictEqual(detail.blockedCases.map(c => c.modelId), blockedIds);
assert(detail.blockedCases.every(c => c.status === 'BLOCKED_CONFIG' && c.missingConfig.length > 0));
for (const id of blockedIds) assert.strictEqual(detail.summary.find(x => x.modelId === id).status, 'BLOCKED_CONFIG');
// Token-time block: formula, stored calibration and MTP exclusion are explicit.
for (const [key, value] of Object.entries(detail.tokenTime.calibration)) assert.deepStrictEqual(value, workload.calibration[key], `tokenTime.calibration.${key} is stale`);
assert.strictEqual(detail.tokenTime.mtpApplied, false);
assert.strictEqual(detail.tokenTime.slots.length, comparableIds.length * 12);
assert.strictEqual(detail.summary.length, 3);
assert.strictEqual(detail.sizing.targetTpsPerUser, 1000);
assert.strictEqual(detail.sizing.utilizationAssumption, 0.6);
assert.strictEqual(detail.sizing.dutyCycleAssumption, 0.85);
assert(detail.sizing.availableResources.P0.L.peakFlops > 0);
assert(detail.sizing.availableResources.P1.L.peakFlops > 0);
assert.strictEqual(detail.agentRuns.Q2.status, 'COMPLETE');
assert.strictEqual(detail.agentRuns.Q8.status, 'PLANNING_ONLY');
assert.strictEqual(detail.agentRuns.Q9.status, 'COMPLETE');
assert.strictEqual(detail.observationMatrix.requiredSlots, 18);
assert.strictEqual(detail.observationMatrix.all18SlotsAccounted, true);
assert(detail.provenance.manifestHash);
assert.strictEqual(detail.evidenceKind, 'CALIBRATED_PLANNING_TOKEN_TIME');
assert.strictEqual(detail.qGate.provenanceComplete, true);
assert.strictEqual(detail.qGate.p0P1DistinctResources, true);
assert.strictEqual(detail.qGate.observationMatrixCompleteOrBlocked, false);
assert.strictEqual(detail.qGate.decision, 'BLOCKED_BY_D_GATE_MANIFEST_EVENT_MODEL_AND_PROVENANCE');
// Performance acceptance is computed from the slots, not written as a literal.
const target = detail.sizing.targetTpsPerUser;
const gateTps = detail.sizing.architectureGateTpsPerUser;
// A BLOCKED_CONFIG slot (null TPS) never meets the target.
const meets = (o, x) => o.tpsPerUser !== null && o.tpsPerUser >= x;
const comparable = matrix.observations.filter(o => o.status !== 'BLOCKED_CONFIG');
const acc = detail.performanceAcceptance;
assert.strictEqual(acc.all18SlotsMeetTarget, matrix.observations.every(o => meets(o, target)));
assert.strictEqual(acc.all18SlotsMeetArchitectureGate, matrix.observations.every(o => meets(o, gateTps)));
assert.strictEqual(acc.comparableSlotsMeetTarget, comparable.every(o => meets(o, target)));
assert.strictEqual(acc.selectedCandidateSlotsMeetTarget, formal ? acc.selectedCandidateSlotsMeetTarget : null);
assert.strictEqual(acc.coverageStatus, comparable.length === matrix.observations.length ? 'COMPLETE' : 'BLOCKED_CONFIG_PARTIAL_COVERAGE');
assert(['PERFORMANCE_MISS_REQUIRES_DIRECTION_BACKFLOW', 'PERFORMANCE_MISS_OUTSIDE_SELECTED_CANDIDATES_NOT_VALIDATED', 'STUDIED_CANDIDATES_ABOVE_TARGET_OTHERS_MISS_NOT_VALIDATED', 'PLANNING_ESTIMATE_ABOVE_GATE_NOT_VALIDATED'].includes(acc.status));
// Formal candidates meet the target by the selection rule, so the status must not read as a
// performance result: with a formal selection and slots below the gate it names the misses outside it.
assert.strictEqual(acc.comparableSlotsBelowTarget, comparable.filter(o => !meets(o, target)).length);
if (formal && !acc.comparableSlotsMeetArchitectureGate) {
  assert.strictEqual(acc.status, acc.selectedCandidateSlotsMeetTarget ? 'PERFORMANCE_MISS_OUTSIDE_SELECTED_CANDIDATES_NOT_VALIDATED' : 'PERFORMANCE_MISS_REQUIRES_DIRECTION_BACKFLOW');
}
if (formal) assert.deepStrictEqual(acc.selectedTauConditions.map(x => x.candidateId).sort(), register.formalSelectedCandidates.slice().sort());
assert.strictEqual(replay.eventCount, detail.operatorLedger.length * 4);
assert.strictEqual(replay.events.length, replay.eventCount);
assert(replay.events.every(e => e.status === 'SYNTHETIC_PLACEHOLDER'), 'synthetic events must not be labelled REPLAYED');
assert.strictEqual(gate.quantificationGate.decision, detail.qGate.decision);
assert(report.includes(detail.runMode));
if (blockedIds.length) assert(report.includes('BLOCKED_CONFIG'));
assert(report.includes(`All 18 slots meet target: **${detail.performanceAcceptance.all18SlotsMeetTarget ? 'yes' : 'no'}**`));
console.log(`PASS Stage B planning: register-driven candidates, distinct P0/P1 capacity, computed acceptance (${detail.performanceAcceptance.status}) and Q-Gate block are explicit`);
