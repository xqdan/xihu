'use strict';
/* Generate out/detailed/die_area_reallocation.json: the EXPLORATORY compute-die area/power
 * reallocation study (integration/detailed/die_area_reallocation.js). Feeds no gate or baseline.
 *
 * Run: node integration/pipelines/generate_die_area_reallocation.js   (npm run area:explore)
 */
const fs = require('fs');
const path = require('path');
const D = require('../detailed/die_area_reallocation.js');

const root = path.resolve(__dirname, '../..');
const out = D.build();
fs.writeFileSync(path.join(root, 'out/detailed/die_area_reallocation.json'), `${JSON.stringify(out, null, 2)}\n`);
const f = (v, n = 1) => (v === null || v === undefined ? '-' : v.toFixed(n));
console.log(out.status);
console.log(`published: nominal ${f(out.published.nominal.tps)}, compute-pessimistic ${f(out.published.compute.tps)}, all-unmeasured ${f(out.published.allUnmeasured.tps)}; `
  + `die area ${f(out.published.nominal.dieAreaMm2)}/${out.envelope.limits.dieAreaMm2}, die power ${f(out.published.nominal.diePowerW)}/${out.envelope.limits.diePowerW}, card ${f(out.published.nominal.cardPowerW, 0)}/${out.envelope.limits.cardPowerW}`);
for (const p of out.proposals) {
  console.log(`${p.floor} (nominal >= ${f(p.nominalFloorTps)}): ${JSON.stringify(p.changed)} -> nominal ${f(p.result.nominal.tps)}, compute ${f(p.result.compute.tps)}, all-unmeasured ${f(p.result.allUnmeasured && p.result.allUnmeasured.tps)}`);
}
