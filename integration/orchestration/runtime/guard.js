'use strict';

// Backend-independent evidence that "agents are read-only" actually held.
//
// Each backend asks its agents to be read-only in its own vocabulary (a tool
// allow-list for Claude, a tool request for Cursor). Those are requests; this is the
// check. It snapshots every modified-or-untracked file (size and mtime) before the
// run and compares after. Anything that changed means an agent wrote to the working
// tree, and the driver then refuses to land the run's files.

const fs = require('fs');
const path = require('path');
const {execFileSync} = require('child_process');

// The files worth watching: modified tracked files and untracked, non-ignored ones.
function gitListing(root) {
  return execFileSync('git', ['ls-files', '-m', '-o', '--exclude-standard', '-z'], {cwd: root, maxBuffer: 64 * 1024 * 1024})
    .toString('utf8')
    .split('\0')
    .filter(Boolean);
}

// `list` is injectable so the comparison logic can be tested without a git work tree.
function snapshot(root, list = gitListing) {
  const listed = list(root);
  const state = new Map();
  for (const file of listed) {
    try {
      const stat = fs.statSync(path.join(root, file));
      state.set(file, `${stat.size}:${stat.mtimeMs}`);
    } catch (_) {
      state.set(file, 'missing');
    }
  }
  return state;
}

// Paths that appeared, vanished, or changed between two snapshots.
function changedBetween(before, after) {
  const changed = new Set();
  for (const [file, sig] of after) if (before.get(file) !== sig) changed.add(file);
  for (const file of before.keys()) if (!after.has(file)) changed.add(file);
  return [...changed].sort();
}

module.exports = {snapshot, changedBetween};
