'use strict';
/* Planning resource profile for the Stage A / Stage B runners.
 *
 * There is one hardware spec: the P1 compact card in
 * teams/hardware/inputs/k3_mc_baseline.json. Cores per die, engine shapes and
 * the fixed 1.0 GHz clock are read from #/computeDieCandidate (the Final Tuning
 * search result, see doc 21 / ADR-0005); MC tiers from #/bandwidthTiers; the
 * package boundary and card network limit from #/package and #/card. Nothing here
 * is a measured or signed-off figure.
 */
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '../../..');
const read = relativePath => JSON.parse(fs.readFileSync(path.join(root, relativePath), 'utf8').replace(/^\uFEFF/, ''));

const SPEC_PATH = 'teams/hardware/inputs/k3_mc_baseline.json';
const DIES_PER_PACKAGE = 8;

function corePeakFlops(shape, cores, ghz) {
  return cores * shape.engines * shape.rows * shape.cols * 2 * ghz * 1e9;
}
function vectorPeakFlops(lanes, cores, ghz) {
  return cores * lanes * 2 * ghz * 1e9;
}

function buildProfile(id, {lCoresPerDie, hCoresPerDie, ghz, powerWPerDie, engine, source}) {
  const L = corePeakFlops(engine.L, lCoresPerDie, ghz) * DIES_PER_PACKAGE;
  const H = corePeakFlops(engine.H, hCoresPerDie, ghz) * DIES_PER_PACKAGE;
  const V = vectorPeakFlops(engine.vectorLanesPerCore, lCoresPerDie + hCoresPerDie, ghz) * DIES_PER_PACKAGE;
  return {
    id,
    lCoresPerDie, hCoresPerDie, ghz,
    engine,
    scope: 'package_rank',
    computeTF: (L + H) / 1e12,
    vectorTOPS: V / 1e12,
    powerW: powerWPerDie * DIES_PER_PACKAGE,
    // Lightning-indexer scoring is a low-precision dot product over every cached
    // index key, mapped to the H tensor engines (same as QK). REDUCE has no
    // dedicated unit and is budgeted on the vector lanes.
    peakByCore: {L, H, V, INDEXER: H, REDUCE: V},
    source
  };
}

const spec = read(SPEC_PATH);
const c = spec.computeDieCandidate;
const P1_ENGINE = {
  L: {engines: c.lCore.tensorEngines, rows: c.lCore.tensorShape[0], cols: c.lCore.tensorShape[1]},
  H: {engines: c.hCore.tensorEngines, rows: c.hCore.tensorShape[0], cols: c.hCore.tensorShape[1]},
  vectorLanesPerCore: c.lCore.vectorLanes
};

const coreProfiles = {
  P1: buildProfile('P1-compact', {
    lCoresPerDie: c.lCores,
    hCoresPerDie: c.hCores,
    ghz: c.frequencyGHz,
    powerWPerDie: c.estimatedPowerW,
    engine: P1_ENGINE,
    source: SPEC_PATH
  })
};
const PHYSICAL_PROFILES = Object.keys(coreProfiles);
// Package peak must equal the searched candidate's die peak x 8 (guards against stale engine shapes).
const p1DiePeak = (coreProfiles.P1.peakByCore.L + coreProfiles.P1.peakByCore.H) / DIES_PER_PACKAGE / 1e12;
if (Math.abs(p1DiePeak - c.bf16DenseTflops) > 1e-6) {
  throw new Error(`P1 peak ${p1DiePeak} TFLOPS/die does not match k3_mc_baseline.json bf16DenseTflops ${c.bf16DenseTflops}`);
}

// MC profiles: raw package payload x sustained efficiency (never raw payload).
// MC320 is the REFERENCE tier, MC640 the STRETCH_AGGRESSIVE tier of ADR-0019.
const MC_SUSTAINED = spec.bandwidthTiers.sustainedEfficiency;
const tierGBs = classification => spec.bandwidthTiers.tiersGBsPerCube.find(t => t.classification === classification).gbs;
const mcProfiles = {
  MC320: {id: 'MC320', payloadGBsPerCube: tierGBs('REFERENCE'), classification: 'baseline_reference'},
  MC640: {id: 'MC640', payloadGBsPerCube: tierGBs('STRETCH_AGGRESSIVE'), classification: 'stretch_not_manufacturing_default'}
};
for (const mc of Object.values(mcProfiles)) {
  mc.rawPayloadTBs = spec.card.memoryCubes * mc.payloadGBsPerCube / 1000;
  mc.sustainedAssumption = MC_SUSTAINED;
  mc.effectiveBytesPerSecond = mc.rawPayloadTBs * 1e12 * MC_SUSTAINED;
}

module.exports = {
  SPEC_PATH,
  DIES_PER_PACKAGE,
  PHYSICAL_PROFILES,
  P1_ENGINE,
  coreProfiles,
  mcProfiles,
  utilization: 0.6,
  dutyCycle: 0.85,
  networkBandwidth: spec.card.networkPayloadLimitGBs * 1e9,
  physicalProfileOf: candidateId => PHYSICAL_PROFILES.find(key => candidateId.startsWith(coreProfiles[key].id)),
  mcProfileOf: candidateId => (candidateId.includes('MC640') ? 'MC640' : 'MC320'),
  tpOf: candidateId => Number(candidateId.match(/TP(\d+)$/)[1]),
  candidateIdFor: (physicalProfile, mcProfile, tp) => `${coreProfiles[physicalProfile].id}-${mcProfile}-TP${tp}`
};
