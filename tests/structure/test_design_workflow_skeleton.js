'use strict';

// The four `design.<domain>` workflows are inline copies of one C-group
// skeleton. The copies are deliberate -- a workflow cannot `require` and the
// repository does not share a module for the skeleton -- but a copy that drifts
// is worse than no copy: a reader who learns the contract from one domain then
// believes the next domain honours it. This test fixes where those files are
// allowed to differ.
//
// It does NOT diff the files against each other. The copies add blocks (a
// per-thread fan-out, a domain caliber schema), so a line-by-line comparison
// reports every subsequent line as a difference and says nothing about which
// differences matter. What matters is the named contract surface, so each is
// asserted by name:
//
//   * the `args` the workflow accepts and the guards it throws on
//   * the schema constants that cross the workflow boundary
//   * the phase order and the gate on the return value
//   * the read-only / deterministic constraints on the file itself
//
// The strategy prose inside the prompt template literals is expected to differ
// and is never compared.

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '../..');
const dir = path.join(root, 'integration/orchestration');

const files = fs.readdirSync(dir).filter(f => /^design\.[a-z]+\.workflow\.js$/.test(f)).sort();
const domain = f => f.replace(/^design\./, '').replace(/\.workflow\.js$/, '');
const read = f => fs.readFileSync(path.join(dir, f), 'utf8');

// `intake` is the pipeline's first stage and is deliberately NOT a C-group
// copy -- it has different args and a different phase list. The skeleton test
// covers the four domain workflows that share the search -> merge -> check
// shape.
const DOMAINS = ['compute', 'memory', 'comm', 'physical'];
const missing = DOMAINS.filter(d => !files.includes(`design.${d}.workflow.js`));
assert.deepStrictEqual(missing, [], `missing design workflows: ${missing.join(', ')}`);

const text = Object.fromEntries(DOMAINS.map(d => [d, read(`design.${d}.workflow.js`)]));

// 1. The `args` contract: every domain takes the same inputs, because the main
// loop that launches them does not branch on the domain. A domain that invents
// an extra required arg would be unlaunchable by that loop; one that drops an
// arg would silently ignore what the loop passes.
const ARGS = {
  'const REPO = args.repo': "the repo root",
  'const BRIEF = args.brief': 'the DesignBrief from intake',
  'const RUN_ID = args.runId': 'the run identifier for the ledger patch',
  'const MAX_CANDIDATES = args.maxCandidates': 'the fan-out bound',
  'const SEARCH_ARTIFACT = args.searchArtifact': 'the artifact the main loop already generated',
  'const SEARCH_BRIEF = args.searchBrief': 'the candidate set integration/pipelines/search_brief.js already read and verified',
  'const SEARCH_COMMAND_FOR_RECORD = args.searchCommand': 'the command recorded for replay'
};
for (const d of DOMAINS) {
  for (const [line, why] of Object.entries(ARGS)) {
    assert(text[d].includes(line), `design.${d}: missing the shared arg \`${line}\` (${why})`);
  }
}

// 2. The guards. Each one exists because the workflow would otherwise run on an
// input it never received -- the wrong stage's brief, or no search artifact at
// all. These must be present in every domain and must name their own stage.
for (const d of DOMAINS) {
  const t = text[d];
  assert(/if \(!BRIEF\) throw new Error\(/.test(t), `design.${d}: missing the missing-brief guard`);
  assert(/if \(!SEARCH_ARTIFACT\) \{/.test(t), `design.${d}: missing the missing-artifact guard`);
  assert(/if \(!SEARCH_BRIEF\) \{/.test(t), `design.${d}: missing the missing-search-brief guard`);
  // The candidate numbers every later verdict rests on come from the verified brief.
  // An agent that reads the artifact and transcribes it brings back an unchecked copy.
  assert(!t.includes("label: 'read-search-artifact'"), `design.${d}: no agent may read and transcribe the search artifact`);
  assert(t.includes(`if (BRIEF.stage !== '${d}') {`), `design.${d}: missing the wrong-stage guard`);
  assert(t.includes(`const STAGE = '${d}'`), `design.${d}: STAGE must be '${d}'`);
  // Every guard error names the workflow it came from, so a failure in a run
  // says which stage's contract was crossed. The name appears both as a plain
  // string and inside the template literal that reports the received stage.
  assert((t.match(new RegExp(`design\\.${d}`, 'g')) || []).length >= 2, `design.${d}: the guard errors must name the workflow`);
}

// 3. The schema constants that cross the workflow boundary. Two workflows
// exchanging a constraint must agree on its shape or the same object is read two
// ways. These are copied verbatim and must stay identical when whitespace is
// normalized.
//
// The copies do NOT agree on how to declare them: the skeleton inlines several
// schemas directly in the `agent(...)` call, and a copy that needs to reuse one
// across a per-thread fan-out hoists it to a named constant. Both spellings
// carry the same object, so the comparison is on the object at its use site,
// never on the declaration.
const braced = (src, from) => {
  const i = src.indexOf(from);
  assert(i >= 0, `missing \`${from}\``);
  let depth = 0;
  for (let k = src.indexOf('{', i); k < src.length; k++) {
    if (src[k] === '{') depth++;
    else if (src[k] === '}' && --depth === 0) return src.slice(src.indexOf('{', i), k + 1).replace(/\s+/g, '');
  }
  assert.fail(`\`${from}\` is unterminated`);
};
// Read the object from wherever the copy declares it: a hoisted constant if
// there is one, otherwise the `schema:` of the call site with that label.
const schemaAt = (src, name, label) => {
  if (src.includes(`const ${name} = {`)) return braced(src, `const ${name} = {`).replace(`const${name}=`, '');
  const i = src.indexOf(label);
  assert(i >= 0, `missing label \`${label}\``);
  return braced(src.slice(i), 'schema: {').replace(/^schema:/, '');
};
// The schemas every domain must agree on. CONSTRAINT_SCHEMA is hoisted (the
// lateral count varies, 2 or 3, and the block is identical across them);
// MERGE_SCHEMA and CHECK_SCHEMA are inlined in the integrator and checker calls.
const SHARED = [
  ['CONSTRAINT_SCHEMA', null],
  ['MERGE_SCHEMA', "label: 'integrator'"],
  ['CHECK_SCHEMA', "label: 'invariant-checker'"]
];
for (const [name, label] of SHARED) {
  const ref = schemaAt(text.compute, name, label || '');
  for (const d of DOMAINS) {
    assert.strictEqual(schemaAt(text[d], name, label || ''), ref, `design.${d}: ${name} drifted from the compute skeleton`);
  }
}

// The policy schema is the session's decisive input shape, so it is compared
// separately: comm and physical hoist it to fan out per thread, memory and
// compute inline it in the single policy call.
const POLICY_LABEL = "label: 'search-policy'";
const policyRef = schemaAt(text.compute, 'POLICY_SCHEMA', POLICY_LABEL);
for (const d of DOMAINS) {
  // A hoisted policy schema is used at the fan-out label, so look for the
  // constant first and fall back to the inline call site.
  const got = text[d].includes('const POLICY_SCHEMA = {')
    ? braced(text[d], 'const POLICY_SCHEMA = {').replace('constPOLICY_SCHEMA=', '')
    : schemaAt(text[d], 'POLICY_SCHEMA', POLICY_LABEL);
  assert.strictEqual(got, policyRef, `design.${d}: the policy schema drifted from the compute skeleton`);
}

// 4. The five skeleton phases, in order. A copy that reorders them would score
// candidates against constraints recalled after the merge, or merge before the
// search artifact was read.
const PHASES = ['Search policy', 'Deterministic search', 'Constraint recall', 'Merge', 'Invariant check'];
for (const d of DOMAINS) {
  const order = [...text[d].matchAll(/^phase\('([^']+)'\)/gm)].map(m => m[1]);
  assert.deepStrictEqual(order, PHASES, `design.${d}: phase order must be the skeleton order`);
  const declared = [...text[d].slice(0, text[d].indexOf('\n}')).matchAll(/title:\s*'([^']+)'/g)].map(m => m[1]);
  assert.deepStrictEqual(declared.slice(0, PHASES.length), PHASES, `design.${d}: meta.phases must declare the skeleton phases in order`);
  assert.strictEqual(new Set(declared).size, declared.length, `design.${d}: duplicate phase title in meta`);
}

// 5. The invariant check is a separate agent call from the merge, and the
// return is gated on its verdict. The merge agent has a structural preference
// for the candidates it just merged, so a workflow where one agent does both
// has no independent check left -- and the gate is what keeps a violated
// invariant out of `out/`.
for (const d of DOMAINS) {
  const t = text[d];
  const merge = t.indexOf("label: 'integrator'");
  const check = t.indexOf("label: 'invariant-checker'");
  assert(merge >= 0 && check >= 0, `design.${d}: merge and check must be separate agent calls`);
  assert(check > merge, `design.${d}: the invariant check must come after the merge`);
  assert(/const okInvariants = check && check\.verdict === 'INVARIANT_OK'/.test(t), `design.${d}: the return must be gated on the checker verdict`);
  const ret = t.slice(t.lastIndexOf('return {'));
  assert(/files:/.test(ret), `design.${d}: the return value must carry files`);
  assert(/okInvariants/.test(ret), `design.${d}: the returned files must be gated on okInvariants`);
  assert(/files: okInvariants/.test(t) || /okInvariants\s*\?/.test(ret), `design.${d}: files must be empty when the check fails`);
}

// 6. What a workflow may not do at all. It has no filesystem, cannot require,
// and must be deterministic -- the runtime rejects the nondeterministic calls,
// so a copy that uses them is a broken file rather than a design choice.
for (const d of DOMAINS) {
  const t = text[d];
  assert(!/require\(/.test(t), `design.${d}: a workflow cannot require`);
  assert(!/\bfs\./.test(t), `design.${d}: a workflow has no filesystem`);
  assert(!/Date\.now\(\)|Math\.random\(\)|new Date\(\)/.test(t), `design.${d}: nondeterministic call`);
  // Gate conclusions are computed only by the governance evaluator.
  assert(!/['"`](PASS|D_GATE_PASSED|Q_GATE_PASSED)['"`]/.test(t), `design.${d}: a workflow must not write a gate literal`);
  // The brief arrives as injected context; it is never read from disk.
  assert(/const BRIEF = args\.brief/.test(t), `design.${d}: the brief must arrive via args`);
}

// 7. The per-thread fan-out: every domain fans its expert out over the search
// threads rather than running one policy call, and the width is bounded by
// MAX_CANDIDATES so a strategy that returns many threads cannot spawn an
// unbounded number of agents. The fan-out may sit in phase 1 (hoisting
// POLICY_SCHEMA) or phase 2; both are accepted, but it must be there and it must
// be bounded.
for (const d of DOMAINS) {
  const t = text[d];
  assert(/await parallel\(/.test(t), `design.${d}: the strategy threads must fan out via parallel`);
  assert(/MAX_CANDIDATES/.test(t), `design.${d}: the fan-out must be bounded by MAX_CANDIDATES`);
  assert(/slice\(0, MAX_CANDIDATES\)|Math\.min\(MAX_CANDIDATES/.test(t), `design.${d}: the fan-out width must be bounded by MAX_CANDIDATES`);
}

console.log(`PASS design workflow skeleton: ${DOMAINS.length} copies (${DOMAINS.join(', ')}) share the args contract, `
  + `the guards, ${SHARED.length + 1} schema constants, the ${PHASES.length}-phase order and the gated return`);
