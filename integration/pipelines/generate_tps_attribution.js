'use strict';
/* Generate out/attribution/<dimension>_card.json: the TPS/usr attribution cards
 * (integration/detailed/tps_attribution.js), input to the design.attribution workflow.
 * Feeds no gate or baseline.
 *
 * Run: node integration/pipelines/generate_tps_attribution.js [dimension ...]   (npm run attribution:cards)
 *      default dimensions: sram comm joint
 */
const fs = require('fs');
const path = require('path');
const T = require('../detailed/tps_attribution.js');

const root = path.resolve(__dirname, '../..');
const dims = process.argv.slice(2).length ? process.argv.slice(2) : T.DEFAULT_DIMENSIONS;
const ctx = T.context();
fs.mkdirSync(path.join(root, T.OUT_DIR), {recursive: true});
const f = (v, n = 1) => (v === null || v === undefined ? '-' : v.toFixed(n));
console.log(`design point: nominal ${f(ctx.base.tpsPerUser, 2)} TPS/usr, raw ${f(ctx.base.rawUs, 2)} / ${f(ctx.budgetUs, 2)} us; `
  + `all-unmeasured ${ctx.stressBase.feasible ? f(ctx.stressBase.tpsPerUser, 2) : 'infeasible'}`);
for (const dim of dims) {
  const card = T.build(dim, {context: ctx});
  const file = path.join(T.OUT_DIR, `${dim}_card.json`);
  fs.writeFileSync(path.join(root, file), `${JSON.stringify(card, null, 2)}\n`);
  console.log(`${file}: ${card.parameters.length} parameters; loadBearing [${card.loadBearing.join(', ')}]`
    + (card.slack ? `; slack [${card.slack.join(', ')}]` : '')
    + (dim === 'joint' ? `; routeTo ${card.jointPessimistic.routing.routeTo}` : ''));
}
