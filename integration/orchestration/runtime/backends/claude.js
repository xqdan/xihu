'use strict';

// Backend that answers `agent()` by running the Claude Code CLI headless:
//
//   claude -p --output-format json --json-schema <schema> --tools Read,Grep,Glob
//
// The prompt goes in on stdin (these prompts embed whole candidate sets; an argv
// would hit the OS limit). Claude Code enforces `--json-schema` itself and returns
// the validated object as `structured_output`; the runtime validates again anyway,
// so a CLI version that ignores the flag degrades to a retry, not a bad value.
//
// Read-only is a tool allow-list (`--tools`), not a sandbox. The independent guard
// is driver-side: guard.js compares the working tree before and after the run.
//
// Failure split, which matters more than it looks:
//   * cannot start / not authenticated / model disabled  -> BackendFatalError, the
//     run aborts, because "403 Model disabled" must never be read as an agent that
//     had nothing to say;
//   * timeouts, 429, 5xx, unparseable output            -> ordinary error, retried.

const {spawn} = require('child_process');
const {BackendFatalError} = require('../errors');

const EFFORTS = new Set(['low', 'medium', 'high', 'xhigh', 'max']);

function parseCliOutput(stdout) {
  const text = stdout.trim();
  try {
    return JSON.parse(text);
  } catch (_) {
    // Some versions print a diagnostic line before the JSON document.
    const lines = text.split('\n').filter(Boolean);
    for (let i = lines.length - 1; i >= 0; i -= 1) {
      try {
        const parsed = JSON.parse(lines[i]);
        if (parsed && typeof parsed === 'object') return parsed;
      } catch (_) { /* keep looking */ }
    }
  }
  throw new Error(`claude printed no JSON document: ${text.slice(0, 200)}`);
}

// Turns the CLI's result document into the reply value, or throws the right class of error.
function interpret(document) {
  if (document.is_error) {
    const status = Number(document.api_error_status || 0);
    const message = `claude reported an error${status ? ` (HTTP ${status})` : ''}: ${String(document.result || '').slice(0, 300)}`;
    const retryable = status === 408 || status === 409 || status === 429 || status >= 500;
    if (status >= 400 && !retryable) throw new BackendFatalError(message);
    throw new Error(message);
  }
  if (document.structured_output !== undefined && document.structured_output !== null) return document.structured_output;
  if (typeof document.result === 'string') return document.result;
  throw new Error('claude result has neither structured_output nor result text');
}

function createClaudeBackend({
  command = 'claude',
  cwd = process.cwd(),
  model,
  tools = ['Read', 'Grep', 'Glob'],
  timeoutMs = 600000,
  extraArgs = [],
  spawnImpl = spawn,
} = {}) {
  return {
    name: 'claude',
    async complete({prompt, schema, effort}) {
      const argv = ['-p', '--output-format', 'json', '--no-session-persistence', '--tools', tools.join(',')];
      if (model) argv.push('--model', model);
      if (effort && EFFORTS.has(effort)) argv.push('--effort', effort);
      if (schema) argv.push('--json-schema', JSON.stringify(schema));
      argv.push(...extraArgs);

      const stdout = await new Promise((resolve, reject) => {
        const child = spawnImpl(command, argv, {cwd, stdio: ['pipe', 'pipe', 'pipe']});
        let out = '';
        let err = '';
        const timer = setTimeout(() => {
          child.kill('SIGKILL');
          reject(new Error(`claude timed out after ${timeoutMs} ms`));
        }, timeoutMs);
        child.stdout.on('data', (d) => { out += d; });
        child.stderr.on('data', (d) => { err += d; });
        child.on('error', (error) => {
          clearTimeout(timer);
          reject(error.code === 'ENOENT'
            ? new BackendFatalError(`cannot start "${command}": not found on PATH`)
            : error);
        });
        child.on('close', (code) => {
          clearTimeout(timer);
          // A non-zero exit still carries a JSON document when the API errored; let
          // `interpret` classify it. Without one, the stderr is all we have.
          if (code !== 0 && !out.trim()) reject(new Error(`claude exited ${code}: ${err.slice(0, 300)}`));
          else resolve(out);
        });
        child.stdin.end(prompt);
      });

      // A string reply is left for the runtime to parse and validate against the schema.
      return interpret(parseCliOutput(stdout));
    },
  };
}

module.exports = {createClaudeBackend, interpret, parseCliOutput};
