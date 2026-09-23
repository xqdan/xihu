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

// P0 and P1 must carry distinct core-class capacities in the scorecard, sourced from the two spec files.
const packageSpec = read('docs/design/spec/k3_7r_package_baseline.json');
const mcSpec = read('docs/design/spec/k3_mc_baseline.json');
assert.notStrictEqual(score.resourceProfiles.P0.peakByCore.L, score.resourceProfiles.P1.peakByCore.L);
assert.notStrictEqual(score.resourceProfiles.P0.peakByCore.H, score.resourceProfiles.P1.peakByCore.H);
assert.strictEqual(score.resourceProfiles.P0.lCoresPerDie, packageSpec.compute.lCoresPerDie);
assert.strictEqual(score.resourceProfiles.P0.ghz, packageSpec.compute.frequencyGHzCandidate);
assert.strictEqual(score.resourceProfiles.P1.lCoresPerDie, mcSpec.computeDieCandidate.lCores);
assert.strictEqual(score.resourceProfiles.P1.ghz, mcSpec.computeDieCandidate.frequencyGHz);
// P1 package peak must be the searched candidate's die peak x 8, not a stale engine shape.
assert(Math.abs((score.resourceProfiles.P1.peakByCore.L + score.resourceProfiles.P1.peakByCore.H) / 8 / 1e12 - mcSpec.computeDieCandidate.bf16DenseTflops) < 1e-6, 'P1 peak must match k3_mc_baseline.json');
const p0k3 = score.candidates.find(c => c.candidateId === 'P0-7R-balanced-MC640-TP32' && c.modelId === 'K3');
const p1k3 = score.candidates.find(c => c.candidateId === 'P1-compact-MC640-TP32' && c.modelId === 'K3');
assert.notStrictEqual(p0k3.computeTimeUs, p1k3.computeTimeUs, 'P0 and P1 compute time must differ');

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
