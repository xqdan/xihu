'use strict';
/* Generate out/requirements/budget_frontier.json: the L1-b requirement frontier and its candidate
 * budget contracts (integration/planning/requirement_frontier.js), input to the design.req.budget
 * workflow. Feeds no gate or baseline.
 *
 * Run: node integration/pipelines/generate_budget_frontier.js   (npm run budget:frontier)
 */
const fs = require('fs');
const path = require('path');
const R = require('../planning/requirement_frontier.js');

const root = path.resolve(__dirname, '../..');
const frontier = R.build();
fs.mkdirSync(path.dirname(path.join(root, R.OUT_FILE)), {recursive: true});
fs.writeFileSync(path.join(root, R.OUT_FILE), `${JSON.stringify(frontier, null, 2)}\n`);
const f = (v, n = 3) => (v === null || v === undefined ? '-' : v.toFixed(n));
console.log(`${R.OUT_FILE}: raw budget ${f(frontier.target.rawBudgetUs, 2)} us; single-axis room `
  + Object.values(frontier.singleAxis).map(s => `${s.axis} ${f(s.value)} (${s.binding})`).join(', '));
for (const {splitId, contract: c} of frontier.splits) {
  const v = Object.fromEntries(c.split.map(e => [e.id, e.min !== undefined ? e.min : e.max]));
  console.log(`  ${splitId}: tau <= ${f(v['B-TAU'])} us, compute >= ${f(v['B-SERIAL-CMP'])}, MC >= ${f(v['B-MEM-BW'], 1)} GB/s/cube, `
    + `shared >= ${v['B-SRAM-CAP']} MiB/die; holds ${c.check.holds}`);
}
