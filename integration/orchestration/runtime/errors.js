'use strict';

// A backend throws this when the run cannot start at all (missing CLI, bad
// credentials, disabled model). The runtime aborts on it instead of retrying and
// instead of returning `null`: a configuration problem must never be reported as a
// design verdict. Anything else a backend throws is a failed attempt and is retried.
class BackendFatalError extends Error {
  constructor(message) {
    super(message);
    this.name = 'BackendFatalError';
    this.fatal = true;
  }
}

module.exports = {BackendFatalError};
