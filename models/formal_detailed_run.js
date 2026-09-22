'use strict';

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
const hashFile = relativePath => crypto.createHash('sha256').update(fs.readFileSync(path.join(root, relativePath))).digest('hex');
const sourceCommit = (() => {
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], {cwd: root, encoding: 'utf8'}).trim();
  } catch {
    return 'WORKTREE';
  }
})();

const manifest = read('data/workload/formal_model_manifests.json');
const manifestHash = hashFile('data/workload/formal_model_manifests.json');
const profiles = read('data/workload/model_profiles.json');
const directional = read('data/direction/directional_tps_scorecard.json');
const register = read('data/governance/candidate_register.json');
const matrix = read('data/workload/tps_observation_matrix.json');
const targetTps = profiles.policy.sharedDecodeTargetTpsPerUser;
const utilization = 0.6;
const dutyCycle = 0.85;
const mcBandwidth = {MC320: 5.12e12 * 0.7, MC640: 10.24e12 * 0.7};
const networkBandwidth = 0.8e12;
const available = {
  L: 157.2864e12,
  H: 1258.2912e12,
  V: 78.6432e12,
  INDEXER: 78.6432e12,
  REDUCE: 78.6432e12
};
const opTemplates = read('data/workload/planning_operator_workload.json').operators;

const runId = 'stage-b-20260922-formal';
const selected = register.formalSelectedCandidates;
const inputHashes = {
  directionalScorecard: hashFile('data/direction/directional_tps_scorecard.json'),
  modelProfiles: hashFile('data/workload/model_profiles.json'),
  operatorWorkload: hashFile('data/workload/planning_operator_workload.json'),
  runner: hashFile('models/formal_detailed_run.js'),
  gateValidator: hashFile('models/governance/evaluate_gates.js'),
  manifest: manifestHash,
  candidateRegister: hashFile('data/governance/candidate_register.json')
};

function physicalProfile(candidateId) {
  return candidateId.startsWith('P1') ? 'P1' : 'P0';
}
function mcProfile(candidateId) {
  return candidateId.includes('MC640') ? 'MC640' : 'MC320';
}
function tpOf(candidateId) {
  return Number(candidateId.match(/TP(\d+)$/)[1]);
}

function ledgerRows(modelId, candidateId) {
  const tp = tpOf(candidateId);
  const mc = mcProfile(candidateId);
  return opTemplates[modelId].map(([operatorId, coreClass, globalFlops, globalBytes, byteClass]) => {
    const flops = globalFlops / tp;
    const bytes = globalBytes / tp;
    const bandwidth = byteClass === 'collective' ? networkBandwidth : mcBandwidth[mc];
    const peak = available[coreClass];
    const intensity = flops / bytes;
    const ridgePoint = peak / bandwidth;
    const rooflinePerformance = Math.min(peak, intensity * bandwidth);
    const requiredEffectiveFlops = flops * targetTps;
    const requiredPeakFlops = requiredEffectiveFlops / (utilization * dutyCycle);
    const requiredMemoryBandwidth = bytes * targetTps;
    const requiredNetworkBandwidth = byteClass === 'collective' ? bytes * targetTps : 0;
    return {
      runId,
      stage: 'quantification',
      agentId: 'Q2',
      candidateId,
      modelId,
      phase: 'decode',
      tp,
      cp: 1,
      ep: modelId === 'K3' ? 1 : 6,
      physicalProfile: physicalProfile(candidateId),
      mcProfile: mc,
      operatorId,
      operatorClass: operatorId,
      coreClass,
      manifestHash,
      source: 'data/workload/formal_model_manifests.json',
      flops,
      bytes: {[byteClass]: bytes, total: bytes},
      arithmeticIntensity: intensity,
      networkIntensity: byteClass === 'collective' ? flops / (bytes * 1.25) : intensity,
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
      availableNetworkBandwidth: byteClass === 'collective' ? bandwidth : 0,
      requiredToAvailableNetworkRatio: byteClass === 'collective' ? requiredNetworkBandwidth / bandwidth : 0,
      confidence: manifest.models.find(model => model.modelId === modelId).confidence,
      status: 'MODEL_REPLAY_ESTIMATE'
    };
  });
}

const ledger = [];
for (const physicalProfile of ['P0', 'P1']) {
  for (const mcProfile of ['MC320', 'MC640']) {
    for (const tp of [8, 16, 32]) {
      const candidateId =
        `${physicalProfile === 'P1' ? 'P1-compact' : 'P0-7R-balanced'}-${mcProfile}-TP${tp}`;
      for (const model of manifest.models) {
        ledger.push(...ledgerRows(model.modelId, candidateId));
      }
    }
  }
}

const eventTrace = [];
for (const row of ledger) {
  const eventBase = {
    runId,
    candidateId: row.candidateId,
    modelId: row.modelId,
    tp: row.tp,
    mcProfile: row.mcProfile,
    physicalProfile: row.physicalProfile,
    operatorId: row.operatorId,
    manifestHash,
    inputHashes
  };
  eventTrace.push({
    ...eventBase,
    agentId: 'Q3',
    eventType: 'TILE_MEMORY',
    tileBytes: row.bytes.total,
    dramBytes: row.bytes.total * 0.7,
    sramBytes: row.bytes.total * 0.3,
    tileCount: Math.max(1, Math.ceil(row.bytes.total / (8 * 1024 * 1024))),
    status: 'REPLAYED'
  });
  eventTrace.push({
    ...eventBase,
    agentId: 'Q4',
    eventType: 'COLLECTIVE_PACKET',
    packets: row.requiredNetworkBandwidth > 0 ? Math.ceil(row.requiredNetworkBandwidth / 64e3) : 0,
    bytes: row.requiredNetworkBandwidth,
    hopCountP99: row.requiredNetworkBandwidth > 0 ? 3 : 0,
    status: 'REPLAYED'
  });
  eventTrace.push({
    ...eventBase,
    agentId: 'Q5',
    eventType: 'KERNEL_CYCLE',
    computeCycles: Math.ceil(row.requiredEffectiveFlops / 1e12),
    memoryCycles: Math.ceil(row.requiredMemoryBandwidth / 1e9),
    criticalCycles: Math.max(Math.ceil(row.requiredEffectiveFlops / 1e12), Math.ceil(row.requiredMemoryBandwidth / 1e9)),
    status: 'REPLAYED'
  });
  eventTrace.push({
    ...eventBase,
    agentId: 'Q6',
    eventType: 'SCHEDULE',
    overlapFactor: Math.min(1, row.rooflineBound === 'bandwidth' ? 0.85 : 0.9),
    queueDepthP99: row.requiredNetworkBandwidth > 0 ? 8 : 4,
    uncoveredStallCycles: Math.ceil(row.requiredMemoryBandwidth / 1e9 * 0.15),
    status: 'REPLAYED'
  });
}

const byModelTpMc = new Map();
for (const row of ledger) {
  const key = `${row.modelId}:${row.tp}:${row.mcProfile}:${row.physicalProfile}`;
  const previous = byModelTpMc.get(key);
  if (!previous || Math.max(row.requiredToAvailableRatio, row.requiredToAvailableBandwidthRatio) > previous.ratio) {
    byModelTpMc.set(key, {row, ratio: Math.max(row.requiredToAvailableRatio, row.requiredToAvailableBandwidthRatio)});
  }
}

const observations = matrix.observations.map(observation => {
  const physical = observation.physicalProfile;
  if (!['P0','P1'].includes(physical)) throw new Error('Missing/invalid physicalProfile');
  const selectedCandidate =
    `${physical === 'P1' ? 'P1-compact' : 'P0-7R-balanced'}-${observation.mcProfile}-TP${observation.tp}`;
  const result = byModelTpMc.get(
    `${observation.modelId}:${observation.tp}:${observation.mcProfile}:${physical}`
  );
  if (!result) {
    throw new Error(
      `Missing replay coverage for ${observation.modelId} TP${observation.tp} ${observation.mcProfile} ${physical}`
    );
  }
  const ratio = result.ratio;
  const tpsPerUser = targetTps / ratio;
  const e2eLatencyUsPerToken = 1e6 / tpsPerUser;
  return {
    ...observation,
    physicalProfile: physical,
    status: 'PLANNING_ESTIMATE',
    evidenceKind: 'SYNTHETIC_BOTTLENECK_BOUND',
    tpsPerUser,
    rawLatencyUsPerToken: e2eLatencyUsPerToken,
    latencyScope: 'optimistic_single_operator_bottleneck_no_schedule_or_margin',
    e2eLatencyUsPerToken,
    source: 'data/detailed/formal_event_replay.json',
    sourceSelector: `${selectedCandidate}#/model/${observation.modelId}/tp${observation.tp}/${observation.mcProfile}`,
    blocker: null,
    manifestHash,
    runId
  };
});

const summary = manifest.models.map(model => {
  const rows = ledger.filter(row => row.modelId === model.modelId);
  const worstCompute = rows.reduce((a, b) => a.requiredToAvailableRatio > b.requiredToAvailableRatio ? a : b);
  const worstBandwidth = rows.reduce((a, b) => a.requiredToAvailableBandwidthRatio > b.requiredToAvailableBandwidthRatio ? a : b);
  return {
    modelId: model.modelId,
    operatorCount: rows.length,
    maxRequiredToAvailableRatio: worstCompute.requiredToAvailableRatio,
    worstOperator: worstCompute.operatorId,
    maxRequiredToAvailableBandwidthRatio: worstBandwidth.requiredToAvailableBandwidthRatio,
    worstBandwidthOperator: worstBandwidth.operatorId,
    minTpsPerUser: Math.min(...observations.filter(item => item.modelId === model.modelId).map(item => item.tpsPerUser)),
    targetMet: observations.filter(item => item.modelId === model.modelId).every(item => item.tpsPerUser >= targetTps),
    status: 'MODEL_REPLAY_ESTIMATE',
    confidence: model.confidence
  };
});

const eventArtifact = {
  schemaVersion: 'formal-event-replay-v0.1',
  runId,
  manifestHash,
  inputHashes,
  eventCount: eventTrace.length,
  status: 'SYNTHETIC_PLANNING_EVENTS_NOT_TIMING_REPLAY',
  events: eventTrace
};
write('data/detailed/formal_event_replay.json', eventArtifact);
write('data/workload/tps_observation_matrix.json', {
  ...matrix,
  status: 'PLANNING_ESTIMATES_COMPLETE',
  common: {...matrix.common, physicalProfile: 'P0'},
  observationStates: [...new Set([...matrix.observationStates, 'PLANNING_ESTIMATE'])],
  currentCoverage: {
    totalRequired: 18,
    modelObserved: 0,
    planningEstimated: observations.length,
    siliconObserved: 0,
    pendingModelRun: observations.length,
    percentComplete: 0,
    planningPercentComplete: 100,
    note: '18 planning bounds; zero validated timing observations. No silicon result.'
  },
  observations
});

const detail = {
  schemaVersion: 'detailed-architecture-run-v0.3',
  runId,
  stage: 'quantification',
  runMode: 'PLANNING_QUANTIFICATION',
  evidenceKind: 'SYNTHETIC_BOTTLENECK_BOUND',
  agentId: 'Q1-Q9-orchestrator',
  sourceDirectionalRunId: directional.runId,
  selectedCandidates: selected,
  candidateSelection: {source: 'data/governance/candidate_register.json', formal: true, exploratory: false, decision: 'D_GATE_PASSED'},
  manifestStatus: Object.fromEntries(manifest.models.map(model => [model.modelId, model.status])),
  manifestHash,
  operatorLedger: ledger,
  blockedCases: [],
  summary,
  agentRuns: {
    Q1: {status: 'COMPLETE', output: 'formal model manifest, operator inventory and shared hash'},
    Q2: {status: 'COMPLETE', output: 'three-model arithmetic intensity, Roofline, compute/bandwidth/network sizing ledger'},
    Q3: {status: 'PLANNING_ONLY', output: 'tile and memory event replay'},
    Q4: {status: 'PLANNING_ONLY', output: 'collective packet and NoC event replay'},
    Q5: {status: 'PLANNING_ONLY', output: 'kernel cycle replay'},
    Q6: {status: 'PLANNING_ONLY', output: 'scheduler overlap and stall replay'},
    Q7: {status: 'PLANNING_ONLY', output: 'planning PPA and thermal envelope reconciliation'},
    Q8: {status: 'PLANNING_ONLY', output: 'optimistic bottleneck bounds; no dependency-aware timing replay'},
    Q9: {status: 'COMPLETE', output: 'independent gate validator executed after artifact generation'}
  },
  observationMatrix: {
    requiredSlots: 18,
    accountedSlots: observations.length,
    all18SlotsAccounted: observations.length === 18,
    status: 'PLANNING_COVERAGE_ONLY'
  },
  provenance: {
    sourceCommit,
    manifestHash,
    inputHashes,
    seed: 20260922,
    toolVersion: 'node-formal-stage-b-v0.3',
    eventArtifact: 'data/detailed/formal_event_replay.json'
  },
  sizing: {
    targetTpsPerUser: targetTps,
    architectureGateTpsPerUser: profiles.policy.sharedArchitectureGateTpsPerUser,
    utilizationAssumption: utilization,
    dutyCycleAssumption: dutyCycle,
    effectiveMemoryBandwidth: mcBandwidth.MC320,
    networkEffectiveBandwidth: networkBandwidth,
    availableResources: Object.fromEntries(Object.entries(available).map(([key, peakFlops]) => [key, {scope: 'package_rank', peakFlops}]))
  },
  performanceAcceptance: {
    targetTpsPerUser: targetTps,
    architectureGateTpsPerUser: profiles.policy.sharedArchitectureGateTpsPerUser,
    all18SlotsMeetTarget: observations.every(item => item.tpsPerUser >= targetTps),
    all18SlotsMeetArchitectureGate: observations.every(item => item.tpsPerUser >= profiles.policy.sharedArchitectureGateTpsPerUser),
    status: 'PERFORMANCE_MISS_REQUIRES_DIRECTION_BACKFLOW',
    feedback: 'Reduce external-memory bytes or add an implementable bandwidth/reuse route before architecture freeze.'
  },
  qGate: null,
  assumptions: [
    'All three manifests are architecture planning manifests; external vendor/license confirmation remains a qualification risk.',
    'PLANNING_ESTIMATE is a synthetic bottleneck bound, not an event-timed observation.',
    'MC320 and MC640 remain separate profiles; MC640 is not the default manufacturing claim.',
    'Q3-Q8 synthetic events are placeholders and do not drive latency; P0/P1 core-class rates are not reconciled.'
  ],
  nextActions: [
    'Create direction feedback packet for byte reduction and memory topology.',
    'Replace planning operator templates with vendor-verified layer traces.',
    'Repeat formal replay after PPA and bandwidth direction update.'
  ]
};
write('data/detailed/detailed_architecture_run.json', detail);

const gate = writeGateStatus();
detail.qGate = gate.quantificationGate;
write('data/detailed/detailed_architecture_run.json', detail);

const report = [
  '# Stage B Formal Detailed Architecture Run',
  '',
  `Run ID: \`${runId}\``,
  `Manifest hash: \`${manifestHash}\``,
  `Run mode: \`${detail.runMode}\``,
  '',
  '## Gate result',
  '',
  `- D-Gate: \`${gate.directionGate.decision}\``,
  `- Q-Gate: \`${gate.quantificationGate.decision}\``,
  '- Planning artifacts only. Q-Gate blocked: synthetic events do not establish fine TPS or PPA closure.',
  '',
  '## Performance acceptance',
  '',
  `- Target: ${targetTps} TPS/usr`,
  `- All 18 slots meet target: **${detail.performanceAcceptance.all18SlotsMeetTarget ? 'yes' : 'no'}**`,
  `- Feedback: ${detail.performanceAcceptance.feedback}`,
  '',
  '## Agent outputs',
  '',
  ...Object.entries(detail.agentRuns).map(([agentId, item]) => `- **${agentId}**: ${item.status} - ${item.output}`),
  '',
  '## Artifacts',
  '',
  '- `data/workload/formal_model_manifests.json`',
  '- `data/detailed/formal_event_replay.json`',
  '- `data/workload/tps_observation_matrix.json`',
  '- `data/detailed/detailed_architecture_run.json`'
].join('\n');
fs.mkdirSync(path.join(root, 'reports/detailed'), {recursive: true});
fs.writeFileSync(path.join(root, 'reports/detailed/stage_b_formal_run_20260922.md'), `${report}\n`, 'utf8');
console.log(JSON.stringify({
  runId,
  manifestHash,
  ledgerRows: ledger.length,
  eventCount: eventTrace.length,
  observationSlots: observations.length,
  directionGate: gate.directionGate.decision,
  quantificationGate: gate.quantificationGate.decision,
  performance: detail.performanceAcceptance.status
}, null, 2));
