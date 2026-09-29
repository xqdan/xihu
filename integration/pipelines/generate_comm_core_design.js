'use strict';
/* Generate out/detailed/comm_core_design.json: the Comm Core design chosen by
 * the search over the HW-07 design space
 * (teams/hardware/inputs/comm_core_design_space.json). Only the winner is
 * written; the per-option comparison is printed for the document
 * (teams/hardware/docs/10_COMM_CORE.md, section 7). See
 * integration/detailed/comm_core_search.js for the method.
 *
 * Run after npm run baseline:sync: node integration/pipelines/generate_comm_core_design.js
 */
const fs = require('fs');
const path = require('path');
const S = require('../detailed/comm_core_search.js');

const root = path.resolve(__dirname, '../..');
const result = S.search();
const out = S.build(result);
fs.writeFileSync(path.join(root, 'out/detailed/comm_core_design.json'), `${JSON.stringify(out, null, 2)}\n`);
const alt = S.alternatives(result);
console.log(JSON.stringify({
  design: Object.fromEntries(Object.entries(out.design).map(([d, v]) => [d, v.option])),
  search: {candidates: out.designSpace.candidates, valid: out.designSpace.valid, feasible: out.designSpace.feasible},
  specSlackUs: out.controlPath.specSlackUs, tpsPerUser: out.evaluation.withSpecFloor.tpsPerUser,
  alternatives: Object.fromEntries(Object.entries(alt).map(([d, o]) => [d, Object.fromEntries(Object.entries(o).map(([n, v]) =>
    [n, `${v.chosen ? 'chosen' : v.lostOn}; slowest ${v.slowest.latencyUs.toFixed(3)} us, slack ${v.specSlackUs.toFixed(3)} us, `
      + `AI Core ${v.aiCoreUsPerToken.toFixed(2)} us, area ${v.areaMm2.toFixed(3)} mm2, TPS ${v.withSpecFloor.tpsPerUser.toFixed(2)}`]))]))
}, null, 2));
