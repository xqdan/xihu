'use strict';
const assert=require('assert');const fs=require('fs');
const read=p=>JSON.parse(fs.readFileSync(p,'utf8').replace(/^\uFEFF/,''));
const model=read('data/contracts/model_workload_contract.json');
const hw=read('data/contracts/hardware_resource_contract.json');
const sw=read('data/contracts/software_execution_contract.json');
const integration=read('data/contracts/integration_manifest.json');
for(const c of [model,hw,sw]){assert(c.schemaVersion);assert(c.status);assert(c.ownerTeam);assert(Array.isArray(c.outputs)&&c.outputs.length>0);assert(Array.isArray(c.blockers));}
assert.deepStrictEqual(model.dimensions.models,['K3','GLM-5.2','DeepSeek-V4-Pro']);assert.deepStrictEqual(model.dimensions.tp,[8,16,32]);assert.deepStrictEqual(Object.keys(hw.profiles).sort(),['P0','P1']);assert(sw.strategies.includes('communication-computation overlap'));assert.strictEqual(integration.requiredTeams.length,3);assert(integration.inputs.length>=3);assert(integration.gatePrerequisites.length>=4);
const evidence=read('data/verification/timing_evidence_status.json');assert.strictEqual(evidence.current,'CALIBRATED_PLANNING_TOKEN_TIME');const matrix=read('data/workload/tps_observation_matrix.json');assert.strictEqual(evidence.planningSlots,matrix.observations.filter(o=>o.status==='PLANNING_ESTIMATE').length);assert.strictEqual(evidence.blockedConfigSlots,matrix.observations.filter(o=>o.status==='BLOCKED_CONFIG').length);assert.strictEqual(evidence.planningSlots+evidence.blockedConfigSlots,matrix.observations.length);assert.strictEqual(evidence.validatedSlots,0);assert.strictEqual(evidence.qGate,'BLOCKED');assert(evidence.exitCriteria.length>=4);
console.log('PASS cross-team contracts: model, hardware, software, integration and evidence boundaries are explicit');
