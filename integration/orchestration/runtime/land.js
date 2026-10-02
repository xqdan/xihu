'use strict';

// Lands the `files: [{path, content}]` a workflow returns.
//
// A workflow cannot write; it hands files to its host. That makes this function the
// only place a model-influenced string becomes a file on disk, so it is where the
// rules that the workflows state in prose are enforced in code, independent of which
// backend produced the content:
//
//   * a file may land only under the prefixes its workflow owns (LANDING_POLICY);
//   * `design.explore` can only reach `scratch/`, never `out/`;
//   * the path must stay inside the repository after resolution (no `..`, no
//     absolute path pointing elsewhere);
//   * content must not emit a gate literal (PASS, D_GATE_PASSED, ...) as a
//     conclusion: gate decisions come from evaluate_gates.js only;
//   * all-or-nothing: one rejected file lands nothing, so a half-written run record
//     can never sit next to a missing winner.

const fs = require('fs');
const path = require('path');
const {gateLiteralPattern} = require('../../governance/evaluate_gates');

// Prefixes end in `/` for directories; an entry without one is an exact file.
const LANDING_POLICY = {
  intake: ['teams/council/inputs/design_brief.intake.json'],
  contract: ['out/contracts/'],
  direction: ['out/direction/'],
  dgate: ['out/governance/'],
  compute: ['out/compute/'],
  memory: ['out/memory/'],
  comm: ['out/comm/'],
  physical: ['out/physical/'],
  'detail.freeze': ['out/detailed/'],
  'detail.workload': ['out/detailed/'],
  'detail.events': ['out/detailed/'],
  'detail.execute': ['out/detailed/'],
  'detail.integrate': ['out/detailed/'],
  converge: ['out/detailed/'],
  verify: ['out/verification/'],
  audit: ['out/verification/', 'references/external/'],
  backflow: ['out/governance/'],
  explore: ['scratch/'],
  learn: ['references/sota/'],
};

// Same exemption the strategy checker uses: a line that forbids the literal may name it.
const PROHIBITION = /不得|禁止|不判|严禁/;

function allowedBy(relative, prefixes) {
  return prefixes.some((p) => (p.endsWith('/') ? relative.startsWith(p) : relative === p));
}

function checkFile(root, workflow, file) {
  const prefixes = LANDING_POLICY[workflow.replace(/^design\./, '')];
  if (!prefixes) return `no landing policy for workflow "${workflow}"`;
  if (!file || typeof file.path !== 'string' || typeof file.content !== 'string') return 'file needs a string path and string content';
  const absolute = path.resolve(root, file.path);
  const relative = path.relative(root, absolute).split(path.sep).join('/');
  if (relative === '' || relative.startsWith('..') || path.isAbsolute(relative)) return `path escapes the repository: ${file.path}`;
  if (!allowedBy(relative, prefixes)) return `path ${relative} is outside what ${workflow} may land (${prefixes.join(', ')})`;
  const pattern = gateLiteralPattern();
  const offending = file.content.split('\n').find((line) => pattern.test(line) && !PROHIBITION.test(line));
  if (offending !== undefined) return `content emits a gate literal: ${offending.trim().slice(0, 120)}`;
  return null;
}

// Returns {landed, rejected}. With `dryRun` nothing is written but the verdict is the
// same, so a dry run tells you exactly what a real run would have done.
function landFiles({root, workflow, files, dryRun = false}) {
  const list = Array.isArray(files) ? files : [];
  const rejected = [];
  for (const file of list) {
    const reason = checkFile(root, workflow, file);
    if (reason) rejected.push({path: file && file.path, reason});
  }
  if (rejected.length) return {landed: [], rejected};
  const landed = list.map((file) => {
    const absolute = path.resolve(root, file.path);
    if (!dryRun) {
      fs.mkdirSync(path.dirname(absolute), {recursive: true});
      fs.writeFileSync(absolute, file.content);
    }
    return {path: path.relative(root, absolute).split(path.sep).join('/'), bytes: Buffer.byteLength(file.content)};
  });
  return {landed, rejected: []};
}

module.exports = {LANDING_POLICY, landFiles};
