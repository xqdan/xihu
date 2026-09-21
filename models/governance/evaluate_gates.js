'use strict';

const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '../..');
const read = relativePath => JSON.parse(
  fs.readFileSync(path.join(root, relativePath), 'utf8').replace(/^\uFEFF/, '')
);

function evaluateDirectionGate(env, score, register) {
  const summaries = score.candidateSummaries || [];
  const allModelsAccounted = summaries.length > 0 &&
    summaries.every(item => item.accountedModelCount === env.models.length);
  const allModelsComparable = summaries.length > 0 &&
    summaries.every(item => item.comparableModelCount === env.models.length);
  const candidateCountLe3 = (register.formalSelectedCandidates || []).length <= 3;
  const sensitivitySweep = Boolean(score.sensitivitySweep && score.sensitivitySweep.complete);
  const pass = Boolean(
    env.packageEnvelope.areaConservation &&
    allModelsComparable &&
    sensitivitySweep &&
    candidateCountLe3 &&
    register.decisionState === 'D_GATE_PASSED'
  );

  return {
    areaConservation: Boolean(env.packageEnvelope.areaConservation),
    threeModelRowsAccounted: allModelsAccounted,
    threeModelComparable: allModelsComparable,
    bottleneckClassification: score.candidates.every(item => Boolean(item.bottleneck)),
    sensitivitySweep,
    candidateCountLe3,
    formalSelectionRecorded: (register.formalSelectedCandidates || []).length > 0,
    decision: pass ? 'PASS' : 'BLOCKED_PENDING_SENSITIVITY_SWEEP_AND_FORMAL_MANIFEST'
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
  return {
    requiredSlots: required,
    accountedSlots: observations.length,
    all18SlotsAccounted: observations.length === required,
    terminalOrObservedSlots: terminalOrObserved.length,
    observationMatrixCompleteOrBlocked: terminalOrObserved.length === required,
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
    sharedManifest &&
    fineTpsReady &&
    provenanceComplete &&
    coverage.observationMatrixCompleteOrBlocked &&
    coverage.allObservedSlotsHaveProvenance
  );

  return {
    directionGatePassed: directionGate.decision === 'PASS',
    exploratoryOnly: detail.runMode !== 'FORMAL_QUANTIFICATION',
    manifestComplete: manifestsResolved,
    tp8Tp16Tp32PlanningExecutable: [8, 16, 32].every(tp =>
      detail.operatorLedger.some(row => row.modelId === 'K3' && row.tp === tp)
    ),
    sharedManifestAcrossRooflineAndReplay: sharedManifest,
    p0P1Separated: detail.operatorLedger.every(row => row.physicalProfile === 'P0'),
    mc320Mc640Separated: detail.operatorLedger.every(row => row.mcProfile === 'MC320'),
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
    schemaVersion: 'architecture-gate-status-v0.1',
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
