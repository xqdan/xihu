'use strict';

// Runs design.coupling (integration/orchestration/design.coupling.workflow.js) against a mock
// runtime, the way test_c_group_workflow_behavior.js runs the five domains: what the workflow
// RETURNS is checked, not its text.
//
// What this pins:
//   * the happy path lands exactly out/coupling/joint_point.json and coupling_run_record.json,
//     and the joint point's x / opt / model are the artifact row's own (search_brief.js verify
//     accepts it);
//   * nothing feasible is a DIRECTION_BACKFLOW to design.req.budget (doc 23 section 6) that
//     passes the artifact's backflow on, lands nothing and never reaches the merge;
//   * every coupling seat that fails blocks the run, named by seat, and the seats are the
//     design space's couplings.*.seats;
//   * a seat's backflow stops the run before the merge;
//   * the joint point must be a verbatim, feasible, Pareto row -- a dominated row or altered
//     numbers are an INVARIANT_VIOLATED with nothing to land, decided without an agent;
//   * a brief that is not ok blocks; a missing searchBrief or another stage's brief is a launch error.

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const {buildSearchBrief, verifyLandedWinner, STAGES} = require('../../integration/pipelines/search_brief.js');
const {compileWorkflow} = require('../../integration/orchestration/runtime/core.js');
const {fromSchema} = require('../../integration/orchestration/runtime/backends/mock.js');

const root = path.resolve(__dirname, '../..');
const ARTIFACT = STAGES.coupling.artifact;
const space = JSON.parse(fs.readFileSync(path.join(root, 'teams/hardware/inputs/coupling_design_space.json'), 'utf8'));
const real = JSON.parse(fs.readFileSync(path.join(root, ARTIFACT), 'utf8'));

// `winner` answers the integrator, `drop` lists labels that fail (null), `seatReply` overrides one seat.
function mockAgent({winner, drop = [], seatReply = {}}) {
  const labels = [];
  const fn = async (prompt, options = {}) => {
    const label = options.label || '';
    labels.push(label);
    if (drop.includes(label)) return null;
    if (seatReply[label]) return seatReply[label];
    const reply = fromSchema(options.schema, '');
    const required = options.schema.required || [];
    if (required.includes('winner') && required.includes('excluded')) reply.winner = winner;
    return reply;
  };
  fn.labels = labels;
  return fn;
}

async function run(args, opts = {}) {
  const agent = mockAgent(opts);
  const logs = [];
  const result = await compileWorkflow(root, 'coupling')(
    args,
    agent,
    fns => Promise.all(fns.map(f => f())),
    () => {},
    message => logs.push(message)
  );
  return {result, logs, labels: agent.labels};
}

const baseArgs = searchBrief => ({
  repo: '.',
  runId: 'test-coupling',
  brief: {stage: 'coupling', objective: 'behaviour test', hardConstraints: []},
  searchArtifact: ARTIFACT,
  searchBrief
});

const SEATS = [...new Set(Object.values(space.couplings).flatMap(c => c.seats))].sort();

(async () => {
  const brief = buildSearchBrief('coupling', {max: 12, recompute: false});
  assert.strictEqual(brief.ok, true, brief.notes);
  assert(brief.composition && 'backflow' in brief, 'the coupling brief carries the composition and the backflow');
  const rows = brief.candidates.map(c => ({c, row: JSON.parse(c.values)}));
  const top = rows.find(({row}) => row.feasible && row.pareto);
  const dominated = rows.find(({row}) => row.feasible && !row.pareto);
  assert(top && dominated, 'the ranked head holds a Pareto row and a dominated feasible row');
  const winnerOf = ({c}) => ({optionId: c.optionId, values: c.values, provenance: 'test'});

  // 1. Happy path: two files, and the joint point is the row's own point.
  const ok = await run(baseArgs(brief), {winner: winnerOf(top)});
  assert.strictEqual(ok.result.verdict, 'INVARIANT_OK', JSON.stringify(ok.result.violations || ok.result.reason));
  assert.deepStrictEqual(ok.result.files.map(f => f.path), ['./out/coupling/joint_point.json', './out/coupling/coupling_run_record.json']);
  const joint = JSON.parse(ok.result.files[0].content);
  const record = JSON.parse(ok.result.files[1].content);
  assert.deepStrictEqual(joint.x, top.row.x);
  assert.deepStrictEqual(joint.opt, top.row.opt);
  assert.deepStrictEqual(joint.model, top.row.model);
  assert.strictEqual(record.candidateSetSha256, brief.candidateSetSha256);
  assert.deepStrictEqual(record.searchProvenance, brief.provenance);
  assert.deepStrictEqual(record.composition, brief.composition, 'the composition reaches the run record untouched');
  assert.deepStrictEqual(verifyLandedWinner('coupling', joint, record).failures, [], 'the landed joint point verifies');
  // The seats are the design space's, each on the couplings the space puts it on.
  assert.deepStrictEqual(record.seats.map(s => s.seat).sort(), SEATS, 'the seats are couplings.*.seats');
  for (const s of record.seats) {
    const expected = Object.entries(space.couplings).filter(([, c]) => c.seats.includes(s.seat)).map(([name]) => name);
    assert.deepStrictEqual(s.couplings, expected, `${s.seat}: couplings`);
  }
  assert(ok.result.ledgerPatch.currentStage === 'coupling');

  // 2. Nothing feasible: back to L1-b with the artifact's own backflow, before any agent.
  const deadArtifact = JSON.parse(JSON.stringify(real));
  deadArtifact.candidates = deadArtifact.candidates.map(c => ({...c, feasible: false, pareto: false, chosen: false, violations: ['belowContractTarget']}));
  deadArtifact.feasibleCandidates = 0;
  deadArtifact.paretoCandidates = 0;
  deadArtifact.backflow = {to: 'L1-b', routeTo: 'design.req.budget', shortfallTpsPerUser: 7.4, domainBest: deadArtifact.composition.domainAlone};
  const deadBrief = buildSearchBrief('coupling', {max: 12, artifact: deadArtifact, recompute: false});
  assert.strictEqual(deadBrief.ok, true, deadBrief.notes);
  const dead = await run(baseArgs(deadBrief), {winner: winnerOf(top)});
  assert.strictEqual(dead.result.verdict, 'DIRECTION_BACKFLOW');
  assert.strictEqual(dead.result.routeTo, 'design.req.budget');
  assert.deepStrictEqual(dead.result.backflow, deadArtifact.backflow, 'the backflow is passed on verbatim');
  assert.deepStrictEqual(dead.result.files, []);
  assert.deepStrictEqual(dead.labels, [], 'no agent is called when nothing is feasible');
  assert(/7\.4/.test(dead.result.ledgerPatch.openBlockers[0].unblockCondition), 'the shortfall reaches the ledger blocker');

  // 3. A seat that fails blocks the run, named by seat.
  for (const seat of SEATS) {
    const blocked = await run(baseArgs(brief), {winner: winnerOf(top), drop: [`seat:${seat}`]});
    assert.strictEqual(blocked.result.verdict, 'BLOCKED_CONFIG', `dropping ${seat} must block`);
    assert.deepStrictEqual(blocked.result.absentLateral, [seat]);
    assert.deepStrictEqual(blocked.result.files, []);
    assert(!blocked.labels.includes('integrator'), `${seat}: no merge after a missing seat`);
  }

  // 4. A seat's backflow stops the run before the merge.
  const seatBackflow = await run(baseArgs(brief), {winner: winnerOf(top), seatReply: {
    'seat:physical-expert': {from: 'physical-expert', constraints: [], verdict: 'PPA_DIRECTION_BACKFLOW'}
  }});
  assert.strictEqual(seatBackflow.result.verdict, 'PPA_DIRECTION_BACKFLOW');
  assert.deepStrictEqual(seatBackflow.result.files, []);
  assert(!seatBackflow.labels.includes('integrator'));

  // 5. The mechanical check: a dominated row, altered numbers, or an unknown option land nothing,
  // and the invariant checker is never asked.
  const cases = {
    dominated: winnerOf(dominated),
    altered: {...winnerOf(top), values: JSON.stringify({...top.row, tpsPerUser: top.row.tpsPerUser + 1})},
    unknown: {...winnerOf(top), optionId: 'invented'}
  };
  for (const [name, winner] of Object.entries(cases)) {
    const bad = await run(baseArgs(brief), {winner});
    assert.strictEqual(bad.result.verdict, 'INVARIANT_VIOLATED', `${name}: ${JSON.stringify(bad.result)}`);
    assert.deepStrictEqual(bad.result.files, [], `${name}: nothing lands`);
    assert(bad.result.violations.length === 1, `${name}: ${bad.result.violations}`);
    assert(!bad.labels.includes('invariant-checker'), `${name}: decided without an agent`);
  }

  // 6. Inputs.
  const unusable = await run(baseArgs({ok: false, domain: 'coupling', notes: 'stale'}), {winner: winnerOf(top)});
  assert.strictEqual(unusable.result.verdict, 'BLOCKED_CONFIG');
  assert.deepStrictEqual(unusable.result.files, []);
  await assert.rejects(() => run({...baseArgs(brief), searchBrief: undefined}), /searchBrief/);
  await assert.rejects(() => run({...baseArgs(brief), brief: {stage: 'sram'}}), /契约串了/);

  console.log(`PASS coupling workflow behaviour: the joint point lands verbatim with the row's x / opt / model, nothing feasible backflows to design.req.budget before any agent, each of ${SEATS.length} coupling seats blocks when absent, and a dominated, altered or invented joint point is refused mechanically`);
})().catch(error => {
  console.error(error);
  process.exit(1);
});
