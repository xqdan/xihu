'use strict';
/* Generate out/detailed/coupling_design.json: the best joint design point around the five
 * domain winners (teams/hardware/inputs/coupling_design_space.json). The best joint point
 * goes to the design artifact; the whole scored grid (with a fingerprint over it) goes to
 * out/detailed/coupling_candidates.json. The composition (each domain alone against the
 * composed point), the Pareto set and the rejected combinations by cause are printed for
 * doc 23 section 4. See integration/detailed/coupling_search.js for the method.
 *
 * Run after the five domain searches: node integration/pipelines/generate_coupling_design.js
 */
const fs = require('fs');
const path = require('path');
const S = require('../detailed/coupling_search.js');

const root = path.resolve(__dirname, '../..');
const t0 = Date.now();
const result = S.search();
const out = S.build(result);
const cand = S.candidates(result);
fs.writeFileSync(path.join(root, 'out/detailed/coupling_design.json'), `${JSON.stringify(out, null, 2)}\n`);
fs.writeFileSync(path.join(root, 'out/detailed/coupling_candidates.json'), `${JSON.stringify(cand, null, 2)}\n`);
const f = (v, n = 2) => (v === null || v === undefined ? '—' : v.toFixed(n));
const row = v => `TPS ${f(v.tpsPerUser)}, die ${f(v.dieAreaMm2, 3)} mm2 / ${f(v.diePowerW, 3)} W, card ${f(v.cardPowerW, 3)} W`;
console.log(JSON.stringify({
  jointPoint: out.jointPoint ? out.jointPoint.optionId : null,
  search: {candidates: cand.totalCandidates, feasible: cand.feasibleCandidates, pareto: cand.paretoCandidates,
    infeasibleByCause: cand.infeasibleByCause, seconds: (Date.now() - t0) / 1000},
  candidateSetSha256: cand.candidateSetSha256,
  winner: row(out.evaluation),
  composition: {
    composed: `${row(cand.composition.composed)}; ${cand.composition.composed.violations.join(', ') || 'feasible'}`,
    domainAlone: Object.fromEntries(Object.entries(cand.composition.domainAlone).map(([d, v]) => [d, f(v.tpsPerUser)]))
  },
  pareto: cand.candidates.filter(c => c.pareto).map(c => `${c.optionId}: ${row(c)}`),
  backflow: cand.backflow
}, null, 2));
