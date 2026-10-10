'use strict';
/* Operator cost evidence coverage (integration/detailed/cost_coverage.js; ARCH-CH-02 of
 * teams/council/docs/24_TRACE_AND_CHARON_ADOPTION_PLAN.md). Evidence class MODEL.
 *
 * Run: node integration/pipelines/generate_cost_coverage.js   (npm run cost:coverage)
 *   -> out/detailed/cost_coverage.json: the published raw latency split by the cost source of each
 *      compute kernel (measured / fitted / analytical) and the rest (MODEL), and the calibration
 *      queue of op shapes to measure. Reads teams/vv/inputs/operator_cost_observations.json.
 */
const fs = require('fs');
const path = require('path');
const C = require('../detailed/cost_coverage.js');

const root = path.resolve(__dirname, '../..');
const OUT = 'out/detailed/cost_coverage.json';
const f = v => v.toFixed(2);
const pct = v => `${(100 * v).toFixed(1)}%`;

const report = C.build();
fs.writeFileSync(path.join(root, OUT), `${JSON.stringify(report, null, 2)}\n`);
const l = report.ledger, s = report.shares;
console.log(`${OUT}: raw ${f(l.rawUs)} us, ${report.provenance.observationCount} observations; kernel ${f(l.kernelUs)} us (measured ${f(l.bySource.measured)}, fitted ${f(l.bySource.fitted)}, analytical ${f(l.bySource.analytical)}), non-kernel ${f(l.nonKernelUs)} us; observed share ${pct(s.observed)}`);
for (const c of report.classes) console.log(`  ${c.class}: ${c.ops} ops, ${c.shapes} shapes, kernel ${f(c.kernelUs)} us`);
