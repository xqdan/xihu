'use strict';

const fs = require('fs');
const path = require('path');
const R = require('../planning/model_core_replay.js');

const root = path.resolve(__dirname, '../..');
const file = path.join(root, 'out/workload/model_core_replay.json');
const out = R.build();
fs.mkdirSync(path.dirname(file), {recursive: true});
fs.writeFileSync(file, `${JSON.stringify(out, null, 2)}\n`);
console.log(`model core replay: ${out.runs.length} planning runs; no TPS/P95/P99 emitted`);
