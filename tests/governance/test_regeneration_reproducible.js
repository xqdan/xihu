'use strict';

// Regenerating out/ from the committed sources must reproduce the committed out/
// byte for byte. The per-stage inputHashes only prove that the inputs a run
// recorded are still the inputs on disk; they cannot notice an artifact that was
// edited by hand, or one whose generator changed without a rerun.
//
// The regeneration runs in a throw-away copy of the repository, so this test never
// touches the working tree. Provenance is pinned to the commit already recorded in
// the committed artifacts (K3_SOURCE_COMMIT), so the comparison is exact: any
// difference is a real difference.
//
// Not covered, on purpose: `search:final` (about a minute) and `baseline:sync`
// (rewrites a hardware input). Their outputs enter the regeneration as inputs, and
// tests/regression/test_k3_rdma_final_tuning.js and test_design_baseline.js
// check them.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {spawnSync} = require('child_process');

const root = path.resolve(__dirname, '../..');
const COPY_EXCLUDE = new Set(['.git', 'archive', 'node_modules', 'scratch', 'coverage', '.tmp']);
const REGENERATE_SCRIPTS = ['aicore:search', 'commcore:search', 'memory:search', 'sram:search', 'physical:search', 'model:planning'];

const readJson = (base, relativePath) => JSON.parse(fs.readFileSync(path.join(base, relativePath), 'utf8'));

// "node a.js && node b.js" -> [['a.js'], ['b.js']]; anything else is not a plain node chain.
function scriptInvocations(command) {
  return command.split('&&').map(part => {
    const words = part.trim().split(/\s+/);
    assert.strictEqual(words[0], 'node', `package script step is not a plain node call: ${part.trim()}`);
    return words.slice(1);
  });
}

function listFiles(base, relativeDir) {
  const out = [];
  const walk = dir => {
    for (const entry of fs.readdirSync(path.join(base, dir), {withFileTypes: true})) {
      const relative = path.posix.join(dir, entry.name);
      if (entry.isDirectory()) walk(relative);
      else out.push(relative);
    }
  };
  walk(relativeDir);
  return out.sort();
}

const pinnedCommit = readJson(root, 'out/detailed/detailed_architecture_run.json').provenance.sourceCommit;
assert(pinnedCommit, 'committed artifacts must record provenance.sourceCommit');

const scripts = readJson(root, 'package.json').scripts;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'k3-regen-'));
try {
  fs.cpSync(root, tmp, {
    recursive: true,
    filter: source => !COPY_EXCLUDE.has(path.basename(source)) || path.dirname(source) !== root
  });

  for (const name of REGENERATE_SCRIPTS) {
    assert(scripts[name], `package.json has no script ${name}`);
    for (const args of scriptInvocations(scripts[name])) {
      const result = spawnSync(process.execPath, args, {
        cwd: tmp,
        encoding: 'utf8',
        env: {...process.env, K3_SOURCE_COMMIT: pinnedCommit}
      });
      assert.strictEqual(result.status, 0, `regeneration step failed: ${name} -> node ${args.join(' ')}\n${result.stderr}`);
    }
  }

  const committed = listFiles(root, 'out');
  const regenerated = listFiles(tmp, 'out');
  assert.deepStrictEqual(regenerated, committed, 'regeneration added or dropped files under out/');

  const drifted = committed.filter(file => !fs.readFileSync(path.join(root, file)).equals(fs.readFileSync(path.join(tmp, file))));
  assert.deepStrictEqual(
    drifted,
    [],
    `out/ is not reproducible from the committed sources; rerun the pipelines (README: integration/pipelines) and commit:\n  ${drifted.join('\n  ')}`
  );
} finally {
  fs.rmSync(tmp, {recursive: true, force: true});
}

console.log(`PASS regeneration reproducible: ${REGENERATE_SCRIPTS.length} pipeline groups rerun in a scratch copy reproduce out/ byte for byte (provenance pinned to ${pinnedCommit.slice(0, 7)})`);
