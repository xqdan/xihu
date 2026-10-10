'use strict';
/* Workload shape (integration/detailed/workload_shape.js; ARCH-CH-03 of
 * teams/council/docs/24_TRACE_AND_CHARON_ADOPTION_PLAN.md). Evidence class MODEL.
 *
 * Run: node integration/pipelines/generate_workload_shape.js   (npm run shape:explore)
 *   -> out/detailed/workload_shape.json: the published hardware at B = 1..32 sequences per decode
 *      step (mapping re-chosen per point; TPS/usr against TPS/card) and at B = 1 over contexts
 *      2K..1M (LSE merge share, head-parallel bound). About a minute with the evaluation pool
 *      (K3_SEARCH_JOBS sets the worker count).
 */
const fs = require('fs');
const path = require('path');
const S = require('../detailed/workload_shape.js');

const root = path.resolve(__dirname, '../..');
const OUT = 'out/detailed/workload_shape.json';
const f = v => v.toFixed(2);
const pct = v => `${(100 * v).toFixed(1)}%`;

S.build().then(report => {
  fs.writeFileSync(path.join(root, OUT), `${JSON.stringify(report, null, 2)}\n`);
  console.log(`${OUT}: evidence ${S.EVIDENCE}`);
  for (const b of report.batchSweep) {
    const s = b.summary;
    console.log(`  context ${b.context}: ` + b.rows.map(r => (r.best ? `B${r.batch} ${f(r.best.tpsPerUser)}/${f(r.best.tpsPerCard)}` : `B${r.batch} -`)).join(', ')
      + `; max TPS/card ${f(s.maxTpsPerCard.tpsPerCard)} at B${s.maxTpsPerCard.batch} (${f(s.cardGainOverBatch1)}x card, ${pct(s.userRatioAtMaxCard)} TPS/usr); front ${b.paretoFront.length} points`);
  }
  for (const c of report.contextScan) {
    if (!c.feasible) { console.log(`  scan ${c.context}: infeasible ${c.reasons}`); continue; }
    const h = c.headParallel;
    console.log(`  scan ${c.context}: ${f(c.tpsPerUser)} TPS/usr, LSE ${c.lse.count} x = ${f(c.lse.us)} us (${pct(c.lse.shareOfRaw)}), attention ${pct(c.attentionShareOfRaw)}; head-parallel ${f(h.tpsPerUser.kvExposed)}..${f(h.tpsPerUser.kvHidden)}`);
  }
}).catch(error => {
  console.error(error);
  process.exit(1);
});
