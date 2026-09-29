'use strict';
/* Generate out/detailed/comm_core_budget.json: the Comm Core control-path
 * budget (HW-07 decision input, teams/hardware/docs/10_COMM_CORE.md). See
 * integration/detailed/comm_core_budget.js for the method.
 *
 * Run after npm run baseline:sync: node integration/pipelines/generate_comm_core_budget.js
 */
const fs = require('fs');
const path = require('path');
const C = require('../detailed/comm_core_budget.js');

const root = path.resolve(__dirname, '../..');
const out = C.build();
fs.writeFileSync(path.join(root, 'out/detailed/comm_core_budget.json'), `${JSON.stringify(out, null, 2)}\n`);
console.log(JSON.stringify({
  controlBudgetUs: out.budget.controlUsWithinRawBudget,
  schemes: Object.fromEntries(Object.entries(out.schemes).map(([k, s]) => [k, {controlUs: s.controlUs, tpsPerUser: s.bottomUp.tpsPerUser, meetsBudget: s.meetsBudget}]))
}, null, 2));
