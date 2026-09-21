'use strict';
const fs = require('fs');
const path = require('path');
const root = path.resolve(__dirname, '../..');
const models = JSON.parse(fs.readFileSync(path.join(root, 'data/workload/model_profiles.json'), 'utf8').replace(/^\uFEFF/, ''));
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'docs/design/spec/k3_7r_package_baseline.json'), 'utf8').replace(/^\uFEFF/, ''));
const mc = JSON.parse(fs.readFileSync(path.join(root, 'docs/design/spec/k3_mc_baseline.json'), 'utf8').replace(/^\uFEFF/, ''));
const target = models.policy.sharedDecodeTargetTpsPerUser;
const margin = mc.goal.engineeringMargin;
const out = {
  schemaVersion: 'directional-resource-envelope-v0.1',
  runId: `stage-a-${new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14)}`,
  stage: 'direction', agentId: 'D1-D6', candidateId: 'direction-input-envelope',
  targetTpsPerUser: target, engineeringMargin: margin,
  confidence: 'E0', status: 'DIRECTIONAL_ESTIMATE',
  models: models.profiles.map(m => ({
    modelId: m.id, status: m.status, confidence: m.id === 'K3' ? 'E1' : 'E0',
    layerCount: m.layerCount, contextTokens: m.contextTokens,
    parameterCountB: m.reportedParameterCountB || null,
    activeParameterCountB: m.reportedActiveParameterCountB || m.reportedArchitectureSignals?.activeParameterCountB || null,
    features: m.features,
    coarseWorkload: {
      decode: { flopsPerTokenClass: m.id === 'K3' ? 'high_moe_plus_long_context' : 'blocked_config', memoryClass: 'weight_streaming_plus_state', communicationClass: 'tp_collective_and_optional_expert_dispatch' },
      prefill: { flopsClass: 'sequence_length_scaled', memoryClass: 'weight_reuse_plus_kv_write', communicationClass: 'tp_cp_collective' }
    },
    blockers: m.status === 'MODEL' ? [] : ['formal layer/dtype/expert manifest is not frozen']
  })),
  packageEnvelope: {
    reticles: pkg.reticle.count, placementWindowMm2: pkg.placementWindow.areaMm2,
    computeDies: pkg.compute.dieCount, computeDieAreaMm2: pkg.compute.dieAreaMm2,
    memoryCubes: pkg.memory.cubeCount, memoryCapacityGB: pkg.packageTotals.memoryCapacityGBPrimary,
    mcBaselineGBsPerCube: pkg.memory.payloadGBsPerCubeBaseline,
    mcStretchGBsPerCube: pkg.memory.payloadGBsPerCubeStretch,
    packageBaselineTBs: pkg.packageTotals.memoryPayloadTBsBaseline,
    packageStretchTBs: pkg.packageTotals.memoryPayloadTBsStretch,
    computePowerBudgetW: pkg.packageTotals.computePowerWBudget,
    coolingEnvelopeW: pkg.packageTotals.coolingEnvelopeW,
    areaConservation: pkg.compute.dieCount * pkg.compute.dieAreaMm2 + pkg.memory.cubeCount * pkg.memory.cubeAreaMm2Planning + pkg.packageTotals.placementRoutingReserveMm2 === pkg.placementWindow.areaMm2
  },
  bandwidthEnvelope: {
    mc320: { sustainedAssumption: 0.7, payloadTBs: pkg.packageTotals.memoryPayloadTBsBaseline, classification: 'baseline_reference' },
    mc640: { sustainedAssumption: 0.7, payloadTBs: pkg.packageTotals.memoryPayloadTBsStretch, classification: 'stretch_not_manufacturing_default' }
  },
  assumptions: [
    'Stage A uses coarse classes, not operator-level measurements.',
    'K3 is the only repository baseline model; GLM-5.2 and DeepSeek-V4-Pro remain planning inputs.',
    'MC320/MC640 are directional bandwidth profiles and must be replaced by sustained transaction data in Stage B.',
    'No software gain is silently applied in this run.'
  ],
  constraintsChecked: ['7-reticle area conservation', '8 compute die + 16 MC topology', 'P0/P1 separation', 'MC320/MC640 separation'],
  nextActions: ['D7 candidate sweep', 'Q1 formal manifest for selected candidates', 'Q2 arithmetic intensity ledger']
};
fs.writeFileSync(path.join(root, 'data/direction/directional_resource_envelope.json'), JSON.stringify(out, null, 2) + '\n', 'utf8');
console.log(JSON.stringify({runId: out.runId, models: out.models.length, areaConservation: out.packageEnvelope.areaConservation, mc320TBs: out.bandwidthEnvelope.mc320.payloadTBs}, null, 2));
