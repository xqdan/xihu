'use strict';
/* Generate out/attribution/<dimension>_card.json: the TPS/usr attribution cards
 * (integration/detailed/tps_attribution.js), input to the design.attribution workflow.
 * Feeds no gate or baseline.
 *
 * Run: node integration/pipelines/generate_tps_attribution.js [dimension ...] [--point auto|joint|published]
 *      (npm run attribution:cards); default dimensions: sram comm joint; default point: auto, the
 *      joint point once design.coupling has landed one (design_point.js), the published point before
 */
const fs = require('fs');
const path = require('path');
const T = require('../detailed/tps_attribution.js');
const DP = require('./design_point.js');

const root = path.resolve(__dirname, '../..');
const argv = process.argv.slice(2);
const at = argv.indexOf('--point');
const pointKind = at >= 0 ? argv[at + 1] : 'auto';
const positional = argv.filter((a, i) => i !== at && i !== at + 1);
const dims = positional.length ? positional : T.DEFAULT_DIMENSIONS;
const point = DP.resolve({point: pointKind});
const ctx = T.context({point});
fs.mkdirSync(path.join(root, T.OUT_DIR), {recursive: true});
const f = (v, n = 1) => (v === null || v === undefined ? '-' : v.toFixed(n));
console.log(`design point (${point.kind}${point.optionId ? ` ${point.optionId}` : ''}): nominal ${f(ctx.base.tpsPerUser, 2)} TPS/usr, raw ${f(ctx.base.rawUs, 2)} / ${f(ctx.budgetUs, 2)} us; `
  + `all-unmeasured ${ctx.stressBase.feasible ? f(ctx.stressBase.tpsPerUser, 2) : 'infeasible'}`);
for (const dim of dims) {
  const card = T.build(dim, {context: ctx});
  const file = path.join(T.OUT_DIR, `${dim}_card.json`);
  fs.writeFileSync(path.join(root, file), `${JSON.stringify(card, null, 2)}\n`);
  console.log(`${file}: ${card.parameters.length} parameters; loadBearing [${card.loadBearing.join(', ')}]`
    + (card.slack ? `; slack [${card.slack.join(', ')}]` : '')
    + (dim === 'joint' ? `; routeTo ${card.jointPessimistic.routing.routeTo}` : ''));
}
