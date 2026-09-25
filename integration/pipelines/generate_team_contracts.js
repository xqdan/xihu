'use strict';
/* Publish the three team contracts to out/contracts/ and bind their hashes in
 * the integration manifest.
 *
 * Each team owns its contract in teams/<team>/contract.json. This script adds
 * only computed fields: the model qualification counts, the hardware P1
 * core-class peak source (from teams/hardware/src/resource_profiles.js), the
 * contract hashes and the timing evidence status.
 */
const path=require('path');
process.chdir(path.resolve(__dirname,'../..'));
const fs=require('fs');
const crypto=require('crypto');
const qualificationPath='teams/model/inputs/model_manifest_qualification_matrix.json';
const qualification=JSON.parse(fs.readFileSync(qualificationPath,'utf8').replace(/^\uFEFF/,''));
const RES=require('../../teams/hardware/src/resource_profiles');
const IDS=require('../planning/run_ids');
const matrix=JSON.parse(fs.readFileSync('out/workload/tps_observation_matrix.json','utf8'));
const readTeam=team=>JSON.parse(fs.readFileSync(`teams/${team}/contract.json`,'utf8'));
const profileNote=id=>{const c=RES.coreProfiles[id];return `teams/hardware/src/resource_profiles.js (${c.lCoresPerDie}L+${c.hCoresPerDie}H, ${c.ghz} GHz; ${c.source})`;};
const contracts=readTeam('model');
Object.assign(contracts,{qualificationMatrix:qualificationPath,qualificationStatus:qualification.status,verifiedFieldCount:qualification.verifiedFieldCount,requiredFieldCount:qualification.requiredFieldCount});
contracts.blockers.push(`Model qualification matrix status: ${qualification.status}; ${qualification.verifiedFieldCount}/${qualification.requiredFieldCount} fields verified.`);
fs.writeFileSync('out/contracts/model_workload_contract.json',JSON.stringify(contracts,null,2)+'\n');
const hw=readTeam('hardware');
for(const id of Object.keys(hw.profiles))hw.profiles[id].coreClassPeakSource=profileNote(id);
fs.writeFileSync('out/contracts/hardware_resource_contract.json',JSON.stringify(hw,null,2)+'\n');
const sw=readTeam('software');
fs.writeFileSync('out/contracts/software_execution_contract.json',JSON.stringify(sw,null,2)+'\n');
const integration={schemaVersion:'integration-manifest-v0.1',status:'BLOCKED_PENDING_THREE_TEAM_ARTIFACTS',requiredTeams:['Hardware Team','Software Team','Model Team'],requiredAgents:['HW-01','HW-02','HW-03','HW-04','HW-05','HW-06','SW-01','SW-02','SW-03','SW-04','SW-05','SW-06','SW-07','MODEL-01','MODEL-02','MODEL-03','MODEL-04','MODEL-05','MODEL-06'],inputs:['out/contracts/model_workload_contract.json','out/contracts/hardware_resource_contract.json','out/contracts/software_execution_contract.json'],hashPolicy:'Every detailed run binds all three contract hashes; mismatch blocks integration.',gatePrerequisites:['verified model shapes','single hardware spec resource accounting','dependency-aware timing trace','VV-02 conservation report']};
integration.contractHashes=Object.fromEntries(integration.inputs.map(p=>[p,crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex')]));
integration.generatedAt=qualification.asOf;
fs.writeFileSync('out/contracts/integration_manifest.json',JSON.stringify(integration,null,2)+'\n');
const countStatus=st=>matrix.observations.filter(o=>o.status===st).length;
const evidence={schemaVersion:'timing-evidence-status-v0.1',asOf:IDS.RUN_DATE,current:'CALIBRATED_PLANNING_TOKEN_TIME',validatedSlots:0,planningSlots:countStatus('PLANNING_ESTIMATE'),blockedConfigSlots:countStatus('BLOCKED_CONFIG'),siliconSlots:0,qGate:'BLOCKED',exitCriteria:['validated model workload','memory/packet/kernel/schedule dependency trace','18 validated timed slots','independent VV-02/VV-03 report'],blockers:['Planning token time is calibrated on one K3 detailed point and is not event-timed; synthetic event records do not drive latency.','GLM-5.2 and DeepSeek-V4-Pro apply the K3-fitted factors as a planning ASSUMPTION.']};
fs.writeFileSync('out/verification/timing_evidence_status.json',JSON.stringify(evidence,null,2)+'\n');
