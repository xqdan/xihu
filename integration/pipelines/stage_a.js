'use strict';
/* Stage A: directional candidate comparison with the formal planning manifest.
 *
 * Inputs : teams/model/inputs/formal_model_manifests.json (hash-bound)
 *          out/workload/planning_operator_workload.json (K3 shape-derived,
 *            GLM-5.2 derived from its public config.json, DeepSeek-V4-Pro
 *            shape-derived with assumptions; a model without config is BLOCKED_CONFIG,
 *            plus the K3-calibrated token-time factors)
 *          teams/hardware/src/resource_profiles.js (P0 and P1 are distinct)
 *          integration/planning/token_time.js (planning token time per slot)
 * Outputs: out/direction/directional_resource_envelope.json (base record from
 *            integration/planning/directional_envelope.js)
 *          out/direction/directional_tps_scorecard.json
 *          out/direction/sensitivity_sweep.json
 *          out/governance/candidate_register.json
 *          out/governance/formal_manifest_binding.json
 *          out/governance/gate_status.json (via the independent validator)
 *          out/direction/stage_a_blocker_resolution_<date>.md
 *
 * The D-Gate decision and the candidate register state are COMPUTED by
 * integration/governance/evaluate_gates.js. This runner never writes a decision
 * literal. Candidate selection is computed from the scorecard by an explicit
 * policy (see selectCandidates) rather than hard-coded.
 *
 * Each slot also carries (ADR-0008): TPS/usr at tau 1.15 / 1.5 / 2.0 us, the
 * DeepSeek-V4-Pro expert-hidden range, the model's weight dtype policy, and a
 * K3 FP8-dense comparison row that is never ranked.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const {execFileSync} = require('child_process');
const {evaluateDirectionGate, writeGateStatus} = require('../governance/evaluate_gates');
const RES = require('../../teams/hardware/src/resource_profiles');
const TT = require('../planning/token_time');
const ENVELOPE = require('../planning/directional_envelope');
const IDS = require('../planning/run_ids');

const root = path.resolve(__dirname, '../..');
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

const manifestPath = 'teams/model/inputs/formal_model_manifests.json';
const manifest = read(manifestPath);
const manifestHash = hashFile(manifestPath);
const profile = read('teams/model/inputs/model_profiles.json');
const packageSpec = read('teams/hardware/inputs/k3_7r_package_baseline.json');
const workload = read('out/workload/planning_operator_workload.json');
const sourceInputs = {
  manifest: manifestHash,
  operatorWorkload: hashFile('out/workload/planning_operator_workload.json'),
  runner: hashFile('integration/pipelines/stage_a.js'),
  resourceProfiles: hashFile('teams/hardware/src/resource_profiles.js'),
  tokenTime: hashFile('integration/planning/token_time.js'),
  envelope: hashFile('integration/planning/directional_envelope.js'),
  gateValidator: hashFile('integration/governance/evaluate_gates.js'),
  modelProfiles: hashFile('teams/model/inputs/model_profiles.json'),
  packageSpec: hashFile('teams/hardware/inputs/k3_7r_package_baseline.json'),
  mcSpec: hashFile('teams/hardware/inputs/k3_mc_baseline.json')
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

const dtypeLabel = modelId => {
  const d = workload.dtypePolicy[modelId];
  return `dense ${d.attentionAndDenseProjections}, router/LM head ${d.routerAndLmHead.split(' ')[0]}, routed ${d.routedExpert.split(' ')[0]}`;
};
const candidates = [];
const comparisonRows = [];
for (const physicalProfile of ['P0', 'P1']) {
  for (const mcProfile of ['MC320', 'MC640']) {
    for (const tp of [8, 16, 32]) {
      const slot = {tp, physicalProfile, mcProfile};
      for (const [comparisonId, c] of Object.entries(workload.comparisons || {})) {
        const t = TT.slotTime(c, slot, calibration);
        comparisonRows.push({comparisonId, baseModelId: c.baseModelId, candidateId: RES.candidateIdFor(physicalProfile, mcProfile, tp), ...slot, tpsPerUser: t.tpsPerUser, bound: t.bound, ranked: false});
      }
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
        const tau = TT.tauSensitivity(planning, slot, calibration);
        const variants = Object.keys((workload.variants || {})[model.modelId] || {}).map(variant => {
          const v = TT.slotTime(TT.planningModel(workload, model.modelId, variant), slot, calibration);
          return {variant, tpsPerUser: v.tpsPerUser, bound: v.bound};
        });
        const shapeTps = [t.tpsPerUser, ...variants.map(v => v.tpsPerUser)];
        candidates.push({
          ...base,
          workloadUnits: {
            flopsPerToken: planning.rows.reduce((a, r) => a + r[2], 0) / tp,
            memoryBytesPerToken: planning.rows.filter(r => r[4] !== 'collective').reduce((a, r) => a + r[3], 0) / tp,
            collectiveBytesPerToken: planning.rows.filter(r => r[4] === 'collective').reduce((a, r) => a + r[3], 0) / tp,
            collectivesPerToken: t.collectivesPerToken,
            effectiveBytesPerSecond: mcProfiles[mcProfile].effectiveBytesPerSecond,
            source: 'out/workload/planning_operator_workload.json',
            scope: 'model_total_per_rank'
          },
          memoryTimeUs: t.memoryUs,
          expertMemoryTimeUs: t.expertMemoryUs,
          computeTimeUs: t.computeUs,
          computeTimeUsByCore: t.computeUsByCore,
          commTimeUs: t.commUs,
          memoryLaneUs: t.memoryLaneUs,
          serialSplitUs: {flop: t.flopUs, fixed: t.fixedUs, tmaExposed: t.tmaExposedUs},
          serialComputeUs: t.serialComputeUs,
          serialLaneUs: t.serialLaneUs,
          rawLatencyUsPerToken: t.rawUs,
          e2eLatencyUsPerToken: t.e2eUs,
          tpsPerUser: t.tpsPerUser,
          uncalibratedTpsPerUser: t.uncalibratedTpsPerUser,
          bottleneck: t.bound,
          boundingOperatorId: TT.boundingOperator(planning, slot, t),
          tauSensitivity: tau,
          tpsPerUserTauRange: {min: Math.min(...tau.map(x => x.tpsPerUser)), max: Math.max(...tau.map(x => x.tpsPerUser))},
          maxTauUsForTarget: TT.maxTauForTarget(planning, slot, calibration, target),
          rereadSensitivity: TT.rereadSensitivity(planning, slot, calibration),
          shapeVariants: variants,
          tpsPerUserShapeRange: {min: Math.min(...shapeTps), max: Math.max(...shapeTps)},
          dtypePolicy: dtypeLabel(model.modelId),
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
    minTpsPerUserAtMaxTau: Math.min(...comparable.map(row => row.tauSensitivity[row.tauSensitivity.length - 1].tpsPerUser)),
    minTpsPerUserLowerShape: Math.min(...comparable.map(row => row.tpsPerUserShapeRange.min)),
    // Largest tau at which every comparable model still reaches the target (null: misses at any tau).
    maxTauUsForTarget: comparable.some(row => row.maxTauUsForTarget === null) ? null : Math.min(...comparable.map(row => row.maxTauUsForTarget)),
    meetsArchitectureGate: worst.tpsPerUser >= architectureGate,
    geomeanTpsPerUser: Math.exp(comparable.reduce((sum, row) => sum + Math.log(row.tpsPerUser), 0) / comparable.length),
    worstModel: worst.modelId,
    meetsTargetModels: comparable.filter(row => row.tpsPerUser >= target).map(row => row.modelId),
    missesTargetModels: comparable.filter(row => row.tpsPerUser < target).map(row => ({modelId: row.modelId, tpsPerUser: row.tpsPerUser, fractionOfTarget: row.tpsPerUser / target})),
    rankingBasis: 'comparable models only; BLOCKED_CONFIG models are excluded, not assumed',
    rankingEligible: comparable.length > 0
  };
});

// Selection policy (machine-applied, recorded in selectionBasis.policy; ADR-0008):
//   rank candidates by worst-model planning TPS bound (descending, ties by id);
//   a candidate is formally eligible only if EVERY comparable model reaches the
//   target (sharedDecodeTargetTpsPerUser, not the architecture gate) at the tau
//   point estimate, so one model missing badly cannot hide behind the others;
//   take at most three eligible candidates in rank order. The tau range does not
//   gate selection: each candidate records maxTauUsForTarget and is flagged
//   tau-conditional when that is below the top of TAU_SENSITIVITY_US. The best MC320
//   candidate is kept as a non-formal reference with its misses listed. With no
//   eligible candidate the formal selection is empty (the D-Gate blocks) and the
//   exploratory candidates are the three best by rank.
const byBound = (a, b) => b.minTpsPerUser - a.minTpsPerUser || a.candidateId.localeCompare(b.candidateId);
const TAU_TOP_US = TT.TAU_SENSITIVITY_US[TT.TAU_SENSITIVITY_US.length - 1];
const SELECTION_POLICY = `rank by worst comparable-model planning TPS; formally eligible only if every comparable model reaches the ${target} TPS/usr target (not the ${architectureGate} architecture gate) at the tau point estimate ${TT.TAU_US} us; at most three eligible candidates; the tau range is a risk annotation, not a selection criterion: each candidate records the largest tau at which every model still reaches the target and is tau-conditional below ${TAU_TOP_US} us; the best MC320 candidate is a non-formal reference`;
const tauConditional = item => item.maxTauUsForTarget !== null && item.maxTauUsForTarget < TAU_TOP_US;
function selectCandidates(summaries) {
  const ranked = summaries.filter(item => item.rankingEligible).sort(byBound);
  const formal = ranked.filter(item => item.minTpsPerUser >= target).slice(0, 3).map(item => item.candidateId);
  const bestMc320 = ranked.find(item => item.mcProfile === 'MC320');
  const reference = bestMc320 && !formal.includes(bestMc320.candidateId)
    ? [{candidateId: bestMc320.candidateId, role: 'MC320_REFERENCE_NOT_FORMAL', minTpsPerUser: bestMc320.minTpsPerUser, worstModel: bestMc320.worstModel, missesTargetModels: bestMc320.missesTargetModels}]
    : [];
  return {formal, reference, exploratory: formal.length ? formal : ranked.slice(0, 3).map(item => item.candidateId)};
}
const selection = selectCandidates(candidateSummaries);
const selected = selection.formal;

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
  ...ENVELOPE.build({runId}),
  confidence: 'E1',
  status: 'DIRECTIONAL_ESTIMATE_WITH_FORMAL_PLANNING_MANIFEST',
  assumptions: [
    'Formal planning manifests are frozen in teams/model/inputs/formal_model_manifests.json.',
    'K3 planning operators are derived from teams/model/src/design_engine.js (kimiK3 preset) and reconciled to the detailed plan of the published point.',
    'Planning token time = max(memory lane, serial lane) x 1.17 with memory lane = kMemory x (bytes + expertReread x routed bytes) / BW and serial lane = kFlop x FLOP time + fixedPerLayerUs x layers + kTmaExposedUsPerGB x GB + collectives x tau; every factor is fitted on the K3 detailed timing breakdown (ADR-0008).',
    'tau is reported at 1.15 / 1.5 / 2.0 us until B-008 derives it physically; the point estimate uses 1.15 us and alone decides selection; the range is a risk annotation (maxTauUsForTarget per candidate).',
    'expertReread = 0.20 is the detailed model input 1 - prediction accuracy 0.8, applied to every model (ASSUMPTION); rereadSensitivity reports accuracy 0.7 / 0.8 / 0.9.',
    'kFlop is fitted on K3 L/H/V/REDUCE work only; applying it to the INDEXER core class (GLM-5.2, DeepSeek-V4-Pro) is an extrapolation. fixedPerLayerUs nets out the K3 shared-expert comm overlap (26.27 us).',
    'Dense weight dtype differs by model (K3 BF16; GLM-5.2 and DeepSeek-V4-Pro FP8 with BF16 router and LM head); K3-FP8-dense is a comparison row only.',
    'DeepSeek-V4-Pro TPS/usr is a range over the expert hidden solved from 49B active (point) and from 1.6T total (variant).',
    'DeepSeek-V4-Pro rows are derived from its manifest shape block; fields outside shape.reported are ASSUMPTIONs.',
    'GLM-5.2 rows are derived from its public config.json; the FP8 KV/index-key layout and collectives per layer are ASSUMPTIONs.',
    'FFN/MoE is deployed TP-only for all three models (deployment decision): every expert is sharded over the TP ranks; no expert parallelism, no all-to-all.',
    'MC320 and MC640 remain separate physical bandwidth profiles.',
    'P0 and P1 use distinct core-class peak capacities (teams/hardware/src/resource_profiles.js).'
  ]
};
env.packageEnvelope = {...env.packageEnvelope, areaConservation};

const direction = {
  schemaVersion: 'directional-tps-scorecard-v0.5',
  runId,
  stage: 'direction',
  agentId: 'D7',
  targetTpsPerUser: target,
  architectureGateTpsPerUser: architectureGate,
  candidateLimitAfterGate: 3,
  candidateCount: candidates.length,
  selectedCandidateIds: selected,
  referenceCandidates: selection.reference,
  status: 'DIRECTIONAL_ESTIMATE',
  confidence: 'E1',
  manifestHash,
  inputHashes: sourceInputs,
  resourceProfiles: Object.fromEntries(Object.entries(coreProfiles).map(([key, value]) => [key, {id: value.id, lCoresPerDie: value.lCoresPerDie, hCoresPerDie: value.hCoresPerDie, ghz: value.ghz, engine: value.engine, peakByCore: value.peakByCore, source: value.source}])),
  mcProfiles: Object.fromEntries(Object.entries(mcProfiles).map(([key, value]) => [key, {rawPayloadTBs: value.rawPayloadTBs, sustainedAssumption: value.sustainedAssumption, effectiveBytesPerSecond: value.effectiveBytesPerSecond, classification: value.classification}])),
  dtypePolicy: workload.dtypePolicy,
  tauSensitivityUs: TT.TAU_SENSITIVITY_US,
  candidates,
  candidateSummaries,
  comparisonRows,
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
  schemaVersion: 'candidate-register-v0.4',
  updatedAt: `${IDS.RUN_DATE}T00:00:00.000Z`,
  sourceDirectionalRunId: runId,
  decisionState: dGate.decision === 'PASS' ? 'D_GATE_PASSED' : 'D_GATE_BLOCKED',
  decisionSource: 'integration/governance/evaluate_gates.js#evaluateDirectionGate',
  formalSelectedCandidates: dGate.decision === 'PASS' ? selected : [],
  selectionBasis: {
    targetTpsPerUser: target,
    architectureGateTpsPerUser: architectureGate,
    policy: SELECTION_POLICY,
    eligibilityFloorTpsPerUser: target,
    blockedModels: dGate.blockedModels,
    ranking: candidateSummaries.slice().sort(byBound).map(item => ({candidateId: item.candidateId, minTpsPerUser: item.minTpsPerUser, worstModel: item.worstModel, formallyEligible: item.minTpsPerUser >= target, meetsArchitectureGate: item.meetsArchitectureGate, minTpsPerUserAtMaxTau: item.minTpsPerUserAtMaxTau, maxTauUsForTarget: item.maxTauUsForTarget, tauConditional: tauConditional(item)})),
    referenceCandidates: selection.reference,
    tauConditionalCandidates: selected.filter(id => tauConditional(candidateSummaries.find(item => item.candidateId === id))),
    selected: selected.map(candidateId => candidates.filter(item => item.candidateId === candidateId))
  },
  exploratorySweeps: [{
    sweepId: 'ADR-0006-exploratory-after-blocked-d-gate',
    runMode: 'EXPLORATORY_AFTER_BLOCKED_D_GATE',
    active: dGate.decision !== 'PASS',
    candidateIds: selection.exploratory,
    allowedModels: manifest.models.filter(model => TT.planningModel(workload, model.modelId)).map(model => model.modelId),
    decisionRecord: 'teams/council/adr/ADR-0006-planning-token-time-and-blocked-glm.md'
  }, {
    sweepId: 'ADR-0002-formal-manifest-sensitivity-sweep',
    runMode: 'FORMAL_DIRECTIONAL_SWEEP',
    candidateIds,
    allowedModels: manifest.models.map(model => model.modelId),
    decisionRecord: 'teams/council/adr/ADR-0002-formal-manifest-and-sensitivity-closure.md'
  }]
};
direction.dGate = evaluateDirectionGate(env, direction, register);

write('out/direction/directional_tps_scorecard.json', direction);
write('out/governance/candidate_register.json', register);
write('out/governance/formal_manifest_binding.json', {
  schemaVersion: 'formal-manifest-binding-v0.1',
  manifestPath,
  manifestHash,
  sourceCommit,
  inputHashes: sourceInputs,
  boundModels: manifest.models.map(model => model.modelId),
  boundCandidates: register.formalSelectedCandidates,
  status: register.decisionState === 'D_GATE_PASSED' ? 'BOUND_FOR_FORMAL_STAGE_B' : 'NOT_BOUND_D_GATE_BLOCKED'
});
write('out/direction/sensitivity_sweep.json', {
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
write('out/direction/directional_resource_envelope.json', env);
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
  '## Planning token time (integration/planning/token_time.js)',
  '',
  '`memory lane = kMemory x (bytes + expertReread x routed bytes) / TP / BW`; `serial lane = kFlop x FLOP time + fixedPerLayerUs x layers + kTmaExposedUsPerGB x GB/rank + collectives x max(tau, bytes/network)`; `raw = max(memory lane, serial lane)`, `e2e = raw x 1.17`, `TPS/usr = 1e6 / e2e` (ADR-0008).',
  '',
  `- Calibration on the K3 detailed timing breakdown (${calibration.slot.physicalProfile}/${calibration.slot.mcProfile}/TP${calibration.slot.tp}): expertReread ${calibration.expertReread.toFixed(3)}, kMemory ${calibration.kMemory.toFixed(4)}, kFlop ${calibration.kFlop.toFixed(4)}, fixedPerLayerUs ${calibration.fixedPerLayerUs.toFixed(4)}, kTmaExposedUsPerGB ${calibration.kTmaExposedUsPerGB.toFixed(3)}; planning ${calibration.calibratedTpsPerUser.toFixed(2)} vs detailed ${calibration.detailedTpsPerUser.toFixed(2)} TPS/usr (raw residual ${calibration.rawResidualUs.toFixed(2)} us). The ADR-0006 single factor kCompute ${calibration.legacyKCompute.toFixed(4)} is kept for comparison only.`,
  `- Out-of-fit check at MC320: planning ${calibration.validation.planningTpsPerUser.toFixed(2)} vs detailed ${calibration.validation.detailedTpsPerUser.toFixed(2)} TPS/usr (ratio ${calibration.validation.planningOverDetailed.toFixed(3)}).`,
  `- K3 rows are derived from \`teams/model/src/design_engine.js\` (kimiK3 preset) with absorbed MLA and FP8 KV; FLOP ratio vs detailed plan ${k3.flopsRatioDerivedOverCalibrated.toFixed(3)}, byte ratio ${k3.bytesRatioDerivedOverCalibrated.toFixed(3)}.`,
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
  '| Candidate | Model | dtype | memory lane us | FLOP / fixed / TMA us | collective us | bound | TPS/usr | tau 1.15 / 1.5 / 2.0 | shape range |',
  '|---|---|---|---:|---:|---:|---|---:|---|---|',
  ...candidates.map(c => c.status === 'BLOCKED_CONFIG'
    ? `| ${c.candidateId} | ${c.modelId} | - | - | - | - | - | BLOCKED_CONFIG | - | - |`
    : `| ${c.candidateId} | ${c.modelId} | ${c.dtypePolicy} | ${c.memoryLaneUs.toFixed(1)} | ${c.serialSplitUs.flop.toFixed(1)} / ${c.serialSplitUs.fixed.toFixed(1)} / ${c.serialSplitUs.tmaExposed.toFixed(1)} | ${c.commTimeUs.toFixed(1)} | ${c.bottleneck} | ${fmt(c.tpsPerUser)} | ${c.tauSensitivity.map(x => x.tpsPerUser.toFixed(1)).join(' / ')} | ${c.shapeVariants.length ? `${c.tpsPerUserShapeRange.min.toFixed(1)} - ${c.tpsPerUserShapeRange.max.toFixed(1)}` : '-'} |`),
  '',
  '- tau columns: the point estimate uses tau 1.15 us and alone decides selection; 1.5 and 2.0 us are risk columns until B-008 derives tau physically.',
  '- shape range: DeepSeek-V4-Pro expert hidden solved from 49B active (point) and from 1.6T total (variant `expertHiddenFromTotal`).',
  '',
  '## Comparison rows (not ranked, not selectable)',
  '',
  '| Comparison | Candidate | TPS/usr | bound | base model TPS/usr |',
  '|---|---|---:|---|---:|',
  ...comparisonRows.map(c => `| ${c.comparisonId} | ${c.candidateId} | ${c.tpsPerUser.toFixed(2)} | ${c.bound} | ${fmt(candidates.find(x => x.candidateId === c.candidateId && x.modelId === c.baseModelId).tpsPerUser)} |`),
  '',
  '## Candidate ranking (worst comparable-model planning TPS)',
  '',
  `Policy: ${SELECTION_POLICY}.`,
  '',
  `| Candidate | worst model | min TPS | min TPS at tau ${TAU_TOP_US} | max tau for target (us) | >= ${architectureGate} gate | formally eligible |`,
  '|---|---|---:|---:|---:|---|---|',
  ...register.selectionBasis.ranking.map(item => `| ${item.candidateId} | ${item.worstModel} | ${item.minTpsPerUser.toFixed(2)} | ${item.minTpsPerUserAtMaxTau.toFixed(2)} | ${item.maxTauUsForTarget === null ? 'misses at any tau' : item.maxTauUsForTarget.toFixed(3)} | ${item.meetsArchitectureGate ? 'yes' : 'no'} | ${item.formallyEligible ? (item.tauConditional ? 'yes (tau-conditional)' : 'yes') : 'no'} |`),
  '',
  '## Selected candidates',
  '',
  ...(register.formalSelectedCandidates.length ? register.formalSelectedCandidates.map(candidateId => {
    const item = candidateSummaries.find(x => x.candidateId === candidateId);
    return `- \`${candidateId}\`: worst ${item.worstModel} ${item.minTpsPerUser.toFixed(2)} TPS/usr${tauConditional(item) ? `; tau-conditional, reaches the target only while tau <= ${item.maxTauUsForTarget.toFixed(3)} us` : ''}`;
  }) : ['- none (no candidate reaches the target for every model, or the D-Gate is blocked)']),
  ...(register.formalSelectedCandidates.length ? [] : ['', `Exploratory Stage B candidates (policy-ranked, not formally selected): ${selection.exploratory.map(id => `\`${id}\``).join(', ')}`]),
  ...selection.reference.map(r => `- Reference (not formal): \`${r.candidateId}\`, worst ${r.worstModel} ${r.minTpsPerUser.toFixed(2)} TPS/usr; misses: ${r.missesTargetModels.map(m => `${m.modelId} ${m.tpsPerUser.toFixed(1)} (${(m.fractionOfTarget * 100).toFixed(0)}%)`).join(', ')}.`),
  ''
].join('\n');
fs.mkdirSync(path.join(root, 'out/direction'), {recursive: true});
fs.writeFileSync(path.join(root, IDS.stageAReport), `${report}\n`, 'utf8');
console.log(JSON.stringify({runId, manifestHash, candidateCount: candidates.length, selected: register.formalSelectedCandidates, reference: selection.reference.map(r => r.candidateId), dGate: gateStatus.directionGate.decision, sweepSamples: sweep.length, feasibleCount: sweepSummary.feasibleCount}, null, 2));
