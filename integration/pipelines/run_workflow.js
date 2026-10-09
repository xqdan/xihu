'use strict';

/* The main loop for a design.*.workflow.js script, as code.
 *
 * Claude Code runs these scripts natively. Everywhere else (Cursor, CI, a laptop
 * with neither) this driver plays the host: it supplies the same globals, answers
 * `agent()` with the chosen backend, and does the three things the scripts leave to
 * "the main loop" -- prepare the deterministic inputs, land the returned files, and
 * check what landed. The script source is identical in every environment; only the
 * backend differs.
 *
 *   before   C-group workflows and design.coupling get `args.searchBrief` from
 *            search_brief.js (the candidate numbers reach the workflow without an agent
 *            transcribing them);
 *            attribution gets its sensitivity card and req.budget its budget frontier,
 *            each refused when built from other inputs; the L1 contract's consumers get
 *            `args.brief` derived from the contract (make_brief.js) rather than from a
 *            hand-typed file, and every stage gets `args.ledger` -- what the earlier
 *            stages decided (design_ledger.js);
 *   during   a working-tree snapshot is taken; agents must be read-only;
 *   after    if anything in the tree changed, nothing is landed (exit 3); a C-group
 *            winner (design.coupling: the joint point) is checked against the candidate artifact before anything is
 *            written (exit 5 on mismatch); every `file:line` citation in the result
 *            must point at an existing line with text (exit 7 otherwise; check_citations.js),
 *            and for attribution and req.budget every off-card (off-frontier) number in an
 *            expert's plausibleRange must be on a line its rangeEvidence cites (exit 7 too);
 *            a req.budget contract must be a verbatim frontier split (exit 5 otherwise);
 *            then the returned files go through
 *            land.js's path and content gates (exit 4 on rejection). A run that
 *            returned no files (a backflow, a blocked input) lands an outcome record
 *            instead, so the stop is on disk and not only in the terminal; its citation
 *            report goes into the record rather than stopping it. Finally the workflow's
 *            `ledgerPatch` is merged back into the ledger (exit 8 if that merge is refused),
 *            so the next stage starts from what this one decided.
 *
 * Landing is opt-in: without --land the run is a dry run that applies every gate and
 * writes nothing -- the ledger included.
 *
 * Usage:
 *   node integration/pipelines/run_workflow.js <workflow> --backend mock|claude|cursor|exchange
 *        [--args file.json] [--brief file.json] [--split S-CMP] [--run-id id] [--max N] [--dimension d]
 *        [--model name] [--concurrency N] [--timeout ms] [--exchange-dir dir]
 *        [--result-file file.json] [--land]
 *   <workflow>: compute | sram | mc | comm | physical | intake | detail.events | ... (see --list)
 *   direction, compute, sram, mc, comm and physical derive their brief from the budget contract;
 *   --brief overrides that, and every other stage still needs it.
 *   attribution reads out/attribution/<d>_card.json (d = sram | comm | joint) and refuses a stale card,
 *   or one built at another design point than design_point.js resolves (the joint point after L3).
 *   converge gets args.designPoint (design_point.js) and stops when it is not the baseline's point.
 *   req.budget reads out/requirements/budget_frontier.json and refuses a stale frontier.
 *
 * Exit codes: 0 ran (the workflow's own verdict is in the summary), 1 usage or
 * environment problem, 3 agents modified the tree, 4 a file was rejected, 5 the
 * winner does not match the candidate artifact (req.budget: the contract does not match its
 * frontier split), 6 a reported gate decision differs from gate_status.json, 7 a cited
 * file:line does not exist or has no text, or (attribution, req.budget) a range number is
 * supported neither by the card / frontier nor by its cited lines, 8 the files landed but
 * the ledger patch was refused.
 */

const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const {runWorkflow, listWorkflows} = require('../orchestration/runtime/core');
const {landFiles, scriptGateDecisions, recheckGateDecision} = require('../orchestration/runtime/land');
const {snapshot, changedBetween} = require('../orchestration/runtime/guard');
const {createMockBackend} = require('../orchestration/runtime/backends/mock');
const {createClaudeBackend} = require('../orchestration/runtime/backends/claude');
const {createCursorBackend} = require('../orchestration/runtime/backends/cursor');
const {createExchangeBackend} = require('../orchestration/runtime/backends/exchange');
const {buildOutcomeFile} = require('../orchestration/runtime/outcome');
const {STAGES, DEFAULT_MAX, buildSearchBrief, verifyLandedWinner, landedFiles} = require('./search_brief');
const {checkCitations, checkRangeNumbers} = require('./check_citations');
const MAKE_BRIEF = require('./make_brief');
const LEDGER = require('./design_ledger');
const ATTRIBUTION = require('../detailed/tps_attribution');
const DESIGN_POINT = require('./design_point');
const FRONTIER = require('../planning/requirement_frontier');

const root = path.resolve(__dirname, '../..');
const sha256 = (data) => crypto.createHash('sha256').update(data).digest('hex');

// The L1 contract's consumers get their brief derived from the contract (make_brief.js), so
// --brief is an override rather than the only way in. Every other stage still needs one.
const DERIVED_BRIEFS = MAKE_BRIEF.coveredStages();

function parseFlags(argv) {
  const flags = {};
  const positional = [];
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith('--')) {
      positional.push(token);
      continue;
    }
    const key = token.slice(2);
    const boolean = ['land', 'list', 'help'].includes(key);
    flags[key] = boolean ? true : argv[(i += 1)];
  }
  return {flags, positional};
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(path.resolve(root, file), 'utf8'));
}

function makeBackend(name, flags) {
  const timeoutMs = flags.timeout ? Number(flags.timeout) : undefined;
  switch (name) {
    case 'mock':
      return createMockBackend();
    case 'claude':
      return createClaudeBackend({cwd: root, model: flags.model, timeoutMs});
    case 'cursor':
      return createCursorBackend({cwd: root, model: flags.model});
    case 'exchange':
      return createExchangeBackend({
        dir: path.resolve(root, flags['exchange-dir'] || 'scratch/wf_exchange'),
        timeoutMs,
        onRequest: ({request}) => console.error(`  waiting for an answer: ${path.relative(root, request)} -> ${path.relative(root, request).replace('.request.json', '.answer.txt')}`),
      });
    default:
      throw new Error(`unknown backend "${name}" (mock | claude | cursor | exchange)`);
  }
}

// `designPoint` resolves the point the stages after L3 read (design_point.js); tests inject one.
function prepareArgs(workflow, flags, {designPoint = () => DESIGN_POINT.resolve()} = {}) {
  const args = flags.args ? readJson(flags.args) : {};
  args.repo = args.repo || root;
  if (flags['run-id']) args.runId = flags['run-id'];
  // The brief: an explicit file wins, otherwise it is derived from the budget contract. A
  // derived brief is never stored -- the contract is the single source for its numbers, so
  // there is no second copy next to it to go stale.
  if (flags.brief) {
    args.brief = readJson(flags.brief);
    args.briefOrigin = `--brief ${flags.brief}`;
  } else if (DERIVED_BRIEFS.includes(workflow)) {
    const built = MAKE_BRIEF.briefFor(workflow, {runId: args.runId, splitId: flags.split});
    args.brief = built.brief;
    args.briefOrigin = built.origin;
    if (built.provenance) args.briefProvenance = built.provenance;
  }
  // The ledger is what the earlier stages decided. It is injected whole; the workflow reads
  // what it needs (design.intake already looks for args.rejectedOptions) and returns a patch.
  const ledger = LEDGER.loadLedger();
  if (ledger.exists) {
    args.ledger = ledger.ledger;
    args.ledgerPath = ledger.path;
    if (!args.rejectedOptions) args.rejectedOptions = ledger.ledger.rejectedOptions;
  }
  if (Object.hasOwn(STAGES, workflow)) {
    if (!args.brief) throw new Error(`design.${workflow} needs a brief: pass --brief <file>, or build one from a budget contract (npm run budget:frontier)`);
    const max = flags.max ? Number(flags.max) : DEFAULT_MAX;
    const searchBrief = buildSearchBrief(workflow, {max});
    if (!searchBrief.ok) throw new Error(`search brief for ${workflow} is not usable: ${searchBrief.notes}`);
    args.searchArtifact = STAGES[workflow].artifact;
    args.searchBrief = searchBrief;
  }
  // design.attribution reads one sensitivity card (npm run attribution:cards). The card is
  // handed over whole; a card built from another baseline is refused here, not in the script.
  if (workflow === 'attribution') {
    const dimension = flags.dimension || args.dimension;
    if (!ATTRIBUTION.DEFAULT_DIMENSIONS.includes(dimension)) {
      throw new Error(`design.attribution needs --dimension ${ATTRIBUTION.DEFAULT_DIMENSIONS.join(' | ')}`);
    }
    const cardPath = `${ATTRIBUTION.OUT_DIR}/${dimension}_card.json`;
    if (!fs.existsSync(path.join(root, cardPath))) throw new Error(`${cardPath} is missing; run npm run attribution:cards`);
    const text = fs.readFileSync(path.join(root, cardPath), 'utf8');
    const card = JSON.parse(text);
    const baselineSha256 = sha256(fs.readFileSync(path.join(root, ATTRIBUTION.BASELINE_FILE)));
    if (!card.inputs || card.inputs.baselineSha256 !== baselineSha256) {
      throw new Error(`${cardPath} is stale (built from another ${ATTRIBUTION.BASELINE_FILE}); run npm run attribution:cards`);
    }
    // After L3 the card must be at the joint point: one built at the published point (or at an
    // older joint point) answers a question about a design nobody is building any more.
    const point = designPoint();
    if (!card.inputs.point || card.inputs.point.sha256 !== point.sha256) {
      throw new Error(`${cardPath} was built at another design point than ${point.source}; run npm run attribution:cards`);
    }
    Object.assign(args, {dimension, card, cardPath, cardSha256: sha256(text)});
  }
  // design.converge proposes on the D group's artifacts, which Stage B builds from the baseline.
  // It gets the design point the stages after L3 read, and stops when the two are not the same point.
  if (workflow === 'converge') args.designPoint = designPoint();
  // design.req.budget reads the budget frontier (npm run budget:frontier) the same way: whole,
  // and refused when any input it was built from has changed since.
  if (workflow === 'req.budget') {
    const frontierPath = FRONTIER.OUT_FILE;
    if (!fs.existsSync(path.join(root, frontierPath))) throw new Error(`${frontierPath} is missing; run npm run budget:frontier`);
    const text = fs.readFileSync(path.join(root, frontierPath), 'utf8');
    const frontier = JSON.parse(text);
    const stale = ((frontier.inputs && frontier.inputs.sourceArtifacts) || [{path: FRONTIER.BASELINE_FILE}])
      .filter((a) => !fs.existsSync(path.join(root, a.path)) || sha256(fs.readFileSync(path.join(root, a.path))) !== a.sha256);
    if (stale.length) {
      throw new Error(`${frontierPath} is stale (built from another ${stale.map((a) => a.path).join(', ')}); run npm run budget:frontier`);
    }
    Object.assign(args, {frontier, frontierPath, frontierSha256: sha256(text)});
  }
  return args;
}

// The landed L1 contract must be a verbatim frontier split plus its selection record, and it
// comes with its run record: an agent that edited a budget, a frontier swapped under the run,
// or half a result stops landing.
function verifyLandedBudget(files, frontier, frontierSha256) {
  const budget = parseLanded(files, 'L1_budget.json');
  const record = parseLanded(files, 'L1_run_record.json');
  if (!budget || !record) {
    return {ok: false, problems: [budget ? 'L1_budget.json without its L1_run_record.json' : 'returned files without L1_budget.json']};
  }
  const {selection, ...contract} = budget;
  const split = ((frontier && frontier.splits) || []).find((s) => s.splitId === contract.splitId);
  const problems = [];
  if (!split) problems.push(`split ${contract.splitId} is not in ${FRONTIER.OUT_FILE}`);
  else {
    try { assert.deepStrictEqual(contract, split.contract); } catch (_) { problems.push(`L1_budget.json differs from ${FRONTIER.OUT_FILE} split ${contract.splitId}`); }
  }
  if (!selection || selection.frontierSha256 !== frontierSha256) problems.push(`selection.frontierSha256 is not the frontier that was read (${frontierSha256})`);
  return {ok: !problems.length, splitId: contract.splitId, problems};
}

function parseLanded(files, suffix) {
  const file = (files || []).find((f) => f.path.endsWith(suffix));
  return file ? JSON.parse(file.content) : null;
}

// Who stopped the run and on what, for the summary: the workflow's own `constraints`
// (lateral experts) when it has them. The full result is available through --result-file.
function findingsOf(result) {
  if (!result || !Array.isArray(result.constraints)) return undefined;
  return result.constraints.map((c) => ({
    from: c.from,
    verdict: c.verdict,
    rulesOut: (c.constraints || []).map((item) => item.rulesOut),
  }));
}

// The landed winner / run record file names (design.coupling's are joint_point.json and
// coupling_run_record.json, the domains' <domain>_winner.json and <domain>_run_record.json).
const landedName = (workflow, which) => path.posix.basename(landedFiles(workflow)[which]);

// A winner without its run record (or the reverse) is half a result.
function halfWinnerResult(workflow, files) {
  const winner = parseLanded(files, landedName(workflow, 'winner'));
  const record = parseLanded(files, landedName(workflow, 'record'));
  if (winner && !record) return `${workflow} returned a winner without its run_record`;
  if (record && !winner) return `${workflow} returned a run_record without a winner`;
  return null;
}

// Whether this run's decisions enter the ledger, and the patch that does. Three things stop
// it, and none of them is an error: a dry run decides nothing, a run whose files were rejected
// did not happen (and must not leave a decision behind), and a workflow that returns no patch
// is not in the ledger's chain at all (design.explore, design.learn).
function ledgerUpdate({land, landing, result}) {
  if (!land) return {write: false, why: 'dry run'};
  if (landing && landing.rejected && landing.rejected.length) return {write: false, why: 'files were rejected'};
  const patch = LEDGER.patchOf(result);
  if (!patch) return {write: false, why: 'the workflow returns no ledger patch'};
  return {write: true, patch};
}

async function main(argv, deps = {}) {
  const {flags, positional} = parseFlags(argv);
  if (flags.list) {
    console.log(listWorkflows(root).join('\n'));
    return 0;
  }
  const [workflow] = positional;
  if (flags.help || !workflow || !flags.backend) {
    console.error('usage: run_workflow.js <workflow> --backend mock|claude|cursor|exchange [--args f] [--brief f] [--split S-CMP] [--run-id id] [--max N] [--dimension sram|comm|joint] [--model m] [--concurrency N] [--timeout ms] [--exchange-dir d] [--result-file f] [--land]   (--list shows workflows)');
    return 1;
  }

  let args;
  let backend;
  try {
    args = prepareArgs(workflow, flags, deps);
    backend = deps.backend || makeBackend(flags.backend, flags);
  } catch (error) {
    console.error(error.message);
    return 1;
  }

  let before;
  try {
    before = snapshot(root);
  } catch (error) {
    console.error(`the read-only guard needs a git work tree: ${error.message}`);
    return 1;
  }
  let run;
  try {
    run = await runWorkflow({
      root,
      name: workflow,
      args,
      backend,
      concurrency: flags.concurrency ? Number(flags.concurrency) : undefined,
      onLog: (line) => console.error(`  ${line}`),
    });
  } catch (error) {
    console.error(`${error.fatal ? 'cannot run' : 'workflow threw'}: ${error.message}`);
    return 1;
  }
  const modified = changedBetween(before, snapshot(root));
  const {result} = run;
  if (flags['result-file']) fs.writeFileSync(path.resolve(root, flags['result-file']), `${JSON.stringify(result, null, 2)}\n`);
  const summary = {
    workflow,
    backend: backend.name,
    verdict: result && result.verdict,
    reason: result && result.reason,
    nextActions: result && result.nextActions,
    findings: findingsOf(result),
    agentCalls: run.calls.length,
    failedCalls: run.calls.filter((c) => !c.ok).length,
    retries: run.failures.length,
    phases: run.phases,
  };

  if (modified.length) {
    summary.error = 'agents modified the working tree; nothing was landed';
    summary.modified = modified;
    console.log(JSON.stringify(summary, null, 2));
    return 3;
  }

  let files = (result && result.files) || [];
  // A citation onto a blank line or past the end of a file is wrong whatever the agents said
  // about it, and so is an expert range number found neither on the card nor on a line its
  // evidence cites. A result with files does not land; a stop records the report alongside.
  const citations = checkCitations(root, result);
  summary.citations = {checked: citations.checked, problems: citations.problems, unresolved: citations.unresolved.length};
  const rangeCard = workflow === 'attribution' ? args.card : workflow === 'req.budget' ? args.frontier : null;
  const rangeNumbers = rangeCard ? checkRangeNumbers(root, result, {card: rangeCard}) : null;
  if (rangeNumbers) summary.rangeNumbers = rangeNumbers;
  const outcome = buildOutcomeFile(workflow, result, {
    runId: result && result.runId,
    backend: backend.name,
    agentCalls: run.calls.length,
    phases: run.phases,
    citations: {checked: citations.checked, problems: citations.problems},
    ...(rangeNumbers ? {rangeNumbers} : {}),
  }, workflow === 'attribution' ? args.dimension : undefined);
  if (outcome) files = [outcome];
  else if (files.length && (!citations.ok || (rangeNumbers && !rangeNumbers.ok))) {
    summary.error = !citations.ok
      ? `${citations.problems.length} citation(s) point at a missing file, a line without text or past the end; nothing was landed`
      : `${rangeNumbers.problems.length} plausibleRange number(s) are neither on the ${workflow === 'req.budget' ? 'frontier' : 'card'} nor on a line their rangeEvidence cites; nothing was landed`;
    console.log(JSON.stringify(summary, null, 2));
    return 7;
  }

  // The L1 contract is checked against the frontier BEFORE anything is written.
  if (workflow === 'req.budget' && files.length && !outcome) {
    summary.verifyLanded = verifyLandedBudget(files, args.frontier, args.frontierSha256);
    if (!summary.verifyLanded.ok) {
      console.log(JSON.stringify(summary, null, 2));
      return 5;
    }
  }

  // The C-group winner is checked against the candidate artifact BEFORE anything is
  // written: a winner that is not a verbatim artifact row must never reach out/.
  if (Object.hasOwn(STAGES, workflow) && files.length) {
    const winner = parseLanded(files, landedName(workflow, 'winner'));
    const record = parseLanded(files, landedName(workflow, 'record'));
    // A winner without its run record (or the reverse) is half a result: refuse it.
    const half = halfWinnerResult(workflow, files);
    if (half) {
      summary.error = `${half}; nothing was landed`;
      console.log(JSON.stringify(summary, null, 2));
      return 5;
    }
    if (winner && record) {
      summary.verifyLanded = verifyLandedWinner(workflow, winner, record);
      if (!summary.verifyLanded.ok) {
        console.log(JSON.stringify(summary, null, 2));
        return 5;
      }
    }
  }

  // The gate decision is the script's: a reported value that differs from gate_status.json lands nothing.
  const scriptDecisions = scriptGateDecisions(root, workflow);
  const gateMismatch = recheckGateDecision(workflow, result, scriptDecisions);
  if (gateMismatch) {
    summary.error = gateMismatch;
    console.log(JSON.stringify(summary, null, 2));
    return 6;
  }
  const landing = landFiles({root, workflow, files, dryRun: !flags.land, scriptDecisions});
  summary.landing = {dryRun: !flags.land, landed: landing.landed, rejected: landing.rejected};
  // The ledger is the loop's own record, not one of the workflow's files: it goes through
  // neither the path policy (out/governance/ belongs to dgate and backflow) nor the content
  // gate. It is written only when everything the workflow returned actually landed.
  const ledger = ledgerUpdate({land: flags.land, landing, result});
  if (ledger.write) {
    try {
      const written = LEDGER.writeLedger({patch: ledger.patch});
      summary.ledger = {path: written.path, created: written.created, currentStage: written.ledger.currentStage};
    } catch (error) {
      summary.error = `the files landed but the ledger did not: ${error.message}`;
      console.log(JSON.stringify(summary, null, 2));
      return 8;
    }
  }
  console.log(JSON.stringify(summary, null, 2));
  return landing.rejected.length ? 4 : 0;
}

module.exports = {main, parseFlags, halfWinnerResult, verifyLandedBudget, ledgerUpdate, DERIVED_BRIEFS};

if (require.main === module) {
  main(process.argv.slice(2)).then((code) => { process.exitCode = code; });
}
