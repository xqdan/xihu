'use strict';
/* DEPRECATED (2026-09-23): superseded by models/resolve_architecture_blockers.js.
 * This runner predates the formal manifest, the shape-derived planning workload
 * and the validator-computed D-Gate. It overwrites the same artifacts with an
 * older run id and a BLOCKED register. Kept for history only; do not run it as
 * part of the planning pipeline. */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const {evaluateDirectionGate, writeGateStatus} = require('../governance/evaluate_gates');

const root = path.resolve(__dirname, '../..');
const read = relativePath => JSON.parse(fs.readFileSync(path.join(root, relativePath), 'utf8').replace(/^\uFEFF/, ''));
const write = (relativePath, value) => {
  const target = path.join(root, relativePath);
  fs.mkdirSync(path.dirname(target), {recursive: true});
  fs.writeFileSync(target, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
};
const sha256 = relativePath => crypto.createHash('sha256').update(fs.readFileSync(path.join(root, relativePath))).digest('hex');

const env = read('data/direction/directional_resource_envelope.json');
const workloadBaseline = read('data/direction/directional_workload_baseline.json');
const target = env.targetTpsPerUser;
const margin = env.engineeringMargin;
const workloadByModel = new Map(workloadBaseline.models.map(item => [item.modelId, item]));

const coreProfiles = [
  {id: 'P1-compact', computeTF: 176.9472 * 8, vectorTOPS: 9.8304 * 8, powerW: 237.46 * 8, status: 'executable_comparison', scope: 'package_rank', source: 'docs/design/spec/k3_mc_baseline.json'},
  {id: 'P0-7R-balanced', computeTF: (32.768 + 262.144) * 8, vectorTOPS: 16.384 * 8, powerW: 250 * 8, status: 'physical_directional_envelope', scope: 'package_rank', source: 'docs/design/02_AI_CORE.md'}
];
const mcProfiles = [
  {id: 'MC320', rawPayloadTBs: env.bandwidthEnvelope.mc320.payloadTBs, sustainedAssumption: env.bandwidthEnvelope.mc320.sustainedAssumption, source: 'docs/design/spec/k3_7r_package_baseline.json'},
  {id: 'MC640', rawPayloadTBs: env.bandwidthEnvelope.mc640.payloadTBs, sustainedAssumption: env.bandwidthEnvelope.mc640.sustainedAssumption, source: 'docs/design/spec/k3_7r_package_baseline.json'}
].map(item => ({...item, effectiveBandwidthTBs: item.rawPayloadTBs * item.sustainedAssumption}));

const candidates = [];
for (const core of coreProfiles) for (const mc of mcProfiles) for (const tp of [8, 16, 32]) for (const model of env.models) {
  const w = workloadByModel.get(model.modelId);
  const executable = w && w.status === 'CALIBRATED_DIRECTIONAL_BASELINE';
  const computeUs = executable ? (w.globalFlopsPerToken / tp) / (core.computeTF * 1e12) * 1e6 : null;
  const memoryUs = executable ? (w.globalMemoryBytesPerToken / tp) / (mc.effectiveBandwidthTBs * 1e12) * 1e6 : null;
  const collectiveUs = executable ? w.collectiveReference.latencyUsPerToken * Math.log2(tp) / Math.log2(w.collectiveReference.tp) : null;
  const softwareUs = executable ? w.softwareOverheadUsPerToken : null;
  const rawUs = executable ? Math.max(computeUs, memoryUs, collectiveUs) + softwareUs : null;
  const e2eUs = rawUs == null ? null : rawUs * margin;
  const tps = e2eUs == null ? null : 1e6 / e2eUs;
  const values = {compute: computeUs, memory: memoryUs, communication: collectiveUs};
  const bottleneck = tps == null ? 'blocked_config' : Object.entries(values).sort((a, b) => b[1] - a[1])[0][0];
  candidates.push({
    candidateId: `${core.id}-${mc.id}-TP${tp}`, modelId: model.modelId, phase: 'decode', tp, cp: 1, ep: 1,
    physicalProfile: core.id.startsWith('P0') ? 'P0' : 'P1', mcProfile: mc.id,
    resourceScope: {compute: core.scope, memory: 'package_rank', bandwidthUnit: 'byte/s'},
    workloadUnits: executable ? {flopsPerToken: w.globalFlopsPerToken / tp, bytesPerToken: w.globalMemoryBytesPerToken / tp, effectiveFlopsPerSecond: core.computeTF * 1e12, effectiveBytesPerSecond: mc.effectiveBandwidthTBs * 1e12} : null,
    computeTimeUs: computeUs, memoryTimeUs: memoryUs, collectiveTimeUs: collectiveUs, softwareOverheadUs: softwareUs,
    uncoveredStallUs: 0, rawEstimateUs: rawUs, e2eEstimateUs: e2eUs, tpsPerUser: tps, bottleneck,
    status: tps == null ? 'BLOCKED_CONFIG' : 'DIRECTIONAL_ESTIMATE', confidence: executable ? 'E1' : 'E0',
    assumptions: executable ? [
      'FLOP and byte demand are in base units and sharded by TP for this directional pass.',
      'MC bandwidth uses payload multiplied by sustainedAssumption; raw payload is never used as effective bandwidth.',
      'Collective latency uses the calibrated K3 TP32 reference and logarithmic directional scaling.',
      'No software gain is silently applied.'
    ] : [w.blocker]
  });
}

const byCandidate = new Map();
for (const row of candidates) (byCandidate.has(row.candidateId) ? byCandidate.get(row.candidateId) : byCandidate.set(row.candidateId, []).get(row.candidateId)).push(row);
const geomean = values => values.length ? Math.exp(values.reduce((sum, value) => sum + Math.log(value), 0) / values.length) : null;
const candidateSummaries = [...byCandidate.entries()].map(([candidateId, rows]) => {
  const valid = rows.filter(row => Number.isFinite(row.tpsPerUser));
  const worst = valid.length ? valid.reduce((a, b) => a.tpsPerUser < b.tpsPerUser ? a : b) : null;
  return {candidateId, accountedModelCount: rows.length, comparableModelCount: valid.length, comparableModels: valid.map(row => row.modelId), blockedModels: rows.filter(row => row.status === 'BLOCKED_CONFIG').map(row => row.modelId), minTpsPerUser: worst ? worst.tpsPerUser : null, geomeanTpsPerUser: geomean(valid.map(row => row.tpsPerUser)), worstModel: worst ? worst.modelId : null, meetsTargetModels: valid.filter(row => row.tpsPerUser >= target).map(row => row.modelId), rankingEligible: valid.length === rows.length && valid.length === env.models.length};
});

const exploratoryCandidateIds = ['P0-7R-balanced-MC320-TP8', 'P0-7R-balanced-MC320-TP16', 'P0-7R-balanced-MC320-TP32'];
const runId = env.runId;
const register = {schemaVersion: 'candidate-register-v0.1', updatedAt: new Date().toISOString(), sourceDirectionalRunId: runId, decisionState: 'D_GATE_BLOCKED', formalSelectedCandidates: [], exploratorySweeps: [{sweepId: 'ADR-0001-P0-MC320-TP-SWEEP', runMode: 'EXPLORATORY_AFTER_BLOCKED_D_GATE', candidateIds: exploratoryCandidateIds, allowedModels: ['K3'], blockedModels: ['GLM-5.2', 'DeepSeek-V4-Pro'], rationale: 'Expose TP scaling and Q2 sizing without treating blocked Stage A as formal sign-off.', decisionRecord: 'docs/design/decisions/ADR-0001-exploratory-stage-b-tp-sweep.md'}]};

const out = {schemaVersion: 'directional-tps-scorecard-v0.2', runId, stage: 'direction', agentId: 'D7', targetTpsPerUser: target, architectureGateTpsPerUser: 1050, candidateLimitAfterGate: 3, candidateCount: candidates.length, selectedCandidateIds: [], exploratoryCandidateIds, status: 'DIRECTIONAL_ESTIMATE', confidence: 'E0', unitContract: {flops: 'FLOP/token/rank', bytes: 'byte/token/rank', computeRate: 'FLOP/s/package_rank', memoryRate: 'byte/s/package_rank', tps: 'tokens/s/user'}, inputHashes: {envelope: sha256('data/direction/directional_resource_envelope.json'), workloadBaseline: sha256('data/direction/directional_workload_baseline.json'), modelProfiles: sha256('data/workload/model_profiles.json')}, candidates, candidateSummaries, sensitivitySweep: {complete: false, dimensions: ['bandwidth', 'frequency', 'core_count', 'collective_latency', 'software_gain', 'area', 'power'], blocker: 'D2-D6 sensitivity sweep is not implemented.'}, dGate: null, blockers: ['GLM-5.2 and DeepSeek-V4-Pro formal manifests are blocked.', 'D2-D6 sensitivity sweep is not implemented.', 'Formal candidate selection is withheld until all three models are comparable.'], nextActions: ['Implement D2-D6 sensitivity sweep.', 'Freeze three-model manifests and rerun candidate aggregation.', 'Only then record formalSelectedCandidates and unlock formal Stage B.']};
out.dGate = evaluateDirectionGate(env, out, register);
write('data/direction/directional_tps_scorecard.json', out);
write('data/governance/candidate_register.json', register);
const gateStatus = writeGateStatus();

const reportDate = new Date().toISOString().slice(0, 10).replace(/-/g, '');
const k3Rows = candidates.filter(row => row.modelId === 'K3');
const report = `# Stage A 方向级架构运行报告\n\n运行时间：${new Date().toISOString()}\nRun ID：\`${runId}\`\n状态：\`${out.status} / D-GATE BLOCKED\`\n\n## 1. 运行链路\n\n\`\`\`text\nD1 workload profile -> D2 memory/bandwidth -> D3 compute/core\n  -> D4 communication -> D5 7-reticle/package -> D6 software\n  -> D7 directional TPS -> independent D-Gate validator\n\`\`\`\n\n## 2. 单位和资源 scope\n\n本次计算只使用基础 SI 单位：FLOP/token、byte/token、FLOP/s、byte/s。MC 的有效带宽为 raw payload × sustainedAssumption。Compute 与 memory 均以 \`package_rank\` 为 scope。\n\n| Profile | Scope | Value |\n|---|---|---:|\n| P1-compact | package_rank | ${coreProfiles[0].computeTF.toFixed(4)} TFLOP/s |\n| P0-7R-balanced | package_rank | ${coreProfiles[1].computeTF.toFixed(4)} TFLOP/s |\n| MC320 | package_rank | ${mcProfiles[0].effectiveBandwidthTBs.toFixed(4)} TB/s effective |\n| MC640 | package_rank | ${mcProfiles[1].effectiveBandwidthTBs.toFixed(4)} TB/s effective |\n\n## 3. 候选与聚合\n\n总候选行：${out.candidateCount}；架构候选：${candidateSummaries.length}；每个候选均有三模型行。只有 K3 可比较，因此不进行正式排名。授权探索 sweep：\`${exploratoryCandidateIds.join('`, `')}\`。\n\n## 4. K3 directional result\n\n| Candidate | TP | MC | Bottleneck | TPS/usr | Memory us | Status |\n|---|---:|---|---|---:|---:|---|\n${k3Rows.map(row => `| ${row.candidateId} | ${row.tp} | ${row.mcProfile} | ${row.bottleneck} | ${row.tpsPerUser.toFixed(2)} | ${row.memoryTimeUs.toFixed(2)} | ${row.status} |`).join('\n')}\n\n## 5. D-Gate\n\n\`\`\`json\n${JSON.stringify(out.dGate, null, 2)}\n\`\`\`\n\nD-Gate blocked 时，Stage B 只能以 \`EXPLORATORY_AFTER_BLOCKED_D_GATE\` 运行，不得把探索结果写成正式候选或 silicon TPS 承诺。\n\n## 6. 产物\n\n\`\`\`text\ndata/direction/directional_workload_baseline.json\ndata/direction/directional_tps_scorecard.json\ndata/governance/candidate_register.json\ndata/governance/gate_status.json\nreports/direction/stage_a_directional_run_${reportDate}.md\n\`\`\`\n`;
fs.mkdirSync(path.join(root, 'reports/direction'), {recursive: true});
fs.writeFileSync(path.join(root, `reports/direction/stage_a_directional_run_${reportDate}.md`), report, 'utf8');
console.log(JSON.stringify({runId, candidateCount: out.candidateCount, selected: out.selectedCandidateIds, exploratory: out.exploratoryCandidateIds, dGate: out.dGate, gateStatus: gateStatus.directionGate}, null, 2));
