'use strict';

// Runs the four C-group design workflows (compute, memory, comm, physical) against a
// mock runtime. The structure tests only read these files as text; this test
// executes them, so a control-flow change is checked by what the workflow RETURNS.
//
// The mock `agent()` answers from the call's own `schema`: the first enum value of
// every field (which is the "carry on" verdict in all of these schemas), empty
// arrays, and one search thread. A test overrides a call by its schema shape or
// returns null to simulate an agent that failed.
//
// What this pins:
//   * the search artifact reaches the workflow only through `args.searchBrief`
//     (no agent reads it), and a brief that is not ok blocks the run;
//   * a lateral (constraint) expert that returns nothing blocks the run instead of
//     being read as "no objection";
//   * verifyLandedWinner, the deterministic check run after the files land, accepts
//     a winner that is a verbatim artifact row and rejects an altered one.

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const {buildSearchBrief, verifyLandedWinner, DOMAINS} = require('../../integration/pipelines/search_brief.js');

const root = path.resolve(__dirname, '../..');
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;

function load(domain) {
  const source = fs.readFileSync(path.join(root, `integration/orchestration/design.${domain}.workflow.js`), 'utf8')
    .replace(/^export const meta/m, 'const meta');
  return new AsyncFunction('args', 'agent', 'parallel', 'phase', 'log', source);
}

function fromSchema(schema, key) {
  if (schema.enum) return schema.enum[0];
  const type = Array.isArray(schema.type) ? schema.type[0] : schema.type;
  switch (type) {
    case 'object':
      return Object.fromEntries(Object.entries(schema.properties || {})
        .filter(([name]) => (schema.required || []).includes(name))
        .map(([name, sub]) => [name, fromSchema(sub, name)]));
    case 'array':
      // One search thread is enough to fan out; everything else stays empty.
      return key === 'dims' ? [fromSchema(schema.items, key)] : [];
    case 'boolean':
      return true;
    case 'number':
      return 0;
    case 'string':
      return key === 'name' ? 'probe' : 'x';
    default:
      return null;
  }
}

// The reply for one agent call. `overrides.integrator` is a function of the candidate
// brief text the integrator received; `overrides.drop` lists labels that fail (null).
function mockAgent({winner, drop = []}) {
  return async (prompt, options = {}) => {
    const label = options.label || '';
    if (drop.includes(label)) return null;
    const schema = options.schema;
    const reply = fromSchema(schema, '');
    const required = schema.required || [];
    if (required.includes('winner') && required.includes('excluded')) reply.winner = winner;
    return reply;
  };
}

async function run(domain, args, {winner, drop} = {}) {
  const logs = [];
  const result = await load(domain)(
    args,
    mockAgent({winner, drop}),
    fns => Promise.all(fns.map(fn => fn())),
    () => {},
    message => logs.push(message)
  );
  return {result, logs};
}

const baseArgs = (domain, searchBrief) => ({
  repo: '.',
  runId: `test-${domain}`,
  brief: {stage: domain, objective: 'behaviour test', hardConstraints: []},
  searchArtifact: DOMAINS[domain].artifact,
  searchBrief
});

(async () => {
  for (const domain of Object.keys(DOMAINS)) {
    const brief = buildSearchBrief(domain, {max: 3});
    assert.strictEqual(brief.ok, true, `${domain}: ${brief.notes}`);
    const feasible = brief.candidates.map(c => ({optionId: c.optionId, row: JSON.parse(c.values)})).find(c => c.row.feasible);
    assert(feasible, `${domain}: the ranked head must contain a feasible candidate`);
    const winner = {optionId: feasible.optionId, values: JSON.stringify(feasible.row), provenance: 'test'};

    // 1. The happy path lands exactly the winner and the run record, and the brief
    // reaches the run record untouched.
    const ok = await run(domain, baseArgs(domain, brief), {winner});
    assert.strictEqual(ok.result.verdict, 'INVARIANT_OK', `${domain}: ${JSON.stringify(ok.result.reason || ok.result.violations)}`);
    assert.strictEqual(ok.result.files.length, 2, `${domain}: winner and run record must land`);
    const landedRecord = JSON.parse(ok.result.files.find(f => f.path.endsWith('_run_record.json')).content);
    const landedWinner = JSON.parse(ok.result.files.find(f => f.path.endsWith('_winner.json')).content);
    assert.strictEqual(landedRecord.designSpaceSha256, brief.designSpaceSha256, `${domain}: run record must name the brief's fingerprint`);
    assert.deepStrictEqual(landedRecord.searchProvenance, brief.provenance, `${domain}: run record must carry the brief's provenance`);

    // 2. The deterministic landing check accepts the verbatim winner ...
    const accepted = verifyLandedWinner(domain, landedWinner, landedRecord);
    assert.deepStrictEqual(accepted.failures, [], `${domain}: a verbatim winner must verify`);
    // ... and rejects one whose numbers were altered on the way (the failure the old
    // transcribing agent could introduce and nothing would have noticed).
    const row = JSON.parse(winner.values);
    const numericField = Object.keys(row).find(k => typeof row[k] === 'number');
    assert(numericField, `${domain}: expected a numeric field to alter`);
    const altered = {...landedWinner, values: JSON.stringify({...row, [numericField]: row[numericField] + 1})};
    const rejected = verifyLandedWinner(domain, altered, landedRecord);
    assert.strictEqual(rejected.ok, false, `${domain}: an altered winner must not verify`);
    assert(rejected.failures.some(f => /differs from the artifact row/.test(f)), `${domain}: ${rejected.failures}`);
    // An option that is not in the artifact, and a run record naming another fingerprint.
    assert.strictEqual(verifyLandedWinner(domain, {...landedWinner, optionId: 'invented'}, landedRecord).ok, false);
    assert.strictEqual(verifyLandedWinner(domain, landedWinner, {...landedRecord, designSpaceSha256: '0'}).ok, false);

    // 3. A lateral expert that fails blocks the run; it is not "no objection".
    const LATERAL = {
      compute: ['constraint:memory', 'constraint:physical'],
      memory: ['constraint:compute', 'constraint:software'],
      comm: ['constraint:memory', 'constraint:physical'],
      physical: ['constraint:compute', 'constraint:memory', 'constraint:comm']
    }[domain];
    for (const label of LATERAL) {
      const blocked = await run(domain, baseArgs(domain, brief), {winner, drop: [label]});
      assert.strictEqual(blocked.result.verdict, 'BLOCKED_CONFIG', `${domain}: dropping ${label} must block`);
      assert.deepStrictEqual(blocked.result.files, [], `${domain}: a blocked run must land nothing`);
      assert.deepStrictEqual(blocked.result.absentLateral, [label.replace('constraint:', '') + '-expert'], `${domain}: the absent expert must be named`);
      assert(blocked.result.nextActions.length === 1, `${domain}: a blocked exit must say what to do next`);
    }

    // 4. A brief that is not ok blocks the run before any merge; no brief is a launch error.
    const unusable = await run(domain, baseArgs(domain, {ok: false, domain, notes: 'stale'}), {winner});
    assert.strictEqual(unusable.result.verdict, 'BLOCKED_CONFIG', `${domain}: an unusable brief must block`);
    assert.deepStrictEqual(unusable.result.files, []);
    await assert.rejects(() => run(domain, {...baseArgs(domain, brief), searchBrief: undefined}, {winner}), /searchBrief/, `${domain}: a missing searchBrief must be a launch error`);
  }

  console.log(`PASS C-group workflow behaviour: ${Object.keys(DOMAINS).length} workflows run against a mock runtime -- the verified search brief is the only source of candidate numbers, a missing lateral expert blocks the run, and an altered winner fails the landing check`);
})().catch(error => {
  console.error(error);
  process.exit(1);
});
