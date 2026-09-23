'use strict';
/* DEPRECATED (2026-09-23): superseded by models/formal_detailed_run.js.
 * This exploratory Stage B runner predates the validator-computed D-Gate and
 * the shape-derived planning workload; it overwrites the same artifacts with an
 * older run id. Kept for history only; do not run it as part of the pipeline. */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const {execFileSync} = require('child_process');
const {writeGateStatus} = require('./governance/evaluate_gates');

const root = path.resolve(__dirname, '..');
const read = relativePath => JSON.parse(fs.readFileSync(path.join(root, relativePath), 'utf8').replace(/^\uFEFF/, ''));
const write = (relativePath, value) => {
  const target = path.join(root, relativePath);
  fs.mkdirSync(path.dirname(target), {recursive: true});
  fs.writeFileSync(target, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
};
const sha256 = relativePath => crypto.createHash('sha256').update(fs.readFileSync(path.join(root, relativePath))).digest('hex');
const score = read('data/direction/directional_tps_scorecard.json');
const profiles = read('data/workload/model_profiles.json');
const matrix = read('data/workload/tps_observation_matrix.json');
const register = read('data/governance/candidate_register.json');
const reportDate = '20260921';
const runId = `stage-b-${reportDate}`;
const selected = register.exploratorySweeps[0].candidateIds;
const runMode = 'EXPLORATORY_AFTER_BLOCKED_D_GATE';
const targetTps = profiles.policy.sharedDecodeTargetTpsPerUser;
const utilization = 0.6;
const dutyCycle = 0.85;
const mc320EffectiveBandwidth = 5.12e12 * 0.7;
const networkEffectiveBandwidth = 0.8e12;

const available = {
  L: {scope: 'package_rank', engines: 32, peakFlops: 157.2864e12},
  H: {scope: 'package_rank', engines: 32, peakFlops: 1258.2912e12},
  V: {scope: 'package_rank', engines: 64, peakFlops: 78.6432e12},
  INDEXER: {scope: 'package_rank', engines: 64, peakFlops: 78.6432e12},
  REDUCE: {scope: 'package_rank', engines: 64, peakFlops: 78.6432e12}
};

const opTemplates = {
  K3: [
    ['dense_projection', 'L', 4.0e12, 1.07e12, 'weight'],
    ['routed_moe', 'L', 18.0e12, 4.79e12, 'expert'],
    ['attention', 'H', 6.0e12, 1.90e12, 'kv_state'],
    ['kda_state', 'V', 0.8e12, 0.35e12, 'kv_state'],
    ['collective_reduce', 'REDUCE', 0.2e12, 0.08e12, 'collective']
  ],
  'GLM-5.2': [
    ['dense_projection', 'L', 4.5e12, 1.20e12, 'weight'],
    ['routed_moe', 'L', 22.0e12, 5.86e12, 'expert'],
    ['indexer', 'INDEXER', 2.0e12, 0.60e12, 'index'],
    ['sparse_attention', 'H', 5.0e12, 1.65e12, 'kv_state'],
    ['collective_dispatch', 'REDUCE', 0.3e12, 0.12e12, 'collective']
  ],
  'DeepSeek-V4-Pro': [
    ['dense_projection', 'L', 5.2e12, 1.39e12, 'weight'],
    ['routed_moe', 'L', 25.0e12, 6.83e12, 'expert'],
    ['indexer', 'INDEXER', 3.0e12, 0.85e12, 'index'],
    ['sparse_attention', 'H', 7.0e12, 2.30e12, 'kv_state'],
    ['expert_dispatch', 'REDUCE', 0.5e12, 0.20e12, 'collective']
  ]
};

const rows = [];
const blocked = [];
for (const model of profiles.profiles) {
  for (const tp of [8, 16, 32]) {
    const candidateId = selected.find(id => id.endsWith(`-TP${tp}`));
    if (model.id !== 'K3') {
      blocked.push({runId, stage: 'quantification', agentId: 'Q1', candidateId, modelId: model.id, tp, cp: 1, ep: 1, physicalProfile: 'P0', mcProfile: 'MC320', status: 'BLOCKED_CONFIG', confidence: 'E0', reason: 'formal layer/dtype/expert/state/index manifest is not frozen'});
      continue;
    }
    for (const [operatorId, core, flops, bytes, byteClass] of opTemplates[model.id]) {
      const shardFlops = flops / tp;
      const shardBytes = bytes / tp;
      const intensity = shardFlops / shardBytes;
      const bandwidth = byteClass === 'collective' ? networkEffectiveBandwidth : mc320EffectiveBandwidth;
      const peak = available[core].peakFlops;
      const ridge = peak / bandwidth;
      const roof = Math.min(peak, intensity * bandwidth);
      const requiredEffectiveFlops = shardFlops * targetTps;
      const requiredPeakFlops = requiredEffectiveFlops / (utilization * dutyCycle);
      const requiredMemoryBandwidth = shardBytes * targetTps;
      const availableMemoryBandwidth = bandwidth;
      const requiredNetworkBandwidth = byteClass === 'collective' ? shardBytes * targetTps : 0;
      const availableNetworkBandwidth = byteClass === 'collective' ? networkEffectiveBandwidth : 0;
      rows.push({
        runId, stage: 'quantification', agentId: 'Q2', sourceDirectionalCandidateStatus: score.candidates.find(item => item.candidateId === candidateId && item.modelId === model.id)?.status || 'MISSING_DIRECTIONAL_CANDIDATE',
        candidateId, modelId: model.id, phase: 'decode', tp, cp: 1, ep: 1, physicalProfile: 'P0', mcProfile: 'MC320',
        operatorId, operatorClass: operatorId, coreClass: core,
        flops: shardFlops, bytes: {[byteClass]: shardBytes, total: shardBytes}, arithmeticIntensity: intensity,
        networkIntensity: byteClass === 'collective' ? shardFlops / (shardBytes * 1.25) : intensity,
        ridgePoint: ridge, rooflineBound: roof < intensity * bandwidth ? 'bandwidth' : 'compute', rooflinePerformance: roof,
        requiredEffectiveFlops, requiredPeakFlops, availablePeakFlops: peak, requiredToAvailableRatio: requiredPeakFlops / peak,
        requiredMemoryBandwidth, availableMemoryBandwidth, requiredToAvailableBandwidthRatio: requiredMemoryBandwidth / availableMemoryBandwidth,
        requiredNetworkBandwidth, availableNetworkBandwidth, requiredToAvailableNetworkRatio: availableNetworkBandwidth ? requiredNetworkBandwidth / availableNetworkBandwidth : 0,
        confidence: 'E1', status: 'PLANNING_ESTIMATE', assumptions: ['K3 operator values are planning ledger inputs pending formal layer manifest', 'MC320 effective bandwidth is 5.12 TB/s raw × 0.70 sustained = 3.584 TB/s', 'utilization=0.6 and duty_cycle=0.85 are explicit sizing assumptions', 'Q3-Q7 event replay is not implemented']
      });
    }
  }
}

const byModel = {};
for (const row of rows) (byModel[row.modelId] ??= []).push(row);
const summary = Object.entries(byModel).map(([modelId, modelRows]) => {
  const worstCompute = modelRows.reduce((a, b) => a.requiredToAvailableRatio > b.requiredToAvailableRatio ? a : b);
  const worstBandwidth = modelRows.reduce((a, b) => a.requiredToAvailableBandwidthRatio > b.requiredToAvailableBandwidthRatio ? a : b);
  return {modelId, operatorCount: modelRows.length, maxRequiredToAvailableRatio: worstCompute.requiredToAvailableRatio, worstOperator: worstCompute.operatorId, worstCore: worstCompute.coreClass, maxRequiredToAvailableBandwidthRatio: worstBandwidth.requiredToAvailableBandwidthRatio, worstBandwidthOperator: worstBandwidth.operatorId, status: 'PLANNING_ESTIMATE', confidence: 'E1'};
});

const agentRuns = {
  Q1: {status: 'PARTIAL', output: 'manifest status and blocked-case ledger'},
  Q2: {status: 'PLANNING_COMPLETE', output: 'K3 arithmetic intensity, Roofline, compute/bandwidth/network sizing ledger'},
  Q3: {status: 'BLOCKED_UPSTREAM', output: null, blocker: 'formal manifest and tile event contract pending'},
  Q4: {status: 'BLOCKED_UPSTREAM', output: null, blocker: 'formal manifest and packet event contract pending'},
  Q5: {status: 'BLOCKED_UPSTREAM', output: null, blocker: 'Q3/Q4 event streams pending'},
  Q6: {status: 'BLOCKED_UPSTREAM', output: null, blocker: 'Q5 kernel cycle model pending'},
  Q7: {status: 'BLOCKED_UPSTREAM', output: null, blocker: 'PPA reconciliation pending'},
  Q8: {status: 'BLOCKED_UPSTREAM', output: null, blocker: 'Q1-Q7 provenance closure pending'},
  Q9: {status: 'Q_GATE_BLOCKED', output: 'independent validator required'}
};
const sourceCommit = (() => { try { return execFileSync('git', ['rev-parse', 'HEAD'], {cwd: root, encoding: 'utf8'}).trim(); } catch { return 'WORKTREE'; } })();
const inputHashes = {'directional_scorecard': sha256('data/direction/directional_tps_scorecard.json'), 'model_profiles': sha256('data/workload/model_profiles.json'), 'observation_matrix': sha256('data/workload/tps_observation_matrix.json')};
const out = {
  schemaVersion: 'detailed-architecture-run-v0.2', runId, stage: 'quantification', runMode, agentId: 'Q1-Q9-orchestrator', sourceDirectionalRunId: score.runId,
  selectedCandidates: selected, candidateSelection: {source: 'data/governance/candidate_register.json', formal: false, exploratory: true, decision: register.decisionState},
  manifestStatus: {K3: 'PLANNING_MANIFEST', 'GLM-5.2': 'BLOCKED_CONFIG', 'DeepSeek-V4-Pro': 'BLOCKED_CONFIG'},
  operatorLedger: rows, blockedCases: blocked, summary, agentRuns,
  observationMatrix: {requiredSlots: matrix.requiredCoverage.minimumObservations, accountedSlots: matrix.observations.length, all18SlotsAccounted: matrix.observations.length === 18, status: 'PENDING_MODEL_RUN_OR_BLOCKED_CONFIG'},
  provenance: {sourceCommit, manifestHash: null, inputHashes, seed: null, toolVersion: 'node-18-stage-b-v0.2'},
  sizing: {targetTpsPerUser: targetTps, utilizationAssumption: utilization, dutyCycleAssumption: dutyCycle, availablePeakFlops: Object.fromEntries(Object.entries(available).map(([key, value]) => [key, value.peakFlops])), availableResources: available, effectiveMemoryBandwidth: mc320EffectiveBandwidth, networkEffectiveBandwidth: networkEffectiveBandwidth},
  qGate: {manifestCompleteOrBlocked: true, tp8Tp16Tp32Executable: true, sharedManifestAcrossRooflineAndReplay: false, p0P1Separated: true, mc320Mc640Separated: true, provenanceComplete: false, all18SlotsAccounted: true, observationMatrixCompleteOrBlocked: false, allSlotProvenanceValid: false, allObservedSlotsReplayable: false, decision: 'BLOCKED_BY_D_GATE_MANIFEST_EVENT_MODEL_AND_PROVENANCE'},
  assumptions: ['This is an exploratory Stage B TP sweep after a blocked D-Gate, not formal quantification.', 'Only K3 emits a planning operator ledger; GLM-5.2 and DeepSeek-V4-Pro remain blocked.', 'Q3-Q7 event-level models and Q8 fine TPS are not emitted.', 'All sizing ratios are independently recomputable from the ledger fields.'],
  nextActions: ['Q1 freeze formal manifests for all three models', 'Q3 generate tile/memory events', 'Q4 generate packet/collective events', 'Q5 generate kernel cycles', 'Q6 generate schedule/overlap events', 'Q7 generate PPA reconciliation', 'Q8 emit fine TPS only after Q1-Q7 provenance closure', 'Q9 rerun independent gate validator']
};
write('data/detailed/detailed_architecture_run.json', out);
fs.mkdirSync(path.join(root, 'reports/detailed'), {recursive: true});
const summaryRows = summary.map(item => `| ${item.modelId} | ${item.operatorCount} | ${item.maxRequiredToAvailableRatio.toFixed(2)} | ${item.maxRequiredToAvailableBandwidthRatio.toFixed(2)} | ${item.worstOperator} | ${item.worstBandwidthOperator} |`).join('\n');
const ledgerRows = rows.map(row => `| TP${row.tp} | ${row.operatorId} | ${row.coreClass} | ${row.arithmeticIntensity.toFixed(2)} | ${row.ridgePoint.toFixed(2)} | ${row.rooflineBound} | ${(row.requiredPeakFlops / 1e12).toFixed(1)} | ${(row.availablePeakFlops / 1e12).toFixed(1)} | ${row.requiredToAvailableRatio.toFixed(2)} | ${(row.requiredMemoryBandwidth / 1e12).toFixed(2)} | ${(row.availableMemoryBandwidth / 1e12).toFixed(2)} | ${row.requiredToAvailableBandwidthRatio.toFixed(2)} |`).join('\n');
const blockedRows = blocked.map(item => `| ${item.modelId} | TP${item.tp} | ${item.status} | ${item.reason} |`).join('\n');
const report = `# Stage B Detailed Architecture Exploratory Run\n\nRun ID: \`${runId}\`\nSource Stage A Run ID: \`${out.sourceDirectionalRunId}\`\nRun mode: \`${runMode}\`\nStatus: \`Q-GATE BLOCKED\`\n\n## 1. Governance\n\nStage A D-Gate is blocked. This run is authorized only by ADR-0001 as an exploratory P0/MC320 TP8/TP16/TP32 sweep. It is not formal candidate selection and emits no fine TPS sign-off.\n\nSelected sweep source: \`data/governance/candidate_register.json\`.\n\n## 2. Agent execution\n\n| Agent | Status | Output/blocker |\n|---|---|---|\n${Object.entries(agentRuns).map(([id, item]) => `| ${id} | ${item.status} | ${item.output || item.blocker || ''} |`).join('\n')}\n\n## 3. K3 Q2 Roofline and sizing ledger\n\n| TP | Operator | Core | AI FLOP/B | Ridge FLOP/B | Bound | Req peak TFLOP/s | Available TFLOP/s | Compute ratio | Req BW TB/s | Available BW TB/s | BW ratio |\n|---|---|---|---:|---:|---|---:|---:|---:|---:|---:|---:|\n${ledgerRows}\n\n## 4. Model summary\n\n| Model | Operators | Max compute ratio | Max bandwidth ratio | Worst compute op | Worst bandwidth op |\n|---|---:|---:|---:|---|---|\n${summaryRows}\n\n## 5. Blocked models\n\n| Model | TP | Status | Reason |\n|---|---:|---|---|\n${blockedRows}\n\n## 6. Observation matrix and provenance\n\n- 18 required slots accounted: **${out.observationMatrix.all18SlotsAccounted ? 'yes' : 'no'}**.\n- Matrix is complete or explicitly blocked: **no**; the 16 pending slots are not yet terminal blocked-config observations.\n- Provenance complete: **no**; manifestHash and seed are intentionally missing.\n- Source commit: \`${sourceCommit}\`.\n\n## 7. Q-Gate\n\nThe independent validator must keep the Q-Gate blocked until D-Gate, formal manifests, shared Q3-Q7 event streams, fine TPS, provenance and matrix closure are complete.\n\n## 8. Artifacts\n\n\`\`\`text\ndata/detailed/detailed_architecture_run.json\ndata/governance/gate_status.json\nreports/detailed/stage_b_detailed_run_${reportDate}.md\n\`\`\`\n`;
fs.writeFileSync(path.join(root, `reports/detailed/stage_b_detailed_run_${reportDate}.md`), report, 'utf8');
const gateStatus = writeGateStatus();
out.qGate = gateStatus.quantificationGate;
write('data/detailed/detailed_architecture_run.json', out);
console.log(JSON.stringify({runId, rows: rows.length, blocked: blocked.length, selected, runMode, qGate: out.qGate}, null, 2));
