'use strict';

const fs = require('fs');
const path = require('path');
const {spawnSync} = require('child_process');

const root = path.resolve(__dirname, '..');
const tests = fs.readdirSync(__dirname)
  .filter(name => /^test_.*\.js$/.test(name))
  .sort();

for (const name of tests) {
  console.log(`=== tests/${name} ===`);
  const result = spawnSync(process.execPath, [path.join(__dirname, name)], {
    cwd: root,
    stdio: 'inherit'
  });
  if (result.status !== 0) process.exit(result.status || 1);
}

console.log(`PASS ${tests.length} test files`);
