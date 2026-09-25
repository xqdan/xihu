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
// Every comparable slot is recomputed from the planning workload and the stored calibration.
const TT = require('../models/planning/token_time');
const workload = read('data/workload/planning_operator_workload.json');
for (const obs of matrix.observations) {
 const rows = detail.operatorLedger.filter(r=>r.modelId===obs.modelId && r.tp===obs.tp && r.mcProfile===obs.mcProfile && r.physicalProfile===obs.physicalProfile);
 assert.strictEqual(obs.manifestHash,detail.manifestHash);
 const model = TT.planningModel(workload,obs.modelId);
 if (!model) {
  assert.strictEqual(obs.status,'BLOCKED_CONFIG');
  assert.strictEqual(rows.length,0,'no ledger rows for a BLOCKED_CONFIG model');
  assert.strictEqual(obs.tpsPerUser,null);
  assert(obs.blocker);
  continue;
 }
 assert.strictEqual(rows.length,5);
 assert.strictEqual(obs.sourceSelector,`${rows[0].candidateId}#/model/${obs.modelId}/tp${obs.tp}/${obs.mcProfile}`);
 const t = TT.slotTime(model,{tp:obs.tp,physicalProfile:obs.physicalProfile,mcProfile:obs.mcProfile},workload.calibration);
 assert(Math.abs(obs.tpsPerUser-t.tpsPerUser)<1e-9*t.tpsPerUser);
 assert(Math.abs(obs.rawLatencyUsPerToken-t.rawUs)<1e-9*t.rawUs);
 assert(Math.abs(obs.tpsPerUser*obs.e2eLatencyUsPerToken-1e6)<1e-7);
 // The ledger carries the same per-operator lane inputs as the token time.
 assert(Math.abs(rows.reduce((x,r)=>x+r.computeTimeUs,0)-t.computeUs)<1e-9*t.computeUs);
 assert(Math.abs(rows.filter(r=>r.operatorClass!=='collective_reduce').reduce((x,r)=>x+r.memoryTimeUs,0)-t.memoryUs)<1e-9*t.memoryUs);
 assert(rows.some(r=>r.operatorId===obs.boundingOperatorId));
 assert.strictEqual(obs.boundingOperatorId,TT.boundingOperator(model,obs,t));
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
console.log('PASS planning evidence guards, mutation rejection, token-time recomputation of every comparable slot, BLOCKED_CONFIG slots without TPS, Roofline classification and dashboard freshness');
