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
//     real git-backed guard;
//   * a run that stops on a lateral expert's backflow returns no files, and still leaves
//     an outcome record that names who stopped it (the finding is not only in the terminal).

const assert = require('assert');
const fs = require('fs');
const os = require('os');
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
  // Search policy replies need at least one searched dimension, or the run stops there.
  const withDims = (call, extra) => {
    const required = (call.schema && call.schema.required) || [];
    if (required.includes('dims')) return {...fromSchema(call.schema, ''), dims: [fromSchema(call.schema.properties.dims.items, '')]};
    return extra ? extra(call, required) : undefined;
  };

  // Usage and environment problems.
  assert.strictEqual((await run([])).code, 1);
  assert.strictEqual((await run(['compute'])).code, 1, 'a backend is required');
  assert.strictEqual((await run(['compute', '--backend', 'nonsense'])).code, 1);
  assert.strictEqual((await run(['memory', '--backend', 'mock'])).code, 1, 'only compute has a default brief');
  const listed = await run(['--list']);
  assert.strictEqual(listed.code, 0);
  assert.strictEqual(listed.text.split('\n').length, 19);

  // The mock backend invents a winner; the artifact check must reject it before landing.
  const invented = await run(['compute', '--backend', 'mock'], {backend: createMockBackend({reply: (call) => withDims(call)})});
  assert.strictEqual(invented.code, 5, `an invented winner must stop the run: ${invented.text}`);
  assert.strictEqual(invented.summary.verifyLanded.ok, false);
  assert.strictEqual(invented.summary.landing, undefined, 'nothing reaches landing after a failed check');

  // A real winner (a verbatim artifact row) passes every gate; the run is a dry run.
  const brief = buildSearchBrief('compute', {max: 12});
  const feasible = brief.candidates.map((c) => ({optionId: c.optionId, row: JSON.parse(c.values)})).find((c) => c.row.feasible);
  const winner = {optionId: feasible.optionId, values: JSON.stringify(feasible.row), provenance: 'driver test'};
  // The schema-derived reply fills every other field; only `winner` has to be real.
  const withWinner = createMockBackend({reply: (call) => withDims(call, (c, required) => {
    if (!(required.includes('winner') && required.includes('excluded'))) return undefined;
    return {...fromSchema(c.schema, ''), winner};
  })});
  const good = await run(['compute', '--backend', 'mock'], {backend: withWinner});
  assert.strictEqual(good.code, 0, good.text);
  assert.strictEqual(good.summary.verdict, 'INVARIANT_OK');
  assert.strictEqual(good.summary.verifyLanded.ok, true);
  assert.strictEqual(good.summary.landing.dryRun, true, 'landing is opt-in');
  assert.strictEqual(good.summary.landing.landed.length, 2);
  assert.deepStrictEqual(good.summary.landing.rejected, []);
  assert(!fs.existsSync(path.join(root, 'out/compute')), 'a dry run must not create out/compute');

  // A lateral expert's backflow ends the run with no files. The summary names the expert,
  // and the stop is landable as an outcome record (dry run here: nothing is written).
  const backflowBackend = createMockBackend({reply: (call) => withDims(call, () => (call.label === 'constraint:physical'
    ? {from: 'physical-expert', constraints: [{text: 'package window', rulesOut: 'all six feasible candidates', constraintId: 'NEW', evidence: 'UNVERIFIED'}], verdict: 'PPA_DIRECTION_BACKFLOW'}
    : undefined))});
  const resultFile = path.join(os.tmpdir(), `driver-result-${process.pid}.json`);
  try {
    const stopped = await run(['compute', '--backend', 'mock', '--result-file', resultFile], {backend: backflowBackend});
    assert.strictEqual(stopped.code, 0, stopped.text);
    assert.strictEqual(stopped.summary.verdict, 'PPA_DIRECTION_BACKFLOW');
    const finding = stopped.summary.findings.find((f) => f.from === 'physical-expert');
    assert(finding && finding.verdict === 'PPA_DIRECTION_BACKFLOW' && finding.rulesOut[0] === 'all six feasible candidates', 'the summary names who stopped the run and on what');
    assert.deepStrictEqual(stopped.summary.landing.landed.map((f) => f.path), ['out/compute/compute_outcome.json']);
    assert.strictEqual(stopped.summary.landing.dryRun, true);
    assert(!fs.existsSync(path.join(root, 'out/compute')), 'a dry run must not create out/compute');
    const full = JSON.parse(fs.readFileSync(resultFile, 'utf8'));
    assert.strictEqual(full.verdict, 'PPA_DIRECTION_BACKFLOW', '--result-file keeps the full result');
  } finally {
    fs.rmSync(resultFile, {force: true});
  }

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

  console.log('PASS workflow driver: usage errors, invented winner stopped before landing, valid winner dry-run lands 2 files, working-tree write stops the run, a backflow leaves an outcome record');
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
