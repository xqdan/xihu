'use strict';
/* Foreground overlap contention delta (integration/detailed/contention_delta.js; ARCH-CH-01 of
 * teams/council/docs/24_TRACE_AND_CHARON_ADOPTION_PLAN.md). Evidence class MODEL.
 *
 * Run: node integration/pipelines/generate_contention_delta.js   (npm run contention:delta)
 *   -> out/detailed/contention_delta.json: the published point and every feasible joint point of
 *      out/detailed/coupling_candidates.json under contention 'none' (the published model) and
 *      'proportional'. A few seconds. Reads coupling_candidates.json, so run it after coupling:search.
 */
const fs = require('fs');
const path = require('path');
const D = require('../detailed/contention_delta.js');

const root = path.resolve(__dirname, '../..');
const OUT = 'out/detailed/contention_delta.json';
const f = v => v.toFixed(2);

const report = D.build();
fs.writeFileSync(path.join(root, OUT), `${JSON.stringify(report, null, 2)}\n`);
const s = report.summary;
console.log(`${OUT}: ${s.feasible}/${s.points} points; max |raw delta| ${s.maxAbsRawDeltaUs.toExponential(2)} us; max foreground load ${f(s.maxPeakForegroundLoad)} of cap; evidence ${D.EVIDENCE}`);
for (const p of report.points) {
  if (!p.feasible) { console.log(`  ${p.point}: infeasible`); continue; }
  const peak = Object.entries(p.peakForegroundLoad).map(([k, v]) => `${k} ${f(v.load)}`).join(', ');
  console.log(`  ${p.point}: ${f(p.none.tpsPerUser)} -> ${f(p.proportional.tpsPerUser)} TPS/usr, contention ${f(p.contentionUs)} us of ${f(p.overlapGainUs)} overlap; peak load ${peak}; over-cap ops ${p.overCap.map(o => o.name).join(', ') || 'none'}`);
}
