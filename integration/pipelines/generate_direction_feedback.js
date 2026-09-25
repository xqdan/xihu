'use strict';
/* Generate out/governance/direction_feedback.json: the Stage B -> Stage A backflow
 * (open blockers and the best planning estimate per model). Runs before the dashboard,
 * which renders the blockers from this file.
 *
 * Run: node integration/pipelines/generate_direction_feedback.js
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const root = path.resolve(__dirname, '../..');
const read = p => JSON.parse(fs.readFileSync(path.join(root,p),'utf8').replace(/^﻿/,''));
const sources = ['out/governance/gate_status.json','out/detailed/detailed_architecture_run.json','out/workload/tps_observation_matrix.json','out/direction/sensitivity_sweep.json','out/contracts/model_workload_contract.json','out/contracts/hardware_resource_contract.json','out/contracts/software_execution_contract.json','out/contracts/integration_manifest.json','out/verification/timing_evidence_status.json'];
const detail = read('out/detailed/detailed_architecture_run.json');
const matrix = read('out/workload/tps_observation_matrix.json');
sources.push(read('out/contracts/model_workload_contract.json').qualificationMatrix);
const hashes = Object.fromEntries(sources.map(p=>[p,crypto.createHash('sha256').update(fs.readFileSync(path.join(root,p))).digest('hex')]));
const blockers = [
 {id:'Q1-Q2',priority:'P0',issue:'GLM-5.2 deployment layout (KV/index-key bytes, collectives per layer) and DeepSeek-V4-Pro shape rest on ASSUMPTION fields; K3 rows come from the engineering preset',exit:'vendor config for DeepSeek-V4-Pro; confirmed GLM-5.2 serving layout; FLOP/byte reconciliation'},
 {id:'Q3-Q6/Q8',priority:'P0',issue:'Synthetic events do not drive token latency',exit:'Dependency/resource-aware timeline; cycle, byte, packet conservation; 18 timed slots'},
 {id:'Q7/D3',priority:'P0',issue:'P1 core-class peaks come from the spec but utilization, duty cycle and PPA are not activity-validated',exit:'Per-die/package/core-class resource accounting, area and activity-bound power'},
 {id:'D2-D6',priority:'P1',issue:'Sweep only covers K3 at the calibration slot and five numerical axes; the token-time factors are fitted on K3 only',exit:'Extend model/profile coverage; calibrate on a second detailed point; add physical area/power sensitivity'},
 {id:'D7/Q9',priority:'P0',issue:'1000 TPS/user target not established by validated timing',exit:'Calibrated operator ledger, validated timing and feasible P1 package resource envelope'}
];
const feedback={schemaVersion:'architecture-backflow-v0.1',runId:detail.runId,status:'OPEN',evidenceKind:detail.evidenceKind,targetTpsPerUser:matrix.metric.targetTpsPerUser,sourceHashes:hashes,blockers,models:matrix.requiredCoverage.models.map(modelId=>{const rows=matrix.observations.filter(x=>x.modelId===modelId&&x.status!=='BLOCKED_CONFIG');if(!rows.length)return {modelId,status:'BLOCKED_CONFIG',bestPlanningEstimate:null,gapFactor:null,note:'No config, no TPS.'};const best=rows.reduce((a,b)=>a.tpsPerUser>b.tpsPerUser?a:b);return {modelId,status:'PLANNING_ESTIMATE',bestPlanningEstimate:best.tpsPerUser,gapFactor:matrix.metric.targetTpsPerUser/best.tpsPerUser,caseId:best.observationId,note:'K3-calibrated planning token time on the matrix slots; gap is not a hardware sizing recommendation.'};})};
fs.writeFileSync(path.join(root,'out/governance/direction_feedback.json'),JSON.stringify(feedback,null,2)+'\n');
console.log(`Generated out/governance/direction_feedback.json: ${blockers.length} blockers, ${feedback.models.length} models`);
