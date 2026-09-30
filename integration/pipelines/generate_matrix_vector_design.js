'use strict';
/* Generate out/detailed/matrix_vector_design.json: the AI Core matrix:vector
 * design chosen by the search over the HW-02 design space
 * (teams/hardware/inputs/matrix_vector_design_space.json). The winner goes to
 * the design artifact; the whole scored candidate set (with a fingerprint over
 * it) goes to out/detailed/matrix_vector_candidates.json, which is what a
 * consumer that merges or excludes candidates is checked against -- a
 * winner-only artifact makes "every exclusion is traceable" unverifiable.
 * The per-option comparison and the analysis tables are printed for the
 * document (teams/hardware/docs/02_AI_CORE.md, section 2.5). See
 * integration/detailed/matrix_vector_search.js for the method.
 *
 * Run after npm run baseline:sync: node integration/pipelines/generate_matrix_vector_design.js
 */
const fs = require('fs');
const path = require('path');
const S = require('../detailed/matrix_vector_search.js');

const root = path.resolve(__dirname, '../..');
const result = S.search();
const out = S.build(result);
const cand = S.candidates(result);
fs.writeFileSync(path.join(root, 'out/detailed/matrix_vector_design.json'), `${JSON.stringify(out, null, 2)}\n`);
fs.writeFileSync(path.join(root, 'out/detailed/matrix_vector_candidates.json'), `${JSON.stringify(cand, null, 2)}\n`);
const alt = S.alternatives(result), an = S.analysis(result);
const f = (v, n = 1) => (v === null || v === Infinity ? '—' : v.toFixed(n));
console.log(JSON.stringify({
  design: Object.fromEntries(Object.entries(out.design).map(([d, v]) => [d, v.option])),
  search: {candidates: out.designSpace.candidates, feasible: out.designSpace.feasible},
  candidateSetSha256: cand.candidateSetSha256,
  ratio: out.ratio, binding: out.binding, areaMm2: out.evaluation.areaMm2, tpsPerUser: out.evaluation.k3System.tpsPerUser,
  alternatives: Object.fromEntries(Object.entries(alt).map(([d, o]) => [d, Object.fromEntries(Object.entries(o).map(([n, v]) =>
    [n, `${v.chosen ? 'chosen' : v.lostOn}; ${JSON.stringify(v.pick)} die ${f(v.dieRatio)}:1, H ${f(v.hCoreRatio)}:1, `
      + `TPS ${f(v.tpsPerUser, 2)}, area ${f(v.areaMm2, 2)} mm2, power ${f(v.diePowerW, 1)} W`]))])),
  sweep: an.sweep.map(r => Object.entries(r).map(([k, v]) => `${k} ${typeof v === 'number' ? f(v, 2) : v}`).join(', ')),
  kernels: an.kernels.map(k => `${k.model} ${k.kernel} ${k.core}: ${Object.entries(k.maxCoreRatio).map(([c, v]) => `${c} ${f(v)}`).join(', ')}`),
  unpackAttribution: an.unpackAttribution, nativeBreakEvenMatrixOverhead: an.nativeBreakEvenMatrixOverhead,
  k3Only: an.k3Only
}, null, 2));
