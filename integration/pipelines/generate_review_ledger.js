'use strict';
/* Persist a k3_multiteam_review workflow run into out/reviews/, so that two runs
 * can be compared and "how much progress has been made on the freeze gap" stops
 * being a question nobody can answer.
 *
 * The workflow script itself cannot touch the filesystem (Workflow scripts have
 * no fs access, and out/ is generator-owned), so it returns one deterministic
 * object and this generator writes it. runId is a content hash, not a timestamp,
 * so an identical run produces an identical file.
 *
 * Input: the workflow's return value, saved verbatim to a JSON file — e.g.
 *   <session>/subagents/workflows/<runId>/result.json
 * or the `result` field of a task output file.
 *
 * Run: node integration/pipelines/generate_review_ledger.js <input.json> [--check]
 *   --check   compare against out/reviews/latest.json and print the diff without writing
 */
const fs = require('fs');
const path = require('path');
const root = path.resolve(__dirname, '../..');

const args = process.argv.slice(2);
const check = args.includes('--check');
const input = args.find((a) => !a.startsWith('--'));
if (!input) {
  console.error('usage: node integration/pipelines/generate_review_ledger.js <workflow-result.json> [--check]');
  process.exit(2);
}

const read = (p) => JSON.parse(fs.readFileSync(path.join(root, p), 'utf8').replace(/^﻿/, ''));
const write = (p, v) => fs.writeFileSync(path.join(root, p), `${JSON.stringify(v, null, 2)}\n`, 'utf8');
const exists = (p) => fs.existsSync(path.join(root, p));

const raw = read(input);
// Accepts either the workflow's return value, or a task-output wrapper holding it.
const parsed = raw.result !== undefined && typeof raw.result === 'string' ? JSON.parse(raw.result) : raw.result !== undefined && raw.result !== null ? raw.result : raw;

if (!parsed.runId) {
  console.error('input has no runId — is this the return value of k3_multiteam_review.workflow.js?');
  process.exit(2);
}

const claims = parsed.claims || [];
const adversarial = parsed.adversarial || [];
const statusOf = Object.fromEntries(adversarial.map((a) => [a.claim_id, a.status]));

// claim 表：把核验状态贴在每条 claim 上，Council 引用时能带上（README 已知问题 1）
const claimRows = claims.map((c) => ({
  claim_id: c.claim_id,
  owner: c.owner,
  severity: c.severity,
  statement: c.statement,
  evidence: c.evidence,
  number: c.number,
  interfaces: c.interfaces || [],
  verification: statusOf[c.claim_id] || 'not_verified',
}));

const blockers = claimRows.filter((c) => c.severity === 'blocker');
const record = {
  schemaVersion: 'review-ledger-v0.1',
  runId: parsed.runId,
  generatedBy: 'integration/pipelines/generate_review_ledger.js',
  sourceFingerprint: parsed.claims_hash,
  summary: {
    claims: claimRows.length,
    blockers: blockers.length,
    adversarial: {
      survived: adversarial.filter((a) => a.status === 'survived').length,
      split: adversarial.filter((a) => a.status === 'split').length,
      killed: adversarial.filter((a) => a.status === 'killed').length,
      incomplete: adversarial.filter((a) => a.status === 'incomplete').length,
    },
    premise_may_be_wrong: (parsed.premises && parsed.premises.premises || []).filter((p) => p.direction === 'premise_may_be_wrong').length,
    evidence_requests: (parsed.evidenceRequests || []).length,
    evidence_requests_critical: (parsed.evidenceRequests || []).filter((r) => r.critical).length,
  },
  team_positions: (parsed.leads || []).map((l) => ({ team: l.team, position: l.position, gap_estimate: l.gap_estimate })),
  blockers,
  claims: claimRows,
  premises: parsed.premises || null,
  evidence_requests: parsed.evidenceRequests || [],
  interface_verdicts: parsed.interfaceVerdicts || [],
  interface_findings: parsed.pairFindings || [],
  stage_failures: parsed.stageFailures,
  absent_teams: parsed.absentTeams || [],
  uncovered_responsibilities: parsed.uncoveredResponsibilities || [],
  unpaired_interfaces: parsed.unpairedInterfaces || [],
  unverified_contested: (parsed.unverifiedContested || []).map((c) => c.claim_id),
  council_report: parsed.council,
  council_new_items: (parsed.newItemVerdicts || []).map((v) => ({ item_id: v.item_id, statement: v.statement, status: v.status })),
  council_addendum: parsed.addendum || null,
  critic: parsed.critic,
};

// 跨轮 diff：上一轮的 blocker / 前提 / 取证需求在这一轮还在不在
const PREV = 'out/reviews/latest.json';
let diff = null;
if (exists(PREV)) {
  const prev = read(PREV);
  const key = (a, f) => new Set(a.map(f));
  const prevBlockers = key(prev.blockers || [], (b) => b.statement);
  const prevReqs = key(prev.evidence_requests || [], (r) => r.item);
  const curBlockers = new Set(record.blockers.map((b) => b.statement));
  const curReqs = new Set(record.evidence_requests.map((r) => r.item));
  diff = {
    previous_run: prev.runId,
    same_run: prev.runId === record.runId,
    blockers_resolved: [...prevBlockers].filter((s) => !curBlockers.has(s)),
    blockers_new: [...curBlockers].filter((s) => !prevBlockers.has(s)),
    evidence_requests_closed: [...prevReqs].filter((s) => !curReqs.has(s)),
    evidence_requests_open: [...curReqs].filter((s) => !prevReqs.has(s)),
    gap_estimate_prev: (prev.team_positions || []).map((t) => `${t.team}: ${t.gap_estimate}`),
    gap_estimate_now: record.team_positions.map((t) => `${t.team}: ${t.gap_estimate}`),
  };
  if (diff.same_run) console.log('note: runId matches out/reviews/latest.json — the inputs produced an identical run');
}
record.diff_vs_previous = diff;

const printable = [
  `runId ${record.runId}`,
  `claims ${record.summary.claims} (blocker ${record.summary.blockers})`,
  `adversarial ${JSON.stringify(record.summary.adversarial)}`,
  `premises may-be-wrong ${record.summary.premise_may_be_wrong}`,
  `evidence requests ${record.summary.evidence_requests} (critical ${record.summary.evidence_requests_critical})`,
];
if (diff) {
  printable.push(`blockers resolved ${diff.blockers_resolved.length}, new ${diff.blockers_new.length}`);
  printable.push(`evidence requests closed ${diff.evidence_requests_closed.length}, open ${diff.evidence_requests_open.length}`);
}

if (check) {
  if (!exists(PREV)) { console.log('no out/reviews/latest.json to compare against'); process.exit(0); }
  const prev = read(PREV);
  const changed = JSON.stringify(prev, null, 2) !== JSON.stringify({ ...record, diff_vs_previous: prev.diff_vs_previous }, null, 2);
  console.log(printable.join('\n'));
  console.log(changed ? 'status: DIFFERS from out/reviews/latest.json' : 'status: identical to out/reviews/latest.json');
  process.exit(0);
}

if (!exists('out/reviews')) fs.mkdirSync(path.join(root, 'out/reviews'), { recursive: true });
write(`out/reviews/${record.runId}.json`, record);
write(PREV, record);
console.log(`Generated out/reviews/${record.runId}.json and out/reviews/latest.json`);
console.log(printable.join('\n'));
