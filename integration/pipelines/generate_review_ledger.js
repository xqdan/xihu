'use strict';
/* Persist a design verify/audit cycle into out/reviews/, so that two runs can be
 * compared and "how much progress has been made on the freeze gap" stops being a
 * question nobody can answer.
 *
 * The workflows themselves cannot touch the filesystem (Workflow scripts have no
 * fs access, and out/ is generator-owned): design.verify and design.audit return
 * their artifacts and the main loop persists them under out/verification/.
 * This generator reads those landed reports back and folds them into one ledger.
 *
 * It reads the reports, it does not re-derive them. In particular the gate
 * decision is transcribed from governance/, never computed here.
 *
 * Input: the landed reports. With no argument, picks up out/verification/.
 *   node integration/pipelines/generate_review_ledger.js [<report.json> ...] [--check]
 *   --check   compare against out/reviews/latest.json and print the diff without writing
 *
 * Explicit paths are useful for archiving a run whose reports have since been
 * overwritten by a newer one.
 */
const fs = require('fs');
const path = require('path');
const root = path.resolve(__dirname, '../..');

const args = process.argv.slice(2);
const check = args.includes('--check');
const inputs = args.filter((a) => !a.startsWith('--'));

const read = (p) => JSON.parse(fs.readFileSync(path.join(root, p), 'utf8').replace(/^﻿/, ''));
const exists = (p) => fs.existsSync(path.join(root, p));
const write = (p, v) => {
  const abs = path.join(root, p);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, `${JSON.stringify(v, null, 2)}\n`, 'utf8');
};
const num = (v) => (typeof v === 'number' ? v : 0);
const arr = (v) => (Array.isArray(v) ? v : []);

// 报告里的 runId 直接来自 args.runId，不保证是文件名安全的；统一收敛一次。
const safe = (s) => String(s).replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 120) || 'unknown';

// ---------------------------------------------------------------------------
// 找报告。默认读 out/verification/ 下当前落盘的 verify/audit 报告——
// 这两份是 design.verify 与 design.audit 的产物，同处一目录、靠 stage 字段区分。
// ---------------------------------------------------------------------------
const REPORT_DIR = 'out/verification';
const reports = [];
if (inputs.length) {
  for (const p of inputs) reports.push({ rel: p, body: read(p) });
} else {
  // run_record 只登记口径，不含检查项，不单独入账；缺报告时用它的 runId 兜底。
  let runRecords = [];
  if (exists(REPORT_DIR)) {
    for (const name of fs.readdirSync(path.join(root, REPORT_DIR)).sort()) {
      if (!name.endsWith('.json')) continue;
      const rel = `${REPORT_DIR}/${name}`;
      const body = read(rel);
      if (/^design-(verify|audit)-report-/.test(body.schemaVersion || '')) reports.push({ rel, body });
      else if (/^design-run-record-/.test(body.schemaVersion || '')) runRecords.push(body);
    }
  }
  if (!reports.length) {
    const landed = runRecords.map((r) => `${r.stage} (runId ${r.runId})`).join('、');
    console.error(
      `no design verify/audit report found in ${REPORT_DIR}/` +
      (landed ? ` — 只找到 run record：${landed}。报告受 ok 门控，未通过时不落盘；` +
                '要么这一轮没有可入账的报告，要么把落盘的报告路径显式传进来' : '')
    );
    process.exit(2);
  }
}

const byStage = {};
for (const r of reports) {
  const stage = r.body.stage || 'unknown';
  if (byStage[stage]) {
    console.error(`两个 ${stage} 报告（${byStage[stage].rel} 与 ${r.rel}）；一次入账只接受一份，请显式传路径`);
    process.exit(2);
  }
  byStage[stage] = r;
}
if (!byStage.verify && !byStage.audit) {
  console.error('报告里没有 stage=verify 或 stage=audit；这是 design.verify / design.audit 的产物吗？');
  process.exit(2);
}
if (!byStage.verify) console.log('note: 没有 verify 报告，本轮只入账 audit');
if (!byStage.audit) console.log('note: 没有 audit 报告，本轮只入账 verify');

const vrep = byStage.verify ? byStage.verify.body : null;
const arep = byStage.audit ? byStage.audit.body : null;

// runId 取 verify 的，audit 的单独登记。两者本该是同一轮；不一致时如实记下，
// 不替它们对齐——"审的是不是同一轮"是个该被人看见的问题，不是该被抹平的差异。
const RUN_ID = (vrep && vrep.runId) || (arep && arep.runId);
if (vrep && arep && vrep.runId !== arep.runId) {
  console.log(`note: verify runId ${vrep.runId} 与 audit runId ${arep.runId} 不一致；ledger 以 verify 的为准，audit 的记在 stages.audit.runId`);
}

// ---------------------------------------------------------------------------
// 汇总两类"没通过"的项。它们就是本轮的 blocker 清单。
// ---------------------------------------------------------------------------
const verifyGaps = arr(vrep && vrep.gaps);
const failedChecks = arr(vrep && vrep.failedChecks);
const gateItems = arr(vrep && vrep.gateEvidence && vrep.gateEvidence.items);
const openItems = arr(vrep && vrep.signOff && vrep.signOff.openItems);
const routeContradictions = arr(vrep && vrep.routeContradictions);
// 检查全通过时 verify 报告里只留 failedChecks 摘要（完整 checks 不落盘），
// 所以这里读 summary，不假装读得到逐项结论。
const checkSummary = arr(vrep && vrep.checks).map((c) => ({
  checkId: c.checkId,
  name: c.name,
  verdict: c.verdict,
  failed: arr(c.checks).filter((x) => x.result !== 'passed').map((x) => ({ item: x.item, result: x.result, locator: x.locator })),
  gapCount: arr(c.gaps).length,
}));

const blockers = [
  ...failedChecks.map((c) => ({ source: 'verify', kind: 'check', id: c.checkId, statement: `${c.checkId}（${c.name || ''}）未通过`, verdict: c.verdict })),
  ...verifyGaps.map((g, i) => ({ source: 'verify', kind: 'gap', id: `GAP-${String(i + 1).padStart(2, '0')}`, statement: `未覆盖：${g.what}（${g.why}）`, owner: g.owner })),
  ...gateItems.filter((it) => it.blocker && it.blocker !== 'none').map((it, i) => ({ source: 'verify', kind: 'gate-evidence', id: `GATE-${String(i + 1).padStart(2, '0')}`, statement: `${it.requirement}：${it.blocker}`, owner: 'gate-keeper' })),
  ...openItems.map((o, i) => ({ source: 'verify', kind: 'open-item', id: `OPEN-${String(i + 1).padStart(2, '0')}`, statement: o, owner: 'architect' })),
  ...routeContradictions.map((c, i) => ({ source: 'verify', kind: 'contradiction', id: `CONTRA-${String(i + 1).padStart(2, '0')}`, statement: c })),
  ...arr(arep && arep.blocking).map((f, i) => ({ source: 'audit', kind: f.severity || 'blocking', id: f.finding_id || `AUDIT-${String(i + 1).padStart(2, '0')}`, statement: `${f.locator}：${f.issue}（期望 ${f.expected}，实为 ${f.found}）`, owner: f.owner })),
];

// 每个 stage 的账。audit 报告里没有的字段留 null，不补零——补零会让"没查"看起来像"查了没问题"。
const stages = {
  verify: vrep ? {
    runId: vrep.runId,
    verdict: vrep.verdict,
    sourceCommit: vrep.sourceCommit,
    artifacts: arr(vrep.artifactsVerified),
    checks: checkSummary,
    failedChecks,
    gaps: verifyGaps,
    gateEvidence: vrep.gateEvidence || null,
    signOff: vrep.signOff || null,
    // 照抄，不判断。本 generator 不产生门控结论。
    gateDecision: vrep.gateDecision !== undefined ? vrep.gateDecision : 'UNVERIFIED',
    gateDecisionSource: vrep.gateDecisionSource || 'UNVERIFIED',
    report: byStage.verify.rel,
  } : null,
  audit: arep ? {
    runId: arep.runId,
    verdict: arep.verdict,
    sourceCommit: arep.sourceCommit,
    artifacts: arr(arep.artifactsAudited),
    lenses: arr(arep.lenses).map((l) => ({ lensId: l.lensId, name: l.name, verdict: l.verdict })),
    blocking: arr(arep.blocking),
    noted: arr(arep.noted),
    contradictions: arr(arep.contradictions),
    unresolved: arr(arep.unresolved),
    crossLensPatterns: arr(arep.crossLensPatterns),
    // 参照系不是裁决。它是"同类系统的取值区间"，只有出处没有结论。
    // 这里只登记它存在与落点，不把它写进任何结论字段。
    externalReferenceFrame: (arep.externalReferenceFrame && arep.externalReferenceFrame.entryCount !== undefined)
      ? { not_evidence: true, entryCount: arep.externalReferenceFrame.entryCount, landedAt: arep.externalReferenceFrame.landedAt, participatesInVerdict: false }
      : null,
    report: byStage.audit.rel,
  } : null,
};

const record = {
  schemaVersion: 'review-ledger-v0.2',
  runId: RUN_ID,
  generatedBy: 'integration/pipelines/generate_review_ledger.js',
  sourceCommit: (vrep && vrep.sourceCommit) || (arep && arep.sourceCommit) || null,
  summary: {
    verifyVerdict: vrep ? vrep.verdict : null,
    auditVerdict: arep ? arep.verdict : null,
    checks: checkSummary.length,
    checksFailed: failedChecks.length,
    gaps: verifyGaps.length,
    openItems: openItems.length,
    routeContradictions: routeContradictions.length,
    auditBlocking: arr(arep && arep.blocking).length,
    auditNoted: arr(arep && arep.noted).length,
    blockers: blockers.length,
    artifactsVerified: arr(vrep && vrep.artifactsVerified).length,
    artifactsAudited: arr(arep && arep.artifactsAudited).length,
  },
  stages,
  blockers,
  open_items: openItems,
  // 门控结论的原文与出处，照抄自 verify 报告；本 generator 不判定它。
  gate_decision: stages.verify ? { decision: stages.verify.gateDecision, source: stages.verify.gateDecisionSource } : null,
  next_actions: arr(vrep && vrep.nextActions),
};

// ---------------------------------------------------------------------------
// 跨轮 diff：上一轮的 blocker 在这一轮还在不在。这是这份 ledger 存在的理由——
// 单轮的 blockers 看一眼报告就够了，能回答"差距在缩小吗"的只有跨轮对比。
// ---------------------------------------------------------------------------
const PREV = 'out/reviews/latest.json';
let diff = null;
if (exists(PREV)) {
  const prev = read(PREV);
  const key = (a, f) => new Set(a.map(f));
  const prevBlockers = key(arr(prev.blockers), (b) => b.statement);
  const curBlockers = new Set(blockers.map((b) => b.statement));
  diff = {
    previous_run: prev.runId,
    same_run: prev.runId === record.runId,
    blockers_resolved: [...prevBlockers].filter((s) => !curBlockers.has(s)),
    blockers_new: [...curBlockers].filter((s) => !prevBlockers.has(s)),
    verify_verdict_prev: (prev.summary || {}).verifyVerdict === undefined ? null : prev.summary.verifyVerdict,
    verify_verdict_now: record.summary.verifyVerdict,
    gate_decision_prev: prev.gate_decision ? prev.gate_decision.decision : null,
    gate_decision_now: record.gate_decision ? record.gate_decision.decision : null,
  };
  if (diff.same_run) console.log('note: runId matches out/reviews/latest.json — the inputs produced an identical run');
}
record.diff_vs_previous = diff;

const printable = [
  `runId ${record.runId}`,
  `verify ${record.summary.verifyVerdict} · audit ${record.summary.auditVerdict}`,
  `checks ${record.summary.checks} (failed ${record.summary.checksFailed})`,
  `gaps ${record.summary.gaps} · open items ${record.summary.openItems} · contradictions ${record.summary.routeContradictions}`,
  `audit blocking ${record.summary.auditBlocking} · noted ${record.summary.auditNoted}`,
  `blockers ${record.summary.blockers}`,
  `gate decision ${record.gate_decision ? `${record.gate_decision.decision} (${record.gate_decision.source})` : 'UNVERIFIED'}`,
];
if (diff) {
  printable.push(`blockers resolved ${diff.blockers_resolved.length}, new ${diff.blockers_new.length}`);
}

if (check) {
  if (!exists(PREV)) { console.log(printable.join('\n')); console.log('no out/reviews/latest.json to compare against'); process.exit(0); }
  const prev = read(PREV);
  const changed = JSON.stringify(prev, null, 2) !== JSON.stringify({ ...record, diff_vs_previous: prev.diff_vs_previous }, null, 2);
  console.log(printable.join('\n'));
  console.log(changed ? 'status: DIFFERS from out/reviews/latest.json' : 'status: identical to out/reviews/latest.json');
  process.exit(0);
}

write(`out/reviews/${safe(record.runId)}.json`, record);
write(PREV, record);
console.log(`Generated out/reviews/${safe(record.runId)}.json and out/reviews/latest.json`);
console.log(printable.join('\n'));
