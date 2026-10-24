'use strict';
/* Directional resource envelope of Stage A: model profiles and the P1 card
 * (package and MC) envelopes in one coarse, class-level record. build() returns the base
 * record; Stage A (integration/pipelines/stage_a.js) adds its run id, confidence,
 * status and assumptions and writes out/direction/directional_resource_envelope.json.
 */
const fs = require('fs');
const path = require('path');
const root = path.resolve(__dirname, '../..');
const read = p => JSON.parse(fs.readFileSync(path.join(root, p), 'utf8').replace(/^\uFEFF/, ''));

// Raw and sustained side by side, so a reader never has to know which one a lone number was.
function bandwidthOf(profile) {
  return {
    sustainedAssumption: profile.sustainedAssumption,
    rawPayloadTBs: profile.rawPayloadTBs,
    sustainedTBs: profile.rawPayloadTBs * profile.sustainedAssumption,
    effectiveBytesPerSecond: profile.effectiveBytesPerSecond,
    classification: profile.classification
  };
}

function build({runId}) {
  const models = read('teams/model/inputs/model_profiles.json');
  const mc = read('teams/hardware/inputs/k3_mc_baseline.json');
  const RES = require('../../teams/hardware/src/resource_profiles');
  const pkg = mc.package, die = mc.computeDieCandidate;
  const packageAreaMm2 = mc.card.computeDies * die.estimatedAreaMm2 + mc.card.memoryCubes * pkg.memoryCubeAreaMm2Planning;
  const target = models.policy.sharedDecodeTargetTpsPerUser;
  const margin = mc.goal.engineeringMargin;
  return {
    schemaVersion: 'directional-resource-envelope-v0.1',
    runId,
    stage: 'arch.direction', agentId: 'D1-D6', candidateId: 'direction-input-envelope',
    targetTpsPerUser: target, engineeringMargin: margin,
    confidence: 'E0', status: 'DIRECTIONAL_ESTIMATE',
    models: models.profiles.map(m => ({
      modelId: m.id, status: m.status, confidence: m.id === 'K3' ? 'E1' : 'E0',
      layerCount: m.layerCount, contextTokens: m.contextTokens,
      parameterCountB: m.reportedParameterCountB || null,
      activeParameterCountB: m.reportedActiveParameterCountB || m.reportedArchitectureSignals?.activeParameterCountB || null,
      features: m.features,
      coarseWorkload: {
        decode: { flopsPerTokenClass: m.id === 'K3' ? 'high_moe_plus_long_context' : 'high_moe_plus_indexed_sparse_attention', memoryClass: 'weight_streaming_plus_state', communicationClass: 'tp_collective_only_no_all_to_all' },
        prefill: { flopsClass: 'sequence_length_scaled', memoryClass: 'weight_reuse_plus_kv_write', communicationClass: 'tp_cp_collective' }
      },
      blockers: m.status === 'MODEL' ? [] : ['formal layer/dtype/expert manifest is not frozen']
    })),
    packageEnvelope: {
      reticles: pkg.reticles, placementWindowMm2: pkg.placementWindowMm2,
      computeDies: mc.card.computeDies, computeDieAreaMm2: die.estimatedAreaMm2,
      computeDieAreaLimitMm2: pkg.computeDieAreaLimitMm2,
      memoryCubes: mc.card.memoryCubes, memoryCubeAreaMm2: pkg.memoryCubeAreaMm2Planning,
      memoryCapacityGB: mc.card.memoryCubes * pkg.capacityGBPerCubePrimary,
      packageAreaMm2,
      // ADR-0027 renamed the roles: MC320 is the reference tier, the MC640 slot is the tier a brief
      // binds to. "Stretch"/"Baseline" here described the old rule and would now mislead.
      mcReferenceGBsPerCube: RES.mcProfiles.MC320.payloadGBsPerCube,
      mcBindingGBsPerCube: RES.mcProfiles.MC640.payloadGBsPerCube,
      packageReferenceTBs: RES.mcProfiles.MC320.rawPayloadTBs,
      packageBindingTBs: RES.mcProfiles.MC640.rawPayloadTBs,
      cardPowerW: die.estimatedCardPowerW,
      cardPowerLimitW: mc.card.powerLimitW,
      // Area conservation: the searched die and the 16 MC fit the 7-reticle placement window.
      areaConservation: die.estimatedAreaMm2 <= pkg.computeDieAreaLimitMm2 && packageAreaMm2 <= pkg.placementWindowMm2
    },
    bandwidthEnvelope: {
      // The classification is read from the profile, not restated: a second copy here is exactly how
      // the two strings drifted apart from resource_profiles.js before ADR-0027.
      // `rawPayloadTBs` is the PIN RATE times the stack count, NOT what the running op gets. The memory
      // lane divides by the sustained figure below (O-023: the field used to be called `payloadTBs`
      // next to sustainedAssumption, and a reader -- including an invariant-checker -- concluded the
      // 0.7 was never applied). Both numbers are emitted so the two cannot be confused again.
      mc320: bandwidthOf(RES.mcProfiles.MC320),
      mc640: bandwidthOf(RES.mcProfiles.MC640)
    },
    assumptions: [
      'Stage A uses coarse classes, not operator-level measurements.',
      'K3 is the only repository baseline model; GLM-5.2 and DeepSeek-V4-Pro remain planning inputs.',
      'MC320/MC640 are directional bandwidth profiles and must be replaced by sustained transaction data in Stage B.',
      'No software gain is silently applied in this run.'
    ],
    constraintsChecked: ['7-reticle package area conservation (P1 die + 16 MC)', '8 compute die + 16 MC topology', 'single hardware spec (P1)', 'MC320/MC640 separation'],
    nextActions: ['D7 candidate sweep', 'Q1 formal manifest for selected candidates', 'Q2 arithmetic intensity ledger']
  };
}

module.exports = {build};
