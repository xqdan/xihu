'use strict';
/* Stage B: planning quantification.
 *
 * Reads the candidate register (never hard-codes candidates), the hash-bound
 * manifest and the shape-derived planning workload. P0 and P1 use distinct
 * core-class capacities from models/planning/resource_profiles.js.
 *
 * With D-Gate passed the register's formal selection is used. With D-Gate
 * blocked the run is EXPLORATORY_AFTER_BLOCKED_D_GATE (ADR-0001, ADR-0006): it
 * takes the register's active exploratory sweep and claims no formal selection.
 *
 * Slot TPS/usr is the calibrated planning token time (models/planning/token_time.js).
 * BLOCKED_CONFIG models get no ledger rows and no TPS. Q3-Q8 events are
 * placeholders and do not drive latency. Performance acceptance is COMPUTED
 * from the slots, not written as a literal.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const {execFileSync} = require('child_process');
const {writeGateStatus} = require('./governance/evaluate_gates');
const RES = require('./planning/resource_profiles');
const TT = require('./planning/token_time');
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

const manifest = read('data/workload/formal_model_manifests.json');
const manifestHash = hashFile('data/workload/formal_model_manifests.json');
const profiles = read('data/workload/model_profiles.json');
const directional = read('data/direction/directional_tps_scorecard.json');
const register = read('data/governance/candidate_register.json');
const matrix = read('data/workload/tps_observation_matrix.json');
const workload = read('data/workload/planning_operator_workload.json');
const targetTps = profiles.policy.sharedDecodeTargetTpsPerUser;
const architectureGateTps = profiles.policy.sharedArchitectureGateTpsPerUser;
const {coreProfiles, mcProfiles, utilization, dutyCycle, networkBandwidth} = RES;
const opTemplates = workload.operators;
const calibration = workload.calibration;

const runId = IDS.stageBRunId;
const formal = register.decisionState === 'D_GATE_PASSED' && register.formalSelectedCandidates.length > 0;
const exploratorySweep = (register.exploratorySweeps || []).find(sweep => sweep.runMode === 'EXPLORATORY_AFTER_BLOCKED_D_GATE' && sweep.active);
if (!formal && !exploratorySweep) {
  throw new Error(`Stage B needs D_GATE_PASSED or an active EXPLORATORY_AFTER_BLOCKED_D_GATE sweep; register state is ${register.decisionState}`);
}
const runMode = formal ? 'PLANNING_QUANTIFICATION' : 'EXPLORATORY_AFTER_BLOCKED_D_GATE';
const selected = formal ? register.formalSelectedCandidates : [];
const studied = formal ? selected : exploratorySweep.candidateIds;
const planningModels = Object.fromEntries(manifest.models.map(model => [model.modelId, TT.planningModel(workload, model.modelId)]));
const comparableModels = manifest.models.filter(model => planningModels[model.modelId]);
const blockedModels = manifest.models.filter(model => !planningModels[model.modelId]);
const inputHashes = {
  directionalScorecard: hashFile('data/direction/directional_tps_scorecard.json'),
  modelProfiles: hashFile('data/workload/model_profiles.json'),
  operatorWorkload: hashFile('data/workload/planning_operator_workload.json'),
  resourceProfiles: hashFile('models/planning/resource_profiles.js'),
  tokenTime: hashFile('models/planning/token_time.js'),
  runner: hashFile('models/formal_detailed_run.js'),
  gateValidator: hashFile('models/governance/evaluate_gates.js'),
  manifest: manifestHash,
  candidateRegister: hashFile('data/governance/candidate_register.json')
};

function ledgerRows(modelId, candidateId) {
  const tp = RES.tpOf(candidateId);
  const mc = RES.mcProfileOf(candidateId);
  const physical = RES.physicalProfileOf(candidateId);
  return opTemplates[modelId].map(([operatorId, coreClass, globalFlops, globalBytes, byteClass]) => {
    const flops = globalFlops / tp;
    const bytes = globalBytes / tp;
    const bandwidth = byteClass === 'collective' ? networkBandwidth : mcProfiles[mc].effectiveBytesPerSecond;
    const peak = coreProfiles[physical].peakByCore[coreClass];
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
      physicalProfile: physical,
      mcProfile: mc,
      operatorId,
      operatorClass: operatorId,
      coreClass,
      manifestHash,
      source: 'data/workload/formal_model_manifests.json',
      workloadSource: 'data/workload/planning_operator_workload.json',
      workloadStatus: workload.provenance[modelId].status,
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
      // Uncalibrated per-rank lane contributions (token_time.js sums these per slot).
      computeTimeUs: flops / (peak * utilization * dutyCycle) * 1e6,
      memoryTimeUs: byteClass === 'collective' ? 0 : bytes / bandwidth * 1e6,
      confidence: manifest.models.find(model => model.modelId === modelId).confidence,
      status: 'MODEL_REPLAY_ESTIMATE'
    };
  });
}

const ledger = [];
const slotTimes = [];
for (const physicalProfile of ['P0', 'P1']) {
  for (const mcProfile of ['MC320', 'MC640']) {
    for (const tp of [8, 16, 32]) {
      const candidateId = RES.candidateIdFor(physicalProfile, mcProfile, tp);
      for (const model of comparableModels) {
        ledger.push(...ledgerRows(model.modelId, candidateId));
        const slot = {tp, physicalProfile, mcProfile};
        const t = TT.slotTime(planningModels[model.modelId], slot, calibration);
        slotTimes.push({
          candidateId, modelId: model.modelId, ...slot,
          memoryUs: t.memoryUs, computeUs: t.computeUs, commUs: t.commUs,
          collectivesPerToken: t.collectivesPerToken, perCollectiveUs: t.perCollectiveUs,
          memoryLaneUs: t.memoryLaneUs, serialLaneUs: t.serialLaneUs,
          rawUs: t.rawUs, e2eUs: t.e2eUs, tpsPerUser: t.tpsPerUser, bound: t.bound,
          boundingOperatorId: TT.boundingOperator(planningModels[model.modelId], slot, t)
        });
      }
    }
  }
}
const slotTimeOf = (modelId, candidateId) => slotTimes.find(x => x.modelId === modelId && x.candidateId === candidateId);

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
    status: 'SYNTHETIC_PLACEHOLDER'
  });
  eventTrace.push({
    ...eventBase,
    agentId: 'Q4',
    eventType: 'COLLECTIVE_PACKET',
    packets: row.requiredNetworkBandwidth > 0 ? Math.ceil(row.requiredNetworkBandwidth / 64e3) : 0,
    bytes: row.requiredNetworkBandwidth,
    hopCountP99: row.requiredNetworkBandwidth > 0 ? 3 : 0,
    status: 'SYNTHETIC_PLACEHOLDER'
  });
  eventTrace.push({
    ...eventBase,
    agentId: 'Q5',
    eventType: 'KERNEL_CYCLE',
    computeCycles: Math.ceil(row.requiredEffectiveFlops / 1e12),
    memoryCycles: Math.ceil(row.requiredMemoryBandwidth / 1e9),
    criticalCycles: Math.max(Math.ceil(row.requiredEffectiveFlops / 1e12), Math.ceil(row.requiredMemoryBandwidth / 1e9)),
    status: 'SYNTHETIC_PLACEHOLDER'
  });
  eventTrace.push({
    ...eventBase,
    agentId: 'Q6',
    eventType: 'SCHEDULE',
    overlapFactor: Math.min(1, row.rooflineBound === 'bandwidth' ? 0.85 : 0.9),
    queueDepthP99: row.requiredNetworkBandwidth > 0 ? 8 : 4,
    uncoveredStallCycles: Math.ceil(row.requiredMemoryBandwidth / 1e9 * 0.15),
    status: 'SYNTHETIC_PLACEHOLDER'
  });
}

const observations = matrix.observations.map(observation => {
  const physical = observation.physicalProfile;
  if (!['P0','P1'].includes(physical)) throw new Error('Missing/invalid physicalProfile');
  const candidateId = RES.candidateIdFor(physical, observation.mcProfile, observation.tp);
  const common = {...observation, physicalProfile: physical, sourceSelector: `${candidateId}#/model/${observation.modelId}/tp${observation.tp}/${observation.mcProfile}`, manifestHash, runId};
  const blocked = blockedModels.find(model => model.modelId === observation.modelId);
  if (blocked) {
    return {
      ...common,
      status: 'BLOCKED_CONFIG',
      evidenceKind: 'NONE',
      tpsPerUser: null,
      rawLatencyUsPerToken: null,
      e2eLatencyUsPerToken: null,
      latencyScope: 'not computed: model config is missing',
      boundingOperatorId: null,
      boundingResource: null,
      source: 'data/workload/formal_model_manifests.json',
      blocker: blocked.blockers[0]
    };
  }
  const result = slotTimeOf(observation.modelId, candidateId);
  if (!result) {
    throw new Error(`Missing replay coverage for ${observation.modelId} TP${observation.tp} ${observation.mcProfile} ${physical}`);
  }
  return {
    ...common,
    status: 'PLANNING_ESTIMATE',
    evidenceKind: 'CALIBRATED_PLANNING_TOKEN_TIME',
    tpsPerUser: result.tpsPerUser,
    rawLatencyUsPerToken: result.rawUs,
    e2eLatencyUsPerToken: result.e2eUs,
    latencyScope: 'planning token time: max(memory x kMemory, compute x kCompute + collectives x tau) x 1.17 margin; calibrated on the K3 detailed point; not event-timed',
    boundingOperatorId: result.boundingOperatorId,
    boundingResource: {memory: 'memory_bandwidth', compute: 'compute', collective: 'collective_latency'}[result.bound],
    source: 'data/detailed/detailed_architecture_run.json',
    blocker: null
  };
});
const comparableObservations = observations.filter(item => item.status !== 'BLOCKED_CONFIG');
const blockedObservations = observations.filter(item => item.status === 'BLOCKED_CONFIG');

const summary = manifest.models.map(model => {
  const modelObservations = comparableObservations.filter(item => item.modelId === model.modelId);
  if (!planningModels[model.modelId]) {
    return {modelId: model.modelId, operatorCount: 0, minTpsPerUser: null, targetMet: null, status: 'BLOCKED_CONFIG', blocker: model.blockers[0], confidence: model.confidence};
  }
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
    collectivesPerToken: planningModels[model.modelId].collectivesPerToken,
    minTpsPerUser: Math.min(...modelObservations.map(item => item.tpsPerUser)),
    maxTpsPerUser: Math.max(...slotTimes.filter(item => item.modelId === model.modelId).map(item => item.tpsPerUser)),
    targetMet: modelObservations.every(item => item.tpsPerUser >= targetTps),
    status: 'PLANNING_ESTIMATE',
    workloadStatus: workload.provenance[model.modelId].status,
    confidence: model.confidence
  };
});

const eventArtifact = {
  schemaVersion: 'formal-event-replay-v0.2',
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
  status: blockedObservations.length ? 'PLANNING_ESTIMATES_WITH_BLOCKED_CONFIG' : 'PLANNING_ESTIMATES_COMPLETE',
  common: {...matrix.common, physicalProfile: 'P0'},
  observationStates: [...new Set([...matrix.observationStates, 'PLANNING_ESTIMATE', 'BLOCKED_CONFIG'])],
  currentCoverage: {
    totalRequired: 18,
    modelObserved: 0,
    planningEstimated: comparableObservations.length,
    blockedConfig: blockedObservations.length,
    siliconObserved: 0,
    pendingModelRun: comparableObservations.length,
    percentComplete: 0,
    planningPercentComplete: comparableObservations.length / observations.length * 100,
    note: `${comparableObservations.length} calibrated planning estimates, ${blockedObservations.length} BLOCKED_CONFIG slots; zero validated timing observations. No silicon result.`
  },
  observations
});

// Acceptance over all 18 slots cannot hold while any slot is BLOCKED_CONFIG.
const comparableMeetTarget = comparableObservations.every(item => item.tpsPerUser >= targetTps);
const comparableMeetGate = comparableObservations.every(item => item.tpsPerUser >= architectureGateTps);
const allMeetTarget = blockedObservations.length === 0 && comparableMeetTarget;
const allMeetGate = blockedObservations.length === 0 && comparableMeetGate;
const studiedSlots = slotTimes.filter(item => studied.includes(item.candidateId));
const selectedSlotsMeetTarget = selected.length ? slotTimes.filter(item => selected.includes(item.candidateId)).every(item => item.tpsPerUser >= targetTps) : null;
const studiedSlotsMeetTarget = studiedSlots.length ? studiedSlots.every(item => item.tpsPerUser >= targetTps) : null;
const performanceStatus = comparableMeetGate
  ? 'PLANNING_ESTIMATE_ABOVE_GATE_NOT_VALIDATED'
  : (studiedSlotsMeetTarget ? 'STUDIED_CANDIDATES_ABOVE_TARGET_OTHERS_MISS_NOT_VALIDATED' : 'PERFORMANCE_MISS_REQUIRES_DIRECTION_BACKFLOW');
const coverageStatus = blockedObservations.length ? 'BLOCKED_CONFIG_PARTIAL_COVERAGE' : 'COMPLETE';

const detail = {
  schemaVersion: 'detailed-architecture-run-v0.5',
  runId,
  stage: 'quantification',
  runMode,
  evidenceKind: 'CALIBRATED_PLANNING_TOKEN_TIME',
  agentId: 'Q1-Q9-orchestrator',
  sourceDirectionalRunId: directional.runId,
  selectedCandidates: selected,
  studiedCandidates: studied,
  candidateSelection: {
    source: 'data/governance/candidate_register.json',
    formal,
    exploratory: !formal,
    decision: register.decisionState,
    exploratorySweep: formal ? null : exploratorySweep.sweepId,
    decisionRecord: formal ? null : exploratorySweep.decisionRecord
  },
  manifestStatus: Object.fromEntries(manifest.models.map(model => [model.modelId, model.status])),
  manifestHash,
  tokenTime: {
    source: 'models/planning/token_time.js',
    formula: 'raw = max(memoryUs x kMemory, computeUs x kCompute + collectivesPerToken x max(tau, bytes/network)); e2e = raw x margin; TPS/usr = 1e6 / e2e',
    calibration: {kMemory: calibration.kMemory, kCompute: calibration.kCompute, margin: calibration.margin, tauUs: calibration.tauUs, slot: calibration.slot, source: calibration.source, detailedTpsPerUser: calibration.detailedTpsPerUser, calibratedTpsPerUser: calibration.calibratedTpsPerUser, validation: calibration.validation},
    mtpApplied: false,
    slots: slotTimes
  },
  operatorLedger: ledger,
  blockedCases: blockedModels.map(model => ({modelId: model.modelId, status: 'BLOCKED_CONFIG', missingConfig: model.missingConfig || [], blocker: model.blockers[0]})),
  summary,
  agentRuns: {
    Q1: {status: 'COMPLETE', output: 'formal model manifest, operator inventory and shared hash'},
    Q2: {status: 'COMPLETE', output: `arithmetic intensity, Roofline and sizing ledger for ${comparableModels.map(m => m.modelId).join(', ')}; ${blockedModels.map(m => m.modelId).join(', ') || 'no model'} BLOCKED_CONFIG`},
    Q3: {status: 'PLANNING_ONLY', output: 'tile and memory event placeholders'},
    Q4: {status: 'PLANNING_ONLY', output: 'collective packet and NoC event placeholders'},
    Q5: {status: 'PLANNING_ONLY', output: 'kernel cycle placeholders'},
    Q6: {status: 'PLANNING_ONLY', output: 'scheduler overlap and stall placeholders'},
    Q7: {status: 'PLANNING_ONLY', output: 'planning PPA and thermal envelope reconciliation'},
    Q8: {status: 'PLANNING_ONLY', output: 'K3-calibrated planning token time; no dependency-aware timing replay'},
    Q9: {status: 'COMPLETE', output: 'independent gate validator executed after artifact generation'}
  },
  observationMatrix: {
    requiredSlots: 18,
    accountedSlots: observations.length,
    all18SlotsAccounted: observations.length === 18,
    planningEstimatedSlots: comparableObservations.length,
    blockedConfigSlots: blockedObservations.length,
    status: blockedObservations.length ? 'PLANNING_COVERAGE_WITH_BLOCKED_CONFIG' : 'PLANNING_COVERAGE_ONLY'
  },
  provenance: {
    sourceCommit,
    manifestHash,
    inputHashes,
    seed: IDS.seed,
    toolVersion: 'node-formal-stage-b-v0.5',
    eventArtifact: 'data/detailed/formal_event_replay.json'
  },
  sizing: {
    targetTpsPerUser: targetTps,
    architectureGateTpsPerUser: architectureGateTps,
    utilizationAssumption: utilization,
    dutyCycleAssumption: dutyCycle,
    effectiveMemoryBandwidth: {MC320: mcProfiles.MC320.effectiveBytesPerSecond, MC640: mcProfiles.MC640.effectiveBytesPerSecond},
    networkEffectiveBandwidth: networkBandwidth,
    availableResources: Object.fromEntries(Object.entries(coreProfiles).map(([key, value]) => [key, Object.fromEntries(Object.entries(value.peakByCore).map(([core, peakFlops]) => [core, {scope: 'package_rank', peakFlops, source: value.source}]))]))
  },
  performanceAcceptance: {
    targetTpsPerUser: targetTps,
    architectureGateTpsPerUser: architectureGateTps,
    all18SlotsMeetTarget: allMeetTarget,
    all18SlotsMeetArchitectureGate: allMeetGate,
    comparableSlotsMeetTarget: comparableMeetTarget,
    comparableSlotsMeetArchitectureGate: comparableMeetGate,
    selectedCandidateSlotsMeetTarget: selectedSlotsMeetTarget,
    studiedCandidateSlotsMeetTarget: studiedSlotsMeetTarget,
    coverageStatus,
    status: performanceStatus,
    feedback: (blockedObservations.length ? `${blockedObservations.length} slots are BLOCKED_CONFIG and have no TPS. ` : '') + (comparableMeetGate
      ? 'Calibrated planning estimates clear the gate for every comparable slot; this proves nothing until validated event timing replaces them.'
      : 'Slots below target need byte reduction, more TP ranks or an implementable bandwidth route before architecture freeze.')
  },
  qGate: null,
  assumptions: [
    'All manifests are architecture planning manifests; external vendor/license confirmation remains a qualification risk.',
    'K3 operator rows are shape-derived from the repository engineering preset (absorbed MLA, FP8 KV) and reconciled to the detailed plan of the published point.',
    'DeepSeek-V4-Pro rows are derived from its manifest shape block; fields outside shape.reported are ASSUMPTIONs. MTP is excluded.',
    'GLM-5.2 rows are derived from its public config.json; the FP8 KV/index-key layout, TP mapping and collectives per layer are ASSUMPTIONs. MTP is excluded.',
    'PLANNING_ESTIMATE is the K3-calibrated planning token time, not an event-timed observation; applying the K3 factors to other models is an ASSUMPTION.',
    'Expert parallelism is not modelled: every model shards experts over the TP ranks (no all-to-all dispatch).',
    'MC320 and MC640 remain separate profiles; MC640 is not the default manufacturing claim.',
    'P0 and P1 use distinct core-class peak capacities but share utilization and duty-cycle assumptions.',
    'Q3-Q8 synthetic events are placeholders and do not drive latency.'
  ],
  nextActions: [
    'Replace the DeepSeek-V4-Pro ASSUMPTION fields with the vendor config and confirm the GLM-5.2 deployment layout (KV/index-key bytes, collectives per layer).',
    'Replace synthetic Q3-Q8 events with the dependency-aware tile/packet/kernel replay.',
    'Repeat formal replay after PPA and bandwidth direction update.'
  ]
};
write('data/detailed/detailed_architecture_run.json', detail);

const gate = writeGateStatus();
detail.qGate = gate.quantificationGate;
write('data/detailed/detailed_architecture_run.json', detail);

const report = [
  '# Stage B Planning Quantification Run',
  '',
  `Run ID: \`${runId}\``,
  `Manifest hash: \`${manifestHash}\``,
  `Run mode: \`${detail.runMode}\``,
  `Source commit: \`${sourceCommit}\``,
  '',
  '## Gate result',
  '',
  `- D-Gate: \`${gate.directionGate.decision}\``,
  `- Q-Gate: \`${gate.quantificationGate.decision}\``,
  '- Planning artifacts only. Q-Gate blocked: planning token time and synthetic events do not establish fine TPS or PPA closure.',
  ...(formal ? [] : [`- D-Gate is blocked, so this is an exploratory run (\`${exploratorySweep.sweepId}\`, ${exploratorySweep.decisionRecord}); studied candidates ${studied.map(id => `\`${id}\``).join(', ')} are not formally selected.`]),
  ...blockedModels.map(model => `- ${model.modelId}: BLOCKED_CONFIG, no TPS. Missing: ${(model.missingConfig || []).join('; ')}.`),
  '',
  '## Planning token time',
  '',
  `- \`raw = max(memory x ${calibration.kMemory.toFixed(4)}, compute x ${calibration.kCompute.toFixed(4)} + collectives x max(${calibration.tauUs} us, bytes/network))\`, \`e2e = raw x ${calibration.margin}\`.`,
  `- Calibrated on the K3 detailed point (${calibration.slot.physicalProfile}/${calibration.slot.mcProfile}/TP${calibration.slot.tp}): planning ${calibration.calibratedTpsPerUser.toFixed(2)} vs detailed ${calibration.detailedTpsPerUser.toFixed(2)}; MC320 out-of-fit ${calibration.validation.planningTpsPerUser.toFixed(2)} vs ${calibration.validation.detailedTpsPerUser.toFixed(2)}.`,
  '',
  '## Performance acceptance (planning estimates, not validated)',
  '',
  `- Target: ${targetTps} TPS/usr; architecture gate: ${architectureGateTps} TPS/usr`,
  `- All 18 slots meet target: **${allMeetTarget ? 'yes' : 'no'}**`,
  `- All 18 slots meet architecture gate: **${allMeetGate ? 'yes' : 'no'}**`,
  `- Comparable slots meet target: **${comparableMeetTarget ? 'yes' : 'no'}**; coverage: \`${coverageStatus}\``,
  `- Selected candidate slots meet target: **${selectedSlotsMeetTarget === null ? 'n/a (no formal selection)' : (selectedSlotsMeetTarget ? 'yes' : 'no')}**`,
  `- Studied candidate slots meet target: **${studiedSlotsMeetTarget === null ? 'n/a' : (studiedSlotsMeetTarget ? 'yes' : 'no')}**`,
  `- Status: \`${performanceStatus}\``,
  `- Feedback: ${detail.performanceAcceptance.feedback}`,
  '',
  '## Planning slots',
  '',
  '| Model | TP | MC | Profile | TPS/usr | bounding operator | resource |',
  '|---|---:|---|---|---:|---|---|',
  ...observations.map(item => item.status === 'BLOCKED_CONFIG'
    ? `| ${item.modelId} | ${item.tp} | ${item.mcProfile} | ${item.physicalProfile} | BLOCKED_CONFIG | - | - |`
    : `| ${item.modelId} | ${item.tp} | ${item.mcProfile} | ${item.physicalProfile} | ${item.tpsPerUser.toFixed(2)} | ${item.boundingOperatorId} | ${item.boundingResource} |`),
  '',
  '## Planning slots on P1 (token-time lanes, us)',
  '',
  '| Model | TP | MC | memory lane | compute x k | collectives | bound | TPS/usr |',
  '|---|---:|---|---:|---:|---:|---|---:|',
  ...slotTimes.filter(item => item.physicalProfile === 'P1').map(item => `| ${item.modelId} | ${item.tp} | ${item.mcProfile} | ${item.memoryLaneUs.toFixed(1)} | ${(item.computeUs * calibration.kCompute).toFixed(1)} | ${item.commUs.toFixed(1)} (${item.collectivesPerToken} x ${item.perCollectiveUs.toFixed(2)}) | ${item.bound} | ${item.tpsPerUser.toFixed(2)} |`),
  '',
  '## Agent outputs',
  '',
  ...Object.entries(detail.agentRuns).map(([agentId, item]) => `- **${agentId}**: ${item.status} - ${item.output}`),
  '',
  '## Artifacts',
  '',
  '- `data/workload/formal_model_manifests.json`',
  '- `data/workload/planning_operator_workload.json`',
  '- `data/detailed/formal_event_replay.json`',
  '- `data/workload/tps_observation_matrix.json`',
  '- `data/detailed/detailed_architecture_run.json`'
].join('\n');
fs.mkdirSync(path.join(root, 'reports/detailed'), {recursive: true});
fs.writeFileSync(path.join(root, IDS.stageBReport), `${report}\n`, 'utf8');
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
