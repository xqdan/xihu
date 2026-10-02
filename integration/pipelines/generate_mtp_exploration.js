'use strict';
/* Generate out/detailed/mtp_exploration.json: the EXPLORATORY Batch=1 + MTP verify scenario
 * (integration/detailed/mtp_exploration.js). It does not feed any gate or baseline. About two minutes.
 *
 * Run: node integration/pipelines/generate_mtp_exploration.js   (npm run mtp:explore)
 */
const fs = require('fs');
const path = require('path');
const M = require('../detailed/mtp_exploration.js');

const root = path.resolve(__dirname, '../..');
const out = M.build();
fs.writeFileSync(path.join(root, 'out/detailed/mtp_exploration.json'), `${JSON.stringify(out, null, 2)}\n`);
const f = v => (v === null || v === undefined ? '-' : v.toFixed(1));
console.log(`${out.status}\nrows ${out.rows.length}, perf ${out.perf.length}; published k=1 step ${f(out.checkRow.verifyRawUs)} us`);
for (const dtype of Object.keys(M.SCENARIO.dtypes)) for (const union of M.SCENARIO.unions) {
  const line = M.SCENARIO.mcGBs.map(mc => {
    const r = out.alphaForGoal.find(a => a.dtype === dtype && a.mcGBs === mc && a.union === union && a.draftLayerEquiv === 1);
    return `MC${mc}: ${r.minAcceptance === null ? 'none' : r.minAcceptance}`;
  }).join(', ');
  console.log(`min acceptance for ${out.inputs.goalTpsPerUser} TPS/usr, ${dtype}, ${union}, d=1: ${line}`);
}
