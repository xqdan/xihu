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
 *            written (exit 5 on mismatch); then the returned files go through
 *            land.js's path and content gates (exit 4 on rejection). A run that
 *            returned no files (a backflow, a blocked input) lands an outcome record
 *            instead, so the stop is on disk and not only in the terminal.
 *
 * Landing is opt-in: without --land the run is a dry run that applies every gate and
 * writes nothing.
 *
 * Usage:
 *   node integration/pipelines/run_workflow.js <workflow> --backend mock|claude|cursor|exchange
 *        [--args file.json] [--brief file.json] [--run-id id] [--max N]
 *        [--model name] [--concurrency N] [--timeout ms] [--exchange-dir dir]
 *        [--result-file file.json] [--land]
 *   <workflow>: compute | memory | comm | physical | intake | detail.events | ... (see --list)
 *
 * Exit codes: 0 ran (the workflow's own verdict is in the summary), 1 usage or
 * environment problem, 3 agents modified the tree, 4 a file was rejected, 5 the
 * winner does not match the candidate artifact.
 */

const fs = require('fs');
const path = require('path');
const {runWorkflow, listWorkflows} = require('../orchestration/runtime/core');
const {landFiles} = require('../orchestration/runtime/land');
const {snapshot, changedBetween} = require('../orchestration/runtime/guard');
const {createMockBackend} = require('../orchestration/runtime/backends/mock');
const {createClaudeBackend} = require('../orchestration/runtime/backends/claude');
const {createCursorBackend} = require('../orchestration/runtime/backends/cursor');
const {createExchangeBackend} = require('../orchestration/runtime/backends/exchange');
const {buildOutcomeFile} = require('../orchestration/runtime/outcome');
const {DOMAINS, DEFAULT_MAX, buildSearchBrief, verifyLandedWinner} = require('./search_brief');

const root = path.resolve(__dirname, '../..');

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

async function main(argv, deps = {}) {
  const {flags, positional} = parseFlags(argv);
  if (flags.list) {
    console.log(listWorkflows(root).join('\n'));
    return 0;
  }
  const [workflow] = positional;
  if (flags.help || !workflow || !flags.backend) {
    console.error('usage: run_workflow.js <workflow> --backend mock|claude|cursor|exchange [--args f] [--brief f] [--run-id id] [--max N] [--model m] [--concurrency N] [--timeout ms] [--exchange-dir d] [--result-file f] [--land]   (--list shows workflows)');
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
  const outcome = buildOutcomeFile(workflow, result, {
    runId: result && result.runId,
    backend: backend.name,
    agentCalls: run.calls.length,
    phases: run.phases,
  });
  if (outcome) files = [outcome];

  // The C-group winner is checked against the candidate artifact BEFORE anything is
  // written: a winner that is not a verbatim artifact row must never reach out/.
  if (Object.hasOwn(DOMAINS, workflow) && files.length) {
    const winner = parseLanded(files, `${workflow}_winner.json`);
    const record = parseLanded(files, `${workflow}_run_record.json`);
    if (winner && record) {
      summary.verifyLanded = verifyLandedWinner(workflow, winner, record);
      if (!summary.verifyLanded.ok) {
        console.log(JSON.stringify(summary, null, 2));
        return 5;
      }
    }
  }

  const landing = landFiles({root, workflow, files, dryRun: !flags.land});
  summary.landing = {dryRun: !flags.land, landed: landing.landed, rejected: landing.rejected};
  console.log(JSON.stringify(summary, null, 2));
  return landing.rejected.length ? 4 : 0;
}

module.exports = {main, parseFlags};

if (require.main === module) {
  main(process.argv.slice(2)).then((code) => { process.exitCode = code; });
}
