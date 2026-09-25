'use strict';
/* Shared planning resource profiles for the Stage A / Stage B runners.
 *
 * P0 and P1 are DIFFERENT physical profiles and must never share core-class
 * capacity numbers. Every value here is traceable to a design document; none
 * is a measured or signed-off figure.
 *
 *  P0  7-reticle physical primary: 8 L + 8 H cores per die, 1.0 GHz candidate
 *      (docs/architecture/12_7_RETICLE_SINGLE_CHIP_ARCHITECTURE.md §3.1,
 *       teams/hardware/inputs/k3_7r_package_baseline.json: compute.frequencyGHzCandidate)
 *  P1  compact executable: the searched K3 candidate in
 *      teams/hardware/inputs/k3_mc_baseline.json#/computeDieCandidate (cores per die,
 *      engine shapes and the fixed 1.0 GHz clock are read from the spec, so this
 *      profile follows the search; see doc 21 / ADR-0005)
 *
 * P0 engine shapes: L = 8 engines x (1x256), H = 8 engines x (16x128) BF16 MAC
 * per cycle, 2 FLOP per MAC, 512 vector lanes per core (docs/architecture/02_AI_CORE.md).
 */
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '../../..');
const read = relativePath => JSON.parse(fs.readFileSync(path.join(root, relativePath), 'utf8').replace(/^﻿/, ''));

const DIES_PER_PACKAGE = 8;
// P0 engine shapes (docs/architecture/02_AI_CORE.md, 12_7_RETICLE): L = 8 x (1x256), H = 8 x (16x128), 512 vector lanes.
// P1 engine shapes come from the searched candidate in k3_mc_baseline.json (they change when the search moves).
const P0_ENGINE = {L: {engines: 8, rows: 1, cols: 256}, H: {engines: 8, rows: 16, cols: 128}, vectorLanesPerCore: 512};

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

const packageSpec = read('teams/hardware/inputs/k3_7r_package_baseline.json');
const mcSpec = read('teams/hardware/inputs/k3_mc_baseline.json');
const c = mcSpec.computeDieCandidate;
const P1_ENGINE = {
  L: {engines: c.lCore.tensorEngines, rows: c.lCore.tensorShape[0], cols: c.lCore.tensorShape[1]},
  H: {engines: c.hCore.tensorEngines, rows: c.hCore.tensorShape[0], cols: c.hCore.tensorShape[1]},
  vectorLanesPerCore: c.lCore.vectorLanes
};

const coreProfiles = {
  P0: buildProfile('P0-7R-balanced', {
    lCoresPerDie: packageSpec.compute.lCoresPerDie,
    hCoresPerDie: packageSpec.compute.hCoresPerDie,
    ghz: packageSpec.compute.frequencyGHzCandidate,
    powerWPerDie: packageSpec.compute.powerWPerDieBudget,
    engine: P0_ENGINE,
    source: 'teams/hardware/inputs/k3_7r_package_baseline.json'
  }),
  P1: buildProfile('P1-compact', {
    lCoresPerDie: c.lCores,
    hCoresPerDie: c.hCores,
    ghz: c.frequencyGHz,
    powerWPerDie: c.estimatedPowerW,
    engine: P1_ENGINE,
    source: 'teams/hardware/inputs/k3_mc_baseline.json'
  })
};
// P1 package peak must equal the searched candidate's die peak x 8 (guards against stale engine shapes).
const p1DiePeak = (coreProfiles.P1.peakByCore.L + coreProfiles.P1.peakByCore.H) / DIES_PER_PACKAGE / 1e12;
if (Math.abs(p1DiePeak - c.bf16DenseTflops) > 1e-6) {
  throw new Error(`P1 peak ${p1DiePeak} TFLOPS/die does not match k3_mc_baseline.json bf16DenseTflops ${c.bf16DenseTflops}`);
}

// MC profiles: raw package payload x sustained efficiency (never raw payload).
const MC_SUSTAINED = 0.70;
const mcProfiles = {
  MC320: {id: 'MC320', payloadGBsPerCube: packageSpec.memory.payloadGBsPerCubeBaseline, classification: 'baseline_reference'},
  MC640: {id: 'MC640', payloadGBsPerCube: packageSpec.memory.payloadGBsPerCubeStretch, classification: 'stretch_not_manufacturing_default'}
};
for (const mc of Object.values(mcProfiles)) {
  mc.rawPayloadTBs = packageSpec.memory.cubeCount * mc.payloadGBsPerCube / 1000;
  mc.sustainedAssumption = MC_SUSTAINED;
  mc.effectiveBytesPerSecond = mc.rawPayloadTBs * 1e12 * MC_SUSTAINED;
}

module.exports = {
  DIES_PER_PACKAGE,
  P0_ENGINE,
  P1_ENGINE,
  coreProfiles,
  mcProfiles,
  utilization: 0.6,
  dutyCycle: 0.85,
  networkBandwidth: packageSpec.packageTotals.scaleOutPayloadGBsTarget * 1e9,
  physicalProfileOf: candidateId => (candidateId.startsWith('P1') ? 'P1' : 'P0'),
  mcProfileOf: candidateId => (candidateId.includes('MC640') ? 'MC640' : 'MC320'),
  tpOf: candidateId => Number(candidateId.match(/TP(\d+)$/)[1]),
  candidateIdFor: (physicalProfile, mcProfile, tp) => `${coreProfiles[physicalProfile].id}-${mcProfile}-TP${tp}`
};
