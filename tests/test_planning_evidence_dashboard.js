'use strict';
const assert = require('assert');
const fs = require('fs');
const crypto = require('crypto');
const read = p => JSON.parse(fs.readFileSync(p,'utf8').replace(/^﻿/,''));
const {evaluateQuantificationGate, observationCoverage, evaluateDirectionGate} = require('../models/governance/evaluate_gates');
const detail = read('data/detailed/detailed_architecture_run.json');
const matrix = read('data/workload/tps_observation_matrix.json');
const register = read('data/governance/candidate_register.json');
const score = read('data/direction/directional_tps_scorecard.json');
const env = read('data/direction/directional_resource_envelope.json');
const clone = x => JSON.parse(JSON.stringify(x));
// Mutation tests: the validator must reject tampered inputs.
assert.notStrictEqual(evaluateDirectionGate(env,score,{...register,formalSelectedCandidates:[]}).decision,'PASS');
assert.notStrictEqual(evaluateDirectionGate(env,score,{...register,formalSelectedCandidates:['NOT-A-CANDIDATE']}).decision,'PASS');
assert.notStrictEqual(evaluateDirectionGate({...env,packageEnvelope:{...env.packageEnvelope,areaConservation:false}},score,register).decision,'PASS');
assert.notStrictEqual(evaluateDirectionGate(env,{...score,sensitivitySweep:{complete:false}},register).decision,'PASS');
// A register that claims PASS while the artifacts do not support it is flagged.
assert.strictEqual(evaluateDirectionGate(env,{...score,sensitivitySweep:{complete:false}},{...register,decisionState:'D_GATE_PASSED'}).registerConsistent,false);
const duplicate = clone(matrix);
duplicate.observations[1] = clone(duplicate.observations[0]);
assert.strictEqual(observationCoverage(duplicate).uniqueCoverage,false);
const fake = clone(detail);
fake.runMode = 'FORMAL_QUANTIFICATION';
for (const agent of Object.values(fake.agentRuns)) agent.status = 'COMPLETE';
assert.notStrictEqual(evaluateQuantificationGate(fake,matrix,register,{decision:'PASS'}).decision,'PASS');
const sharedCapacity = clone(detail);
sharedCapacity.sizing.availableResources.P0 = clone(sharedCapacity.sizing.availableResources.P1);
assert.strictEqual(evaluateQuantificationGate(sharedCapacity,matrix,register,{decision:'PASS'}).p0P1DistinctResources,false);
for (const row of detail.operatorLedger) {
 assert.strictEqual(row.rooflineBound,row.arithmeticIntensity < row.ridgePoint ? 'bandwidth' : 'compute');
}
for (const obs of matrix.observations) {
 const rows = detail.operatorLedger.filter(r=>r.modelId===obs.modelId && r.tp===obs.tp && r.mcProfile===obs.mcProfile && r.physicalProfile===obs.physicalProfile);
 assert.strictEqual(rows.length,5);
 assert.strictEqual(obs.sourceSelector,`${rows[0].candidateId}#/model/${obs.modelId}/tp${obs.tp}/${obs.mcProfile}`);
 assert.strictEqual(obs.manifestHash,detail.manifestHash);
 const ratio = Math.max(...rows.map(r=>Math.max(r.requiredToAvailableRatio,r.requiredToAvailableBandwidthRatio)));
 assert(Math.abs(obs.tpsPerUser-detail.sizing.targetTpsPerUser/ratio)<1e-10);
 assert(Math.abs(obs.tpsPerUser*obs.e2eLatencyUsPerToken-1e6)<1e-7);
 assert(rows.some(r=>r.operatorId===obs.boundingOperatorId));
}
const html = fs.readFileSync('reports/dashboard/architecture_global_dashboard.html','utf8');
const match = html.match(/<script id="dashboard-source-hashes" type="application\/json">([^<]+)<\/script>/);
assert(match,'Missing machine source hashes');
for (const [p,h] of Object.entries(JSON.parse(match[1]))) {
 assert.strictEqual(crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex'),h,`Stale dashboard: ${p}; run npm run dashboard`);
}
const feedback = read('data/governance/direction_feedback.json');
assert.strictEqual(feedback.runId,detail.runId);
assert.strictEqual(feedback.blockers.length,5);
assert(feedback.blockers.every(b=>b.id && b.exit));
assert(!html.includes('28.05×') && !html.includes('167.06×'));
console.log('PASS planning evidence guards, mutation rejection, exact slot/ledger linkage, Roofline classification and dashboard freshness');
