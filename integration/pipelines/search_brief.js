'use strict';

/* The deterministic half of the C-group design workflows (design.compute / memory /
 * comm / physical).
 *
 * A workflow has no filesystem and its agents are read-only, so the search
 * artifact has to reach it through the main loop. Until now the main loop passed a
 * PATH and a workflow agent read the file and transcribed the candidate numbers
 * into its reply. That transcriber is an LLM, and the transcribed numbers are the
 * only numbers every later verdict (merge, constraints, invariant check) rests on,
 * with nothing comparing "transcription" to "original". This module moves that
 * step out of the workflow:
 *
 *   brief   read the candidate artifact, check it is current (design space hash and
 *           a fresh search reproduce the stored fingerprint), take the ranked head and
 *           print a `searchBrief` the main loop passes as `args.searchBrief`;
 *   verify  after a workflow has returned and its files are written, check that the
 *           landed winner is a row of the artifact (byte-for-byte, as parsed JSON),
 *           that it is feasible, and that the run record names the same fingerprint.
 *
 * Usage:
 *   node integration/pipelines/search_brief.js brief  <domain> [--max N] [--no-recompute]
 *   node integration/pipelines/search_brief.js verify <domain>
 *   domain: compute | memory | comm | physical
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const {isDeepStrictEqual} = require('util');
const computeSearch = require('../detailed/matrix_vector_search.js');
const memorySearch = require('../detailed/memory_search.js');
const commSearch = require('../detailed/comm_core_search.js');
const physicalSearch = require('../detailed/physical_search.js');

const root = path.resolve(__dirname, '../..');
const DEFAULT_MAX = 12;

// One entry per C-group domain. `caliberUnverified` uses the field names of that
// domain's workflow schema (they differ), and is the answer when the artifact does
// not state its own caliber: the brief never infers one.
const DOMAINS = {
  compute: {
    artifact: 'out/detailed/matrix_vector_candidates.json',
    search: computeSearch,
    caliberUnverified: {areaIncludesPortCost: 'UNVERIFIED', powerScope: 'UNVERIFIED'}
  },
  memory: {
    artifact: 'out/detailed/memory_candidates.json',
    search: memorySearch,
    caliberUnverified: {mcGBsCaliber: 'UNVERIFIED', capacityGBPerCubeCaliber: 'UNVERIFIED'}
  },
  comm: {
    artifact: 'out/detailed/comm_candidates.json',
    search: commSearch,
    caliberUnverified: {areaIncludesPortCost: 'UNVERIFIED', powerScope: 'UNVERIFIED'}
  },
  physical: {
    artifact: 'out/detailed/physical_candidates.json',
    search: physicalSearch,
    caliberUnverified: {areaIncludesPortCost: 'UNVERIFIED', powerScope: 'UNVERIFIED', reserveFractionMeaning: 'UNVERIFIED'}
  }
};

const sha256 = buffer => crypto.createHash('sha256').update(buffer).digest('hex');
const readText = relativePath => fs.readFileSync(path.join(root, relativePath));
const readJson = relativePath => JSON.parse(readText(relativePath).toString('utf8').replace(/^\uFEFF/, ''));

function domainOf(name) {
  const entry = DOMAINS[name];
  if (!entry) throw new Error(`unknown domain ${name}; expected one of ${Object.keys(DOMAINS).join(', ')}`);
  return entry;
}

// A fresh search is the strongest currency check, and the slowest part of this
// module, so it runs at most once per domain per process.
const freshFingerprints = new Map();
function freshFingerprint(name) {
  if (!freshFingerprints.has(name)) {
    const S = domainOf(name).search;
    freshFingerprints.set(name, S.candidates(S.search()).candidateSetSha256);
  }
  return freshFingerprints.get(name);
}

const fail = (domain, notes) => ({ok: false, domain, notes});

function buildSearchBrief(domain, {max = DEFAULT_MAX, recompute = true, artifact} = {}) {
  const entry = domainOf(domain);
  let data = artifact;
  let artifactSha256 = null;
  if (!data) {
    if (!fs.existsSync(path.join(root, entry.artifact))) return fail(domain, `${entry.artifact} is missing; run the ${domain} search first`);
    const raw = readText(entry.artifact);
    artifactSha256 = sha256(raw);
    try {
      data = JSON.parse(raw.toString('utf8'));
    } catch (error) {
      return fail(domain, `${entry.artifact} is not valid JSON: ${error.message}`);
    }
  }
  if (!Array.isArray(data.candidates)) return fail(domain, `${entry.artifact} has no candidate array (a winner-only artifact cannot support exclusion reasons)`);
  if (!data.candidateSetSha256) return fail(domain, `${entry.artifact} carries no candidateSetSha256`);

  // The artifact must come from the design space on disk now.
  const space = data.designSpace || {};
  if (!space.file || !space.sha256) return fail(domain, `${entry.artifact} does not name its design space file and hash`);
  const currentSpaceSha256 = sha256(readText(space.file));
  if (currentSpaceSha256 !== space.sha256) {
    return fail(domain, `${entry.artifact} was searched over a different ${space.file} (stored ${space.sha256}, now ${currentSpaceSha256}); rerun the ${domain} search`);
  }

  // ... and a fresh search must reproduce the stored fingerprint, so a hand-edited or
  // stale candidate file cannot reach the workflow.
  if (recompute) {
    const fresh = freshFingerprint(domain);
    if (fresh !== data.candidateSetSha256) {
      return fail(domain, `${entry.artifact} does not match a fresh search (stored ${data.candidateSetSha256}, fresh ${fresh}); rerun the ${domain} search`);
    }
  }

  const caliberStated = Boolean(data.fieldCaliber);
  return {
    ok: true,
    domain,
    candidateSetSha256: data.candidateSetSha256,
    designSpaceFileSha256: space.sha256,
    totalCandidates: data.totalCandidates,
    feasibleCandidates: data.feasibleCandidates,
    listed: data.candidates.length,
    truncated: Boolean(data.truncated),
    infeasibleByCause: data.infeasibleByCause || null,
    dimensions: Array.isArray(space.dimensions) ? space.dimensions : Object.keys(space.dimensions || {}),
    fieldCaliber: {...(caliberStated ? data.fieldCaliber : entry.caliberUnverified), source: caliberStated ? 'artifact' : 'NOT_STATED_BY_ARTIFACT'},
    candidates: data.candidates.slice(0, max).map(row => ({optionId: row.optionId, values: JSON.stringify(row)})),
    provenance: {
      artifactPath: entry.artifact,
      artifactSha256,
      designSpaceFile: space.file,
      designSpaceFileSha256: space.sha256,
      fingerprintRecomputed: recompute
    },
    notes: caliberStated
      ? 'candidates are verbatim rows of the artifact'
      : 'candidates are verbatim rows of the artifact; the artifact states no field caliber, so every caliber field is UNVERIFIED'
  };
}

// Check a landed winner against the artifact it claims to come from. `winner` and
// `runRecord` are the parsed contents of out/<domain>/<domain>_winner.json and
// <domain>_run_record.json.
function verifyLandedWinner(domain, winner, runRecord, {artifact} = {}) {
  const entry = domainOf(domain);
  const data = artifact || readJson(entry.artifact);
  const failures = [];
  const rows = new Map((data.candidates || []).map(row => [row.optionId, row]));

  if (!winner || typeof winner.optionId !== 'string') {
    failures.push('winner has no optionId');
  } else if (!rows.has(winner.optionId)) {
    failures.push(`winner ${winner.optionId} is not a row of the candidate artifact`);
  } else {
    const row = rows.get(winner.optionId);
    let parsed = null;
    try {
      parsed = JSON.parse(winner.values);
    } catch {
      failures.push(`winner.values is not JSON (${winner.optionId})`);
    }
    if (parsed !== null && !isDeepStrictEqual(parsed, row)) {
      failures.push(`winner.values for ${winner.optionId} differs from the artifact row; the numbers were not transcribed verbatim`);
    }
    if (row.feasible !== true) failures.push(`winner ${winner.optionId} is not feasible in the artifact`);
  }

  if (!runRecord || runRecord.candidateSetSha256 !== data.candidateSetSha256) {
    failures.push(`run record names fingerprint ${runRecord && runRecord.candidateSetSha256}, the artifact has ${data.candidateSetSha256}`);
  }
  const excluded = (runRecord && runRecord.merge && runRecord.merge.excluded) || [];
  for (const item of excluded) {
    if (!rows.has(item.optionId)) failures.push(`excluded option ${item.optionId} is not a row of the candidate artifact`);
  }
  return {ok: failures.length === 0, domain, winner: winner && winner.optionId, failures};
}

function main(argv) {
  const [command, domain, ...flags] = argv;
  if (!['brief', 'verify'].includes(command) || !Object.hasOwn(DOMAINS, domain)) {
    console.error('usage: search_brief.js brief|verify <compute|memory|comm|physical> [--max N] [--no-recompute]');
    return 2;
  }
  if (command === 'brief') {
    const maxIndex = flags.indexOf('--max');
    const max = maxIndex >= 0 ? Number(flags[maxIndex + 1]) : DEFAULT_MAX;
    if (!Number.isInteger(max) || max < 1) {
      console.error('--max needs a positive integer');
      return 2;
    }
    const brief = buildSearchBrief(domain, {max, recompute: !flags.includes('--no-recompute')});
    console.log(JSON.stringify(brief, null, 2));
    return brief.ok ? 0 : 1;
  }
  const winnerPath = `out/${domain}/${domain}_winner.json`;
  const recordPath = `out/${domain}/${domain}_run_record.json`;
  const missing = [winnerPath, recordPath].filter(p => !fs.existsSync(path.join(root, p)));
  if (missing.length) {
    console.error(`nothing to verify, missing: ${missing.join(', ')}`);
    return 1;
  }
  const result = verifyLandedWinner(domain, readJson(winnerPath), readJson(recordPath));
  console.log(JSON.stringify(result, null, 2));
  return result.ok ? 0 : 1;
}

module.exports = {DOMAINS, DEFAULT_MAX, buildSearchBrief, verifyLandedWinner};

if (require.main === module) process.exitCode = main(process.argv.slice(2));
