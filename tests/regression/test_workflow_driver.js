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
//     an outcome record that names who stopped it (the finding is not only in the terminal);
//   * a returned file:line citation onto a blank line lands nothing (exit 7); on a stop
//     the report goes into the outcome record instead;
//   * attribution: an expert range number found neither on the card nor on its cited line
//     lands nothing (exit 7); a loose number in a reason gets one repair call, and one left
//     after it is a mechanical violation; a card built at another design point than the one
//     design_point.js resolves is refused before the run (exit 1);
//   * req.budget: an unreachable entry rules its split out, none left is a direction backflow,
//     and a landed contract that is not its frontier split verbatim is refused (exit 5);
//   * design.coupling's joint point is checked against its artifact under its own file names;
//   * the budget contract's consumers get their brief derived from the contract rather than
//     from a committed file, and every other stage still has to be handed one.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {main, halfWinnerResult} = require('../../integration/pipelines/run_workflow.js');
const {createMockBackend, fromSchema} = require('../../integration/orchestration/runtime/backends/mock.js');
const {buildSearchBrief} = require('../../integration/pipelines/search_brief.js');
const {briefFor} = require('../../integration/pipelines/make_brief.js');
const DP = require('../../integration/pipelines/design_point.js');

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
  // A stage outside the budget contract's consumers still has to be handed a brief.
  assert.strictEqual((await run(['contract', '--backend', 'mock'])).code, 1, 'design.contract has no derivable brief');
  // The contract's consumers derive theirs instead -- mc has no committed brief file and
  // still gets past prepareArgs, which is the whole point of make_brief.js.
  const derived = await run(['mc', '--backend', 'mock']);
  assert.notStrictEqual(derived.code, 1, `mc must derive its brief from the budget contract: ${derived.text}`);
  const builtBrief = briefFor('mc').brief;
  assert.strictEqual(builtBrief.stage, 'mc');
  assert.strictEqual(builtBrief.profileBinding.mcProfile, 'MC320', 'the manufacturable binding is hand-authored, never read off the contract point (ADR-0021)');
  assert(builtBrief.hardConstraints.every((c) => c.source && c.source !== 'TBD'), 'every derived constraint names where its number came from');
  const listed = await run(['--list']);
  assert.strictEqual(listed.code, 0);
  assert.strictEqual(listed.text.split('\n').length, 23);

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

  // design.coupling lands under its own names (joint_point.json, coupling_run_record.json) and
  // the driver checks the joint point against the coupling artifact the same way.
  const joint = buildSearchBrief('coupling', {max: 12}).candidates.find((c) => {
    const row = JSON.parse(c.values);
    return row.feasible && row.pareto;
  });
  const withJoint = createMockBackend({reply: (call) => {
    const required = (call.schema && call.schema.required) || [];
    if (!(required.includes('winner') && required.includes('excluded'))) return undefined;
    return {...fromSchema(call.schema, ''), winner: {optionId: joint.optionId, values: joint.values, provenance: 'driver test'}};
  }});
  const coupled = await run(['coupling', '--backend', 'mock'], {backend: withJoint});
  assert.strictEqual(coupled.code, 0, coupled.text);
  assert.strictEqual(coupled.summary.verdict, 'INVARIANT_OK');
  assert.strictEqual(coupled.summary.verifyLanded.ok, true, coupled.text);
  assert.deepStrictEqual(coupled.summary.landing.landed.map((f) => f.path), ['out/coupling/joint_point.json', 'out/coupling/coupling_run_record.json']);
  assert(!fs.existsSync(path.join(root, 'out/coupling')), 'a dry run must not create out/coupling');
  // An invented joint point is stopped by the workflow's own mechanical check, so the run
  // returns no files and lands only its outcome record.
  const inventedJoint = await run(['coupling', '--backend', 'mock']);
  assert.strictEqual(inventedJoint.code, 0, inventedJoint.text);
  assert.strictEqual(inventedJoint.summary.verdict, 'INVARIANT_VIOLATED');
  assert.deepStrictEqual(inventedJoint.summary.landing.landed.map((f) => f.path), ['out/coupling/coupling_outcome.json']);
  assert(/winner without its run_record/.test(halfWinnerResult('coupling', [{path: 'out/coupling/joint_point.json', content: '{}'}])));

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

  // A winner without its run record (or the reverse) is half a result.
  const file = (name) => ({path: `out/compute/${name}`, content: '{"a":1}'});
  assert.strictEqual(halfWinnerResult('compute', [file('compute_winner.json'), file('compute_run_record.json')]), null);
  assert(/winner without its run_record/.test(halfWinnerResult('compute', [file('compute_winner.json')])));
  assert(/run_record without a winner/.test(halfWinnerResult('compute', [file('compute_run_record.json')])));
  assert.strictEqual(halfWinnerResult('compute', [file('compute_outcome.json')]), null, 'an outcome record alone is a legitimate stop');

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

  // A cited file:line that is blank stops a result with files (exit 7); a stop that cites it
  // still lands its outcome record, with the citation report inside. run_workflow.js:2 is blank.
  const card = JSON.parse(fs.readFileSync(path.join(root, 'out/attribution/comm_card.json'), 'utf8'));
  const attributionBackend = (evidence, reviewVerdict, {range = 'UNVERIFIED', reason = '', repairReason = '', calls = []} = {}) => createMockBackend({reply: (call) => {
    calls.push(call.label);
    const base = fromSchema(call.schema, '');
    const review = call.label.match(/^(review|repair):(.+-expert)$/);
    if (review) {
      const from = review[2];
      const extra = review[1] === 'repair' ? repairReason : reason;
      const rows = card.parameters.filter((p) => p.owner === from).map((p) => ({name: p.name, classification: 'agree', plausibleRange: range, rangeEvidence: evidence, breakEvenInsideRange: 'unknown', measurementPriority: 'high', reason: `parameters[${p.name}]${extra}`}));
      return {...base, from, rows, verdict: reviewVerdict, note: '', softwareDependence: []};
    }
    if (call.label === 'integrator') {
      const lb = card.loadBearing.map((name) => ({name, owner: 'comm-expert', basis: 'card', source: `parameters[${name}].classification`}));
      return {...base, loadBearing: lb, slack: [], measurementPlan: lb.map(({name, owner}) => ({name, owner, measurement: 'card measurementNeeded', priority: 'high'})), conflicts: [], verdict: 'INTEGRATION_OK', deltaNote: ''};
    }
    if (call.label === 'invariant-checker') return {...base, verdict: 'INVARIANT_OK', violations: []};
    return undefined;
  }});
  const clean = await run(['attribution', '--backend', 'mock', '--dimension', 'comm'], {backend: attributionBackend('integration/pipelines/run_workflow.js:1', 'LOCAL_DETAIL_FIX')});
  assert.strictEqual(clean.code, 0, clean.text);
  assert.strictEqual(clean.summary.verdict, 'INVARIANT_OK');
  assert.deepStrictEqual(clean.summary.landing.landed.map((f) => f.path).sort(), ['out/attribution/reviews/comm_review.json', 'out/attribution/reviews/comm_run_record.json']);
  const blank = await run(['attribution', '--backend', 'mock', '--dimension', 'comm'], {backend: attributionBackend('integration/pipelines/run_workflow.js:2', 'LOCAL_DETAIL_FIX')});
  assert.strictEqual(blank.code, 7, blank.text);
  assert.strictEqual(blank.summary.citations.problems[0].problem, 'blank line');
  assert.strictEqual(blank.summary.landing, undefined, 'a blank citation lands nothing');
  const blockedStop = await run(['attribution', '--backend', 'mock', '--dimension', 'comm'], {backend: attributionBackend('integration/pipelines/run_workflow.js:2', 'BLOCKED_CONFIG')});
  assert.strictEqual(blockedStop.code, 0, blockedStop.text);
  assert.deepStrictEqual(blockedStop.summary.landing.landed.map((f) => f.path), ['out/attribution/reviews/attribution_comm_outcome.json']);
  assert.strictEqual(blockedStop.summary.citations.problems.length, 1, 'the stop carries the citation report');

  // Once design.coupling has landed a joint point the cards must be rebuilt at it: a card at the
  // published point is refused before any agent (exit 1).
  const coupling = JSON.parse(fs.readFileSync(path.join(root, 'out/detailed/coupling_candidates.json'), 'utf8'));
  const jointRow = coupling.candidates.find((c) => c.feasible);
  const jointPoint = () => DP.resolve({point: 'joint', artifact: coupling, runRecord: {candidateSetSha256: coupling.candidateSetSha256},
    jointPoint: {optionId: jointRow.optionId, values: JSON.stringify(jointRow), provenance: 'test', x: jointRow.x, opt: jointRow.opt, model: jointRow.model}});
  const otherPoint = await run(['attribution', '--backend', 'mock', '--dimension', 'comm'], {backend: attributionBackend('integration/pipelines/run_workflow.js:1', 'LOCAL_DETAIL_FIX'), designPoint: jointPoint});
  assert.strictEqual(otherPoint.code, 1, 'a card at another design point is refused');
  assert.strictEqual(otherPoint.summary, null, 'nothing ran');

  // An expert range number that is neither on the card nor on the cited line stops landing (exit 7).
  const offCard = await run(['attribution', '--backend', 'mock', '--dimension', 'comm'], {backend: attributionBackend('integration/pipelines/run_workflow.js:1', 'LOCAL_DETAIL_FIX', {range: '123.456 us'})});
  assert.strictEqual(offCard.code, 7, offCard.text);
  assert.strictEqual(offCard.summary.rangeNumbers.problems[0].number, '123.456');
  assert.strictEqual(offCard.summary.landing, undefined, 'an unsupported range number lands nothing');

  // A loose number in a reason sends that expert back once; a clean repair lands, a repeat does not.
  const repairedCalls = [];
  const repaired = await run(['attribution', '--backend', 'mock', '--dimension', 'comm'], {backend: attributionBackend('integration/pipelines/run_workflow.js:1', 'LOCAL_DETAIL_FIX', {reason: ' about 123.456 us', calls: repairedCalls})});
  assert.strictEqual(repaired.code, 0, repaired.text);
  assert.strictEqual(repaired.summary.verdict, 'INVARIANT_OK');
  assert(repairedCalls.some((l) => l.startsWith('repair:')), 'a loose number triggers a repair call');
  const stuck = await run(['attribution', '--backend', 'mock', '--dimension', 'comm', '--result-file', resultFile], {backend: attributionBackend('integration/pipelines/run_workflow.js:1', 'LOCAL_DETAIL_FIX', {reason: ' about 123.456 us', repairReason: ' still 123.456 us'})});
  try {
    assert.strictEqual(stuck.code, 0, stuck.text);
    assert.strictEqual(stuck.summary.verdict, 'INVARIANT_VIOLATED', 'a loose number left after the repair is a violation');
    const full = JSON.parse(fs.readFileSync(resultFile, 'utf8'));
    assert(full.runRecord.mechanicalChecks.looseNumbers.length > 0 && full.runRecord.mechanicalChecks.looseNumbers.every((l) => l.number === '123.456'));
  } finally {
    fs.rmSync(resultFile, {force: true});
  }

  // req.budget: experts judge every split, the architect picks among the reachable ones, and the
  // landed contract is the frontier split verbatim. An unreachable entry rules its split out; an
  // edited contract or a frontier swapped under the run stops landing (exit 5).
  const frontier = JSON.parse(fs.readFileSync(path.join(root, 'out/requirements/budget_frontier.json'), 'utf8'));
  const budgetBackend = ({unreachable = [], pick, calls = []} = {}) => createMockBackend({reply: (call) => {
    calls.push(call.label);
    const base = fromSchema(call.schema, '');
    const review = call.label.match(/^(review|repair):(.+-expert)$/);
    if (review) {
      const from = review[2];
      const entries = frontier.splits.flatMap((s) => s.contract.split.filter((e) => e.ownerAgent === from).map((e) => ({
        splitId: s.splitId, id: e.id, reachability: unreachable.includes(`${s.splitId}/${e.id}`) ? 'unreachable' : 'reachable',
        plausibleRange: 'UNVERIFIED', rangeEvidence: 'integration/pipelines/run_workflow.js:1', reason: `splits[${s.splitId}].${e.id}`})));
      return {...base, from, entries, note: ''};
    }
    if (call.label === 'architect') return {...base, splitId: pick || call.schema.properties.splitId.enum[0], reason: 'tradeoff by entry id', tradeoff: 'B-TAU'};
    if (call.label === 'invariant-checker') return {...base, verdict: 'INVARIANT_OK', violations: []};
    return undefined;
  }});
  const budgetCalls = [];
  const landedBudget = await run(['req.budget', '--backend', 'mock', '--result-file', resultFile], {backend: budgetBackend({unreachable: ['S-TAU/B-TAU'], calls: budgetCalls})});
  try {
    assert.strictEqual(landedBudget.code, 0, landedBudget.text);
    assert.strictEqual(landedBudget.summary.verdict, 'INVARIANT_OK');
    assert.strictEqual(landedBudget.summary.verifyLanded.ok, true);
    assert.deepStrictEqual(landedBudget.summary.landing.landed.map((f) => f.path).sort(), ['out/budget/L1_budget.json', 'out/budget/L1_run_record.json']);
    assert(!fs.existsSync(path.join(root, 'out/budget')), 'a dry run must not create out/budget');
    const full = JSON.parse(fs.readFileSync(resultFile, 'utf8'));
    assert.strictEqual(full.splitId, 'S-CMP', 'the unreachable S-TAU is not offered to the architect');
    assert.deepStrictEqual(full.ledgerPatch.rejectedOptions.map((r) => [r.optionId, r.rejectedBy]), [['S-TAU', 'comm-expert']]);
    assert.deepStrictEqual(full.budget.selection.reachable, ['S-CMP', 'S-BW', 'S-BAL']);
    assert(['review:compute-expert', 'review:memory-expert', 'review:comm-expert', 'review:physical-expert', 'architect', 'framing-critic', 'invariant-checker'].every((l) => budgetCalls.includes(l)));
  } finally {
    fs.rmSync(resultFile, {force: true});
  }
  // Every split ruled out is a direction backflow: no contract, an outcome record instead.
  const allOut = await run(['req.budget', '--backend', 'mock'], {backend: budgetBackend({unreachable: frontier.splits.map((s) => `${s.splitId}/B-AREA`)})});
  assert.strictEqual(allOut.code, 0, allOut.text);
  assert.strictEqual(allOut.summary.verdict, 'DIRECTION_BACKFLOW');
  assert.deepStrictEqual(allOut.summary.landing.landed.map((f) => f.path), ['out/budget/req_budget_outcome.json']);
  // The landed contract must equal its frontier split and name the frontier that was read.
  const {verifyLandedBudget} = require('../../integration/pipelines/run_workflow.js');
  const split = frontier.splits[1];
  const budgetFiles = (contract, sha = 'abc') => [
    {path: 'out/budget/L1_budget.json', content: JSON.stringify({...contract, selection: {frontierSha256: sha}})},
    {path: 'out/budget/L1_run_record.json', content: '{}'},
  ];
  assert.strictEqual(verifyLandedBudget(budgetFiles(split.contract), frontier, 'abc').ok, true);
  const edited = verifyLandedBudget(budgetFiles({...split.contract, point: {...split.contract.point, tauUs: 9}}), frontier, 'abc');
  assert(!edited.ok && /differs from/.test(edited.problems[0]), 'an edited budget is refused');
  assert(!verifyLandedBudget(budgetFiles(split.contract, 'other'), frontier, 'abc').ok, 'a contract from another frontier is refused');
  assert(!verifyLandedBudget(budgetFiles(split.contract).slice(0, 1), frontier, 'abc').ok, 'a contract without its run record is half a result');

  console.log('PASS workflow driver: usage errors, a derived brief for the contract\'s consumers, invented winner stopped before landing, valid winner dry-run lands 2 files, working-tree write stops the run, a backflow leaves an outcome record, a blank file:line citation or an unsupported range number stops landing (exit 7), a loose number is repaired once and otherwise violates; req.budget lands a verbatim frontier split, rules out unreachable splits and backflows when none is left');
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
