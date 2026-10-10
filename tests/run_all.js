'use strict';

// Usage: node tests/run_all.js [--jobs=N] [group ...]   groups: unit, regression, governance, structure
//
// Test files run as separate processes, up to N at a time (default: min(8, cores - 1);
// TEST_JOBS=N or --jobs=N overrides it, --jobs=1 is the old strictly serial order). A file's
// output is printed whole when it finishes, under its own header, so parallel runs do not
// interleave. The first failing file stops the run with that file's exit code.
const fs = require('fs');
const os = require('os');
const path = require('path');
const {spawn} = require('child_process');

const root = path.resolve(__dirname, '..');
const GROUPS = ['unit', 'regression', 'governance', 'structure'];

const jobsArg = process.argv.slice(2).find(arg => arg.startsWith('--jobs='));
const selected = process.argv.slice(2).filter(arg => !arg.startsWith('--jobs='));
for (const g of selected) if (!GROUPS.includes(g)) throw new Error(`unknown test group ${g}; expected one of ${GROUPS.join(', ')}`);

// The tests write only to per-process temp paths, with one deliberate exception: test_workflow_driver
// puts a probe file in the working tree, which test_regeneration_reproducible's copy ignores.
const cores = typeof os.availableParallelism === 'function' ? os.availableParallelism() : os.cpus().length;
const defaultJobs = Math.min(8, Math.max(1, cores - 1));
const jobs = Number(jobsArg ? jobsArg.slice('--jobs='.length) : (process.env.TEST_JOBS || defaultJobs));
if (!Number.isInteger(jobs) || jobs < 1) throw new Error(`invalid job count ${jobsArg || process.env.TEST_JOBS}; expected a positive integer`);

const tests = (selected.length ? selected : GROUPS).flatMap(group => fs.readdirSync(path.join(__dirname, group))
  .filter(name => /^test_.*\.js$/.test(name))
  .sort()
  .map(name => `${group}/${name}`));

// Dispatch order only: these files take 20 s or more each, so they start first and the quick files
// fill the gaps. Without it the slowest file can start last and become the whole run's tail.
// Out of date is harmless: it changes how long the run takes, never what it checks.
const SLOW_FIRST = [
  'regression/test_tps_attribution.js',
  'governance/test_regeneration_reproducible.js',
  'regression/test_baseline_joint_sync.js',
  'regression/test_workflow_driver.js',
  'regression/test_c_group_workflow_behavior.js',
  'regression/test_budget_frontier.js',
  'regression/test_tps_design_baseline.js',
  'regression/test_sram_design.js',
  'regression/test_memory_design.js',
  'regression/test_tau_derivation.js'
];
const dispatchOrder = [
  ...SLOW_FIRST.filter(name => tests.includes(name)),
  ...tests.filter(name => !SLOW_FIRST.includes(name))
];

function start(name) {
  const child = spawn(process.execPath, [path.join(__dirname, name)], {cwd: root, stdio: ['ignore', 'pipe', 'pipe']});
  const chunks = [];
  child.stdout.on('data', chunk => chunks.push(chunk));
  child.stderr.on('data', chunk => chunks.push(chunk));
  const done = new Promise(resolve => {
    const finish = (status, extra = '') => resolve({name, status, output: Buffer.concat(chunks).toString('utf8') + extra});
    child.on('error', error => finish(1, String(error.stack || error)));
    child.on('close', status => finish(status === null ? 1 : status));
  });
  return {child, done};
}

async function main() {
  const queue = [...dispatchOrder];
  const running = new Map();
  let failure = null;

  while (queue.length || running.size) {
    while (!failure && queue.length && running.size < jobs) {
      const name = queue.shift();
      running.set(name, start(name));
    }
    const result = await Promise.race([...running.values()].map(entry => entry.done));
    running.delete(result.name);
    if (failure) continue; // a run already failed: stopped files report nothing
    console.log(`=== tests/${result.name} ===`);
    process.stdout.write(result.output);
    if (result.status !== 0) {
      failure = result;
      queue.length = 0;
      for (const entry of running.values()) entry.child.kill();
    }
  }

  if (failure) process.exit(failure.status || 1);
  console.log(`PASS ${tests.length} test files`);
}

main();
