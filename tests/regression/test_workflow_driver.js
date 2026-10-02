'use strict';

// The driver (integration/pipelines/run_workflow.js) end to end, against the real
// repository and a scripted backend. Nothing here may write to out/: every run is a
// dry run, and the tests assert that nothing landed.
//
// What this pins:
//   * a usage or environment problem is exit 1, never a design verdict;
//   * a C-group winner that is not a verbatim artifact row stops the run before
//     anything is written (exit 5) -- the mock backend invents one;
//   * a valid winner passes every gate and is reported as a dry run (exit 0);
//   * an agent that writes to the working tree stops the run (exit 3), checked by the
//     real git-backed guard.

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const {main} = require('../../integration/pipelines/run_workflow.js');
const {createMockBackend, fromSchema} = require('../../integration/orchestration/runtime/backends/mock.js');
const {buildSearchBrief} = require('../../integration/pipelines/search_brief.js');

const root = path.resolve(__dirname, '../..');

async function run(argv, deps) {
  const lines = [];
  const log = console.log;
  const error = console.error;
  console.log = (line) => lines.push(String(line));
  console.error = () => {};
  try {
    const code = await main(argv, deps);
    const text = lines.join('\n');
    let summary = null;
    try { summary = JSON.parse(text); } catch (_) { /* --list prints plain text */ }
    return {code, text, summary};
  } finally {
    console.log = log;
    console.error = error;
  }
}

(async () => {
  assert(!fs.existsSync(path.join(root, 'out/compute')), 'precondition: out/compute does not exist');

  // Usage and environment problems.
  assert.strictEqual((await run([])).code, 1);
  assert.strictEqual((await run(['compute'])).code, 1, 'a backend is required');
  assert.strictEqual((await run(['compute', '--backend', 'nonsense'])).code, 1);
  assert.strictEqual((await run(['memory', '--backend', 'mock'])).code, 1, 'only compute has a default brief');
  const listed = await run(['--list']);
  assert.strictEqual(listed.code, 0);
  assert.strictEqual(listed.text.split('\n').length, 19);

  // The mock backend invents a winner; the artifact check must reject it before landing.
  const invented = await run(['compute', '--backend', 'mock']);
  assert.strictEqual(invented.code, 5, `an invented winner must stop the run: ${invented.text}`);
  assert.strictEqual(invented.summary.verifyLanded.ok, false);
  assert.strictEqual(invented.summary.landing, undefined, 'nothing reaches landing after a failed check');

  // A real winner (a verbatim artifact row) passes every gate; the run is a dry run.
  const brief = buildSearchBrief('compute', {max: 12});
  const feasible = brief.candidates.map((c) => ({optionId: c.optionId, row: JSON.parse(c.values)})).find((c) => c.row.feasible);
  const winner = {optionId: feasible.optionId, values: JSON.stringify(feasible.row), provenance: 'driver test'};
  // The schema-derived reply fills every other field; only `winner` has to be real.
  const withWinner = createMockBackend({reply: (call) => {
    const required = (call.schema && call.schema.required) || [];
    if (!(required.includes('winner') && required.includes('excluded'))) return undefined;
    return {...fromSchema(call.schema, ''), winner};
  }});
  const good = await run(['compute', '--backend', 'mock'], {backend: withWinner});
  assert.strictEqual(good.code, 0, good.text);
  assert.strictEqual(good.summary.verdict, 'INVARIANT_OK');
  assert.strictEqual(good.summary.verifyLanded.ok, true);
  assert.strictEqual(good.summary.landing.dryRun, true, 'landing is opt-in');
  assert.strictEqual(good.summary.landing.landed.length, 2);
  assert.deepStrictEqual(good.summary.landing.rejected, []);
  assert(!fs.existsSync(path.join(root, 'out/compute')), 'a dry run must not create out/compute');

  // An agent that writes to the working tree stops the run.
  const probe = path.join(root, 'tests/regression/__driver_write_probe.txt');
  const writer = createMockBackend({reply: (call) => {
    fs.writeFileSync(probe, `written during ${call.label}`);
    return undefined;
  }});
  try {
    const tampered = await run(['compute', '--backend', 'mock'], {backend: writer});
    assert.strictEqual(tampered.code, 3, tampered.text);
    assert(tampered.summary.modified.includes('tests/regression/__driver_write_probe.txt'));
    assert.strictEqual(tampered.summary.landing, undefined);
  } finally {
    fs.rmSync(probe, {force: true});
  }

  console.log('PASS workflow driver: usage errors, invented winner stopped before landing, valid winner dry-run lands 2 files, working-tree write stops the run');
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
