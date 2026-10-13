'use strict';

const fs = require('fs');
const path = require('path');
const S = require('../planning/model_sram_sensitivity.js');

const root = path.resolve(__dirname, '../..');
const target = path.join(root, 'out/workload/model_sram_sensitivity.json');
const out = S.build();
fs.mkdirSync(path.dirname(target), {recursive: true});
fs.writeFileSync(target, `${JSON.stringify(out, null, 2)}\n`);
console.log(`model SRAM sensitivity: ${out.runs.length} deterministic capacity/bandwidth planning cells; no TPS/P95/P99 emitted`);
