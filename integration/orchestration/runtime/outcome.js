'use strict';

// The record of a run that returned no files.
//
// A workflow that stops on a backflow or a blocked input returns `files: []`, and with
// it the most useful thing the run learned (who stopped it, on which constraint, what to
// do next) exists only in the terminal. AGENTS.md is explicit that a conclusion in a
// conversation is not evidence. This module turns the result into a file the normal
// landing gates can accept, so the stop is as citable as a winner.
//
// The record is built by the driver from the workflow's own result; it is not model
// output and carries no verdict the workflow did not compute.

const {LANDING_POLICY} = require('./land');

// Candidate tables are already persisted in out/detailed/*_candidates.json under a
// fingerprint; repeating hundreds of rows per record would bury the finding. Keep the ids.
function compact(value) {
  if (Array.isArray(value)) {
    if (value.length > 3 && value.every((row) => row && typeof row === 'object' && typeof row.optionId === 'string')) {
      return {count: value.length, optionIds: value.map((row) => row.optionId)};
    }
    return value.map(compact);
  }
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, inner]) => [key, compact(inner)]));
  }
  return value;
}

// Where a workflow's outcome record goes: the first directory it may land in. A workflow
// whose only landing target is one exact file (intake) has no place for it. A workflow run
// once per variant (attribution, per dimension) names the variant so runs do not overwrite.
function outcomePath(workflow, variant) {
  const name = workflow.replace(/^design\./, '');
  const dir = (LANDING_POLICY[name] || []).find((prefix) => prefix.endsWith('/'));
  const stem = variant ? `${name}_${variant}` : name;
  return dir ? `${dir}${stem.replace(/\./g, '_')}_outcome.json` : null;
}

// Returns {path, content} or null when there is nothing to record (the run returned
// files, or the workflow has no directory to put a record in).
function buildOutcomeFile(workflow, result, meta = {}, variant) {
  if (!result || (Array.isArray(result.files) && result.files.length)) return null;
  const target = outcomePath(workflow, variant);
  if (!target) return null;
  const {files, ...rest} = result;
  const record = {
    kind: 'WORKFLOW_OUTCOME_NO_FILES',
    workflow,
    ...meta,
    result: compact(rest),
  };
  return {path: target, content: `${JSON.stringify(record, null, 2)}\n`};
}

module.exports = {buildOutcomeFile, outcomePath, compact};
