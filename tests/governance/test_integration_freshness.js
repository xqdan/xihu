'use strict';
const assert=require('assert');const fs=require('fs');const crypto=require('crypto');const read=p=>JSON.parse(fs.readFileSync(p,'utf8').replace(/^\uFEFF/,''));
const i=read('out/contracts/integration_manifest.json');assert(i.contractHashes);for(const [p,h] of Object.entries(i.contractHashes)){assert.strictEqual(crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex'),h,`stale contract hash ${p}`)}
const expectedInputs=['out/contracts/model_workload_contract.json','out/contracts/hardware_resource_contract.json','out/contracts/software_execution_contract.json'];assert.deepStrictEqual(i.inputs,expectedInputs);assert.deepStrictEqual(Object.keys(i.contractHashes).sort(),[...expectedInputs].sort());assert.strictEqual(i.generatedAt,read('teams/model/inputs/model_manifest_qualification_matrix.json').asOf);
const e=read('out/verification/timing_evidence_status.json');assert.strictEqual(e.qGate,'BLOCKED');assert.strictEqual(e.validatedSlots,0);assert(e.blockers.length>0);
const gate=read('out/governance/gate_status.json');assert.strictEqual(gate.quantificationGate.decision,'BLOCKED_BY_D_GATE_MANIFEST_EVENT_MODEL_AND_PROVENANCE');assert.strictEqual(gate.quantificationGate.evidenceKind,'CALIBRATED_PLANNING_TOKEN_TIME');
console.log('PASS integration freshness and blocker guard: contract hashes, evidence state and Q-Gate block are enforced');
