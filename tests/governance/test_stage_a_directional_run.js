'use strict';
const fs = require('fs');
const path = require('path');
const assert = require('assert');
const IDS = require('../../integration/planning/run_ids');
const root = path.resolve(__dirname, '../..');
const read = p => JSON.parse(fs.readFileSync(path.join(root, p), 'utf8').replace(/^﻿/, ''));
const env = read('out/direction/directional_resource_envelope.json');
const workload = read('out/direction/directional_workload_baseline.json');
const score = read('out/direction/directional_tps_scorecard.json');
const register = read('out/governance/candidate_register.json');
const report = fs.readFileSync(path.join(root, IDS.stageAReport), 'utf8');
assert.strictEqual(env.stage, 'direction');
assert.strictEqual(env.runId, IDS.stageARunId);
assert.strictEqual(env.models.length, 3);
assert.strictEqual(env.packageEnvelope.areaConservation, true);
// Area conservation is recomputed from the single hardware spec: 8 dies + 16 MC fit the placement window.
{
  const mc = read('teams/hardware/inputs/k3_mc_baseline.json');
  const pe = env.packageEnvelope;
  assert.strictEqual(pe.computeDieAreaMm2, mc.computeDieCandidate.estimatedAreaMm2);
  assert.strictEqual(pe.placementWindowMm2, mc.package.placementWindowMm2);
  assert(Math.abs(pe.packageAreaMm2 - (mc.card.computeDies * mc.computeDieCandidate.estimatedAreaMm2 + mc.card.memoryCubes * mc.package.memoryCubeAreaMm2Planning)) < 1e-9);
  assert(pe.packageAreaMm2 <= pe.placementWindowMm2 && pe.computeDieAreaMm2 <= pe.computeDieAreaLimitMm2);
}
assert.strictEqual(workload.models.find(item => item.modelId === 'K3').status, 'CALIBRATED_DIRECTIONAL_BASELINE');
assert.strictEqual(score.runId, IDS.stageARunId);
assert.strictEqual(score.candidateCount, 18);
assert.strictEqual(score.candidateSummaries.length, 6);
assert(score.candidateSummaries.every(item => item.accountedModelCount === 3));
assert(score.candidateSummaries.every(item => item.rankingEligible === true));
// A BLOCKED_CONFIG model is accounted for but never ranked or assumed.
const planningWorkload = read('out/workload/planning_operator_workload.json');
const blockedIds = Object.keys(planningWorkload.provenance).filter(id => planningWorkload.provenance[id].status === 'BLOCKED_CONFIG');
for (const summary of score.candidateSummaries) {
  assert.deepStrictEqual(summary.blockedModels, blockedIds);
  assert.strictEqual(summary.comparableModelCount + summary.blockedModels.length, summary.accountedModelCount);
  const rows = score.candidates.filter(c => c.candidateId === summary.candidateId && !blockedIds.includes(c.modelId));
  assert.strictEqual(summary.minTpsPerUser, Math.min(...rows.map(r => r.tpsPerUser)));
}
for (const row of score.candidates.filter(c => blockedIds.includes(c.modelId))) {
  assert.strictEqual(row.status, 'BLOCKED_CONFIG');
  assert.strictEqual(row.tpsPerUser, null);
}

// One hardware spec (P1, ADR-0021): its capacity is derived from k3_mc_baseline.json,
// never copied into the runner.
const mcSpec = read('teams/hardware/inputs/k3_mc_baseline.json');
const RES = require('../../teams/hardware/src/resource_profiles');
const peak = (shape, cores, ghz) => cores * shape.engines * shape.rows * shape.cols * 2 * ghz * 1e9 * 8;
assert.deepStrictEqual(Object.keys(score.resourceProfiles), ['P1']);
const p1 = score.resourceProfiles.P1;
// Fail fast with an actionable message when the committed scorecard predates the current runner.
assert(p1 && p1.engine && score.inputHashes.resourceProfiles,
  'directional_tps_scorecard.json is stale (missing resourceProfiles.*.engine); run `npm run model:planning` and commit the regenerated out/ files');
const hashFile = p => require('crypto').createHash('sha256').update(fs.readFileSync(path.join(root, p))).digest('hex');
assert.strictEqual(score.inputHashes.resourceProfiles, hashFile('teams/hardware/src/resource_profiles.js'),
  'scorecard was generated with a different teams/hardware/src/resource_profiles.js; run `npm run model:planning`');
assert.strictEqual(score.inputHashes.runner, hashFile('integration/pipelines/stage_a.js'),
  'scorecard was generated with a different integration/pipelines/stage_a.js; run `npm run model:planning`');
assert.strictEqual(score.inputHashes.mcSpec, hashFile('teams/hardware/inputs/k3_mc_baseline.json'),
  'scorecard predates the current k3_mc_baseline.json; run `npm run baseline:sync && npm run model:planning`');
const cand = mcSpec.computeDieCandidate;
assert.strictEqual(p1.lCoresPerDie, cand.lCores);
assert.strictEqual(p1.hCoresPerDie, cand.hCores);
assert.strictEqual(p1.ghz, cand.frequencyGHz);
assert.deepStrictEqual(p1.engine.L, {engines: cand.lCore.tensorEngines, rows: cand.lCore.tensorShape[0], cols: cand.lCore.tensorShape[1]});
assert.deepStrictEqual(p1.engine.H, {engines: cand.hCore.tensorEngines, rows: cand.hCore.tensorShape[0], cols: cand.hCore.tensorShape[1]});
assert.strictEqual(p1.peakByCore.L, peak(p1.engine.L, p1.lCoresPerDie, p1.ghz));
assert.strictEqual(p1.peakByCore.H, peak(p1.engine.H, p1.hCoresPerDie, p1.ghz));
// P1 package peak must be the searched candidate's die peak x 8, not a stale engine shape.
assert(Math.abs((p1.peakByCore.L + p1.peakByCore.H) / 8 / 1e12 - cand.bf16DenseTflops) < 1e-6, 'P1 peak must match k3_mc_baseline.json; rerun npm run model:planning');
assert.deepStrictEqual(score.resourceProfiles, JSON.parse(JSON.stringify(Object.fromEntries(Object.entries(RES.coreProfiles).map(([k, v]) => [k, {id: v.id, lCoresPerDie: v.lCoresPerDie, hCoresPerDie: v.hCoresPerDie, ghz: v.ghz, engine: v.engine, peakByCore: v.peakByCore, source: v.source}])))), 'scorecard resource profiles are stale; rerun npm run model:planning');
const p1k3 = score.candidates.find(c => c.candidateId === 'P1-compact-MC640-TP32' && c.modelId === 'K3');
const mc320k3 = score.candidates.find(c => c.candidateId === 'P1-compact-MC320-TP32' && c.modelId === 'K3');
assert(p1k3 && mc320k3);
// TPS/usr is the calibrated planning token time of the slot.
const TT = require('../../integration/planning/token_time');
const k3Model = TT.planningModel(planningWorkload, 'K3');
for (const row of [mc320k3, p1k3]) {
  const t = TT.slotTime(k3Model, row, planningWorkload.calibration);
  assert(Math.abs(row.tpsPerUser - t.tpsPerUser) < 1e-9 * t.tpsPerUser);
  assert.strictEqual(row.bottleneck, t.bound);
}
// The K3 calibration slot (P1/MC640/TP32) replays the detailed published point.
assert(Math.abs(p1k3.tpsPerUser - planningWorkload.calibration.calibratedTpsPerUser) < 1e-9 * p1k3.tpsPerUser);
assert.strictEqual(score.inputHashes.tokenTime, hashFile('integration/planning/token_time.js'),
  'scorecard was generated with a different integration/planning/token_time.js; run `npm run model:planning`');
if (score.dGate.decision !== 'PASS') {
  const sweep = register.exploratorySweeps.find(x => x.active);
  assert(sweep && sweep.runMode === 'EXPLORATORY_AFTER_BLOCKED_D_GATE', 'a blocked D-Gate needs an active exploratory sweep for Stage B');
  assert(sweep.candidateIds.length > 0 && sweep.candidateIds.length <= 3);
  assert(sweep.allowedModels.every(id => !blockedIds.includes(id)));
  assert(fs.existsSync(path.join(root, sweep.decisionRecord)), `missing decision record ${sweep.decisionRecord}`);
}

// D-Gate is recomputed by the validator, and the register state is derived from it.
const {evaluateDirectionGate} = require('../../integration/governance/evaluate_gates');
const recomputed = evaluateDirectionGate(env, score, register);
assert.deepStrictEqual(score.dGate, recomputed, 'scorecard dGate must equal the validator result');
assert.strictEqual(register.decisionSource, 'integration/governance/evaluate_gates.js#evaluateDirectionGate');
assert.strictEqual(register.decisionState, recomputed.decision === 'PASS' ? 'D_GATE_PASSED' : 'D_GATE_BLOCKED');
assert.strictEqual(recomputed.registerConsistent, true);
assert(register.formalSelectedCandidates.length <= 3);
// Selection policy is machine-applied (ADR-0008): rank by worst-model bound; a formal
// candidate reaches the target for EVERY comparable model; at most three; the best
// MC320 candidate is a non-formal reference with its misses listed.
const byBound = (a, b) => b.minTpsPerUser - a.minTpsPerUser || a.candidateId.localeCompare(b.candidateId);
const ranking = register.selectionBasis.ranking;
assert.deepStrictEqual(ranking.map(r => r.candidateId), score.candidateSummaries.slice().sort(byBound).map(s => s.candidateId));
const eligible = ranking.filter(r => r.minTpsPerUser >= score.targetTpsPerUser).map(r => r.candidateId);
assert.deepStrictEqual(ranking.filter(r => r.formallyEligible).map(r => r.candidateId), eligible);
assert.deepStrictEqual(score.selectedCandidateIds, eligible.slice(0, 3));
// The tau range annotates risk but does not gate selection: each selected candidate records the
// largest tau at which every model reaches the target, and tau-conditional ones are listed.
const tauTop = score.tauSensitivityUs[score.tauSensitivityUs.length - 1];
for (const r of ranking) {
  const s = score.candidateSummaries.find(x => x.candidateId === r.candidateId);
  const rows = score.candidates.filter(c => c.candidateId === r.candidateId && c.status !== 'BLOCKED_CONFIG');
  const expected = rows.some(c => c.maxTauUsForTarget === null) ? null : Math.min(...rows.map(c => c.maxTauUsForTarget));
  assert.strictEqual(s.maxTauUsForTarget, expected);
  assert.strictEqual(r.maxTauUsForTarget, expected);
  assert.strictEqual(r.tauConditional, expected !== null && expected < tauTop);
  assert.strictEqual(r.meetsArchitectureGate, r.minTpsPerUser >= score.architectureGateTpsPerUser);
  if (r.formallyEligible) assert(expected !== null && expected >= 1.15 - 1e-9, `${r.candidateId} eligible but misses at the tau point estimate`);
}
assert.deepStrictEqual(register.selectionBasis.tauConditionalCandidates, score.selectedCandidateIds.filter(id => ranking.find(r => r.candidateId === id).tauConditional));
assert(register.selectionBasis.policy.includes('not the') && register.selectionBasis.policy.includes('risk annotation'), 'policy must name the target floor and the tau rule');
const bestMc320 = ranking.find(r => r.candidateId.includes('MC320'));
if (!eligible.slice(0, 3).includes(bestMc320.candidateId)) {
  assert.deepStrictEqual(register.selectionBasis.referenceCandidates.map(r => r.candidateId), [bestMc320.candidateId]);
  const ref = register.selectionBasis.referenceCandidates[0];
  assert.strictEqual(ref.role, 'MC320_REFERENCE_NOT_FORMAL');
  assert(ref.missesTargetModels.length > 0 && ref.missesTargetModels.every(m => m.tpsPerUser < score.targetTpsPerUser));
  assert(!register.formalSelectedCandidates.includes(ref.candidateId), 'a reference candidate is never formal');
}
if (recomputed.decision === 'PASS') {
  assert(register.formalSelectedCandidates.length > 0);
  assert.deepStrictEqual(register.formalSelectedCandidates, score.selectedCandidateIds);
  for (const id of register.formalSelectedCandidates) {
    const summary = score.candidateSummaries.find(s => s.candidateId === id);
    assert(summary.minTpsPerUser >= score.targetTpsPerUser, `${id} misses the target for ${summary.worstModel}`);
  }
} else {
  assert.deepStrictEqual(register.formalSelectedCandidates, []);
}
assert(report.includes('D-Gate'));
assert(report.includes(IDS.stageARunId));
console.log(`PASS stage A directional run: single P1 spec resources, validator-computed D-Gate (${recomputed.decision}) and policy-derived candidate selection`);
