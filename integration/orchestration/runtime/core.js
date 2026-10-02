'use strict';

// Host runtime for the design.*.workflow.js scripts.
//
// The scripts are written for Claude Code's Workflow runtime: top-level `await`,
// a top-level `return`, and the injected globals `args`, `agent`, `parallel`,
// `phase` and `log`. Claude Code provides those natively. This module provides the
// same five globals for every other host (Cursor, a CI job, a test), so one script
// source runs everywhere and only the backend that answers `agent()` differs.
//
// What the runtime guarantees, identically across backends:
//   * every `agent()` call that carries a `schema` returns a value that validates
//     against it, or `null` after `maxAttempts` (the scripts already treat `null`
//     as "this instance produced nothing" and block the run on it);
//   * a failure to START (bad credentials, missing CLI, unreachable API) is not an
//     agent that produced nothing: it aborts the run, so a configuration problem is
//     never reported as a design verdict;
//   * at most `concurrency` backend calls are in flight.
//
// What it deliberately does not do: read or write repository files. The scripts
// return `files: [{path, content}]`; landing them is `land.js`'s job, behind its
// own path and content gates.

const fs = require('fs');
const path = require('path');
const {validate, extractJson} = require('./schema');
const {BackendFatalError} = require('./errors');

const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
const GLOBALS = ['args', 'agent', 'parallel', 'phase', 'log'];

function workflowFile(root, name) {
  const short = name.replace(/^design\./, '');
  return path.join(root, 'integration/orchestration', `design.${short}.workflow.js`);
}

function listWorkflows(root) {
  return fs.readdirSync(path.join(root, 'integration/orchestration'))
    .map((n) => n.match(/^design\.(.+)\.workflow\.js$/))
    .filter(Boolean)
    .map((m) => m[1])
    .sort();
}

function compileWorkflow(root, name) {
  const file = workflowFile(root, name);
  if (!fs.existsSync(file)) throw new Error(`no such workflow: ${name} (known: ${listWorkflows(root).join(', ')})`);
  const source = fs.readFileSync(file, 'utf8').replace(/^export const meta/m, 'const meta');
  return new AsyncFunction(...GLOBALS, source);
}

function semaphore(limit) {
  let active = 0;
  const waiting = [];
  const release = () => {
    active -= 1;
    const next = waiting.shift();
    if (next) next();
  };
  return async (task) => {
    if (active >= limit) await new Promise((resolve) => waiting.push(resolve));
    active += 1;
    try {
      return await task();
    } finally {
      release();
    }
  };
}

function createRuntime({backend, concurrency = 4, maxAttempts = 3, onLog = () => {}}) {
  if (!backend || typeof backend.complete !== 'function') throw new Error('runtime needs a backend with complete()');
  const record = {calls: [], phases: [], logs: [], failures: []};
  const limited = semaphore(concurrency);

  async function agent(prompt, options = {}) {
    const {schema, label = '', effort, phase: phaseTitle} = options;
    const started = Date.now();
    let feedback = '';
    let attempts = 0;
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      attempts = attempt;
      let raw;
      try {
        raw = await limited(() => backend.complete({prompt: prompt + feedback, schema, label, effort, phase: phaseTitle, attempt}));
      } catch (error) {
        if (error && error.fatal) throw error;
        record.failures.push({label, attempt, kind: 'backend', error: String(error && error.message || error)});
        feedback = '';
        continue;
      }
      if (!schema) {
        record.calls.push({label, attempts, ms: Date.now() - started, ok: true});
        return typeof raw === 'string' ? raw : JSON.stringify(raw, null, 2);
      }
      let value;
      let problems;
      try {
        value = typeof raw === 'string' ? extractJson(raw) : raw;
        problems = validate(schema, value);
      } catch (error) {
        problems = [String(error.message)];
      }
      if (problems.length === 0) {
        record.calls.push({label, attempts, ms: Date.now() - started, ok: true});
        return value;
      }
      record.failures.push({label, attempt, kind: 'schema', error: problems.slice(0, 5).join('; ')});
      feedback = `\n\n[上一次回复不符合要求的 JSON Schema，请只返回一个合法 JSON 对象，不要附加说明。问题：${problems.slice(0, 5).join('；')}]`;
    }
    record.calls.push({label, attempts, ms: Date.now() - started, ok: false});
    return null;
  }

  return {
    record,
    globals: {
      agent,
      parallel: (fns) => Promise.all(fns.map((fn) => fn())),
      phase: (title) => {
        record.phases.push(title);
        onLog(`phase: ${title}`);
      },
      log: (message) => {
        record.logs.push(String(message));
        onLog(String(message));
      },
    },
  };
}

// Runs one workflow script to completion and returns what it returned plus the
// runtime's own record (calls, retries, failures, phases, logs).
async function runWorkflow({root, name, args, backend, concurrency, maxAttempts, onLog}) {
  const run = compileWorkflow(root, name);
  const runtime = createRuntime({backend, concurrency, maxAttempts, onLog});
  const {agent, parallel, phase, log} = runtime.globals;
  const result = await run(args, agent, parallel, phase, log);
  return {result, ...runtime.record};
}

module.exports = {BackendFatalError, compileWorkflow, createRuntime, listWorkflows, runWorkflow, workflowFile};
