'use strict';

/* Mechanical check of the `file:line` citations in what a workflow hands back.
 *
 * Every number an agent gives must carry a source (file:line, ADR or blocker id). Whether the cited
 * line says what the citation claims is a judgement, left to invariant-checker; whether the line
 * exists and is not blank is not a judgement, and a model gets it wrong often enough (an off-by-one
 * onto a blank line) that it is checked here, in code, before anything lands. Prompt wording does
 * not stop it; this does. A line with no letter or digit (a table border, a code fence, a lone
 * brace) cannot carry a claim either and is reported the same way.
 *
 * checkRangeNumbers goes one step further for the expert ranges of design.attribution: every number
 * in a `plausibleRange` must be on the card or appear, as a number, on one of the lines its
 * `rangeEvidence` cites. Only numbers with a decimal point or at least three digits are checked
 * (small integers are mostly design-space steps, rule numbers and counts); a `rangeEvidence` with no
 * file:line (an ADR or blocker id only) is counted as unchecked, not as a problem.
 *
 * A citation is `<path>.<ext>:<line>` with optional ranges and siblings on the same file:
 * `a.js:12`, `a.js:39-40`, `a.js:100,107`, `a.js:273/:279`, `a.md:7、:12`. A bare or shortened file
 * name is resolved against the files git knows when it names exactly one; an ambiguous name is
 * reported as unresolved, not as a problem. Lines are checked against the working tree, so a citation
 * made before a file was edited is checked against the edited file.
 *
 * Usage:
 *   node integration/pipelines/check_citations.js <result.json> [...]
 *   (a run_workflow.js --result-file, or a Workflow tool output whose `result` is the return value)
 *   node integration/pipelines/check_citations.js --card out/attribution/sram_card.json <result.json>
 *   (also checks the plausibleRange numbers against the card and the cited lines)
 * Exit codes: 0 every resolved citation points at a line with text (and, with --card, every range
 * number is supported), 1 usage, 2 problems found.
 */

const fs = require('fs');
const path = require('path');
const {execFileSync} = require('child_process');

const EXTENSIONS = 'js|cjs|mjs|ts|md|json|py|ya?ml|txt|csv';
const NUM = '\\d+(?:-\\d+)?(?!\\d|\\.\\d)';
const CITE = new RegExp(`([A-Za-z0-9_][\\w.\\-/]*\\.(?:${EXTENSIONS})):(${NUM})((?:(?:,|/:?|、:)${NUM})*)`, 'g');

// A number as a claim: not part of an identifier (FP8, TP32, B-008, HW-03), not a line reference
// (citations, ":254" and dates are stripped first), at least three digits or a decimal point.
// MC320 / MC640 name a bandwidth tier, so the number of an MC tier label counts.
const NUMBER = /(?<![A-Za-z0-9_.])(?<![A-Za-z]-)\d+(?:\.\d+)?(?![A-Za-z0-9_]|\.\d)/g;
const significant = (t) => t.includes('.') || t.length >= 3;
function numberTokens(text) {
  const plain = String(text).replace(/\bMC(\d{3})\b/g, ' $1 ').replace(CITE, ' ')
    .replace(/\d{4}-\d{2}-\d{2}/g, ' ').replace(/:\s*\d+(?:\s*[-,/、]\s*:?\s*\d+)*/g, ' ')
    .replace(/§\s*\d+(?:\.\d+)*/g, ' ').replace(/#\d+/g, ' ');
  return (plain.match(NUMBER) || []).filter(significant);
}
// t (as written, with its decimals) matches n when n rounds to it.
const sameNumber = (t, n) => {
  const d = (t.split('.')[1] || '').length;
  return d ? Math.abs(n - Number(t)) < 0.5 * 10 ** -d + 1e-12 : n === Number(t);
};
// Every number a JSON value carries: numeric leaves and the numbers written in its strings and keys.
function numbersIn(value, out = []) {
  if (typeof value === 'number') out.push(value);
  else if (typeof value === 'string') (value.match(NUMBER) || []).forEach((t) => out.push(Number(t)));
  else if (Array.isArray(value)) value.forEach((v) => numbersIn(v, out));
  else if (value && typeof value === 'object') Object.entries(value).forEach(([k, v]) => { numbersIn(k, out); numbersIn(v, out); });
  return out;
}

function strings(value, out = []) {
  if (typeof value === 'string') out.push(value);
  else if (Array.isArray(value)) value.forEach((v) => strings(v, out));
  else if (value && typeof value === 'object') Object.values(value).forEach((v) => strings(v, out));
  return out;
}

// Landed file contents are JSON text; scan the strings inside them, not the escaped text.
function textsOf(value) {
  return strings(value).flatMap((s) => {
    try { return strings(JSON.parse(s)); } catch (_) { return [s]; }
  });
}

function trackedFiles(root) {
  try {
    return execFileSync('git', ['ls-files', '-co', '--exclude-standard'], {cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024})
      .split('\n').filter(Boolean);
  } catch (_) {
    return [];
  }
}

function parseLines(spec) {
  const [a, b] = spec.split('-').map(Number);
  return {from: a, to: b === undefined ? a : b};
}

function resolver(root) {
  const known = trackedFiles(root);
  const cache = new Map();
  const rootPatterns = [root, root.split(path.sep).join('/')].map((r) => new RegExp(`${r.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[\\\\/]?`, 'gi'));
  const resolve = (cited) => {
    const p = cited.replace(/\\/g, '/').replace(/^\.\//, '');
    if (fs.existsSync(path.join(root, p)) && fs.statSync(path.join(root, p)).isFile()) return {file: p};
    const matches = known.filter((f) => f === p || f.endsWith(`/${p}`));
    // A shortened bare name (FREEZE_GAP_REVIEW.md for 2026-09-26_K3_P1_FREEZE_GAP_REVIEW.md) still
    // names one file when exactly one file name ends with it.
    const shortened = !matches.length && !p.includes('/') ? known.filter((f) => path.posix.basename(f).endsWith(p)) : [];
    const found = matches.length ? matches : shortened;
    if (found.length === 1) return {file: found[0]};
    if (found.length > 1) return {ambiguous: found};
    return {missing: true};
  };
  const linesOf = (file) => {
    if (!cache.has(file)) cache.set(file, fs.readFileSync(path.join(root, file), 'utf8').split(/\r?\n/));
    return cache.get(file);
  };
  return {resolve, linesOf, rootPatterns};
}

const hasText = (line) => /[\p{L}\p{N}]/u.test(line);

function checkCitations(root, value) {
  const {resolve, linesOf, rootPatterns} = resolver(root);
  const seen = new Set();
  const problems = [];
  const unresolved = [];
  let checked = 0;
  for (const raw of textsOf(value)) {
    const text = rootPatterns.reduce((t, re) => t.replace(re, ''), raw);
    for (const m of text.matchAll(CITE)) {
      const [citation, cited, first, rest] = m;
      if (seen.has(citation)) continue;
      seen.add(citation);
      const where = resolve(cited);
      if (where.ambiguous) { unresolved.push({citation, candidates: where.ambiguous}); continue; }
      if (where.missing) { problems.push({citation, problem: 'no such file in the repository'}); continue; }
      const lines = linesOf(where.file);
      const specs = [first, ...(rest.match(new RegExp(NUM, 'g')) || [])];
      for (const spec of specs) {
        checked += 1;
        const {from, to} = parseLines(spec);
        const at = `${where.file}:${spec}`;
        if (from < 1 || to < from) problems.push({citation, at, problem: 'not a line range'});
        else if (to > lines.length) problems.push({citation, at, problem: `past the end of the file (${lines.length} lines)`});
        else if (lines.slice(from - 1, to).every((l) => !l.trim())) problems.push({citation, at, problem: from === to ? 'blank line' : 'blank lines only'});
        else if (!lines.slice(from - 1, to).some(hasText)) problems.push({citation, at, problem: 'no text on the cited line(s): a border, rule, fence or brace'});
      }
    }
  }
  return {ok: !problems.length, checked, problems, unresolved};
}

// Objects carrying an expert range: {name?, plausibleRange, rangeEvidence}.
function ranges(value, out = []) {
  if (Array.isArray(value)) value.forEach((v) => ranges(v, out));
  else if (value && typeof value === 'object') {
    if (typeof value.plausibleRange === 'string' && typeof value.rangeEvidence === 'string') out.push(value);
    Object.values(value).forEach((v) => ranges(v, out));
  }
  return out;
}

function checkRangeNumbers(root, value, {card} = {}) {
  const {resolve, linesOf, rootPatterns} = resolver(root);
  const onCard = card ? numbersIn(card) : [];
  const problems = [];
  let checked = 0;
  let unchecked = 0;
  for (const row of ranges(value)) {
    const wanted = numberTokens(row.plausibleRange).filter((t) => !onCard.some((n) => sameNumber(t, n)));
    if (!wanted.length) continue;
    const evidence = rootPatterns.reduce((t, re) => t.replace(re, ''), row.rangeEvidence);
    const cited = [];
    for (const [, file, first, rest] of evidence.matchAll(CITE)) {
      const where = resolve(file);
      if (!where.file) continue;
      const lines = linesOf(where.file);
      for (const spec of [first, ...(rest.match(new RegExp(NUM, 'g')) || [])]) {
        const {from, to} = parseLines(spec);
        cited.push(...lines.slice(Math.max(0, from - 1), Math.min(lines.length, to)));
      }
    }
    if (!cited.length) { unchecked += wanted.length; continue; }
    const there = numbersIn(cited.join('\n'));
    for (const t of wanted) {
      checked += 1;
      if (!there.some((n) => sameNumber(t, n))) {
        problems.push({row: row.name || null, number: t, problem: 'not on the card and on none of the lines its rangeEvidence cites', rangeEvidence: row.rangeEvidence});
      }
    }
  }
  return {ok: !problems.length, checked, unchecked, problems};
}

module.exports = {checkCitations, checkRangeNumbers, numberTokens, CITE};

if (require.main === module) {
  const argv = process.argv.slice(2);
  const at = argv.indexOf('--card');
  const cardFile = at >= 0 ? argv[at + 1] : null;
  const files = argv.filter((_, i) => at < 0 || (i !== at && i !== at + 1));
  if (!files.length || (at >= 0 && !cardFile)) {
    console.error('usage: check_citations.js [--card <card.json>] <result.json> [...]');
    process.exit(1);
  }
  const root = path.resolve(__dirname, '../..');
  const card = cardFile ? JSON.parse(fs.readFileSync(cardFile, 'utf8')) : null;
  let bad = false;
  for (const file of files) {
    const text = fs.readFileSync(file, 'utf8');
    const parsed = JSON.parse(text.slice(text.indexOf('{')));
    const result = parsed.result !== undefined ? parsed.result : parsed;
    const report = checkCitations(root, result);
    const rangeNumbers = card ? checkRangeNumbers(root, result, {card}) : null;
    bad = bad || !report.ok || Boolean(rangeNumbers && !rangeNumbers.ok);
    console.log(JSON.stringify({file, ...report, ...(rangeNumbers ? {rangeNumbers} : {})}, null, 2));
  }
  process.exit(bad ? 2 : 0);
}
