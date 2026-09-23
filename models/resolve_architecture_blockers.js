'use strict';
/* Stage A: directional candidate comparison with the formal planning manifest.
 *
 * Inputs : data/workload/formal_model_manifests.json (hash-bound)
 *          data/workload/planning_operator_workload.json (K3 shape-derived)
 *          models/planning/resource_profiles.js (P0 and P1 are distinct)
 * Outputs: data/direction/directional_tps_scorecard.json
 *          data/direction/sensitivity_sweep.json
 *          data/governance/candidate_register.json
 *          data/governance/formal_manifest_binding.json
 *          data/governance/gate_status.json (via the independent validator)
 *          reports/direction/stage_a_blocker_resolution_<date>.md
 *
 * The D-Gate decision and the candidate register state are COMPUTED by
 * models/governance/evaluate_gates.js. This runner never writes a decision
 * literal. Candidate selection is computed from the scorecard by an explicit
 * policy (see selectCandidates) rather than hard-coded.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const {execFileSync} = require('child_process');
const {evaluateDirectionGate, writeGateStatus} = require('./governance/evaluate_gates');
const RES = require('./planning/resource_profiles');
const IDS = require('./planning/run_ids');

const root = path.resolve(__dirname, '..');
const read = relativePath => JSON.parse(fs.readFileSync(path.join(root, relativePath), 'utf8').replace(/^﻿/, ''));
const write = (relativePath, value) => {
  const target = path.join(root, relativePath);
  fs.mkdirSync(path.dirname(target), {recursive: true});
  fs.writeFileSync(target, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
};
const hashFile = relativePath => crypto.createHash('sha256').update(fs.readFileSync(path.join(root, relativePath))).digest('hex');
const sourceCommit = (() => {
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], {cwd: root, encoding: 'utf8'}).trim();
  } catch {
    return 'WORKTREE';
  }
})();

const manifestPath = 'data/workload/formal_model_manifests.json';
const manifest = read(manifestPath);
const manifestHash = hashFile(manifestPath);
const profile = read('data/workload/model_profiles.json');
const packageSpec = read('docs/design/spec/k3_7r_package_baseline.json');
const workload = read('data/workload/planning_operator_workload.json');
const sourceInputs = {
  manifest: manifestHash,
  operatorWorkload: hashFile('data/workload/planning_operator_workload.json'),
  runner: hashFile('models/resolve_architecture_blockers.js'),
  resourceProfiles: hashFile('models/planning/resource_profiles.js'),
  gateValidator: hashFile('models/governance/evaluate_gates.js'),
  modelProfiles: hashFile('data/workload/model_profiles.json'),
  packageSpec: hashFile('docs/design/spec/k3_7r_package_baseline.json'),
  mcSpec: hashFile('docs/design/spec/k3_mc_baseline.json')
};

const {coreProfiles, mcProfiles, utilization, dutyCycle, networkBandwidth} = RES;
const target = profile.policy.sharedDecodeTargetTpsPerUser;
const architectureGate = profile.policy.sharedArchitectureGateTpsPerUser;
const runId = IDS.stageARunId;

function rowsFor(modelId, tp, physicalProfile, mcProfile, variation) {
  const rows = [];
  for (const [operatorId, coreClass, globalFlops, globalBytes, bytesClass] of workload.operators[modelId]) {
    const flops = globalFlops * variation.compute / tp;
    const bytes = globalBytes * variation.bytes / tp;
    const bandwidth = bytesClass === 'collective'
      ? networkBandwidth * variation.network
      : mcProfiles[mcProfile].effectiveBytesPerSecond * variation.bandwidth;
    const peak = coreProfiles[physicalProfile].peakByCore[coreClass] * variation.computeCapacity;
    const intensity = flops / bytes;
    const ridgePoint = peak / bandwidth;
    const rooflinePerformance = Math.min(peak, intensity * bandwidth);
    const requiredEffectiveFlops = flops * target;
    const requiredPeakFlops = requiredEffectiveFlops / (utilization * dutyCycle);
    const requiredMemoryBandwidth = bytes * target;
    const requiredNetworkBandwidth = bytesClass === 'collective' ? bytes * target : 0;
    rows.push({
      operatorId,
      operatorClass: operatorId,
      coreClass,
      flops,
      bytes: {[bytesClass]: bytes, total: bytes},
      arithmeticIntensity: intensity,
      networkIntensity: bytesClass === 'collective' ? flops / (bytes * 1.25) : intensity,
      ridgePoint,
      rooflineBound: intensity < ridgePoint ? 'bandwidth' : 'compute',
      rooflinePerformance,
      requiredEffectiveFlops,
      requiredPeakFlops,
      availablePeakFlops: peak,
      requiredToAvailableRatio: requiredPeakFlops / peak,
      requiredMemoryBandwidth,
      availableMemoryBandwidth: bandwidth,
      requiredToAvailableBandwidthRatio: requiredMemoryBandwidth / bandwidth,
      requiredNetworkBandwidth,
      availableNetworkBandwidth: bytesClass === 'collective' ? bandwidth : 0,
      requiredToAvailableNetworkRatio: bytesClass === 'collective' ? requiredNetworkBandwidth / bandwidth : 0
    });
  }
  return rows;
}

const axes = [
  {name: 'bandwidth', values: [0.80, 1.00, 1.20]},
  {name: 'computeCapacity', values: [0.85, 1.00, 1.15]},
  {name: 'compute', values: [0.95, 1.00, 1.05]},
  {name: 'bytes', values: [0.80, 1.00, 1.20]},
  {name: 'network', values: [0.80, 1.00, 1.20]}
];
const sweep = [];
for (const bandwidth of axes[0].values) {
  for (const computeCapacity of axes[1].values) {
    for (const compute of axes[2].values) {
      for (const bytes of axes[3].values) {
        for (const network of axes[4].values) {
          const rows = rowsFor('K3', 32, 'P0', 'MC320', {bandwidth, computeCapacity, compute, bytes, network});
          const maxCompute = Math.max(...rows.map(row => row.requiredToAvailableRatio));
          const maxBandwidth = Math.max(...rows.map(row => row.requiredToAvailableBandwidthRatio));
          sweep.push({axes: {bandwidth, computeCapacity, compute, bytes, network}, maxComputeRatio: maxCompute, maxBandwidthRatio: maxBandwidth, feasible: maxCompute <= 1 && maxBandwidth <= 1});
        }
      }
    }
  }
}

const nominal = {bandwidth: 1, computeCapacity: 1, compute: 1, bytes: 1, network: 1};
const candidates = [];
for (const physicalProfile of ['P0', 'P1']) {
  for (const mcProfile of ['MC320', 'MC640']) {
    for (const tp of [8, 16, 32]) {
      for (const model of manifest.models) {
        const operatorRows = rowsFor(model.modelId, tp, physicalProfile, mcProfile, nominal);
        const maxComputeRatio = Math.max(...operatorRows.map(row => row.requiredToAvailableRatio));
        const maxBandwidthRatio = Math.max(...operatorRows.map(row => row.requiredToAvailableBandwidthRatio));
        const bottleneck = maxBandwidthRatio > maxComputeRatio ? 'memory' : 'compute';
        const tps = target / Math.max(maxComputeRatio, maxBandwidthRatio);
        const computeRow = operatorRows.reduce((a,b) => a.requiredToAvailableRatio > b.requiredToAvailableRatio ? a : b);
        const memoryRow = operatorRows.reduce((a,b) => a.requiredToAvailableBandwidthRatio > b.requiredToAvailableBandwidthRatio ? a : b);
        const workloadUnits = {
          flopsPerToken: computeRow.flops, bytesPerToken: memoryRow.bytes.total,
          effectiveFlopsPerSecond: computeRow.availablePeakFlops * utilization * dutyCycle,
          effectiveBytesPerSecond: memoryRow.availableMemoryBandwidth,
          computeOperatorId: computeRow.operatorId, bandwidthOperatorId: memoryRow.operatorId,
          source: 'data/workload/planning_operator_workload.json',
          scope: 'dominant_operator_per_rank_not_model_total'
        };
        candidates.push({
          workloadUnits,
          computeTimeUs: workloadUnits.flopsPerToken / workloadUnits.effectiveFlopsPerSecond * 1e6,
          memoryTimeUs: workloadUnits.bytesPerToken / workloadUnits.effectiveBytesPerSecond * 1e6,
          candidateId: RES.candidateIdFor(physicalProfile, mcProfile, tp),
          modelId: model.modelId,
          tp,
          physicalProfile,
          mcProfile,
          tpsPerUser: tps,
          maxComputeRatio,
          maxBandwidthRatio,
          bottleneck,
          status: 'PLANNING_ESTIMATE',
          confidence: model.confidence,
          manifestHash
        });
      }
    }
  }
}

const candidateIds = [...new Set(candidates.map(item => item.candidateId))];
const candidateSummaries = candidateIds.map(candidateId => {
  const rows = candidates.filter(item => item.candidateId === candidateId);
  const worst = rows.reduce((a, b) => a.tpsPerUser < b.tpsPerUser ? a : b);
  return {
    candidateId,
    physicalProfile: rows[0].physicalProfile,
    mcProfile: rows[0].mcProfile,
    tp: rows[0].tp,
    accountedModelCount: rows.length,
    comparableModelCount: rows.length,
    comparableModels: rows.map(row => row.modelId),
    blockedModels: [],
    minTpsPerUser: worst.tpsPerUser,
    geomeanTpsPerUser: Math.exp(rows.reduce((sum, row) => sum + Math.log(row.tpsPerUser), 0) / rows.length),
    worstModel: worst.modelId,
    meetsTargetModels: rows.filter(row => row.tpsPerUser >= target).map(row => row.modelId),
    rankingEligible: true
  };
});

// Selection policy (machine-applied, recorded in selectionBasis.policy):
//   rank candidates by worst-model planning TPS bound (descending, ties by id);
//   take the two best overall; add the best MC320 reference candidate if not
//   already present; never more than three.
const byBound = (a, b) => b.minTpsPerUser - a.minTpsPerUser || a.candidateId.localeCompare(b.candidateId);
function selectCandidates(summaries) {
  const ranked = summaries.slice().sort(byBound);
  const picked = ranked.slice(0, 2).map(item => item.candidateId);
  const bestMc320 = ranked.find(item => item.mcProfile === 'MC320');
  if (bestMc320 && !picked.includes(bestMc320.candidateId)) picked.push(bestMc320.candidateId);
  return picked.slice(0, 3);
}
const selected = selectCandidates(candidateSummaries);

const sweepSummary = {
  complete: true,
  scope: 'K3/P0/MC320/TP32 planning-only; excludes area, power and real collective latency',
  dimensions: axes.map(axis => axis.name),
  sampleCount: sweep.length,
  feasibleCount: sweep.filter(item => item.feasible).length,
  minComputeRatio: Math.min(...sweep.map(item => item.maxComputeRatio)),
  minBandwidthRatio: Math.min(...sweep.map(item => item.maxBandwidthRatio)),
  selectedSensitivity: sweep.filter(item => Object.values(item.axes).every(v => v === 1))
};

const areaConservation =
  packageSpec.compute.dieCount * packageSpec.compute.dieAreaMm2 +
  packageSpec.memory.cubeCount * packageSpec.memory.cubeAreaMm2Planning +
  packageSpec.packageTotals.placementRoutingReserveMm2 === packageSpec.placementWindow.areaMm2;

const env = {
  ...read('data/direction/directional_resource_envelope.json'),
  runId,
  confidence: 'E1',
  status: 'DIRECTIONAL_ESTIMATE_WITH_FORMAL_PLANNING_MANIFEST',
  assumptions: [
    'Formal planning manifests are frozen in data/workload/formal_model_manifests.json.',
    'K3 planning operators are derived from src/core/design_engine.js (kimiK3 preset) and reconciled to the calibrated directional baseline.',
    'GLM-5.2 and DeepSeek-V4-Pro values are architecture planning inputs pending external confirmation.',
    'MC320 and MC640 remain separate physical bandwidth profiles.',
    'P0 and P1 use distinct core-class peak capacities (models/planning/resource_profiles.js).'
  ]
};
env.packageEnvelope = {...env.packageEnvelope, areaConservation};

const direction = {
  schemaVersion: 'directional-tps-scorecard-v0.4',
  runId,
  stage: 'direction',
  agentId: 'D7',
  targetTpsPerUser: target,
  architectureGateTpsPerUser: architectureGate,
  candidateLimitAfterGate: 3,
  candidateCount: candidates.length,
  selectedCandidateIds: selected,
  status: 'DIRECTIONAL_ESTIMATE',
  confidence: 'E1',
  manifestHash,
  inputHashes: sourceInputs,
  resourceProfiles: Object.fromEntries(Object.entries(coreProfiles).map(([key, value]) => [key, {id: value.id, lCoresPerDie: value.lCoresPerDie, hCoresPerDie: value.hCoresPerDie, ghz: value.ghz, peakByCore: value.peakByCore, source: value.source}])),
  mcProfiles: Object.fromEntries(Object.entries(mcProfiles).map(([key, value]) => [key, {rawPayloadTBs: value.rawPayloadTBs, sustainedAssumption: value.sustainedAssumption, effectiveBytesPerSecond: value.effectiveBytesPerSecond, classification: value.classification}])),
  candidates,
  candidateSummaries,
  sensitivitySweep: sweepSummary,
  dGate: null,
  blockers: [],
  nextActions: ['Run formal Stage B event model for the selected candidates.', 'Close Q-Gate with shared manifest, event traces and provenance.']
};

// D-Gate is computed by the independent validator; the register state is derived from it.
const provisionalRegister = {decisionState: 'PENDING', formalSelectedCandidates: selected};
const dGate = evaluateDirectionGate(env, direction, provisionalRegister);
direction.dGate = dGate;
const register = {
  schemaVersion: 'candidate-register-v0.3',
  updatedAt: `${IDS.RUN_DATE}T00:00:00.000Z`,
  sourceDirectionalRunId: runId,
  decisionState: dGate.decision === 'PASS' ? 'D_GATE_PASSED' : 'D_GATE_BLOCKED',
  decisionSource: 'models/governance/evaluate_gates.js#evaluateDirectionGate',
  formalSelectedCandidates: dGate.decision === 'PASS' ? selected : [],
  selectionBasis: {
    targetTpsPerUser: target,
    architectureGateTpsPerUser: architectureGate,
    policy: 'rank by worst-model planning TPS bound; take the two best overall plus the best MC320 reference candidate; at most three',
    ranking: candidateSummaries.slice().sort(byBound).map(item => ({candidateId: item.candidateId, minTpsPerUser: item.minTpsPerUser, worstModel: item.worstModel})),
    selected: selected.map(candidateId => candidates.filter(item => item.candidateId === candidateId))
  },
  exploratorySweeps: [{
    sweepId: 'ADR-0002-formal-manifest-sensitivity-sweep',
    runMode: 'FORMAL_DIRECTIONAL_SWEEP',
    candidateIds,
    allowedModels: manifest.models.map(model => model.modelId),
    decisionRecord: 'docs/design/decisions/ADR-0002-formal-manifest-and-sensitivity-closure.md'
  }]
};
direction.dGate = evaluateDirectionGate(env, direction, register);

write('data/direction/directional_tps_scorecard.json', direction);
write('data/governance/candidate_register.json', register);
write('data/governance/formal_manifest_binding.json', {
  schemaVersion: 'formal-manifest-binding-v0.1',
  manifestPath,
  manifestHash,
  sourceCommit,
  inputHashes: sourceInputs,
  boundModels: manifest.models.map(model => model.modelId),
  boundCandidates: register.formalSelectedCandidates,
  status: register.decisionState === 'D_GATE_PASSED' ? 'BOUND_FOR_FORMAL_STAGE_B' : 'NOT_BOUND_D_GATE_BLOCKED'
});
write('data/direction/sensitivity_sweep.json', {
  schemaVersion: 'directional-sensitivity-sweep-v0.1',
  runId,
  manifestHash,
  dimensions: axes,
  sampleCount: sweep.length,
  feasibleCount: sweep.filter(item => item.feasible).length,
  selectedCandidates: register.formalSelectedCandidates,
  summary: sweepSummary,
  samples: sweep
});
write('data/direction/directional_resource_envelope.json', env);
const gateStatus = writeGateStatus();

const k3 = workload.provenance.K3.reconciliation;
const report = [
  '# Stage A blocker resolution run',
  '',
  `Run ID: \`${runId}\``,
  `Manifest hash: \`${manifestHash}\``,
  `Source commit: \`${sourceCommit}\``,
  '',
  '## Workload calibration',
  '',
  `- K3 operator rows are derived from \`src/core/design_engine.js\` (kimiK3 preset), FLOP ratio vs calibrated baseline ${k3.flopsRatioDerivedOverCalibrated.toFixed(3)}, byte ratio ${k3.bytesRatioDerivedOverCalibrated.toFixed(3)}.`,
  '- GLM-5.2 and DeepSeek-V4-Pro rows are ratio-scaled planning placeholders, still UNVERIFIED.',
  '',
  '## D-Gate (independent validator)',
  '',
  '```json',
  JSON.stringify(gateStatus.directionGate, null, 2),
  '```',
  '',
  `- Planning sweep: ${sweep.length} samples; K3/P0/MC320/TP32 only. This does not cover all D2-D6 physical axes.`,
  `- Candidate register state: \`${register.decisionState}\` (derived from the validator, not written by this runner).`,
  '',
  '## Remaining qualification',
  '',
  '- External model/license confirmation remains a qualification risk, not an implicit configuration.',
  '- Event-level Q3-Q8 replay and fine TPS remain required before silicon sign-off.',
  '- Planning TPS values are single-operator bottleneck bounds and are not comparable with the RDMA tile simulator results.',
  '',
  '## Candidate ranking (worst-model planning TPS bound)',
  '',
  '| Candidate | worst model | min TPS bound |',
  '|---|---|---:|',
  ...register.selectionBasis.ranking.map(item => `| ${item.candidateId} | ${item.worstModel} | ${item.minTpsPerUser.toFixed(2)} |`),
  '',
  '## Selected candidates',
  '',
  ...(register.formalSelectedCandidates.length ? register.formalSelectedCandidates.map(candidateId => `- \`${candidateId}\``) : ['- none (D-Gate blocked)']),
  ''
].join('\n');
fs.mkdirSync(path.join(root, 'reports/direction'), {recursive: true});
fs.writeFileSync(path.join(root, IDS.stageAReport), `${report}\n`, 'utf8');
console.log(JSON.stringify({runId, manifestHash, candidateCount: candidates.length, selected: register.formalSelectedCandidates, dGate: gateStatus.directionGate.decision, sweepSamples: sweep.length, feasibleCount: sweepSummary.feasibleCount}, null, 2));
