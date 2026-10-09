'use strict';
/* Generate out/detailed/sram_design.json: the SRAM/TMA design chosen by the search
 * over the HW-03 design space (teams/hardware/inputs/sram_design_space.json). The
 * winner goes to the design artifact; the whole scored candidate set (with a
 * fingerprint over it) goes to out/detailed/sram_candidates.json. The per-option
 * comparison, the B-SRAM-CAP sweep, the local-capacity sweep and the published
 * combination's rank are printed for the document
 * (teams/hardware/docs/03_TMA_AND_SRAM.md). See integration/detailed/sram_search.js
 * for the method.
 *
 * Run after npm run baseline:sync: node integration/pipelines/generate_sram_design.js
 */
const fs = require('fs');
const path = require('path');
const S = require('../detailed/sram_search.js');

const root = path.resolve(__dirname, '../..');
const t0 = Date.now();
const result = S.search();
const out = S.build(result);
const cand = S.candidates(result);
fs.writeFileSync(path.join(root, 'out/detailed/sram_design.json'), `${JSON.stringify(out, null, 2)}\n`);
fs.writeFileSync(path.join(root, 'out/detailed/sram_candidates.json'), `${JSON.stringify(cand, null, 2)}\n`);
const alt = S.alternatives(result), an = S.analysis(result);
const f = (v, n = 2) => (v === null || v === undefined ? '—' : v.toFixed(n));
const row = v => `TPS ${f(v.tpsPerUser)}, die ${f(v.dieAreaMm2, 3)} mm2 / ${f(v.diePowerW, 3)} W, card ${f(v.cardPowerW, 3)} W`;
console.log(JSON.stringify({
  design: Object.fromEntries(Object.entries(out.design).map(([d, v]) => [d, v.option])),
  search: {candidates: cand.totalCandidates, replayed: cand.replayedCandidates, feasible: cand.feasibleCandidates,
    infeasibleByCause: cand.infeasibleByCause, seconds: (Date.now() - t0) / 1000},
  candidateSetSha256: cand.candidateSetSha256,
  winner: `${row({...out.evaluation, tpsPerUser: out.evaluation.k3System.tpsPerUser})}, port ${f(out.evaluation.portAreaMm2, 3)} mm2`,
  margins: an.margins,
  published: an.published,
  alternatives: Object.fromEntries(Object.entries(alt).map(([d, o]) => [d, Object.fromEntries(Object.entries(o).map(([n, v]) =>
    [n, `${v.chosen ? 'chosen' : v.lostOn}; ${row(v)}`]))])),
  capacitySweep: an.capacitySweep.map(r => `${r.sharedMiB} MiB: contract ${r.contractHolds ? 'holds' : 'fails'}, replay ${r.replayFeasible ? row(r) : r.reasons.join(', ')}`),
  localSweep: an.localSweep.map(r => `L ${r.lMiB} / H ${r.hMiB} MiB: ${r.feasible ? row(r) : `${r.violations.join(', ')}; die ${f(r.dieAreaMm2, 3)} mm2`}`)
}, null, 2));
