'use strict';
/* Link-level tau derivation (integration/detailed/collective_topology.js; HW-CH-01 of
 * teams/council/docs/24_TRACE_AND_CHARON_ADOPTION_PLAN.md). Evidence class MODEL.
 *
 * Run: node integration/pipelines/generate_tau_derivation.js   (npm run tau:derivation)
 *   -> out/detailed/tau_derivation.json: per scale-out topology candidate x algorithm x ACK
 *      semantics, the bottom-up tau of each collective class and the TPS/usr of the published point
 *      at it (no floor, 1.15 us floor, optimistic and pessimistic corners); per topology the
 *      tornado and the break-even of each parameter that decides 1000 TPS/usr.
 *      Reads teams/hardware/inputs/scaleout_topology_candidates.json and out/detailed/comm_core_design.json.
 */
const fs = require('fs');
const path = require('path');
const C = require('../detailed/collective_topology.js');

const root = path.resolve(__dirname, '../..');
const OUT = 'out/detailed/tau_derivation.json';
const f = v => v.toFixed(2);

const report = C.build();
fs.writeFileSync(path.join(root, OUT), `${JSON.stringify(report, null, 2)}\n`);
const p = report.published;
console.log(`${OUT}: published ${f(p.tpsPerUser)} TPS/usr at tau ${p.specTauUs} us (break-even ${p.tauBreakEvenUs.toFixed(3)} us); abstract wire one-way budget ${p.abstractWire.oneWayBudgetUs.toFixed(3)} us vs model ${p.modelOneWayUs} us`);
for (const c of report.conditions) {
  const hold = c.mustHold.map(h => `${h.param} <= ${h.atMost.toFixed(3)}`).join(', ');
  console.log(`  ${c.topology} / ${c.bestAlgorithm} / ACK ${c.ackDrain}: max tau ${c.maxTauUs.toFixed(3)} us, ${f(c.tpsPerUser.bottomUp)} TPS/usr (corners ${f(c.tpsPerUser.optimistic)}-${f(c.tpsPerUser.pessimistic)})${hold ? `; needs ${hold}` : ''}`);
}
