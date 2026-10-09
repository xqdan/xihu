'use strict';
/* Generate out/requirements/workload_requirements.json: the L1-a per-token workload and arithmetic
 * intensity summary (integration/planning/requirement_workload.js), input to the design.req.workload
 * workflow. Feeds no gate or baseline.
 *
 * Run: node integration/pipelines/generate_workload_requirements.js   (npm run workload:requirements)
 */
const fs = require('fs');
const path = require('path');
const R = require('../planning/requirement_workload.js');

const root = path.resolve(__dirname, '../..');
const out = R.build();
fs.mkdirSync(path.dirname(path.join(root, R.OUT_FILE)), {recursive: true});
fs.writeFileSync(path.join(root, R.OUT_FILE), `${JSON.stringify(out, null, 2)}\n`);
const f = (v, n = 2) => (v === null || v === undefined ? '-' : v.toFixed(n));
console.log(`${R.OUT_FILE}: raw budget ${f(out.target.rawLatencyBudgetUs)} us`);
for (const m of out.models) {
  const s = m.slots.find(x => x.tp === 32);
  const ratio = id => f((s.sizing.ratios.find(r => r.ratio === id) || {}).value, 3);
  const bases = s.collectives.bases.map(b => `${b.basis} ${b.count}`).join(' / ');
  console.log(`  ${m.model}: ${(s.totals.globalFlopsPerToken / 1e12).toFixed(3)} TFLOP/token, `
    + `${(s.totals.globalBytesPerToken / 1e9).toFixed(3)} GB/token, intensity ${f(s.totals.aggregateFlopPerByte)} FLOP/B; `
    + `TP32 raw ${f(s.lanes.rawUs)} us, ${f(s.lanes.tpsPerUser, 1)} TPS/usr, bound ${s.lanes.bound}; `
    + `collectives ${bases}; required/available compute/memory/network `
    + `${ratio('requiredToAvailableRatio')} / ${ratio('requiredToAvailableBandwidthRatio')} / ${ratio('requiredToAvailableNetworkRatio')}`);
}
