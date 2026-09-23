'use strict';
const fs = require('fs');
const path = require('path');
const assert = require('assert');
const IDS = require('../models/planning/run_ids');
const root = path.resolve(__dirname, '..');
const read = p => JSON.parse(fs.readFileSync(path.join(root, p), 'utf8').replace(/^﻿/, ''));
const env = read('data/direction/directional_resource_envelope.json');
const workload = read('data/direction/directional_workload_baseline.json');
const score = read('data/direction/directional_tps_scorecard.json');
const register = read('data/governance/candidate_register.json');
const report = fs.readFileSync(path.join(root, IDS.stageAReport), 'utf8');
assert.strictEqual(env.stage, 'direction');
assert.strictEqual(env.runId, IDS.stageARunId);
assert.strictEqual(env.models.length, 3);
assert.strictEqual(env.packageEnvelope.areaConservation, true);
assert.strictEqual(workload.models.find(item => item.modelId === 'K3').status, 'CALIBRATED_DIRECTIONAL_BASELINE');
assert.strictEqual(score.runId, IDS.stageARunId);
assert.strictEqual(score.candidateCount, 36);
assert.strictEqual(score.candidateSummaries.length, 12);
assert(score.candidateSummaries.every(item => item.accountedModelCount === 3));
assert(score.candidateSummaries.every(item => item.rankingEligible === true));

// P0 and P1 capacities must each be derived from their own spec file. Equality of a
// single core class is allowed (the search may pick the same H shape); what is
// forbidden is copying one profile's numbers into the other.
const packageSpec = read('docs/design/spec/k3_7r_package_baseline.json');
const mcSpec = read('docs/design/spec/k3_mc_baseline.json');
const RES = require('../models/planning/resource_profiles');
const peak = (shape, cores, ghz) => cores * shape.engines * shape.rows * shape.cols * 2 * ghz * 1e9 * 8;
const p0 = score.resourceProfiles.P0, p1 = score.resourceProfiles.P1;
assert.strictEqual(p0.lCoresPerDie, packageSpec.compute.lCoresPerDie);
assert.strictEqual(p0.hCoresPerDie, packageSpec.compute.hCoresPerDie);
assert.strictEqual(p0.ghz, packageSpec.compute.frequencyGHzCandidate);
assert.strictEqual(p0.peakByCore.L, peak(RES.P0_ENGINE.L, p0.lCoresPerDie, p0.ghz));
assert.strictEqual(p0.peakByCore.H, peak(RES.P0_ENGINE.H, p0.hCoresPerDie, p0.ghz));
const cand = mcSpec.computeDieCandidate;
assert.strictEqual(p1.lCoresPerDie, cand.lCores);
assert.strictEqual(p1.hCoresPerDie, cand.hCores);
assert.strictEqual(p1.ghz, cand.frequencyGHz);
assert.deepStrictEqual(p1.engine.L, {engines: cand.lCore.tensorEngines, rows: cand.lCore.tensorShape[0], cols: cand.lCore.tensorShape[1]});
assert.deepStrictEqual(p1.engine.H, {engines: cand.hCore.tensorEngines, rows: cand.hCore.tensorShape[0], cols: cand.hCore.tensorShape[1]});
// P1 package peak must be the searched candidate's die peak x 8, not a stale engine shape.
assert(Math.abs((p1.peakByCore.L + p1.peakByCore.H) / 8 / 1e12 - cand.bf16DenseTflops) < 1e-6, 'P1 peak must match k3_mc_baseline.json; rerun npm run model:planning');
assert.deepStrictEqual(score.resourceProfiles, JSON.parse(JSON.stringify(Object.fromEntries(Object.entries(RES.coreProfiles).map(([k, v]) => [k, {id: v.id, lCoresPerDie: v.lCoresPerDie, hCoresPerDie: v.hCoresPerDie, ghz: v.ghz, engine: v.engine, peakByCore: v.peakByCore, source: v.source}])))), 'scorecard resource profiles are stale; rerun npm run model:planning');
const p0k3 = score.candidates.find(c => c.candidateId === 'P0-7R-balanced-MC640-TP32' && c.modelId === 'K3');
const p1k3 = score.candidates.find(c => c.candidateId === 'P1-compact-MC640-TP32' && c.modelId === 'K3');
assert(p0k3 && p1k3);
assert.strictEqual(p0k3.workloadUnits.effectiveFlopsPerSecond, p0.peakByCore[score.candidates.find(c => c === p0k3).workloadUnits.computeOperatorId === 'attention' ? 'H' : 'L'] * 0.6 * 0.85);

// D-Gate is recomputed by the validator, and the register state is derived from it.
const {evaluateDirectionGate} = require('../models/governance/evaluate_gates');
const recomputed = evaluateDirectionGate(env, score, register);
assert.deepStrictEqual(score.dGate, recomputed, 'scorecard dGate must equal the validator result');
assert.strictEqual(register.decisionSource, 'models/governance/evaluate_gates.js#evaluateDirectionGate');
assert.strictEqual(register.decisionState, recomputed.decision === 'PASS' ? 'D_GATE_PASSED' : 'D_GATE_BLOCKED');
assert.strictEqual(recomputed.registerConsistent, true);
assert(register.formalSelectedCandidates.length <= 3);
if (recomputed.decision === 'PASS') {
  assert.strictEqual(register.formalSelectedCandidates.length, 3);
  // Selection policy is machine-applied: two best by worst-model bound plus the best MC320 reference.
  const byBound = (a, b) => b.minTpsPerUser - a.minTpsPerUser || a.candidateId.localeCompare(b.candidateId);
  const ranking = register.selectionBasis.ranking;
  assert.deepStrictEqual(ranking.map(r => r.candidateId), score.candidateSummaries.slice().sort(byBound).map(s => s.candidateId));
  assert.deepStrictEqual(register.formalSelectedCandidates.slice(0, 2), ranking.slice(0, 2).map(r => r.candidateId));
  assert(register.formalSelectedCandidates.some(id => id.includes('MC320')), 'MC320 reference candidate must be retained');
  assert.deepStrictEqual(score.selectedCandidateIds, register.formalSelectedCandidates);
} else {
  assert.deepStrictEqual(register.formalSelectedCandidates, []);
}
assert(report.includes('D-Gate'));
assert(report.includes(IDS.stageARunId));
console.log(`PASS stage A directional run: P0/P1 distinct resources, validator-computed D-Gate (${recomputed.decision}) and policy-derived candidate selection`);
