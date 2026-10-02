'use strict';

// Backend that answers `agent()` through the Cursor SDK (`@cursor/sdk`), one
// `Agent.prompt()` per call (it disposes the agent for you).
//
// The SDK has no schema parameter, so unlike the Claude backend the schema travels
// in the prompt: the reply is asked to be a bare JSON document, and the runtime
// validates it and retries with the error list. That makes this the backend where
// `maxAttempts` actually gets used.
//
// `@cursor/sdk` is deliberately NOT a dependency of this repository (it has none):
// it is loaded on first use, so the other backends, the tests and `npm test` never
// need it installed. That is the one reason for a dynamic import here; if the
// package is missing the backend fails fast with an install hint.
//
// Read-only: `tools` asks the local executor for a read-only tool set. That option
// name follows the SDK documentation and has not been exercised against a live key
// in this repository, so treat it as a request, not a guarantee. The guarantee is
// driver-side (guard.js compares the working tree before and after the run).
//
// Failure split: a thrown CursorAgentError that is not retryable (auth, config) and a
// missing key/package are BackendFatalError; `status: 'error'` runs and retryable
// errors are ordinary errors and get retried.

const {BackendFatalError} = require('../errors');

function withSchema(prompt, schema) {
  if (!schema) return prompt;
  return `${prompt}\n\n你的整个回复必须是一个 JSON 文档（不要 markdown 围栏，不要任何说明文字），并且符合下面的 JSON Schema：\n${JSON.stringify(schema)}`;
}

async function loadSdk() {
  try {
    return await import('@cursor/sdk');
  } catch (error) {
    throw new BackendFatalError(`cannot load @cursor/sdk (${error.message}); run "npm install --no-save @cursor/sdk" (Node >= 22.13)`);
  }
}

function createCursorBackend({
  apiKey = process.env.CURSOR_API_KEY,
  model = 'composer-2.5',
  cwd = process.cwd(),
  tools = ['read', 'grep', 'glob', 'ls'],
  effortParam,
  agentOptions = {},
  sdk,
} = {}) {
  return {
    name: 'cursor',
    async complete({prompt, schema, effort}) {
      if (!apiKey) throw new BackendFatalError('CURSOR_API_KEY is not set');
      const {Agent, CursorAgentError} = sdk || await loadSdk();
      const modelOption = {id: model};
      // The effort knob is a model parameter whose id differs per model; only send
      // it when the caller says which parameter id to use.
      if (effort && effortParam) modelOption.params = [{id: effortParam, value: effort}];

      let result;
      try {
        result = await Agent.prompt(withSchema(prompt, schema), {
          apiKey,
          model: modelOption,
          local: {cwd, settingSources: []},
          tools,
          ...agentOptions,
        });
      } catch (error) {
        if (CursorAgentError && error instanceof CursorAgentError && error.isRetryable === false) {
          throw new BackendFatalError(`cursor agent did not start: ${error.message}`);
        }
        throw error;
      }
      if (result.status === 'error') throw new Error(`cursor run failed (status=error, id=${result.id || 'unknown'})`);
      if (typeof result.result !== 'string') throw new Error('cursor run returned no text result');
      return result.result;
    },
  };
}

module.exports = {createCursorBackend, withSchema};
