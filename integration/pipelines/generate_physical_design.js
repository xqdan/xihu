'use strict';
/* Generate out/detailed/physical_design.json: the physical (package / power / RAS)
 * design chosen by the search over the HW-09 design space
 * (teams/hardware/inputs/physical_design_space.json). The winner goes to the
 * design artifact; the whole scored candidate set (with a fingerprint over it)
 * goes to out/detailed/physical_candidates.json, which is what a consumer that
 * merges or excludes candidates is checked against -- a winner-only artifact
 * makes "every exclusion is traceable" unverifiable.
 * The per-option comparison, the process / cooling / matrix sensitivities and the
 * keep-out sweep are printed for the document
 * (teams/hardware/docs/09_PACKAGE_POWER_RAS.md). See
 * integration/detailed/physical_search.js for the method.
 *
 * Run after npm run baseline:sync: node integration/pipelines/generate_physical_design.js
 */
const fs = require('fs');
const path = require('path');
const S = require('../detailed/physical_search.js');

const root = path.resolve(__dirname, '../..');
const result = S.search();
const out = S.build(result);
const cand = S.candidates(result);
fs.writeFileSync(path.join(root, 'out/detailed/physical_design.json'), `${JSON.stringify(out, null, 2)}\n`);
fs.writeFileSync(path.join(root, 'out/detailed/physical_candidates.json'), `${JSON.stringify(cand, null, 2)}\n`);
const alt = S.alternatives(result), an = S.analysis(result);
const f = (v, n = 1) => (v === null || v === undefined || v === Infinity ? '—' : v.toFixed(n));
const mm = v => `${f(v, 3)} mm2`, w = v => `${f(v, 3)} W`;
console.log(JSON.stringify({
  design: Object.fromEntries(Object.entries(out.design).map(([d, v]) => [d, v.option])),
  search: {candidates: out.designSpace.candidates, feasible: out.designSpace.feasible},
  candidateSetSha256: cand.candidateSetSha256,
  publishedReproduced: {dieAreaMm2: out.evaluation.dieAreaMm2, diePowerW: out.evaluation.diePowerW,
    cardPowerW: out.evaluation.cardPowerW, packageAreaMm2: out.evaluation.packageAreaMm2,
    shorelineMm: out.evaluation.shorelineMm, edgeBudgetMm: out.evaluation.edgeBudgetMm},
  areaConservation: `placed ${f(an.areaConservation.placedMm2, 3)} + keep-out ${f(an.areaConservation.keepOutMm2, 3)}`
    + ` = ${f(an.areaConservation.windowMm2, 0)} mm2, over/under ${f(an.areaConservation.overUnderMm2, 3)} mm2`
    + ` (tolerance ${an.areaConservation.toleranceMm2}, satisfied ${an.areaConservation.satisfied})`,
  alternatives: Object.fromEntries(Object.entries(alt).map(([d, o]) => [d, Object.fromEntries(Object.entries(o).map(([n, v]) =>
    [n, `${v.chosen ? 'chosen' : v.lostOn}; die ${mm(v.dieAreaMm2)}, placed ${mm(v.packageAreaMm2)}, `
      + `leftover ${mm(v.reserveMm2)}, die power ${w(v.diePowerW)}, card power ${w(v.cardPowerW)}`]))])),
  process: an.process.map(r => `${r.process}: die ${mm(r.dieAreaMm2)}, placed ${mm(r.packageAreaMm2)}, `
    + `leftover ${mm(r.reserveMm2)}, card power ${w(r.cardPowerW)}${r.feasible ? '' : ` -- ${r.violations.join(', ')}`}`),
  cooling: an.cooling.map(r => `${r.cooling}: die power ${w(r.diePowerW)} / ${r.diePowerLimitW} W, `
    + `card power ${w(r.cardPowerW)} / ${r.cardPowerLimitW} W, margin ${w(r.diePowerMarginW)}`
    + `${r.feasible ? '' : ` -- ${r.violations.join(', ')}`}`),
  matrix: an.matrix.map(r => `${r.matrixTFPerMm2} TF/mm2: matrix area ${mm(r.matrixAreaMm2)}, die ${mm(r.dieAreaMm2)}, `
    + `leftover ${mm(r.reserveMm2)}${r.feasible ? '' : ` -- ${r.violations.join(', ')}`}`),
  keepOut: an.reserve.map(r => `${r.reserveFraction}: leftover ${mm(r.reserveMm2)}${r.feasible ? '' : ` -- ${r.violations.join(', ')}`}`)
}, null, 2));
