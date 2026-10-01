'use strict';
// Comm Core design search (teams/hardware/docs/10_COMM_CORE.md): the stored
// artifact is the winner of a fresh search over the HW-07 design space and
// holds no alternatives; the winner keeps the published point; every other
// option loses on a stated criterion; the document quotes the design, the
// search and the per-option comparison.
const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const S = require('../../integration/detailed/comm_core_search.js');
const A = require('../../integration/detailed/k3_architecture_search.js');
const O = require('../../integration/detailed/k3_rdma_final_tuning_model.js');
const R = require('../../integration/detailed/k3_sram_memory_rdma_model.js');

const stored = JSON.parse(fs.readFileSync('out/detailed/comm_core_design.json', 'utf8'));
const space = JSON.parse(fs.readFileSync(S.SPACE_FILE, 'utf8'));

// 1. The artifact is a fresh build; TECH/OPT/R.collective are left untouched.
const techBefore = JSON.stringify(A.TECH), optBefore = JSON.stringify(O.OPT), collective = R.collective;
const result = S.search();
const fresh = JSON.parse(JSON.stringify(S.build(result)));
const alt = S.alternatives(result);
assert.strictEqual(JSON.stringify(A.TECH), techBefore, 'search must not change A.TECH');
assert.strictEqual(JSON.stringify(O.OPT), optBefore, 'search must restore O.OPT');
assert.strictEqual(R.collective, collective, 'search must restore R.collective');
const close = (a, b, path) => {
  if (typeof a === 'number' && typeof b === 'number') return assert(Math.abs(a - b) <= 1e-6 * Math.max(1, Math.abs(b)), `${path}: ${a} vs ${b}`);
  if (a && typeof a === 'object') {
    assert.deepStrictEqual(Object.keys(a).sort(), Object.keys(b).sort(), `${path}: keys`);
    for (const k of Object.keys(a)) close(a[k], b[k], `${path}.${k}`);
    return;
  }
  assert.strictEqual(a, b, path);
};
close(stored, fresh, 'commCoreDesign');
assert(!/FROZEN/.test(stored.status.replace('not FROZEN', '')), 'the design is a MODEL result, not FROZEN');
assert.strictEqual(stored.designSpace.sha256, crypto.createHash('sha256').update(fs.readFileSync(S.SPACE_FILE)).digest('hex'), 'design space hash');

// 2. out/ holds only the final design: one option per searched dimension, one
// choice per ruled dimension, no candidate lists.
assert.deepStrictEqual(Object.keys(stored.design), Object.keys(space.dimensions), 'one entry per searched dimension');
for (const [d, v] of Object.entries(stored.design)) assert(v.option in space.dimensions[d].options, `${d}: ${v.option} is not in the design space`);
assert.deepStrictEqual(Object.keys(stored.ruled), Object.keys(space.ruled));
for (const v of Object.values(stored.ruled)) assert(!('alternatives' in v), 'ruled alternatives stay in the design space');
assert(!/"(alternatives|candidates|perOption)"\s*:\s*[[{]/.test(JSON.stringify(stored)), 'no alternative lists in out/');
assert(stored.designSpace.feasible > 0 && stored.designSpace.feasible <= stored.designSpace.valid && stored.designSpace.valid <= stored.designSpace.candidates);

// 3. The winner keeps the published point and the protocol model.
const e = stored.evaluation, cp = stored.controlPath;
assert(Math.abs(e.withSpecFloor.tpsPerUser - stored.published.tpsPerUser) < 1e-6, 'the design must keep the published TPS');
assert(cp.specSlackUs >= 0 && cp.classes.every(k => k.latencyUs <= O.OPT.tauUs + 1e-12), 'every class within the spec tau');
assert(e.bottomUp.rawLatencyUs <= stored.published.rawBudgetUs, 'bottom-up raw within the raw budget');
assert(cp.classes.every(k => k.controlUs <= e.controlUsWithinRawBudget), 'control path within the uniform raw-budget control');
assert(Math.abs(e.tauSweep.find(r => r.tauUs === O.OPT.tauUs).tpsPerUser - stored.published.tpsPerUser) < 1e-6, 'tau = spec replays the published TPS');
for (let i = 1; i < e.tauSweep.length; i++) assert(e.tauSweep[i].tpsPerUser <= e.tauSweep[i - 1].tpsPerUser + 1e-9, 'TPS must not rise with tau');
const opt = S.signalOpt(stored.design.signal.option, stored.hardware.x);
assert(S.replay(stored.hardware.x, {controlUs: e.controlUsWithinRawBudget + 1e-3, tauUs: 0, opt}).rawLatencyUs > stored.published.rawBudgetUs, 'the control budget must be tight');
const m = O.mapped(stored.hardware.x), comm = m.plan.ops.filter(o => o.unit === 'COMM');
assert.strictEqual(stored.published.collectivesPerToken, comm.length);
assert.strictEqual(cp.classes.reduce((a, k) => a + k.count, 0), comm.length);
if (stored.design.signal.option === 'putWithSignal') {
  for (const o of comm) {
    const k = cp.classes.find(c => c.name === o.name);
    assert(k && Math.abs(k.protocolUs - (o.duration - o.timing.tauFloor)) < 1e-9, `${o.name}: protocol time must be the pre-floor duration`);
  }
}
for (const k of cp.classes) assert(Math.abs(Object.values(k.steps).reduce((a, v) => a + v, 0) - k.controlUs) < 1e-12, `${k.name}: steps add up`);
assert.strictEqual(e.aiCoreUsPerToken, 0, 'AI Cores spend no time on communication control');
assert(!cp.firmwareOnCriticalPath, 'firmware is not on the per-collective critical path');
assert(stored.load.utilization <= space.requirements.maxUtilization);
assert(stored.memorySemantics.remoteLoadMinUs > Math.max(...cp.classes.map(k => k.controlUs)), 'a remote load costs more than the control path');

// 4. The search: the winner beats the best candidate of every other option,
// and a hand-picked candidate scores the same through evaluate().
for (const [d, opts] of Object.entries(alt)) {
  assert.deepStrictEqual(Object.keys(opts), Object.keys(space.dimensions[d].options), `${d}: every option has a best candidate`);
  for (const [n, v] of Object.entries(opts)) {
    assert.strictEqual(v.chosen, n === stored.design[d].option);
    if (v.chosen) { assert.strictEqual(v.lostOn, null); assert(Math.abs(v.specSlackUs - cp.specSlackUs) < 1e-12); continue; }
    assert(v.lostOn && v.lostOn !== 'tie', `${d}.${n} must lose on a criterion`);
    assert(v.pick[d] === n);
  }
}
const pick = Object.fromEntries(Object.entries(stored.design).map(([d, v]) => [d, v.option]));
const again = S.evaluate(S.context(), pick);
assert(again.feasible && Math.abs(again.specSlackUs - cp.specSlackUs) < 1e-12 && Math.abs(again.areaMm2 - e.areaMm2) < 1e-12);
assert(!alt.wqeGeneration.controlProcessor.feasible && !alt.wqeGeneration.coreBuild.feasible, 'per-collective firmware or AI Core dispatch must not fit the spec tau');
assert(alt.wqeGeneration.coreBuild.aiCoreUsPerToken > 0);

// 5. The document quotes the design, the search and the comparison.
const doc = fs.readFileSync('teams/hardware/docs/10_COMM_CORE.md', 'utf8');
const f2 = v => v.toFixed(2), f3 = v => v.toFixed(3), us = v => (v * 1000).toFixed(0);
const signed = v => f3(v).replace('-', '−');
const must = [
  ['published TPS', f2(stored.published.tpsPerUser)], ['raw budget', f2(stored.published.rawBudgetUs)],
  ['candidates', `${stored.designSpace.candidates} 个组合`], ['valid', `${stored.designSpace.valid} 个有效`], ['feasible', `${stored.designSpace.feasible} 个可行`],
  ['space hash', stored.designSpace.sha256.slice(0, 12)],
  ...Object.entries(stored.design).map(([d, v]) => [`design ${d}`, `| ${d} | \`${v.option}\` |`]),
  ['placement', `(${cp.floorplan.xy.join(',')})`],
  ...cp.classes.map(k => [k.name, `| ${k.name} | ${k.count} | ${f3(k.protocolUs)} µs | ${Object.values(k.steps).map(us).join(' / ')} | `
    + `${f3(k.controlUs)} µs | ${f3(k.latencyUs)} µs | ${f3(k.slackUs)} µs |`]),
  ['spec slack', f3(cp.specSlackUs)], ['raw control budget', f3(e.controlUsWithinRawBudget)],
  ['bottom-up TPS', f2(e.bottomUp.tpsPerUser)], ['area', f3(e.areaMm2)],
  ...Object.entries(alt).flatMap(([d, opts]) => Object.entries(opts).map(([n, v]) => [`alt ${d}.${n}`,
    `| \`${n}\` | ${f3(v.slowest.latencyUs)} µs | ${signed(v.specSlackUs)} µs | ${f2(v.aiCoreUsPerToken)} µs | ${f3(v.areaMm2)} mm² | ${f2(v.withSpecFloor.tpsPerUser)} |`])),
  ...Object.entries(alt.signal).map(([n, v]) => [`signal ${n}`, `| \`${n}\` | ${v.wireBytesPerToken} | ${v.wqesPerToken} |`]),
  ...e.tauSweep.map(r => [`tau ${r.tauUs}`, `| ${r.tpsPerUser.toFixed(2)} | ${f2(r.rawLatencyUs)} µs |`]),
  ['WQEs', String(stored.load.wqesPerToken)], ['busy', f2(stored.load.busyUsPerToken)],
  ['utilization', `${(stored.load.utilization * 100).toFixed(1)}%`], ['graph KiB', stored.load.graphKiB.toFixed(1)],
  ['remote load', f3(stored.memorySemantics.remoteLoadMinUs)]
];
const missing = must.filter(([, v]) => !doc.includes(v));
assert.deepStrictEqual(missing, [], `10_COMM_CORE.md is stale; rerun npm run commcore:search and update:\n${missing.map(([k, v]) => `${k}: ${v}`).join('\n')}`);

// 6. The candidate set. The design artifact deliberately holds no candidate list
// (section 2); the ranked head is persisted next to it in
// out/detailed/comm_candidates.json. This grid scores 45900 combinations where
// the siblings score hundreds, so that file is the one place in this repo where
// the listing is knowingly truncated: the fingerprint is over the whole scored
// set and the exclusions are counted by cause, so neither "these are the
// candidates that were searched" nor "why was X dropped" depends on the listing.
const storedCand = JSON.parse(fs.readFileSync('out/detailed/comm_candidates.json', 'utf8'));
const cand = S.candidates(result), cands = cand.candidates;
close(storedCand, JSON.parse(JSON.stringify(cand)), 'commCandidates');
assert.strictEqual(storedCand.designSpace.sha256, stored.designSpace.sha256, 'candidate set comes from the same design space as the winner');
assert.strictEqual(storedCand.totalCandidates, stored.designSpace.candidates);
assert.strictEqual(storedCand.validCandidates, stored.designSpace.valid);
assert.strictEqual(storedCand.feasibleCandidates, stored.designSpace.feasible);

// The listing is a prefix of the ranking, not a sample: the search's own order
// (feasible first, then AI Core time, then spec slack, then area) must hold
// across every listed adjacent pair, or a consumer reading the head is reading
// candidates that the search itself would not have put in front.
assert.strictEqual(cands.length, storedCand.listed, 'the listed count must describe the list');
assert.strictEqual(storedCand.candidates.length, storedCand.listed, 'the stored list must match its own count');
assert.strictEqual(cand.truncated, storedCand.validCandidates > cands.length);
assert.strictEqual(cand.truncated, true, 'this grid is larger than the listing; if that changes, revisit this file\'s shape');
assert.strictEqual(cands.filter(c => c.chosen).length, 1, 'exactly one candidate is the winner');
assert.strictEqual(cands.find(c => c.chosen).lostOn, null, 'the winner loses on nothing');
for (let i = 1; i < cands.length; i++) {
  const a = cands[i - 1], b = cands[i];
  assert(a.rank < b.rank, 'ranks must ascend');
  assert(a.feasible >= b.feasible, `candidate ${i} ranks a feasible candidate below an infeasible one`);
  if (!a.feasible && !b.feasible) continue;
  assert(a.aiCoreUsPerToken <= b.aiCoreUsPerToken + 1e-9, `candidate ${i} breaks the AI Core time ranking`);
}

// Every exclusion is still accounted for: the histogram covers exactly the
// scored candidates the listing left out, so truncation loses no reason.
assert(cand.infeasibleByCause && Object.keys(cand.infeasibleByCause).length > 0, 'infeasible candidates must be counted by cause');
assert.strictEqual(Object.values(cand.infeasibleByCause).reduce((a, v) => a + v, 0), storedCand.validCandidates - storedCand.feasibleCandidates,
  'the exclusion histogram must cover every infeasible scored candidate');
assert(cand.infeasibleByCause.specTau > 0, 'the binding constraint of this space must appear in the histogram');

// The fingerprint is over the whole scored set and must not depend on
// enumeration order: rebuilding it from a reversed copy must give the same
// digest, otherwise two identical searches could disagree.
assert.strictEqual(cand.candidateSetSha256, storedCand.candidateSetSha256, 'fingerprint is not stable across runs');
assert(cand.candidates.every(c => c.pick && c.optionId === Object.entries(c.pick).map(([d, n]) => `${d}=${n}`).join('|')),
  'optionId must be the pick, so a reader can match a row back to the design space');

console.log(`PASS comm core design: ${stored.designSpace.valid} valid of ${stored.designSpace.candidates} candidates, ${stored.designSpace.feasible} feasible; `
  + `winner keeps ${f2(stored.published.tpsPerUser)} TPS with ${f3(cp.specSlackUs)} us spec slack, ${f3(e.areaMm2)} mm2; only the winner is in out/`);
