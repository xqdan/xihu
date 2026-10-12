'use strict';
const fs = require('fs');
const path = require('path');
const N = require('../planning/network_requirements.js');
const root = path.resolve(__dirname, '../..');
const out = N.build();
fs.mkdirSync(path.dirname(path.join(root, N.OUT_FILE)), {recursive: true});
fs.writeFileSync(path.join(root, N.OUT_FILE), `${JSON.stringify(out, null, 2)}\n`);
for (const s of out.scenarios) {
  if (s.status === 'BLOCKED_CONFIG') { console.log(`${s.scenarioId}: ${s.status} (${s.reasons.join('; ')})`); continue; }
  for (const t of s.topologies) console.log(`${s.scenarioId}/${t.topology}: busiest utilization ${t.busiestLink.utilization.toFixed(3)}, nominal route P99 ${t.nominalMessagePathLatencyUs.p99.toFixed(3)} us (not runtime P99)`);
}
