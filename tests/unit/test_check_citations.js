'use strict';
// The citation check run_workflow.js applies before landing: a cited file:line must exist and carry
// text, and an expert range number must be on the card or on a line its evidence cites. Runs on a
// throwaway git work tree so the fixture lines are known.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {execFileSync} = require('child_process');
const {checkCitations, checkRangeNumbers, numberTokens} = require('../../integration/pipelines/check_citations');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cite-'));
const write = (p, lines) => {
  fs.mkdirSync(path.dirname(path.join(root, p)), {recursive: true});
  fs.writeFileSync(path.join(root, p), lines.join('\n'));
};
write('docs/2026-09-26_K3_FREEZE_GAP_REVIEW.md', ['# title', '', 'line three', 'line four', '', '']);
write('src/a.js', ['const a = 1;', '', 'const b = 2;']);
write('src/x/dup.js', ['one']);
write('src/y/dup.js', ['one']);
write('docs/rules.md', ['| a | b |', '| --- | ---: |', '```', '}', 'bank 656 B, 1.75 us']);
execFileSync('git', ['init', '-q'], {cwd: root});

const run = (...texts) => checkCitations(root, {note: texts.join(' ')});
const problemsAt = r => r.problems.map(p => p.at || p.citation);

try {
  let r = run('see src/a.js:1 and src/a.js:3.');
  assert(r.ok && r.checked === 2, `nonblank lines pass: ${JSON.stringify(r)}`);

  r = run('src/a.js:2');
  assert.deepStrictEqual(problemsAt(r), ['src/a.js:2'], 'blank line');
  assert.strictEqual(r.problems[0].problem, 'blank line');

  r = run('src/a.js:1-3');
  assert(r.ok, 'a range with one nonblank line passes');
  r = run('docs/2026-09-26_K3_FREEZE_GAP_REVIEW.md:5-6');
  assert.strictEqual(r.problems[0].problem, 'blank lines only', 'an all-blank range');

  r = run('src/a.js:1,3 and src/a.js:9/:2');
  assert.deepStrictEqual(problemsAt(r).sort(), ['src/a.js:2', 'src/a.js:9'], 'siblings on one file are each checked');
  assert(/past the end/.test(r.problems.find(p => p.at === 'src/a.js:9').problem), 'past the end of the file');

  r = run('docs/2026-09-26_K3_FREEZE_GAP_REVIEW.md:3、:4');
  assert(r.ok && r.checked === 2, 'the 、: sibling form');

  r = run('FREEZE_GAP_REVIEW.md:3', 'a.js:3');
  assert(r.ok && r.checked === 2 && !r.unresolved.length, 'a shortened or bare name naming one file resolves');

  r = run('dup.js:1');
  assert(r.ok && r.unresolved.length === 1 && r.unresolved[0].candidates.length === 2, 'an ambiguous name is unresolved, not a problem');

  r = run('nowhere.js:1');
  assert.strictEqual(r.problems[0].problem, 'no such file in the repository');

  r = checkCitations(root, {files: [{path: 'out/x.json', content: JSON.stringify({evidence: `${root}/src/a.js:2`})}]});
  assert.deepStrictEqual(problemsAt(r), ['src/a.js:2'], 'citations inside landed JSON with the repo root prefix are checked');

  r = run('version 1.2.3 and ratio 0.85 and a.js:3.5');
  assert.strictEqual(r.checked, 0, 'decimals are not line numbers');

  // A line with no letter or digit cannot carry a claim: a table border, a fence, a brace.
  r = run('docs/rules.md:2', 'docs/rules.md:3', 'docs/rules.md:4', 'docs/rules.md:1-2');
  assert.deepStrictEqual(problemsAt(r).sort(), ['docs/rules.md:2', 'docs/rules.md:3', 'docs/rules.md:4'], 'border, fence and brace lines are problems; a range with text is not');
  assert(r.problems.every(p => /no text/.test(p.problem)));

  // Range numbers: off-card numbers in plausibleRange must be on a line rangeEvidence cites.
  const rows = (...pairs) => ({rows: pairs.map(([plausibleRange, rangeEvidence], i) => ({name: `r${i}`, plausibleRange, rangeEvidence}))});
  const card = {parameters: [{name: 'x', published: 1101.77}], note: 'tau 2.5 us'};
  let n = checkRangeNumbers(root, rows(['656 B to 1.75 us', 'docs/rules.md:5']), {card});
  assert(n.ok && n.checked === 2, `numbers on the cited line pass: ${JSON.stringify(n)}`);
  n = checkRangeNumbers(root, rows(['657 B', 'docs/rules.md:5']), {card});
  assert.deepStrictEqual(n.problems.map(p => p.number), ['657'], 'a number not on the cited line is a problem');
  n = checkRangeNumbers(root, rows(['1101.8 and 2.50 us', 'docs/rules.md:1']), {card});
  assert(n.ok && n.checked === 0, 'numbers on the card (rounded as written) need no line');
  n = checkRangeNumbers(root, rows(['MC320 to 999', 'B-008']), {card});
  assert(n.ok && n.unchecked === 2, 'an ADR / blocker-only evidence leaves its numbers unchecked, not wrong');
  n = checkRangeNumbers(root, rows(['MC320', 'docs/rules.md:5']), {card});
  assert.deepStrictEqual(n.problems.map(p => p.number), ['320'], 'an MC tier label carries its bandwidth number');
  assert.deepStrictEqual(numberTokens('FP8 TP32 B-008 HW-03 a.md:254 :12 2026-09-26 §2.1 #4 8 16 0.85 512'), ['0.85', '512'], 'identifiers, line refs, dates and small integers are not claims');

  // design.attribution.workflow.js repeats numberTokens in-script (it cannot require); the two must agree.
  const wf = fs.readFileSync(path.join(__dirname, '../../integration/orchestration/design.attribution.workflow.js'), 'utf8');
  const wfTokens = new Function(`${wf.slice(wf.indexOf('const CITE ='), wf.indexOf('const sameNumber'))}; return numberTokens`)();
  for (const s of ['FP8 TP32 B-008 HW-03 a.md:254 :12 2026-09-26 §2.1 #4 8 16 0.85 512', 'MC320 656 B at 03_TMA_AND_SRAM.md:241/:248, 1.4245', 'x.json:46、:50 and 1000.15 / 1028.2'])
    assert.deepStrictEqual(wfTokens(s), numberTokens(s), `workflow numberTokens differs on: ${s}`);
} finally {
  fs.rmSync(root, {recursive: true, force: true});
}
console.log('PASS check citations');
