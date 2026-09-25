'use strict';
/* Physical basis of the current (Final Tuning) compute die: process, matrix
 * density and cooling. Decisions 2026-09-25, recorded in ADR-0005.
 *
 * A.physical() in k3_architecture_search.js keeps the project's N4 reference
 * coefficients and the air-cooled limits, so every historical model and artifact
 * replays unchanged. resize() takes its result and re-derives the area terms and
 * all limit checks on the basis below. Power, frequency and bandwidth
 * coefficients are not touched.
 *
 * Process area scaling (ASSUMPTION from public node figures, not PDK or macro
 * data; B-006):
 *  - logic: CPP x MMP, Samsung SF4E 57 x 32 nm vs TSMC N4 51 x 28 nm = 1.277;
 *    the published density ratio 143.7 / 137 MTr/mm2 = 1.049 is the optimistic bound
 *  - SRAM: HD bitcell, SF4E 0.0262 um2 vs TSMC N5/N4 0.021 um2 = 1.248
 *  - PHY (UCIe, RDMA SerDes): hard IP, kept at 1 (no public SF4 macro areas)
 * SF4/SF4X pitches are not published; they are taken equal to SF4E.
 *
 * Matrix density (ASSUMPTION): 3.2 TF/mm2 at 1 GHz on the N4 reference
 * (0.000625 mm2 per BF16 MAC), twice the historical TECH.matrixTFPerMm2 1.6,
 * which was ~2-3x above the tensor-array area implied by shipping N4-class
 * parts; the SF4 logic factor applies on top. Needs a MAC-array macro (B-006).
 *
 * Cooling (ASSUMPTION): liquid (cold plate). Die 300 W and card 2800 W replace
 * the air-cooled 260 W / 2400 W. Cold plate, VRM and card power delivery are
 * not modeled.
 */
const A = require('./k3_architecture_search.js');

const PROCESS = {
  'N4-ref': {logic: 1, sram: 1, phy: 1, note: 'project N4 reference coefficients (TSMC N4-class)'},
  SF4: {logic: (57 * 32) / (51 * 28), sram: .0262 / .021, phy: 1, note: 'Samsung SF4-class 4 nm: logic by CPPxMMP, SRAM by HD bitcell, PHY unscaled'}
};
const BASIS = {
  process: 'SF4',
  matrixTFPerMm2: 3.2,
  cooling: 'liquid',
  limits: {dieArea: A.LIMITS.dieArea, diePower: 300, cardPower: 2800, packageArea: A.LIMITS.packageArea, packageUtil: A.LIMITS.packageUtil}
};
// Every physical() area term must be classified; a new term fails loudly.
const CLASS = {matrix: 'logic', vector: 'logic', banks: 'logic', cores: 'logic', tma: 'logic', noc: 'logic', reduce: 'logic', misc: 'logic', sram: 'sram', ucie: 'phy', rdma: 'phy'};
const LIMIT_REASONS = ['die area', 'die power', 'card power', 'package area', 'PHY shoreline'];

// Limit check shared with the charged shared-port cost (suffix names the stage).
function limitReasons(p, suffix = '') {
  const L = BASIS.limits, reasons = [];
  if (p.dieArea > L.dieArea) reasons.push('die area' + suffix);
  if (p.diePower > L.diePower) reasons.push('die power' + suffix);
  if (p.cardPower > L.cardPower) reasons.push('card power' + suffix);
  if (p.packageArea > L.packageArea * L.packageUtil) reasons.push('package area' + suffix);
  return reasons;
}

function resize(p, basis = BASIS) {
  const proc = PROCESS[basis.process];
  if (!proc) throw new Error('unknown process ' + basis.process);
  const area = {};
  for (const [k, v] of Object.entries(p.area)) {
    if (!CLASS[k]) throw new Error('unclassified area term ' + k);
    area[k] = v * proc[CLASS[k]] * (k === 'matrix' ? A.TECH.matrixTFPerMm2 / basis.matrixTFPerMm2 : 1);
  }
  const dieArea = Object.values(area).reduce((a, b) => a + b, 0);
  const packageArea = p.packageArea + A.LIMITS.dies * (dieArea - p.dieArea);
  const edgeBudget = 4 * Math.sqrt(dieArea) * A.TECH.phyEdgeFraction;
  const q = {...p, area, dieArea, packageArea, edgeBudget, basis: basis.process};
  const reasons = [...p.reasons.filter(r => !LIMIT_REASONS.includes(r)), ...limitReasons(q)];
  if (p.shoreline > edgeBudget) reasons.push('PHY shoreline');
  return {...q, feasible: !reasons.length, reasons};
}

module.exports = {PROCESS, BASIS, CLASS, resize, limitReasons};
