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
 *   before   C-group workflows get `args.searchBrief` from search_brief.js (the
 *            candidate numbers reach the workflow without an agent transcribing them);
 *   during   a working-tree snapshot is taken; agents must be read-only;
 *   after    if anything in the tree changed, nothing is landed (exit 3); a C-group
 *            winner is checked against the candidate artifact before anything is
 *            written (exit 5 on mismatch); every `file:line` citation in the result
 *            must point at an existing line with text (exit 7 otherwise; check_citations.js),
 *            and for attribution every off-card number in an expert's plausibleRange must be
 *            on a line its rangeEvidence cites (exit 7 too);
 *            then the returned files go through
 *            land.js's path and content gates (exit 4 on rejection). A run that
 *            returned no files (a backflow, a blocked input) lands an outcome record
 *            instead, so the stop is on disk and not only in the terminal; its citation
 *            report goes into the record rather than stopping it.
 *
 * Landing is opt-in: without --land the run is a dry run that applies every gate and
 * writes nothing.
 *
 * Usage:
 *   node integration/pipelines/run_workflow.js <workflow> --backend mock|claude|cursor|exchange
 *        [--args file.json] [--brief file.json] [--run-id id] [--max N] [--dimension d]
 *        [--model name] [--concurrency N] [--timeout ms] [--exchange-dir dir]
 *        [--result-file file.json] [--land]
 *   <workflow>: compute | memory | comm | physical | intake | detail.events | ... (see --list)
 *   attribution reads out/attribution/<d>_card.json (d = sram | comm | joint) and refuses a stale card.
 *
 * Exit codes: 0 ran (the workflow's own verdict is in the summary), 1 usage or
 * environment problem, 3 agents modified the tree, 4 a file was rejected, 5 the
 * winner does not match the candidate artifact, 6 a reported gate decision differs from
 * gate_status.json, 7 a cited file:line does not exist or has no text, or (attribution) a
 * range number is supported neither by the card nor by its cited lines.
 */

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
const {DOMAINS, DEFAULT_MAX, buildSearchBrief, verifyLandedWinner} = require('./search_brief');
const {checkCitations, checkRangeNumbers} = require('./check_citations');
const ATTRIBUTION = require('../detailed/tps_attribution');

const root = path.resolve(__dirname, '../..');
const sha256 = (data) => crypto.createHash('sha256').update(data).digest('hex');

// Only compute has a committed brief; the others must be supplied.
const DEFAULT_BRIEFS = {compute: 'teams/council/inputs/design_brief.m2.json'};

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

function prepareArgs(workflow, flags) {
  const args = flags.args ? readJson(flags.args) : {};
  args.repo = args.repo || root;
  if (flags['run-id']) args.runId = flags['run-id'];
  const briefFile = flags.brief || DEFAULT_BRIEFS[workflow];
  if (briefFile) args.brief = readJson(briefFile);
  if (Object.hasOwn(DOMAINS, workflow)) {
    if (!args.brief) throw new Error(`design.${workflow} needs a brief: pass --brief <file> (only compute has a default)`);
    const max = flags.max ? Number(flags.max) : DEFAULT_MAX;
    const searchBrief = buildSearchBrief(workflow, {max});
    if (!searchBrief.ok) throw new Error(`search brief for ${workflow} is not usable: ${searchBrief.notes}`);
    args.searchArtifact = DOMAINS[workflow].artifact;
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
    Object.assign(args, {dimension, card, cardPath, cardSha256: sha256(text)});
  }
  return args;
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

// A winner without its run record (or the reverse) is half a result.
function halfWinnerResult(workflow, files) {
  const winner = parseLanded(files, `${workflow}_winner.json`);
  const record = parseLanded(files, `${workflow}_run_record.json`);
  if (winner && !record) return `${workflow} returned a winner without its run_record`;
  if (record && !winner) return `${workflow} returned a run_record without a winner`;
  return null;
}

async function main(argv, deps = {}) {
  const {flags, positional} = parseFlags(argv);
  if (flags.list) {
    console.log(listWorkflows(root).join('\n'));
    return 0;
  }
  const [workflow] = positional;
  if (flags.help || !workflow || !flags.backend) {
    console.error('usage: run_workflow.js <workflow> --backend mock|claude|cursor|exchange [--args f] [--brief f] [--run-id id] [--max N] [--dimension sram|comm|joint] [--model m] [--concurrency N] [--timeout ms] [--exchange-dir d] [--result-file f] [--land]   (--list shows workflows)');
    return 1;
  }

  let args;
  let backend;
  try {
    args = prepareArgs(workflow, flags);
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
  const rangeNumbers = workflow === 'attribution' ? checkRangeNumbers(root, result, {card: args.card}) : null;
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
      : `${rangeNumbers.problems.length} plausibleRange number(s) are neither on the card nor on a line their rangeEvidence cites; nothing was landed`;
    console.log(JSON.stringify(summary, null, 2));
    return 7;
  }

  // The C-group winner is checked against the candidate artifact BEFORE anything is
  // written: a winner that is not a verbatim artifact row must never reach out/.
  if (Object.hasOwn(DOMAINS, workflow) && files.length) {
    const winner = parseLanded(files, `${workflow}_winner.json`);
    const record = parseLanded(files, `${workflow}_run_record.json`);
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
  console.log(JSON.stringify(summary, null, 2));
  return landing.rejected.length ? 4 : 0;
}

module.exports = {main, parseFlags, halfWinnerResult};

if (require.main === module) {
  main(process.argv.slice(2)).then((code) => { process.exitCode = code; });
}
