'use strict';
/* Generate out/detailed/comm_core_design.json: the Comm Core design chosen by
 * the search over the HW-07 design space
 * (teams/hardware/inputs/comm_core_design_space.json). Only the winner is
 * written; the per-option comparison is printed for the document
 * (teams/hardware/docs/10_COMM_CORE.md, section 7). See
 * integration/detailed/comm_core_search.js for the method.
 *
 * The ranked candidate head goes to out/detailed/comm_candidates.json, which is
 * what design.comm reads: a winner-only artifact cannot support "every exclusion
 * is traceable", since the excluded entries were never written down. This grid
 * scores 45900 combinations where the siblings score hundreds, so that file
 * carries the whole-set fingerprint and an exclusion histogram rather than every
 * row -- see candidates() in comm_core_search.js.
 *
 * Run after npm run baseline:sync: node integration/pipelines/generate_comm_core_design.js
 */
const fs = require('fs');
const path = require('path');
const S = require('../detailed/comm_core_search.js');

const root = path.resolve(__dirname, '../..');
const result = S.search();
const out = S.build(result);
const cand = S.candidates(result);
fs.writeFileSync(path.join(root, 'out/detailed/comm_core_design.json'), `${JSON.stringify(out, null, 2)}\n`);
fs.writeFileSync(path.join(root, 'out/detailed/comm_candidates.json'), `${JSON.stringify(cand, null, 2)}\n`);
const alt = S.alternatives(result);
console.log(JSON.stringify({
  design: Object.fromEntries(Object.entries(out.design).map(([d, v]) => [d, v.option])),
  search: {candidates: out.designSpace.candidates, valid: out.designSpace.valid, feasible: out.designSpace.feasible},
  candidateSetSha256: cand.candidateSetSha256,
  listed: cand.listed, truncated: cand.truncated, infeasibleByCause: cand.infeasibleByCause,
  specSlackUs: out.controlPath.specSlackUs, tpsPerUser: out.evaluation.withSpecFloor.tpsPerUser,
  alternatives: Object.fromEntries(Object.entries(alt).map(([d, o]) => [d, Object.fromEntries(Object.entries(o).map(([n, v]) =>
    [n, `${v.chosen ? 'chosen' : v.lostOn}; slowest ${v.slowest.latencyUs.toFixed(3)} us, slack ${v.specSlackUs.toFixed(3)} us, `
      + `AI Core ${v.aiCoreUsPerToken.toFixed(2)} us, area ${v.areaMm2.toFixed(3)} mm2, TPS ${v.withSpecFloor.tpsPerUser.toFixed(2)}`]))]))
}, null, 2));
