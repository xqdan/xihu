'use strict';

// The host runtime for design.*.workflow.js (integration/orchestration/runtime/):
// schema validation, the retry/abort policy, concurrency, the landing gates, the
// read-only guard, and the two real backends driven through fakes.
//
// What this pins, because each is a way a run can go wrong silently:
//   * a reply that does not match its schema is retried with the error list, then
//     becomes `null` (which the workflows treat as "this agent produced nothing");
//   * a failure to START is fatal and aborts the run instead of becoming `null`;
//   * landing is all-or-nothing and refuses paths outside the workflow's own area,
//     `explore` writing anywhere but scratch/, and gate literals in content;
//   * the guard sees a file an agent wrote;
//   * Claude "403 Model disabled" is fatal, 429 is retried; Cursor needs a key;
//   * the exchange backend answers through files, never from a stale run, and gives up
//     on a call nobody answers (fatal);
//   * a run that returned no files still leaves a landable outcome record.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {EventEmitter} = require('events');

const rt = path.resolve(__dirname, '../../integration/orchestration/runtime');
const {validate, extractJson, withSchema: withSchemaFromSchema} = require(`${rt}/schema`);
const {createRuntime, listWorkflows, compileWorkflow} = require(`${rt}/core`);
const {BackendFatalError} = require(`${rt}/errors`);
const {landFiles, LANDING_POLICY, scriptGateDecisions, recheckGateDecision} = require(`${rt}/land`);
const {snapshot, changedBetween} = require(`${rt}/guard`);
const {createClaudeBackend, interpret, parseCliOutput} = require(`${rt}/backends/claude`);
const {createCursorBackend, withSchema} = require(`${rt}/backends/cursor`);
const {createMockBackend} = require(`${rt}/backends/mock`);
const {createExchangeBackend} = require(`${rt}/backends/exchange`);
const {buildOutcomeFile, outcomePath, compact} = require(`${rt}/outcome`);

const root = path.resolve(__dirname, '../..');

// ---- schema ---------------------------------------------------------------
const schema = {
  type: 'object',
  properties: {
    verdict: {type: 'string', enum: ['INVARIANT_OK', 'INVARIANT_VIOLATED']},
    items: {type: 'array', items: {type: 'object', properties: {id: {type: 'string', pattern: '^X-'}}, required: ['id'], additionalProperties: false}},
    n: {type: ['number', 'null']},
  },
  required: ['verdict', 'items'],
  additionalProperties: false,
};
assert.deepStrictEqual(validate(schema, {verdict: 'INVARIANT_OK', items: [{id: 'X-1'}], n: null}), []);
assert(validate(schema, {verdict: 'MAYBE', items: []}).some((e) => /not one of/.test(e)));
assert(validate(schema, {verdict: 'INVARIANT_OK'}).some((e) => /missing required property "items"/.test(e)));
assert(validate(schema, {verdict: 'INVARIANT_OK', items: [{id: 'Y-1'}]}).some((e) => /does not match/.test(e)));
assert(validate(schema, {verdict: 'INVARIANT_OK', items: [], extra: 1}).some((e) => /unexpected property "extra"/.test(e)));
assert(validate(schema, {verdict: 'INVARIANT_OK', items: [], n: 'a'}).some((e) => /expected number\|null/.test(e)));
assert.throws(() => validate({type: 'wat'}, 1), /unsupported type/, 'an unknown type must not pass silently');
assert.deepStrictEqual(extractJson('{"a":1}'), {a: 1});
assert.deepStrictEqual(extractJson('Here you go:\n```json\n{"a":2}\n```'), {a: 2});
assert.deepStrictEqual(extractJson('prefix {"a":3} suffix'), {a: 3});
assert.throws(() => extractJson('no json here'), /not valid JSON/);

// ---- every workflow compiles ----------------------------------------------
const names = listWorkflows(root);
assert.strictEqual(names.length, 19, `expected 19 workflows, found ${names.length}`);
for (const name of names) assert.strictEqual(typeof compileWorkflow(root, name), 'function', name);
assert.throws(() => compileWorkflow(root, 'nope'), /no such workflow/);

(async () => {
  // ---- retry, null, abort, concurrency ------------------------------------
  const good = {verdict: 'INVARIANT_OK', items: []};
  const seenPrompts = [];
  const flaky = createRuntime({backend: {complete: async ({prompt, attempt}) => { seenPrompts.push(prompt); return attempt === 1 ? '{"verdict":"MAYBE","items":[]}' : JSON.stringify(good); }}});
  assert.deepStrictEqual(await flaky.globals.agent('p', {schema, label: 'a'}), good);
  assert.strictEqual(flaky.record.calls[0].attempts, 2);
  assert(/不符合要求的 JSON Schema/.test(seenPrompts[1]) && /not one of/.test(seenPrompts[1]), 'the retry must carry the validation errors');
  assert.strictEqual(flaky.record.failures[0].kind, 'schema');

  const hopeless = createRuntime({backend: {complete: async () => 'not json'}, maxAttempts: 2});
  assert.strictEqual(await hopeless.globals.agent('p', {schema, label: 'b'}), null);
  assert.strictEqual(hopeless.record.calls[0].ok, false);

  const throwing = createRuntime({backend: {complete: async ({attempt}) => { if (attempt < 3) throw new Error('boom'); return JSON.stringify(good); }}});
  assert.deepStrictEqual(await throwing.globals.agent('p', {schema}), good, 'an ordinary backend error is retried');

  const fatal = createRuntime({backend: {complete: async () => { throw new BackendFatalError('no key'); }}});
  await assert.rejects(fatal.globals.agent('p', {schema}), /no key/, 'a fatal error aborts instead of becoming null');

  const textual = createRuntime({backend: {complete: async () => 'plain text'}});
  assert.strictEqual(await textual.globals.agent('p', {}), 'plain text', 'no schema: the reply is returned as text');

  let active = 0;
  let peak = 0;
  const slow = createRuntime({concurrency: 3, backend: {complete: async () => { active += 1; peak = Math.max(peak, active); await new Promise((r) => setTimeout(r, 5)); active -= 1; return 'x'; }}});
  await slow.globals.parallel(Array.from({length: 12}, () => () => slow.globals.agent('p', {})));
  assert.strictEqual(peak, 3, `concurrency must be capped at 3, peaked at ${peak}`);

  // ---- landing gates ------------------------------------------------------
  assert.deepStrictEqual(Object.keys(LANDING_POLICY).sort(), names.sort(), 'every workflow needs a landing policy');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'land-'));
  const ok = landFiles({root: tmp, workflow: 'compute', files: [{path: 'out/compute/compute_winner.json', content: '{"a":1}'}]});
  assert.strictEqual(ok.landed.length, 1);
  assert.strictEqual(fs.readFileSync(path.join(tmp, 'out/compute/compute_winner.json'), 'utf8'), '{"a":1}');
  const reject = (workflow, files) => landFiles({root: tmp, workflow, files}).rejected.map((r) => r.reason).join(' | ');
  assert(/escapes the repository/.test(reject('compute', [{path: '../evil.json', content: '{}'}])));
  assert(/escapes the repository/.test(reject('compute', [{path: path.join(os.tmpdir(), 'evil.json'), content: '{}'}])));
  assert(/outside what compute may land/.test(reject('compute', [{path: 'out/memory/x.json', content: '{}'}])));
  assert(/outside what explore may land/.test(reject('explore', [{path: 'out/x.md', content: 'hi'}])), 'explore may only write scratch/');
  assert.strictEqual(reject('explore', [{path: 'scratch/explore_1.md', content: 'hi'}]), '');
  assert(/gate literal/.test(reject('dgate', [{path: 'out/governance/e.json', content: '{\n  "decision": "PASS"\n}'}])));
  assert(/gate literal/.test(reject('dgate', [{path: 'out/governance/e.json', content: 'D_GATE_PASSED'}])));
  assert.strictEqual(reject('dgate', [{path: 'out/governance/e.json', content: '不得写 PASS 字面量'}]), '', 'a prohibition may name the literal');
  assert.strictEqual(reject('dgate', [{path: 'out/governance/e.json', content: 'PASSTHROUGH and BYPASS'}]), '', 'a substring is not the literal');
  assert(/no landing policy/.test(reject('mystery', [{path: 'out/x.json', content: '{}'}])));
  // The script's own decision may be carried; anything else may not.
  fs.mkdirSync(path.join(tmp, 'out/governance'), {recursive: true});
  fs.writeFileSync(path.join(tmp, 'out/governance/gate_status.json'), JSON.stringify({directionGate: {decision: 'PASS'}, quantificationGate: {decision: 'BLOCKED_BY_X'}}));
  const decisions = scriptGateDecisions(tmp, 'dgate');
  assert.deepStrictEqual(decisions, ['PASS'], 'dgate reports on the direction gate only');
  assert.deepStrictEqual(scriptGateDecisions(tmp, 'design.verify'), ['PASS', 'BLOCKED_BY_X']);
  assert.deepStrictEqual(scriptGateDecisions(tmp, 'compute'), []);
  const evidence = (value) => [{path: 'out/governance/e.json', content: `{\n  "gateDecision": "${value}",\n  "x": 1\n}\n`}];
  assert.strictEqual(landFiles({root: tmp, workflow: 'dgate', files: evidence('PASS'), dryRun: true, scriptDecisions: decisions}).rejected.length, 0, 'the script value lands');
  assert.strictEqual(landFiles({root: tmp, workflow: 'dgate', files: evidence('PASS'), dryRun: true}).rejected.length, 1, 'without the script value the literal is refused');
  assert.strictEqual(landFiles({root: tmp, workflow: 'dgate', files: [{path: 'out/governance/e.json', content: '{"gateDecision": "PASS", "note": "PASS"}'}], dryRun: true, scriptDecisions: decisions}).rejected.length, 1, 'only the exact gateDecision line is exempt');
  assert.strictEqual(landFiles({root: tmp, workflow: 'dgate', files: [{path: 'out/governance/e.json', content: '{\n  "summary": "PASS"\n}'}], dryRun: true, scriptDecisions: decisions}).rejected.length, 1, 'other keys stay refused');
  assert.strictEqual(recheckGateDecision('dgate', {gateDecision: 'PASS'}, decisions), null);
  assert.strictEqual(recheckGateDecision('dgate', {gateDecision: 'UNVERIFIED'}, decisions), null);
  assert(/does not match/.test(recheckGateDecision('dgate', {gateDecision: 'D_GATE_PASSED'}, decisions)), 'an invented decision is refused');
  assert(/does not match/.test(recheckGateDecision('dgate', {gateDecision: 'BLOCKED_BY_X'}, decisions)), 'the quantification decision is not the direction gate');
  assert.strictEqual(recheckGateDecision('compute', {gateDecision: 'PASS'}, []), null, 'other workflows are not rechecked');
  const atomic = landFiles({root: tmp, workflow: 'verify', files: [
    {path: 'out/verification/verify_report.json', content: '{}'},
    {path: 'out/direction/oops.json', content: '{}'},
  ]});
  assert.strictEqual(atomic.landed.length, 0);
  assert(!fs.existsSync(path.join(tmp, 'out/verification/verify_report.json')), 'one rejected file must land nothing');
  const dry = landFiles({root: tmp, workflow: 'intake', files: [{path: 'teams/council/inputs/design_brief.intake.json', content: '{}'}], dryRun: true});
  assert.strictEqual(dry.landed.length, 1);
  assert(!fs.existsSync(path.join(tmp, 'teams')), 'a dry run writes nothing');
  assert(/outside what intake may land/.test(reject('intake', [{path: 'teams/council/inputs/other.json', content: '{}'}])), 'an exact-file policy admits only that file');

  // ---- read-only guard ----------------------------------------------------
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'guard-'));
  const listDir = (dir) => fs.readdirSync(dir); // stands in for `git ls-files -m -o`
  fs.writeFileSync(path.join(repo, 'a.txt'), 'one');
  const before = snapshot(repo, listDir);
  assert.deepStrictEqual(changedBetween(before, snapshot(repo, listDir)), [], 'an untouched tree reports no change');
  fs.writeFileSync(path.join(repo, 'a.txt'), 'two-longer');
  fs.writeFileSync(path.join(repo, 'b.txt'), 'new');
  assert.deepStrictEqual(changedBetween(before, snapshot(repo, listDir)), ['a.txt', 'b.txt'], 'an agent write is seen');
  fs.rmSync(path.join(repo, 'b.txt'));
  assert.deepStrictEqual(changedBetween(before, snapshot(repo, listDir)), ['a.txt'], 'a deletion is seen');

  // ---- claude backend through a fake CLI ----------------------------------
  const fakeSpawn = (script) => (command, argv, options) => {
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    let stdin = '';
    child.stdin = {end: (text) => { stdin = text; }};
    child.kill = () => {};
    fakeSpawn.last = {command, argv, options, get stdin() { return stdin; }};
    setImmediate(() => script(child));
    return child;
  };
  const respond = (document, {code = 0, prefix = ''} = {}) => fakeSpawn((child) => {
    child.stdout.emit('data', `${prefix}${JSON.stringify(document)}\n`);
    child.emit('close', code);
  });

  const claude = createClaudeBackend({spawnImpl: respond({is_error: false, structured_output: good, result: ''}), cwd: root, model: 'sonnet'});
  assert.deepStrictEqual(await claude.complete({prompt: 'hello', schema, effort: 'high'}), good);
  const used = fakeSpawn.last;
  assert(used.argv.includes('--json-schema') && used.argv.includes(JSON.stringify(schema)));
  assert.strictEqual(used.argv[used.argv.indexOf('--tools') + 1], 'Read,Grep,Glob', 'agents get a read-only tool set');
  assert(used.argv.includes('--no-session-persistence'));
  assert.strictEqual(used.argv[used.argv.indexOf('--effort') + 1], 'high');
  assert.strictEqual(used.argv[used.argv.indexOf('--model') + 1], 'sonnet');
  assert.strictEqual(used.stdin, 'hello', 'the prompt travels on stdin, not argv');

  const viaText = createClaudeBackend({spawnImpl: respond({is_error: false, result: JSON.stringify(good)}, {prefix: '[claude-code:note] diagnostic\n'})});
  assert.strictEqual(typeof await viaText.complete({prompt: 'p', schema}), 'string', 'a text result is left for the runtime to parse');
  assert.deepStrictEqual(parseCliOutput('[warn] x\n{"ok":1}\n'), {ok: 1}, 'a diagnostic line before the JSON is tolerated');

  const disabled = createClaudeBackend({spawnImpl: respond({is_error: true, api_error_status: 403, result: 'Model disabled'}, {code: 1})});
  await assert.rejects(disabled.complete({prompt: 'p', schema}), (e) => e.fatal === true && /403/.test(e.message), '403 must abort the run');
  const limited = createClaudeBackend({spawnImpl: respond({is_error: true, api_error_status: 429, result: 'slow down'}, {code: 1})});
  await assert.rejects(limited.complete({prompt: 'p', schema}), (e) => !e.fatal, '429 is retryable');
  const missing = createClaudeBackend({spawnImpl: fakeSpawn((child) => child.emit('error', Object.assign(new Error('spawn'), {code: 'ENOENT'})))});
  await assert.rejects(missing.complete({prompt: 'p', schema}), (e) => e.fatal === true && /not found/.test(e.message));
  const silent = createClaudeBackend({spawnImpl: fakeSpawn((child) => child.emit('close', 1))});
  await assert.rejects(silent.complete({prompt: 'p'}), (e) => !e.fatal && /exited 1/.test(e.message));
  assert.throws(() => interpret({is_error: false}), /neither structured_output nor result/);

  // ---- cursor backend through a fake SDK ----------------------------------
  class CursorAgentError extends Error {
    constructor(message, isRetryable) { super(message); this.isRetryable = isRetryable; }
  }
  const seen = [];
  const sdk = (reply) => ({CursorAgentError, Agent: {prompt: async (prompt, options) => { seen.push({prompt, options}); return reply(); }}});

  const cursor = createCursorBackend({apiKey: 'k', cwd: root, sdk: sdk(() => ({status: 'finished', result: `\`\`\`json\n${JSON.stringify(good)}\n\`\`\``}))});
  const viaRuntime = createRuntime({backend: cursor});
  assert.deepStrictEqual(await viaRuntime.globals.agent('do it', {schema}), good, 'a fenced reply is parsed and validated by the runtime');
  assert(/JSON Schema/.test(seen[0].prompt) && seen[0].prompt.includes(JSON.stringify(schema)), 'the schema travels in the prompt');
  assert.deepStrictEqual(seen[0].options.local, {cwd: root, settingSources: []}, 'no ambient settings are loaded');
  assert.deepStrictEqual(seen[0].options.tools, ['read', 'grep', 'glob', 'ls']);
  assert.strictEqual(withSchema('p'), 'p');

  await assert.rejects(createCursorBackend({apiKey: '', sdk: sdk(() => ({}))}).complete({prompt: 'p'}), (e) => e.fatal === true && /CURSOR_API_KEY/.test(e.message));
  await assert.rejects(createCursorBackend({apiKey: 'k', sdk: sdk(() => { throw new CursorAgentError('bad key', false); })}).complete({prompt: 'p'}), (e) => e.fatal === true);
  await assert.rejects(createCursorBackend({apiKey: 'k', sdk: sdk(() => { throw new CursorAgentError('blip', true); })}).complete({prompt: 'p'}), (e) => !e.fatal);
  await assert.rejects(createCursorBackend({apiKey: 'k', sdk: sdk(() => ({status: 'error', id: 'r1'}))}).complete({prompt: 'p'}), (e) => !e.fatal && /status=error/.test(e.message));
  const withEffort = createCursorBackend({apiKey: 'k', effortParam: 'reasoning', sdk: sdk(() => ({status: 'finished', result: 'x'}))});
  await withEffort.complete({prompt: 'p', effort: 'high'});
  assert.deepStrictEqual(seen[seen.length - 1].options.model.params, [{id: 'reasoning', value: 'high'}]);

  // ---- mock backend -------------------------------------------------------
  const mock = createMockBackend({reply: ({label}) => (label === 'custom' ? {verdict: 'INVARIANT_VIOLATED', items: []} : undefined)});
  assert.deepStrictEqual(await createRuntime({backend: mock}).globals.agent('p', {schema, label: 'custom'}), {verdict: 'INVARIANT_VIOLATED', items: []});
  assert.deepStrictEqual(await createRuntime({backend: mock}).globals.agent('p', {schema, label: 'other'}), {verdict: 'INVARIANT_OK', items: []});

  // ---- exchange backend ---------------------------------------------------
  const exchangeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wf-exchange-'));
  try {
    assert.strictEqual(withSchemaFromSchema, withSchema, 'one withSchema, shared by the cursor and exchange backends');
    // A leftover answer in another run directory must never be read by this run.
    const stale = createExchangeBackend({dir: exchangeDir, runId: 'old', pollMs: 5, timeoutMs: 150});
    fs.writeFileSync(path.join(stale.dir, '001.answer.txt'), '"stale"');
    const seenRequests = [];
    const fresh = createExchangeBackend({dir: exchangeDir, runId: 'new', pollMs: 5, timeoutMs: 2000, onRequest: (r) => seenRequests.push(r)});
    const pending = fresh.complete({prompt: 'who?', schema, label: 'probe', effort: 'high', attempt: 1});
    await new Promise((resolve) => setTimeout(resolve, 40));
    const requestFile = path.join(fresh.dir, '001.request.json');
    const request = JSON.parse(fs.readFileSync(requestFile, 'utf8'));
    assert.strictEqual(request.label, 'probe');
    assert(request.prompt.startsWith('who?') && request.prompt.includes(JSON.stringify(schema)), 'the request carries the prompt and the schema');
    fs.writeFileSync(path.join(fresh.dir, '001.answer.txt'), '');
    await new Promise((resolve) => setTimeout(resolve, 40));
    fs.writeFileSync(path.join(fresh.dir, '001.answer.txt'), JSON.stringify(good));
    assert.deepStrictEqual(extractJson(await pending), good, 'an empty answer file is not an answer; the real one is');
    assert.strictEqual(seenRequests.length, 1);

    const silent = createExchangeBackend({dir: exchangeDir, runId: 'silent', pollMs: 5, timeoutMs: 60});
    await assert.rejects(silent.complete({prompt: 'p'}), (e) => e.fatal === true && /no answer/.test(e.message), 'a call nobody answers is fatal');
    assert.throws(() => createExchangeBackend({}), (e) => e.fatal === true);
  } finally {
    fs.rmSync(exchangeDir, {recursive: true, force: true});
  }

  // ---- outcome record -----------------------------------------------------
  assert.strictEqual(outcomePath('design.compute'), 'out/compute/compute_outcome.json');
  assert.strictEqual(outcomePath('detail.events'), 'out/detailed/detail_events_outcome.json');
  assert.strictEqual(outcomePath('explore'), 'scratch/explore_outcome.json');
  assert.strictEqual(outcomePath('intake'), null, 'intake can only land one exact file');
  assert.strictEqual(buildOutcomeFile('compute', {verdict: 'X', files: [{path: 'out/compute/a.json', content: '{}'}]}), null, 'a run with files needs no outcome record');
  assert.strictEqual(buildOutcomeFile('intake', {verdict: 'X', files: []}), null);
  const rows = Array.from({length: 5}, (_, i) => ({optionId: `o${i}`, values: '{"big":true}'}));
  assert.deepStrictEqual(compact({candidates: rows, short: rows.slice(0, 2)}), {candidates: {count: 5, optionIds: ['o0', 'o1', 'o2', 'o3', 'o4']}, short: rows.slice(0, 2)});
  const outcome = buildOutcomeFile('compute', {stage: 'compute', runId: 'r1', verdict: 'PPA_DIRECTION_BACKFLOW', reason: 'why', files: [], searchNode: {candidates: rows}}, {backend: 'mock', agentCalls: 3});
  const recorded = JSON.parse(outcome.content);
  assert.strictEqual(recorded.kind, 'WORKFLOW_OUTCOME_NO_FILES');
  assert.strictEqual(recorded.backend, 'mock');
  assert.strictEqual(recorded.result.verdict, 'PPA_DIRECTION_BACKFLOW');
  assert.strictEqual(recorded.result.files, undefined);
  assert.strictEqual(recorded.result.searchNode.candidates.count, 5, 'candidate rows are replaced by their ids');
  assert.deepStrictEqual(landFiles({root, workflow: 'compute', files: [outcome], dryRun: true}).rejected, [], 'the record passes the same landing gates');

  console.log(`PASS workflow runtime: schema, retry/abort policy, concurrency cap, landing gates for ${Object.keys(LANDING_POLICY).length} workflows, read-only guard, claude, cursor and exchange backends, outcome records`);
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
