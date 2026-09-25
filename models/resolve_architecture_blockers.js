'use strict';
/* Stage A: directional candidate comparison with the formal planning manifest.
 *
 * Inputs : data/workload/formal_model_manifests.json (hash-bound)
 *          data/workload/planning_operator_workload.json (K3 shape-derived,
 *            GLM-5.2 derived from its public config.json, DeepSeek-V4-Pro
 *            shape-derived with assumptions; a model without config is BLOCKED_CONFIG,
 *            plus the K3-calibrated token-time factors)
 *          models/planning/resource_profiles.js (P0 and P1 are distinct)
 *          models/planning/token_time.js (planning token time per slot)
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
  tokenTime: hashFile('models/planning/token_time.js'),
  gateValidator: hashFile('models/governance/evaluate_gates.js'),
  modelProfiles: hashFile('data/workload/model_profiles.json'),
  packageSpec: hashFile('docs/design/spec/k3_7r_package_baseline.json'),
  mcSpec: hashFile('docs/design/spec/k3_mc_baseline.json')
};

const {coreProfiles, mcProfiles} = RES;
const calibration = workload.calibration;
const target = profile.policy.sharedDecodeTargetTpsPerUser;
const architectureGate = profile.policy.sharedArchitectureGateTpsPerUser;
const runId = IDS.stageARunId;

const axes = [
  {name: 'bandwidth', values: [0.80, 1.00, 1.20]},
  {name: 'computeCapacity', values: [0.85, 1.00, 1.15]},
  {name: 'compute', values: [0.95, 1.00, 1.05]},
  {name: 'bytes', values: [0.80, 1.00, 1.20]},
  {name: 'network', values: [0.80, 1.00, 1.20]}
];
// Sensitivity sweep around the published K3 point (P1/MC640/TP32, the calibration slot).
const SWEEP_SLOT = calibration.slot;
const k3Model = TT.planningModel(workload, 'K3');
const sweep = [];
for (const bandwidth of axes[0].values) {
  for (const computeCapacity of axes[1].values) {
    for (const compute of axes[2].values) {
      for (const bytes of axes[3].values) {
        for (const network of axes[4].values) {
          const t = TT.slotTime(k3Model, SWEEP_SLOT, calibration, {bandwidth, computeCapacity, compute, bytes, network});
          sweep.push({axes: {bandwidth, computeCapacity, compute, bytes, network}, tpsPerUser: t.tpsPerUser, bound: t.bound, memoryLaneUs: t.memoryLaneUs, serialLaneUs: t.serialLaneUs, feasible: t.tpsPerUser >= target});
        }
      }
    }
  }
}

const candidates = [];
for (const physicalProfile of ['P0', 'P1']) {
  for (const mcProfile of ['MC320', 'MC640']) {
    for (const tp of [8, 16, 32]) {
      const slot = {tp, physicalProfile, mcProfile};
      for (const model of manifest.models) {
        const base = {
          candidateId: RES.candidateIdFor(physicalProfile, mcProfile, tp),
          modelId: model.modelId,
          tp,
          physicalProfile,
          mcProfile,
          confidence: model.confidence,
          manifestHash
        };
        const planning = TT.planningModel(workload, model.modelId);
        if (!planning) {
          candidates.push({...base, tpsPerUser: null, bottleneck: null, status: 'BLOCKED_CONFIG', blocker: model.blockers[0]});
          continue;
        }
        const t = TT.slotTime(planning, slot, calibration);
        candidates.push({
          ...base,
          workloadUnits: {
            flopsPerToken: planning.rows.reduce((a, r) => a + r[2], 0) / tp,
            memoryBytesPerToken: planning.rows.filter(r => r[4] !== 'collective').reduce((a, r) => a + r[3], 0) / tp,
            collectiveBytesPerToken: planning.rows.filter(r => r[4] === 'collective').reduce((a, r) => a + r[3], 0) / tp,
            collectivesPerToken: t.collectivesPerToken,
            effectiveBytesPerSecond: mcProfiles[mcProfile].effectiveBytesPerSecond,
            source: 'data/workload/planning_operator_workload.json',
            scope: 'model_total_per_rank'
          },
          memoryTimeUs: t.memoryUs,
          computeTimeUs: t.computeUs,
          computeTimeUsByCore: t.computeUsByCore,
          commTimeUs: t.commUs,
          memoryLaneUs: t.memoryLaneUs,
          serialLaneUs: t.serialLaneUs,
          rawLatencyUsPerToken: t.rawUs,
          e2eLatencyUsPerToken: t.e2eUs,
          tpsPerUser: t.tpsPerUser,
          uncalibratedTpsPerUser: t.uncalibratedTpsPerUser,
          bottleneck: t.bound,
          boundingOperatorId: TT.boundingOperator(planning, slot, t),
          status: 'PLANNING_ESTIMATE'
        });
      }
    }
  }
}

const candidateIds = [...new Set(candidates.map(item => item.candidateId))];
const candidateSummaries = candidateIds.map(candidateId => {
  const rows = candidates.filter(item => item.candidateId === candidateId);
  const comparable = rows.filter(row => row.status !== 'BLOCKED_CONFIG');
  const worst = comparable.reduce((a, b) => a.tpsPerUser < b.tpsPerUser ? a : b);
  return {
    candidateId,
    physicalProfile: rows[0].physicalProfile,
    mcProfile: rows[0].mcProfile,
    tp: rows[0].tp,
    accountedModelCount: rows.length,
    comparableModelCount: comparable.length,
    comparableModels: comparable.map(row => row.modelId),
    blockedModels: rows.filter(row => row.status === 'BLOCKED_CONFIG').map(row => row.modelId),
    minTpsPerUser: worst.tpsPerUser,
    geomeanTpsPerUser: Math.exp(comparable.reduce((sum, row) => sum + Math.log(row.tpsPerUser), 0) / comparable.length),
    worstModel: worst.modelId,
    meetsTargetModels: comparable.filter(row => row.tpsPerUser >= target).map(row => row.modelId),
    rankingBasis: 'comparable models only; BLOCKED_CONFIG models are excluded, not assumed',
    rankingEligible: comparable.length > 0
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
  scope: `K3/${SWEEP_SLOT.physicalProfile}/${SWEEP_SLOT.mcProfile}/TP${SWEEP_SLOT.tp} (the calibration slot) planning token time; excludes area and power`,
  dimensions: axes.map(axis => axis.name),
  sampleCount: sweep.length,
  feasibleCount: sweep.filter(item => item.feasible).length,
  minTpsPerUser: Math.min(...sweep.map(item => item.tpsPerUser)),
  maxTpsPerUser: Math.max(...sweep.map(item => item.tpsPerUser)),
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
    'K3 planning operators are derived from src/core/design_engine.js (kimiK3 preset) and reconciled to the detailed plan of the published point.',
    'Planning token time = max(memory lane x kMemory, compute x kCompute + collectives x tau) x 1.17; kMemory/kCompute are fitted on the K3 detailed point.',
    'DeepSeek-V4-Pro rows are derived from its manifest shape block; fields outside shape.reported are ASSUMPTIONs.',
    'GLM-5.2 rows are derived from its public config.json; the FP8 KV/index-key layout, TP mapping and collectives per layer are ASSUMPTIONs.',
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
  resourceProfiles: Object.fromEntries(Object.entries(coreProfiles).map(([key, value]) => [key, {id: value.id, lCoresPerDie: value.lCoresPerDie, hCoresPerDie: value.hCoresPerDie, ghz: value.ghz, engine: value.engine, peakByCore: value.peakByCore, source: value.source}])),
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
    policy: 'rank by worst comparable-model planning TPS; take the two best overall plus the best MC320 reference candidate; at most three',
    blockedModels: dGate.blockedModels,
    ranking: candidateSummaries.slice().sort(byBound).map(item => ({candidateId: item.candidateId, minTpsPerUser: item.minTpsPerUser, worstModel: item.worstModel})),
    selected: selected.map(candidateId => candidates.filter(item => item.candidateId === candidateId))
  },
  exploratorySweeps: [{
    sweepId: 'ADR-0006-exploratory-after-blocked-d-gate',
    runMode: 'EXPLORATORY_AFTER_BLOCKED_D_GATE',
    active: dGate.decision !== 'PASS',
    candidateIds: selected,
    allowedModels: manifest.models.filter(model => TT.planningModel(workload, model.modelId)).map(model => model.modelId),
    decisionRecord: 'docs/design/decisions/ADR-0006-planning-token-time-and-blocked-glm.md'
  }, {
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
const ds = workload.provenance['DeepSeek-V4-Pro'].derivation;
const glm = workload.provenance['GLM-5.2'].derivation;
const fmt = (v, d = 2) => (v === null ? 'BLOCKED_CONFIG' : v.toFixed(d));
const report = [
  '# Stage A blocker resolution run',
  '',
  `Run ID: \`${runId}\``,
  `Manifest hash: \`${manifestHash}\``,
  `Source commit: \`${sourceCommit}\``,
  '',
  '## Planning token time (models/planning/token_time.js)',
  '',
  '`raw = max(memory lane x kMemory, compute x kCompute + collectives x max(tau, bytes/network))`, `e2e = raw x 1.17`, `TPS/usr = 1e6 / e2e`.',
  '',
  `- Calibration on the K3 detailed point (${calibration.slot.physicalProfile}/${calibration.slot.mcProfile}/TP${calibration.slot.tp}): kMemory ${calibration.kMemory.toFixed(4)}, kCompute ${calibration.kCompute.toFixed(4)}; planning ${calibration.calibratedTpsPerUser.toFixed(2)} vs detailed ${calibration.detailedTpsPerUser.toFixed(2)} TPS/usr (raw residual ${calibration.rawResidualUs.toFixed(2)} us).`,
  `- Out-of-fit check at MC320: planning ${calibration.validation.planningTpsPerUser.toFixed(2)} vs detailed ${calibration.validation.detailedTpsPerUser.toFixed(2)} TPS/usr (ratio ${calibration.validation.planningOverDetailed.toFixed(3)}).`,
  `- K3 rows are derived from \`src/core/design_engine.js\` (kimiK3 preset) with absorbed MLA and FP8 KV; FLOP ratio vs detailed plan ${k3.flopsRatioDerivedOverCalibrated.toFixed(3)}, byte ratio ${k3.bytesRatioDerivedOverCalibrated.toFixed(3)}.`,
  `- DeepSeek-V4-Pro rows are derived from the manifest shape block (reported fields + ASSUMPTIONs); expert hidden solved from 49B active = ${ds.expertHidden.toFixed(1)}, implied total / reported 1600B = ${ds.impliedTotalOverReported.toFixed(3)}; MTP excluded.`,
  `- GLM-5.2 rows are derived from the public config.json (78 layers, 21 full-indexer layers, 256 experts top-8); parameters with MTP / reported 753B = ${glm.totalWithMtpOverReported.toFixed(4)}, active ${(glm.activeParams / 1e9).toFixed(2)}B; MTP excluded. Applying the K3 factors to GLM-5.2 and DeepSeek-V4-Pro is a planning ASSUMPTION.`,
  '',
  '## D-Gate (independent validator)',
  '',
  '```json',
  JSON.stringify(gateStatus.directionGate, null, 2),
  '```',
  '',
  `- Planning sweep: ${sweep.length} samples around K3/${SWEEP_SLOT.physicalProfile}/${SWEEP_SLOT.mcProfile}/TP${SWEEP_SLOT.tp}; ${sweepSummary.feasibleCount} reach ${target} TPS/usr. This does not cover all D2-D6 physical axes.`,
  `- Blocked models: ${dGate.blockedModels.length ? dGate.blockedModels.join(', ') : 'none'}. A BLOCKED_CONFIG model keeps the three-model comparison open, blocks the D-Gate and sends Stage B to EXPLORATORY_AFTER_BLOCKED_D_GATE (ADR-0006).`,
  `- Candidate register state: \`${register.decisionState}\` (derived from the validator, not written by this runner).`,
  '',
  '## Remaining qualification',
  '',
  '- External model/license confirmation remains a qualification risk, not an implicit configuration.',
  '- Event-level Q3-Q8 replay and fine TPS remain required before silicon sign-off.',
  '- Planning TPS values are calibrated to the K3 detailed point but are not event-timed; they do not replace the detailed model.',
  '',
  '## Planning TPS/usr per slot',
  '',
  '| Candidate | Model | memory lane us | compute us | collective us | bound | TPS/usr |',
  '|---|---|---:|---:|---:|---|---:|',
  ...candidates.map(c => c.status === 'BLOCKED_CONFIG'
    ? `| ${c.candidateId} | ${c.modelId} | - | - | - | - | BLOCKED_CONFIG |`
    : `| ${c.candidateId} | ${c.modelId} | ${c.memoryLaneUs.toFixed(1)} | ${(c.computeTimeUs * calibration.kCompute).toFixed(1)} | ${c.commTimeUs.toFixed(1)} | ${c.bottleneck} | ${fmt(c.tpsPerUser)} |`),
  '',
  '## Candidate ranking (worst comparable-model planning TPS)',
  '',
  '| Candidate | worst model | min TPS |',
  '|---|---|---:|',
  ...register.selectionBasis.ranking.map(item => `| ${item.candidateId} | ${item.worstModel} | ${item.minTpsPerUser.toFixed(2)} |`),
  '',
  '## Selected candidates',
  '',
  ...(register.formalSelectedCandidates.length ? register.formalSelectedCandidates.map(candidateId => `- \`${candidateId}\``) : ['- none (D-Gate blocked)']),
  ...(register.formalSelectedCandidates.length ? [] : ['', `Exploratory Stage B candidates (policy-ranked, not formally selected): ${selected.map(id => `\`${id}\``).join(', ')}`]),
  ''
].join('\n');
fs.mkdirSync(path.join(root, 'reports/direction'), {recursive: true});
fs.writeFileSync(path.join(root, IDS.stageAReport), `${report}\n`, 'utf8');
console.log(JSON.stringify({runId, manifestHash, candidateCount: candidates.length, selected: register.formalSelectedCandidates, dGate: gateStatus.directionGate.decision, sweepSamples: sweep.length, feasibleCount: sweepSummary.feasibleCount}, null, 2));
