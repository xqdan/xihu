'use strict';
/* Generate out/detailed/memory_design.json: the MC/memory design chosen by the
 * search over the HW-04 design space
 * (teams/hardware/inputs/memory_design_space.json). The winner goes to the
 * design artifact; the whole scored candidate set (with a fingerprint over it)
 * goes to out/detailed/memory_candidates.json, which is what a consumer that
 * merges or excludes candidates is checked against -- a winner-only artifact
 * makes "every exclusion is traceable" unverifiable.
 * The tier sweep, the cube-count sweep, the per-route comparison and the
 * held-out routes are printed for the document
 * (teams/hardware/docs/04_MEMORY_SUBSYSTEM_MC.md). See
 * integration/detailed/memory_search.js for the method.
 *
 * Run after npm run baseline:sync: node integration/pipelines/generate_memory_design.js
 */
const fs = require('fs');
const path = require('path');
const S = require('../detailed/memory_search.js');

const root = path.resolve(__dirname, '../..');
const result = S.search();
const out = S.build(result);
const cand = S.candidates(result);
fs.writeFileSync(path.join(root, 'out/detailed/memory_design.json'), `${JSON.stringify(out, null, 2)}\n`);
fs.writeFileSync(path.join(root, 'out/detailed/memory_candidates.json'), `${JSON.stringify(cand, null, 2)}\n`);
const alt = S.alternatives(result), an = S.analysis(result);
const f = (v, n = 1) => (v === null || v === undefined || v === Infinity ? '—' : v.toFixed(n));
const sweep = r => `mcGBs ${r.mcGBs} (${r.classification}): die ${r.dieGBs} GB/s, MC power ${f(r.mcPowerW, 2)} W, `
  + `card ${f(r.cardPowerW, 2)} W, TPS/usr ${f(r.tpsPerUser, 2)}${r.feasible ? '' : ` -- ${r.violations.join(', ')}`}`;
console.log(JSON.stringify({
  design: Object.fromEntries(Object.entries(out.design).map(([d, v]) => [d, v.option])),
  search: {candidates: out.designSpace.candidates, feasible: out.designSpace.feasible},
  candidateSetSha256: cand.candidateSetSha256,
  winner: `die ${out.evaluation.dieGBs} GB/s, ${out.evaluation.capacityGBPerCard} GB/card `
    + `(margin ${f(out.evaluation.capacityMarginGB, 1)} GB), classification ${out.evaluation.classification}, `
    + `MC power ${f(out.evaluation.mcPowerW, 2)} W, card ${f(out.evaluation.cardPowerW, 2)} W, TPS/usr ${f(out.evaluation.k3System.tpsPerUser, 2)}`,
  capacityFloor: `${f(an.capacityFloorGB, 3)} GB/rank needs only ${an.cubesFloor} cubes of the searched grid; `
    + `the published die already carries ${an.publishedDieGBs} GB/s, so capacity is not the binding constraint`,
  alternatives: Object.fromEntries(Object.entries(alt).map(([d, o]) => [d, Object.fromEntries(Object.entries(o).map(([n, v]) =>
    [n, `${v.chosen ? 'chosen' : v.lostOn}; ${JSON.stringify(v.pick)} die ${v.dieGBs} GB/s, `
      + `capacity ${v.capacityGBPerCard} GB, MC power ${f(v.mcPowerW, 2)} W, TPS ${f(v.tpsPerUser, 2)}`]))])),
  sweep: an.sweep.map(sweep),
  cubesSweep: an.cubesSweep.map(r => `${r.cubesPerCard} cubes (${r.capacityGBPerCard} GB): placed ${f(r.packageAreaMm2, 1)} mm2, `
    + `reserve ${f(r.areaReserveMm2, 1)} mm2${r.feasible ? '' : ` -- ${r.violations.join(', ')}`}`),
  routes: an.routes.map(r => `${r.route}: ${r.scored ? (r.feasible ? 'scorable, feasible' : `scorable, ${r.violations.join(', ')}`) : 'HELD OUT (not scored)'}`
    + `${r.conditional ? ' [CONDITIONAL, cannot win]' : ''}${r.scored ? ` -- die ${r.dieGBs} GB/s over ${r.cubes} cubes, capacity ${r.capacityGBPerCard} GB, TPS ${f(r.tpsPerUser, 2)}` : ''}`),
  conditionalAlternative: an.conditionalAlternative && `${an.conditionalAlternative.route}: mcGBs ${an.conditionalAlternative.mcGBs} (${an.conditionalAlternative.classification}), `
    + `TPS/usr ${f(an.conditionalAlternative.tpsPerUser, 2)}, MC power ${f(an.conditionalAlternative.mcPowerW, 2)} W `
    + `(winner ${f(an.conditionalAlternative.versusWinner.winnerTpsPerUser, 2)} at ${an.conditionalAlternative.versusWinner.winnerMcGBs}); conditioned on ${an.conditionalAlternative.conditionedOn}`,
  heldOutRoutes: Object.entries(an.heldOutRoutes).map(([k, v]) => `${k}: ${v.needsModelling}`)
}, null, 2));
