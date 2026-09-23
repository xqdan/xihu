'use strict';

const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '../..');
const read = relativePath => JSON.parse(
  fs.readFileSync(path.join(root, relativePath), 'utf8').replace(/^﻿/, '')
);

// Independent D-Gate validator. It recomputes every check from the artifacts;
// runners must consume its result instead of writing a decision literal.
// The candidate register's decisionState is DERIVED from this function, so it
// is not an input to the pass criteria (that would be circular). Instead the
// validator reports whether the register agrees with the recomputed decision.
function evaluateDirectionGate(env, score, register) {
  const summaries = score.candidateSummaries || [];
  const allModelsAccounted = summaries.length > 0 &&
    summaries.every(item => item.accountedModelCount === env.models.length);
  const allModelsComparable = summaries.length > 0 &&
    summaries.every(item => item.comparableModelCount === env.models.length);
  const selected = register.formalSelectedCandidates || [];
  const candidateCountLe3 = selected.length <= 3;
  const formalSelectionRecorded = selected.length > 0;
  const selectionResolvable = formalSelectionRecorded &&
    selected.every(id => summaries.some(item => item.candidateId === id));
  const sensitivitySweep = Boolean(score.sensitivitySweep && score.sensitivitySweep.complete);
  const bottleneckClassification = (score.candidates || []).length > 0 &&
    score.candidates.every(item => Boolean(item.bottleneck));
  const pass = Boolean(
    env.packageEnvelope.areaConservation &&
    allModelsComparable &&
    bottleneckClassification &&
    sensitivitySweep &&
    candidateCountLe3 && formalSelectionRecorded && selectionResolvable
  );
  const decision = pass ? 'PASS' : 'BLOCKED_PENDING_SENSITIVITY_SWEEP_AND_FORMAL_MANIFEST';
  const expectedRegisterState = pass ? 'D_GATE_PASSED' : 'D_GATE_BLOCKED';

  return {
    scope: 'PLANNING_COMPARISON_ONLY_NOT_ARCHITECTURE_FREEZE',
    areaConservation: Boolean(env.packageEnvelope.areaConservation),
    threeModelRowsAccounted: allModelsAccounted,
    threeModelComparable: allModelsComparable,
    bottleneckClassification,
    sensitivitySweep,
    candidateCountLe3,
    formalSelectionRecorded,
    selectionResolvable,
    registerConsistent: register.decisionState === expectedRegisterState,
    decision
  };
}

function observationCoverage(matrix) {
  const required = matrix.requiredCoverage.minimumObservations;
  const observations = matrix.observations || [];
  const observed = observations.filter(item =>
    ['MODEL_OBSERVED', 'SILICON_OBSERVED'].includes(item.status)
  );
  const terminalOrObserved = observations.filter(item =>
    ['MODEL_OBSERVED', 'SILICON_OBSERVED', 'BLOCKED_CONFIG'].includes(item.status)
  );
  const slotKey = x => [x.modelId, x.tp, x.mcProfile].join(':');
  const expected = matrix.requiredCoverage.models.flatMap(modelId =>
    matrix.requiredCoverage.tp.flatMap(tp => matrix.requiredCoverage.mcProfiles.map(mcProfile => slotKey({modelId,tp,mcProfile}))));
  const keys = observations.map(slotKey);
  const uniqueCoverage = keys.length === required && new Set(keys).size === required && expected.every(k => keys.includes(k));
  return {
    uniqueCoverage,
    planningEstimatedSlots: observations.filter(x => x.status === 'PLANNING_ESTIMATE').length,
    requiredSlots: required,
    accountedSlots: observations.length,
    all18SlotsAccounted: uniqueCoverage,
    terminalOrObservedSlots: terminalOrObserved.length,
    observationMatrixCompleteOrBlocked: uniqueCoverage && terminalOrObserved.length === required,
    observedSlots: observed.length,
    allObservedSlotsHaveProvenance: observed.every(item => item.source && item.sourceSelector),
    allObservedSlotsReplayable: observed.every(item =>
      Number.isFinite(item.tpsPerUser) &&
      Number.isFinite(item.e2eLatencyUsPerToken) &&
      item.source
    )
  };
}

function evaluateQuantificationGate(detail, matrix, register, directionGate) {
  const coverage = observationCoverage(matrix);
  const agentRuns = detail.agentRuns || {};
  const manifestsResolved = Object.values(detail.manifestStatus || {})
    .every(status => !String(status).startsWith('BLOCKED'));
  const provenanceComplete = Boolean(
    detail.provenance &&
    detail.provenance.sourceCommit &&
    detail.provenance.manifestHash &&
    detail.provenance.inputHashes &&
    Object.keys(detail.provenance.inputHashes).length >= 3
  );
  const sharedManifest = Boolean(
    agentRuns.Q3 && agentRuns.Q3.status === 'COMPLETE' &&
    agentRuns.Q4 && agentRuns.Q4.status === 'COMPLETE' &&
    agentRuns.Q5 && agentRuns.Q5.status === 'COMPLETE' &&
    agentRuns.Q6 && agentRuns.Q6.status === 'COMPLETE'
  );
  const fineTpsReady = Boolean(agentRuns.Q8 && agentRuns.Q8.status === 'COMPLETE');
  const pass = Boolean(
    directionGate.decision === 'PASS' &&
    detail.runMode === 'FORMAL_QUANTIFICATION' &&
    manifestsResolved &&
    detail.evidenceKind === 'VALIDATED_EVENT_TIMING' &&
    coverage.observedSlots === coverage.requiredSlots &&
    coverage.allObservedSlotsReplayable &&
    matrix.observations.every(x => x.runId === detail.runId && x.manifestHash === detail.manifestHash) &&
    sharedManifest &&
    fineTpsReady &&
    provenanceComplete &&
    coverage.observationMatrixCompleteOrBlocked &&
    coverage.allObservedSlotsHaveProvenance
  );

  return {
    evidenceKind: detail.evidenceKind || 'UNSPECIFIED',
    directionGatePassed: directionGate.decision === 'PASS',
    exploratoryOnly: detail.runMode !== 'FORMAL_QUANTIFICATION',
    manifestComplete: manifestsResolved,
    tp8Tp16Tp32PlanningExecutable: [8, 16, 32].every(tp =>
      detail.operatorLedger.some(row => row.tp === tp)
    ),
    sharedManifestAcrossRooflineAndReplay: sharedManifest,
    p0P1Separated: [...new Set(detail.operatorLedger.map(row => row.physicalProfile))].every(profile => ['P0', 'P1'].includes(profile)),
    p0P1DistinctResources: Boolean(detail.sizing && detail.sizing.availableResources &&
      detail.sizing.availableResources.P0 && detail.sizing.availableResources.P1 &&
      ['L', 'H', 'V'].some(core => detail.sizing.availableResources.P0[core].peakFlops !== detail.sizing.availableResources.P1[core].peakFlops)),
    mc320Mc640Separated: [...new Set(detail.operatorLedger.map(row => row.mcProfile))].every(profile => ['MC320', 'MC640'].includes(profile)),
    provenanceComplete,
    ...coverage,
    fineTpsReady,
    decision: pass ? 'PASS' : 'BLOCKED_BY_D_GATE_MANIFEST_EVENT_MODEL_AND_PROVENANCE'
  };
}

function writeGateStatus() {
  const env = read('data/direction/directional_resource_envelope.json');
  const score = read('data/direction/directional_tps_scorecard.json');
  const register = read('data/governance/candidate_register.json');
  const matrix = read('data/workload/tps_observation_matrix.json');
  const detailPath = path.join(root, 'data/detailed/detailed_architecture_run.json');
  const directionGate = evaluateDirectionGate(env, score, register);
  const quantificationGate = fs.existsSync(detailPath)
    ? evaluateQuantificationGate(read('data/detailed/detailed_architecture_run.json'), matrix, register, directionGate)
    : {decision: 'NOT_RUN'};
  const out = {
    schemaVersion: 'architecture-gate-status-v0.2',
    evaluatedAt: new Date().toISOString(),
    sourceDirectionalRunId: score.runId,
    sourceDetailedRunId: fs.existsSync(detailPath)
      ? read('data/detailed/detailed_architecture_run.json').runId
      : null,
    directionGate,
    quantificationGate
  };
  fs.mkdirSync(path.join(root, 'data/governance'), {recursive: true});
  fs.writeFileSync(
    path.join(root, 'data/governance/gate_status.json'),
    `${JSON.stringify(out, null, 2)}\n`
  );
  return out;
}

if (require.main === module) {
  console.log(JSON.stringify(writeGateStatus(), null, 2));
}

module.exports = {
  evaluateDirectionGate,
  evaluateQuantificationGate,
  observationCoverage,
  writeGateStatus
};
