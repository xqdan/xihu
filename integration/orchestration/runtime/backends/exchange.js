'use strict';

// A backend that hands every `agent()` call to someone else through the file system.
//
// For the environments that have a model but no API key the driver can use: a Cursor
// or Claude Code session answers each prompt by itself (for example with a subagent)
// and drops the reply next to the request. Nothing here knows who answers.
//
//   <dir>/<run>/NNN.request.json   {id, label, attempt, effort, prompt}  -- prompt already
//                                  carries the schema suffix, so the answerer needs nothing else
//   <dir>/<run>/NNN.answer.txt     the reply, raw text (a bare JSON document)
//
// `<run>` is unique per backend instance, so an answer left over from an earlier run can
// never be mistaken for the answer to this run's NNN. `dir` is expected to be git-ignored
// (default scratch/wf_exchange): the guard compares the tracked and untracked tree, and
// exchange files must not look like an agent writing into the repository.
//
// A call that is not answered within `timeoutMs` is a BackendFatalError: a run that
// waits forever on nobody is an environment problem, not a design verdict.

const fs = require('fs');
const path = require('path');
const {BackendFatalError} = require('../errors');
const {withSchema} = require('../schema');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function createExchangeBackend({dir, pollMs = 500, timeoutMs = 30 * 60 * 1000, runId, onRequest} = {}) {
  if (!dir) throw new BackendFatalError('exchange backend needs a directory');
  const run = runId || `${new Date().toISOString().replace(/[:.]/g, '-')}-${process.pid}`;
  const runDir = path.join(dir, run);
  fs.mkdirSync(runDir, {recursive: true});
  let sequence = 0;

  return {
    name: 'exchange',
    dir: runDir,
    async complete({prompt, schema, label, effort, attempt}) {
      sequence += 1;
      const id = String(sequence).padStart(3, '0');
      const request = path.join(runDir, `${id}.request.json`);
      const answer = path.join(runDir, `${id}.answer.txt`);
      fs.writeFileSync(request, JSON.stringify({id, label, attempt, effort, prompt: withSchema(prompt, schema)}, null, 2));
      if (onRequest) onRequest({id, label, attempt, request, answer});
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        // An empty file is a reply still being written, not a reply. Answerers should
        // write to a temporary name and rename, but this tolerates the ones that do not.
        if (fs.existsSync(answer) && fs.statSync(answer).size > 0) return fs.readFileSync(answer, 'utf8');
        if (Date.now() > deadline) {
          throw new BackendFatalError(`no answer for ${path.relative(dir, request)} within ${timeoutMs} ms`);
        }
        await sleep(pollMs);
      }
    },
  };
}

module.exports = {createExchangeBackend};
