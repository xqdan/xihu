'use strict';
// Comm Core control-path budget (teams/hardware/docs/10_COMM_CORE.md): the
// stored artifact must equal a fresh rebuild, the replay must reproduce the
// published point, the per-class protocol time must match the detailed model,
// and the document must quote the artifact.
const assert = require('assert');
const fs = require('fs');
const C = require('../../integration/detailed/comm_core_budget.js');
const A = require('../../integration/detailed/k3_architecture_search.js');
const O = require('../../integration/detailed/k3_rdma_final_tuning_model.js');
const R = require('../../integration/detailed/k3_sram_memory_rdma_model.js');

const stored = JSON.parse(fs.readFileSync('out/detailed/comm_core_budget.json', 'utf8'));

// 1. The artifact replays exactly and TECH/OPT/R.collective are left untouched.
const techBefore = JSON.stringify(A.TECH), optBefore = JSON.stringify(O.OPT), collective = R.collective;
const fresh = JSON.parse(JSON.stringify(C.build()));
assert.strictEqual(JSON.stringify(A.TECH), techBefore, 'build must not change A.TECH');
assert.strictEqual(JSON.stringify(O.OPT), optBefore, 'build must restore O.OPT');
assert.strictEqual(R.collective, collective, 'build must restore R.collective');
const close = (a, b, path) => {
  if (typeof a === 'number' && typeof b === 'number') return assert(Math.abs(a - b) <= 1e-6 * Math.max(1, Math.abs(b)), `${path}: ${a} vs ${b}`);
  if (a && typeof a === 'object') {
    assert.deepStrictEqual(Object.keys(a).sort(), Object.keys(b).sort(), `${path}: keys`);
    for (const k of Object.keys(a)) close(a[k], b[k], `${path}.${k}`);
    return;
  }
  assert.strictEqual(a, b, path);
};
close(stored, fresh, 'commCoreBudget');
assert(!/FROZEN/.test(stored.status.replace('not FROZEN', '')), 'the budget is a MODEL result, not FROZEN');

// 2. The replay reproduces the published point and the protocol model.
const x = stored.hardware.x, m = O.mapped(x), comm = m.plan.ops.filter(o => o.unit === 'COMM');
const spec = stored.tauSweep.find(r => r.tauUs === O.OPT.tauUs);
assert(spec && Math.abs(spec.tpsPerUser - stored.published.tpsPerUser) < 1e-6, 'tau = spec must replay the published TPS');
assert(Math.abs(stored.schemes.commCore.withSpecFloor.tpsPerUser - stored.published.tpsPerUser) < 1e-6,
  'the Comm Core path fits under the spec tau floor, so the published point is unchanged');
assert.strictEqual(stored.published.collectivesPerToken, comm.length);
assert.strictEqual(stored.collectives.reduce((a, k) => a + k.count, 0), comm.length);
for (const o of comm) {
  const k = stored.collectives.find(c => c.name === o.name);
  assert(k && Math.abs(k.protocolUs - (o.duration - o.timing.tauFloor)) < 1e-9, `${o.name}: protocol time must be the pre-floor duration`);
}
const zero = C.replay(x, {tauUs: 0});
assert(Math.abs(zero.rawLatencyUs - C.replay(x, {controlUs: 0, tauUs: 0}).rawLatencyUs) < 1e-12, 'zero control path must not change the replay');

// 3. Invariants.
for (let i = 1; i < stored.tauSweep.length; i++) {
  assert(stored.tauSweep[i].tpsPerUser <= stored.tauSweep[i - 1].tpsPerUser + 1e-9, 'TPS must not rise with tau');
}
const s = stored.schemes;
assert(s.commCore.controlUs < s.coreDoorbell.controlUs && s.coreDoorbell.controlUs < s.firmwareDispatch.controlUs, 'control path ordering');
assert(s.commCore.keepsSpecTau && s.commCore.meetsBudget, 'the chosen scheme must keep the spec tau and the raw budget');
assert(!s.firmwareDispatch.meetsBudget, 'per-collective firmware dispatch must not fit the raw budget');
const b = stored.budget;
const at = C.replay(x, {controlUs: b.controlUsWithinRawBudget, tauUs: 0});
assert(at.rawLatencyUs <= stored.published.rawBudgetUs + 1e-9, 'the control budget must keep raw within the budget');
assert(C.replay(x, {controlUs: b.controlUsWithinRawBudget + 1e-3, tauUs: 0}).rawLatencyUs > stored.published.rawBudgetUs, 'the control budget must be tight');
for (const v of Object.values(s)) assert.strictEqual(v.meetsBudget, v.marginUs >= 0, 'margin sign must match meetsBudget');
assert.strictEqual(stored.decision.scheme, 'commCore');

// Memory semantics: put-with-signal is the published protocol, and the other
// signal deliveries can only cost more.
const sig = stored.memorySemantics.signaling, put = sig.putWithSignal;
assert.strictEqual(stored.memorySemantics.chosen, 'putWithSignal');
assert.deepStrictEqual(put.opt, {}, 'put-with-signal must be the protocol as published');
assert(Math.abs(put.bottomUp.rawLatencyUs - s.commCore.bottomUp.rawLatencyUs) < 1e-9, 'put-with-signal must replay the Comm Core scheme');
assert(Math.abs(put.controlUsWithinRawBudget - b.controlUsWithinRawBudget) < 1e-12);
for (const [n, v] of Object.entries(sig)) {
  assert(v.keepsSpecTau && v.meetsBudget, `${n}: signal delivery must keep the spec tau and the raw budget`);
  if (n === 'putWithSignal') continue;
  assert(v.slowestProtocolUs > put.slowestProtocolUs && v.bottomUp.commUs > put.bottomUp.commUs, `${n} must cost more than put-with-signal`);
  assert(v.controlUsWithinRawBudget < put.controlUsWithinRawBudget, `${n} must leave less control budget`);
}
assert(sig.separateSignal.wqesPerToken === 2 * put.wqesPerToken && sig.separateSignal.wireBytesPerToken > put.wireBytesPerToken);
assert(stored.memorySemantics.remoteLoadMinUs > s.commCore.controlUs, 'a remote load must cost more than the Comm Core control path');

// 4. The document quotes the artifact.
const doc = fs.readFileSync('teams/hardware/docs/10_COMM_CORE.md', 'utf8');
const f2 = v => v.toFixed(2), f3 = v => v.toFixed(3);
const must = [
  ['published TPS', f2(stored.published.tpsPerUser)], ['raw budget', f2(stored.published.rawBudgetUs)],
  ...stored.collectives.map(k => [k.name, `| ${k.name} | ${k.count} | ${f2(k.protocolUs)} µs | ${k.requests} | ${k.activeNICs} |`]),
  ['spec slack', f3(b.controlUsWithinSpecTau)], ['raw control budget', f3(b.controlUsWithinRawBudget)],
  ['rx firmware spec', b.rxFirmwareCyclesPerMessageMax.withinSpecTau.toFixed(1)],
  ['rx firmware raw', b.rxFirmwareCyclesPerMessageMax.withinRawBudget.toFixed(1)],
  ...Object.entries(s).flatMap(([n, v]) => [[`${n} control`, f3(v.controlUs)], [`${n} latency`, f2(v.maxLatencyUs)],
    [`${n} bottom-up`, f2(v.bottomUp.tpsPerUser)], [`${n} spec floor`, f2(v.withSpecFloor.tpsPerUser)], [`${n} margin`, f3(v.marginUs).replace('-', '−')]]),
  ['AI Core doorbell time', f2(s.coreDoorbell.aiCoreUsPerToken)],
  ...stored.tauSweep.map(r => [`tau ${r.tauUs}`, `| ${r.tpsPerUser.toFixed(2)} | ${f2(r.rawLatencyUs)} µs |`]),
  ['WQEs', String(stored.commCoreLoad.wqesPerToken)], ['busy', f2(stored.commCoreLoad.busyUsPerToken)],
  ['utilization', `${(stored.commCoreLoad.utilization * 100).toFixed(1)}%`], ['template KiB', stored.commCoreLoad.templateSramKiB.toFixed(1)],
  ['template mm2', f3(stored.commCoreLoad.templateSramMm2)],
  ...Object.entries(sig).map(([n, v]) => [`signal ${n}`, `| ${f3(v.slowestProtocolUs)} µs | ${f3(v.maxLatencyUs)} µs | ${f3(O.OPT.tauUs - v.maxLatencyUs)} µs | `
    + `${f3(v.controlUsWithinRawBudget)} µs | ${f2(v.bottomUp.commUs)} µs | ${v.wireBytesPerToken} | ${v.wqesPerToken} |`]),
  ['remote load', f3(stored.memorySemantics.remoteLoadMinUs)]
];
const missing = must.filter(([, v]) => !doc.includes(v));
assert.deepStrictEqual(missing, [], `10_COMM_CORE.md is stale; rerun npm run commcore:budget and update:\n${missing.map(([k, v]) => `${k}: ${v}`).join('\n')}`);

console.log(`PASS comm core budget: artifact replays, tau ${O.OPT.tauUs} reproduces ${f2(stored.published.tpsPerUser)} TPS; `
  + `control path ${f3(s.commCore.controlUs)} us of ${f3(b.controlUsWithinRawBudget)} us budget (firmware dispatch ${f3(s.firmwareDispatch.controlUs)} us does not fit)`);
