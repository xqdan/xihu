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
assert.strictEqual(env.stage, 'arch.direction');
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

// --- L2: the morphology macro-parameter space, scored against the default L1 contract --------
// The published grid above still decides the D-Gate (candidateCount / summary count unchanged), so
// the morphology table is additive. What it must be is COMPLETE and HONEST: every shape scored, its
// numbers traceable to the published point and the contract, and the contract read rather than
// restated.
const MORPH = require('../../integration/planning/morphology');
const morphology = score.morphology;
assert(morphology && Array.isArray(morphology.rows), 'the scorecard must carry the L2 morphology table; run `npm run model:planning`');
assert.strictEqual(morphology.candidateCount, morphology.rows.length);
assert.strictEqual(morphology.rows.length, MORPH.enumerate().length, 'the table must score exactly the enumerated space');
assert.deepStrictEqual(morphology.rows.map(r => r.morphologyId), MORPH.enumerate().map(r => r.morphologyId));

// The published grid is a subset of the space: a morphology at the published shape IS the grid slot,
// so the two tables are comparable instead of describing different hardware.
for (const mcTier of MORPH.MC_TIERS) {
  for (const tp of MORPH.TPS) {
    const id = `${RES.coreProfiles.P1.id}-${mcTier}-TP${tp}`;
    const row = morphology.rows.find(r => r.morphologyId === id);
    assert(row, `${id} must appear in the morphology table`);
    assert.strictEqual(row.axes.dies, 8, `${id} is the published shape, so it is the published 8-die package`);
    const grid = score.candidates.find(c => c.candidateId === id && c.modelId === 'K3');
    const morph = row.tpsPerModel.K3;
    assert(Math.abs(grid.tpsPerUser - morph.tpsPerUser) < 1e-9 * morph.tpsPerUser,
      `${id}: the published grid and the morphology table must agree on TPS/usr at the published shape (${grid.tpsPerUser} vs ${morph.tpsPerUser})`);
    assert.strictEqual(grid.bottleneck, morph.bound, `${id}: the two tables must agree on the bounding lane`);
  }
}

// Area and power come from the existing detailed basis, not a second model.
const BASIS = require('../../integration/detailed/k3_physical_basis');
const A = require('../../integration/detailed/k3_architecture_search');
for (const row of morphology.rows) {
  const r = row.physical;
  assert.strictEqual(r.basis, BASIS.BASIS.process);
  assert.strictEqual(r.cooling, BASIS.BASIS.cooling);
  assert(r.dieAreaMm2 > 0 && r.cardPowerW > 0 && r.packageAreaMm2 > 0);
  assert.strictEqual(r.feasible, r.reasons.length === 0);
  assert.strictEqual(r.limits.packageAreaMm2.max, BASIS.BASIS.limits.packageArea);
  // A die count that does not fit the placement window must be reported infeasible, not dropped:
  // "差多少" needs the number, and a silently missing shape reads as an option nobody considered.
  assert.strictEqual(r.limits.packageAreaMm2.satisfied, r.packageAreaMm2 <= BASIS.BASIS.limits.packageArea);
  assert.strictEqual(row.hardware.cubes, row.axes.dies * A.LIMITS.mcCountPerDie);
}

// Every axis of the L1 contract is checked, and a miss carries the shortfall.
assert.deepStrictEqual(morphology.rows[0].checks.map(c => c.id), morphology.contract.entries.map(e => e.id),
  'every contract entry must be checked, in the contract\'s own order');
for (const row of morphology.rows) {
  for (const c of row.checks) {
    const entry = morphology.contract.entries.find(e => e.id === c.id);
    assert(c.requirement.min !== null || c.requirement.max !== null, `${row.morphologyId}/${c.id}: a check must carry the bound it was tested against`);
    if (entry.min !== null) assert.strictEqual(c.requirement.min, entry.min, `${c.id}: the requirement is the contract's number, not a copy`);
    if (entry.max !== null) assert.strictEqual(c.requirement.max, entry.max);
    assert.strictEqual(c.satisfied, c.shortfall === 0, `${row.morphologyId}/${c.id}: a satisfied check has no shortfall and a miss has one`);
    if (!c.satisfied) assert(c.shortfall > 0, `${row.morphologyId}/${c.id}: a miss must say by how much`);
  }
  assert.deepStrictEqual(row.misses, row.checks.filter(c => !c.satisfied).map(c => ({id: c.id, shortfall: c.shortfall})));
}
// The contract is the DEFAULT split; if that changes, this table is being scored against the wrong
// budget and the failure should name the contract rather than leave a silently different table.
const MB = require('../../integration/pipelines/make_brief');
const frontier = read('out/requirements/budget_frontier.json');
assert.strictEqual(morphology.contract.splitId, MB.DEFAULT_SPLIT, 'the morphology table is scored against the default split; a different split needs a different table, not a different number here');
const sCmp = frontier.splits.find(s => s.splitId === MB.DEFAULT_SPLIT).contract;
assert.strictEqual(morphology.contract.targetTpsPerUser, sCmp.target.tpsPerUser);
assert.strictEqual(morphology.contract.architectureGateTpsPerUser, sCmp.target.architectureGate);
for (const e of sCmp.split) {
  const scored = morphology.contract.entries.find(x => x.id === e.id);
  assert(scored, `${e.id} is in the L1 contract and must be scored`);
  assert.strictEqual(scored.min, e.min === undefined ? null : e.min, `${e.id}: min`);
  assert.strictEqual(scored.max, e.max === undefined ? null : e.max, `${e.id}: max`);
}
// The baseline the whole table is measured from is the published RDMA point, and it is P1.
assert.deepStrictEqual(morphology.baseline.x, read('out/rdma/k3_rdma_final_tuning_results.json').search.best.x,
  'the morphology axes are measured from the published search:final point');
// And the area/power chain must reproduce the L1 contract's own published point -- B-AREA carries
// atPublishedSram precisely so the contract can be checked against the physical model instead of
// trusting it. If the morphology path did not land here, every "差多少" in the table would be the
// difference between two different models of the same die.
{
  const at = sCmp.split.find(e => e.id === 'B-AREA').atPublishedSram;
  const published = morphology.rows.find(r => r.morphologyId === 'P1-compact-MC640-TP32').physical;
  for (const [field, expected] of [['dieAreaMm2', at.dieAreaMm2], ['diePowerW', at.diePowerW], ['cardPowerW', at.cardPowerW]]) {
    assert(Math.abs(published[field] - expected) < 1e-6 * Math.abs(expected),
      `${field}: the morphology path gives ${published[field]} at the published shape but B-AREA.atPublishedSram says ${expected}; the physical model and the L1 contract disagree about the same die`);
  }
}
assert.strictEqual(MORPH.morphologyId(MORPH.shape()), 'P1-compact-MC640-TP32',
  'the published shape must keep the published id; only a deviation is tagged');
// A tagged id still parses back through the spec's three readers: stage_b.js resolves all three.
for (const row of morphology.rows) {
  assert.strictEqual(RES.tpOf(row.morphologyId), row.axes.tp, `${row.morphologyId}: tp must parse back`);
  assert.strictEqual(RES.mcProfileOf(row.morphologyId), row.axes.mcTier, `${row.morphologyId}: the MC tier must parse back`);
  assert.strictEqual(RES.physicalProfileOf(row.morphologyId), 'P1', `${row.morphologyId}: the profile id must parse back`);
}
// A morphology is never a coreProfiles entry: one hardware spec (ADR-0021). Its point travels on the slot.
for (const row of morphology.rows) {
  assert.strictEqual(score.resourceProfiles[row.morphologyId], undefined, 'a morphology must not be registered as a physical profile');
}

// --- L2_budget.json: the L1 contract refined one layer down ----------------------------------
const l2 = read('out/budget/L2_budget.json');
assert.strictEqual(l2.layer, 'L2');
assert.strictEqual(l2.schemaVersion, 'budget-contract-v0.1');
assert.strictEqual(l2.splitId, morphology.contract.splitId);
assert.strictEqual(l2.sourceContract.path, 'out/requirements/budget_frontier.json');
const shared = l2.split.find(e => e.id === 'L2-SRAM-SHARED');
const local = l2.split.find(e => e.id === 'L2-SRAM-LOCAL');
assert(shared && local, 'L2 refines B-SRAM-CAP into shared and local');
assert.strictEqual(shared.refines, 'B-SRAM-CAP');
assert.strictEqual(shared.min, sCmp.split.find(e => e.id === 'B-SRAM-CAP').min, 'the L2 shared floor IS the L1 entry, not a new number');
assert.strictEqual(shared.depth, sCmp.split.find(e => e.id === 'B-SRAM-CAP').depth);
// Every other L1 entry is carried as inherited, so no L1 number is restated at L2.
assert.deepStrictEqual(l2.inherited.map(e => e.id), sCmp.split.filter(e => e.id !== 'B-SRAM-CAP').map(e => e.id));
assert(l2.inherited.every(e => e.relationship === 'INHERITED' && e.layer === 'L1'));
assert.deepStrictEqual(l2.morphology.satisfiesEveryEntry, morphology.satisfiesEveryEntry);
assert.strictEqual(l2.morphology.bestByContract, morphology.bestByContract);

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
// The morphology table is a statement about a particular contract, scored by a particular model.
assert.strictEqual(score.inputHashes.l1Contract, hashFile('out/requirements/budget_frontier.json'),
  'scorecard predates the current budget frontier; run `npm run budget:frontier && npm run model:planning`');
assert.strictEqual(score.inputHashes.morphologyModel, hashFile('integration/planning/morphology.js'),
  'scorecard was generated with a different integration/planning/morphology.js; run `npm run model:planning`');
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

// Every Stage A artifact carries the same provenance (commit, manifest hash, seed, run id).
const sweepFile = read('out/direction/sensitivity_sweep.json');
for (const [name, doc] of [['scorecard', score], ['register', register], ['sweep', sweepFile]]) {
  const p = doc.provenance;
  assert(p && p.sourceCommit && p.manifestHash && Number.isFinite(p.seed) && p.runId && p.toolVersion && p.units, `${name} lacks provenance`);
  assert.deepStrictEqual(p, score.provenance, `${name} provenance differs from the scorecard`);
}
assert.strictEqual(score.provenance.runId, score.runId);
assert.strictEqual(sweepFile.sampleCount, score.sensitivitySweep.sampleCount);
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
  assert.strictEqual(r.planningTpsMeetsArchitectureGate, r.minTpsPerUser >= score.architectureGateTpsPerUser);
  if (r.formallyEligible) assert(expected !== null && expected >= 1.15 - 1e-9, `${r.candidateId} eligible but misses at the tau point estimate`);
}
// The planning-TPS comparison is not the architecture gate: the register carries the baseline's own status.
assert.strictEqual(register.selectionBasis.architectureGate.scope, 'PLANNING_TPS_ONLY');
assert.strictEqual(register.selectionBasis.architectureGate.baselineStatus, JSON.parse(fs.readFileSync(path.join(root, 'teams/hardware/inputs/k3_mc_baseline.json'), 'utf8')).acceptance.architectureGateStatus);
assert(/^not-met/.test(register.selectionBasis.architectureGate.baselineStatus) || ranking.every(r => !r.planningTpsMeetsArchitectureGate), 'a planning-TPS pass must not read as the gate passing while the baseline says not-met');
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
