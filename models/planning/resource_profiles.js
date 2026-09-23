'use strict';
/* Shared planning resource profiles for the Stage A / Stage B runners.
 *
 * P0 and P1 are DIFFERENT physical profiles and must never share core-class
 * capacity numbers. Every value here is traceable to a design document; none
 * is a measured or signed-off figure.
 *
 *  P0  7-reticle physical primary: 8 L + 8 H cores per die, 1.0 GHz candidate
 *      (docs/design/12_7_RETICLE_SINGLE_CHIP_ARCHITECTURE.md §3.1,
 *       docs/design/spec/k3_7r_package_baseline.json: compute.frequencyGHzCandidate)
 *  P1  compact executable: 4 L + 4 H cores per die, 1.2 GHz
 *      (docs/design/02_AI_CORE.md §2, docs/design/spec/k3_mc_baseline.json)
 *
 * Tensor engine shapes are common to both profiles: L = 8 engines x (1x256),
 * H = 8 engines x (16x128) BF16 MAC per cycle, 2 FLOP per MAC, 512 vector
 * lanes per core (docs/design/02_AI_CORE.md).
 */
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '../..');
const read = relativePath => JSON.parse(fs.readFileSync(path.join(root, relativePath), 'utf8').replace(/^﻿/, ''));

const DIES_PER_PACKAGE = 8;
const ENGINE = {L: {engines: 8, rows: 1, cols: 256}, H: {engines: 8, rows: 16, cols: 128}, vectorLanesPerCore: 512};

function corePeakFlops(shape, cores, ghz) {
  return cores * shape.engines * shape.rows * shape.cols * 2 * ghz * 1e9;
}
function vectorPeakFlops(cores, ghz) {
  return cores * ENGINE.vectorLanesPerCore * 2 * ghz * 1e9;
}

function buildProfile(id, {lCoresPerDie, hCoresPerDie, ghz, powerWPerDie, source}) {
  const L = corePeakFlops(ENGINE.L, lCoresPerDie, ghz) * DIES_PER_PACKAGE;
  const H = corePeakFlops(ENGINE.H, hCoresPerDie, ghz) * DIES_PER_PACKAGE;
  const V = vectorPeakFlops(lCoresPerDie + hCoresPerDie, ghz) * DIES_PER_PACKAGE;
  return {
    id,
    lCoresPerDie, hCoresPerDie, ghz,
    scope: 'package_rank',
    computeTF: (L + H) / 1e12,
    vectorTOPS: V / 1e12,
    powerW: powerWPerDie * DIES_PER_PACKAGE,
    // INDEXER and REDUCE have no dedicated unit yet; they are budgeted on the vector lanes.
    peakByCore: {L, H, V, INDEXER: V, REDUCE: V},
    source
  };
}

const packageSpec = read('docs/design/spec/k3_7r_package_baseline.json');
const mcSpec = read('docs/design/spec/k3_mc_baseline.json');

const coreProfiles = {
  P0: buildProfile('P0-7R-balanced', {
    lCoresPerDie: packageSpec.compute.lCoresPerDie,
    hCoresPerDie: packageSpec.compute.hCoresPerDie,
    ghz: packageSpec.compute.frequencyGHzCandidate,
    powerWPerDie: packageSpec.compute.powerWPerDieBudget,
    source: 'docs/design/spec/k3_7r_package_baseline.json'
  }),
  P1: buildProfile('P1-compact', {
    lCoresPerDie: mcSpec.computeDieCandidate.lCores,
    hCoresPerDie: mcSpec.computeDieCandidate.hCores,
    ghz: mcSpec.computeDieCandidate.frequencyGHz,
    powerWPerDie: mcSpec.computeDieCandidate.estimatedPowerW,
    source: 'docs/design/spec/k3_mc_baseline.json'
  })
};

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
  ENGINE,
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
