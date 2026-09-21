'use strict';
const fs = require('fs');
const path = require('path');
const root = path.resolve(__dirname, '../..');
const env = JSON.parse(fs.readFileSync(path.join(root, 'data/direction/directional_resource_envelope.json'), 'utf8').replace(/^\uFEFF/, ''));
const target = env.targetTpsPerUser;
const margin = env.engineeringMargin;
const candidates = [];
const mcProfiles = [
  { id: 'MC320', bwTBs: env.bandwidthEnvelope.mc320.payloadTBs },
  { id: 'MC640', bwTBs: env.bandwidthEnvelope.mc640.payloadTBs }
];
const coreProfiles = [
  { id: 'P1-compact', computeTF: 176.9472, vectorTOPS: 9.8304, powerW: 237.46, status: 'executable_comparison' },
  { id: 'P0-7R-balanced', computeTF: 353.8944, vectorTOPS: 19.6608, powerW: 250, status: 'physical_directional_envelope' }
];
const workload = {
  'K3': { flopsTF: 42, bytesTB: 5.36, collectiveUs: 132, softwareUs: 20 },
  'GLM-5.2': { flopsTF: 48, bytesTB: 5.9, collectiveUs: 180, softwareUs: 25 },
  'DeepSeek-V4-Pro': { flopsTF: 55, bytesTB: 6.4, collectiveUs: 230, softwareUs: 30 }
};
for (const core of coreProfiles) for (const mc of mcProfiles) for (const tp of [8, 16, 32]) for (const model of env.models) {
  const w = workload[model.modelId];
  const computeUs = w ? w.flopsTF * 1e6 / (core.computeTF * 1e12) * 1e6 : null;
  const memoryUs = w ? w.bytesTB * 1e6 / (mc.bwTBs * 1e12) * 1e6 : null;
  const collectiveUs = w ? w.collectiveUs * Math.log2(tp) / 5 : null;
  const softwareUs = w ? w.softwareUs : null;
  const rawUs = w ? Math.max(computeUs, memoryUs, collectiveUs) + softwareUs : null;
  const e2eUs = rawUs == null ? null : rawUs * margin;
  const tps = e2eUs == null ? null : 1e6 / e2eUs;
  candidates.push({
    candidateId: `${core.id}-${mc.id}-TP${tp}`,
    modelId: model.modelId, phase: 'decode', tp, cp: 1, ep: 1,
    physicalProfile: core.id.startsWith('P0') ? 'P0' : 'P1', mcProfile: mc.id,
    computeTimeUs: computeUs, memoryTimeUs: memoryUs, collectiveTimeUs: collectiveUs,
    softwareOverheadUs: softwareUs, uncoveredStallUs: 0, rawEstimateUs: rawUs, e2eEstimateUs: e2eUs,
    tpsPerUser: tps, bottleneck: tps == null ? 'blocked_config' : ['compute', 'memory', 'communication'].sort((a,b) => ({compute: computeUs, memory: memoryUs, communication: collectiveUs}[b]) - ({compute: computeUs, memory: memoryUs, communication: collectiveUs}[a]))[0],
    status: tps == null ? 'BLOCKED_CONFIG' : 'DIRECTIONAL_ESTIMATE', confidence: model.modelId === 'K3' ? 'E1' : 'E0',
    assumptions: ['directional workload constants are placeholders pending Q1/Q2', 'no software gain applied', 'collective latency uses directional logarithmic envelope only']
  });
}
const valid = candidates.filter(x => x.tpsPerUser != null);
const ranked = valid.slice().sort((a,b) => b.tpsPerUser - a.tpsPerUser);
const selected = ranked.slice(0, 3).map(x => x.candidateId);
const out = {
  schemaVersion: 'directional-tps-scorecard-v0.1', runId: env.runId, stage: 'direction', agentId: 'D7',
  targetTpsPerUser: target, architectureGateTpsPerUser: 1050, candidateLimitAfterGate: 3,
  candidateCount: candidates.length, selectedCandidateIds: selected,
  status: 'DIRECTIONAL_ESTIMATE', confidence: 'E0', candidates,
  dGate: { areaConservation: env.packageEnvelope.areaConservation, threeModelCoverage: true, bottleneckClassification: true, sensitivitySweep: false, candidateCountLe3: selected.length <= 3, decision: 'BLOCKED_PENDING_SENSITIVITY_SWEEP_AND_FORMAL_MANIFEST' },
  blockers: ['directional workload constants must be replaced by D1/Q1/Q2 artifacts', 'GLM-5.2 and DeepSeek-V4-Pro configs are pending', 'sensitivity sweep not yet implemented'],
  nextActions: ['implement D2/D3/D4/D5/D6 sensitivity sweep', 'select <=3 candidates after evidence review', 'start Q1 only for selected candidates']
};
fs.writeFileSync(path.join(root, 'data/direction/directional_tps_scorecard.json'), JSON.stringify(out, null, 2) + '\n', 'utf8');
console.log(JSON.stringify({runId: out.runId, candidateCount: out.candidateCount, selected: out.selectedCandidateIds, dGate: out.dGate}, null, 2));
