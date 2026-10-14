'use strict';

// Backend that answers `agent()` through the Codex CLI in non-interactive mode:
//
//   codex exec --ephemeral --sandbox read-only --json
//     --output-schema <schema.json> --output-last-message <reply.txt>
//
// The prompt travels on stdin.  Codex's JSONL stream is an event log, not the
// workflow reply, so the final message is read from --output-last-message.  The
// runtime still validates that message against the schema; this keeps the same
// retry contract as the Cursor backend if a CLI version ignores the schema.
//
// A read-only sandbox is the Codex-side request.  The driver-side working-tree
// guard remains the authoritative protection against an agent writing files.
// Startup/authentication/model configuration failures are fatal.  Timeouts,
// transient API failures and malformed replies are ordinary errors and are
// retried by runtime/core.js.

const fs = require('fs');
const os = require('os');
const path = require('path');
const {spawn} = require('child_process');
const {BackendFatalError} = require('../errors');

const EFFORTS = new Set(['low', 'medium', 'high', 'xhigh', 'max']);
const FATAL_ERROR = /(?:401|403|unauthori[sz]ed|forbidden|authentication|api\s*key|not authenticated|login required|model (?:not found|disabled|unavailable)|invalid model|invalid credential|permission denied)/i;

function eventDocuments(stdout) {
  const documents = [];
  for (const line of String(stdout || '').split('\n').map((line) => line.trim()).filter(Boolean)) {
    try {
      const value = JSON.parse(line);
      if (value && typeof value === 'object') documents.push(value);
    } catch (_) { /* diagnostics are tolerated; the final message is read separately */ }
  }
  return documents;
}

function finalMessageFromEvents(stdout) {
  const documents = eventDocuments(stdout);
  for (let i = documents.length - 1; i >= 0; i -= 1) {
    const event = documents[i];
    const item = event.item;
    if (event.type === 'item.completed' && item && item.type === 'agent_message' && typeof item.text === 'string') return item.text;
    if ((event.type === 'agent_message' || event.type === 'message.completed') && typeof event.text === 'string') return event.text;
  }
  // Useful for simple wrappers and fakes that emit one JSON document instead of JSONL.
  if (documents.length === 1 && typeof documents[0].result === 'string') return documents[0].result;
  return null;
}

function errorText(stdout, stderr) {
  const messages = eventDocuments(stdout)
    .filter((event) => event.type === 'error' || event.type === 'turn.failed' || event.type === 'session.error')
    .map((event) => event.message || event.error || event.reason)
    .filter((message) => typeof message === 'string');
  return [...messages, String(stderr || '').trim()].filter(Boolean).join(' | ');
}

function classifyFailure(message) {
  if (FATAL_ERROR.test(message)) return new BackendFatalError(`codex could not start: ${message.slice(0, 400)}`);
  return new Error(message);
}

function createCodexBackend({
  command = 'codex',
  cwd = process.cwd(),
  model,
  timeoutMs = 600000,
  extraArgs = [],
  spawnImpl = spawn,
  tempRoot = os.tmpdir(),
} = {}) {
  return {
    name: 'codex',
    async complete({prompt, schema, effort}) {
      const work = fs.mkdtempSync(path.join(tempRoot, 'xihu-codex-'));
      const schemaFile = path.join(work, 'schema.json');
      const replyFile = path.join(work, 'last-message.txt');
      if (schema) fs.writeFileSync(schemaFile, JSON.stringify(schema));

      const argv = ['exec', '--ephemeral', '--sandbox', 'read-only', '--json', '--output-last-message', replyFile];
      if (schema) argv.push('--output-schema', schemaFile);
      if (model) argv.push('--model', model);
      if (effort && EFFORTS.has(effort)) argv.push('-c', `model_reasoning_effort=${effort}`);
      argv.push(...extraArgs, '-');

      try {
        const {stdout, stderr, code} = await new Promise((resolve, reject) => {
          const child = spawnImpl(command, argv, {cwd, stdio: ['pipe', 'pipe', 'pipe']});
          let out = '';
          let err = '';
          let settled = false;
          const finish = (fn, value) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            fn(value);
          };
          const timer = setTimeout(() => {
            child.kill('SIGKILL');
            finish(reject, new Error(`codex timed out after ${timeoutMs} ms`));
          }, timeoutMs);
          child.stdout.on('data', (data) => { out += data; });
          child.stderr.on('data', (data) => { err += data; });
          child.on('error', (error) => finish(reject, error.code === 'ENOENT'
            ? new BackendFatalError(`cannot start "${command}": not found on PATH`)
            : error));
          child.on('close', (exitCode) => finish(resolve, {stdout: out, stderr: err, code: exitCode}));
          child.stdin.end(prompt);
        });

        const message = fs.existsSync(replyFile) ? fs.readFileSync(replyFile, 'utf8') : finalMessageFromEvents(stdout);
        const failure = errorText(stdout, stderr);
        if (code !== 0 && !message) throw classifyFailure(failure || `codex exited ${code}`);
        if (!message) {
          if (failure) throw classifyFailure(failure);
          throw new Error(`codex returned no final message (exit ${code})`);
        }
        return message;
      } finally {
        fs.rmSync(work, {recursive: true, force: true});
      }
    },
  };
}

module.exports = {createCodexBackend, eventDocuments, finalMessageFromEvents, classifyFailure};
