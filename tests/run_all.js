'use strict';

// Usage: node tests/run_all.js [group ...]   groups: unit, regression, governance, structure
const fs = require('fs');
const path = require('path');
const {spawnSync} = require('child_process');

const root = path.resolve(__dirname, '..');
const GROUPS = ['unit', 'regression', 'governance', 'structure'];
const selected = process.argv.slice(2);
for (const g of selected) if (!GROUPS.includes(g)) throw new Error(`unknown test group ${g}; expected one of ${GROUPS.join(', ')}`);

const tests = (selected.length ? selected : GROUPS).flatMap(group => fs.readdirSync(path.join(__dirname, group))
  .filter(name => /^test_.*\.js$/.test(name))
  .sort()
  .map(name => `${group}/${name}`));

for (const name of tests) {
  console.log(`=== tests/${name} ===`);
  const result = spawnSync(process.execPath, [path.join(__dirname, name)], {
    cwd: root,
    stdio: 'inherit'
  });
  if (result.status !== 0) process.exit(result.status || 1);
}

console.log(`PASS ${tests.length} test files`);
