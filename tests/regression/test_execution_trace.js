'use strict';
// Execution trace of the published point (VV-TR-01; contract docs/architecture/contracts/EXECUTION_TRACE.md).
// 1. Trace mode is inert: simulate() with {trace:true} gives the same numbers as without.
// 2. The committed trace is what the generator writes now (sha256), and its provenance hashes are the files on disk.
// 3. Conservation: the tracks reconcile with the simulator's time ledger, which is the published ledger.
// 4. Binding: every slice carries its evidence class; every operator appears exactly once, on its own track.
// 5. Shape: no two slices on a track overlap; protocol slices nest inside their collective and sum to it.
// 6. Diff (ARCH-TR-02): per-operator advance deltas sum to the rawUs delta, which is the published ablation.
const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const O = require('../../integration/detailed/k3_rdma_final_tuning_model.js');
const {simulate} = require('../../integration/detailed/k3_operator_sram_sim.js');
const E = require('../../integration/detailed/execution_trace.js');

const root = path.resolve(__dirname, '../..');
const FILE = 'out/trace/k3_published_point.trace.json';
const near = (a, b, tol, what) => assert(Math.abs(a - b) <= tol, `${what}: ${a} vs ${b}`);
const sha256 = data => crypto.createHash('sha256').update(data).digest('hex');
const spec = JSON.parse(fs.readFileSync(path.join(root, E.BASELINE_FILE), 'utf8'));
const x = spec.tpsDesign.hardware.x;

// 1. Trace mode is inert.
const m = O.mapped(x);
const plain = simulate(m.plan, m.window), traced = simulate(m.plan, m.window, {trace: true});
for (const k of Object.keys(plain)) if (typeof plain[k] === 'number') assert.strictEqual(traced[k], plain[k], `trace mode changed ${k}`);
assert.strictEqual(plain.events.length, 0, 'no events without trace');

// 2. Reproducible and bound to its sources.
const text = fs.readFileSync(path.join(root, FILE), 'utf8');
const rebuilt = E.serialize(E.buildPublished());
assert.strictEqual(sha256(rebuilt), sha256(text), `${FILE} is stale: rerun npm run trace:published`);
const trace = JSON.parse(text), head = trace.k3Trace;
assert.strictEqual(head.format, E.FORMAT);
assert.strictEqual(head.evidenceClass, 'MODEL');
assert.strictEqual(trace.otherData.evidenceClass, 'MODEL');
assert.strictEqual(head.provenance.baselineSha256, sha256(fs.readFileSync(path.join(root, E.BASELINE_FILE))));
assert.deepStrictEqual(Object.keys(head.provenance.sources), E.SOURCE_FILES);
for (const [f, h] of Object.entries(head.provenance.sources)) assert.strictEqual(h, sha256(fs.readFileSync(path.join(root, f))), `source hash of ${f}`);
assert.deepStrictEqual(head.provenance.x, x);

// 3. Conservation, on the committed events alone.
const L = head.ledger, P = spec.tpsDesign.ledger;
near(L.rawUs, spec.tpsDesign.point.rawLatencyUs, 1e-9, 'published raw');
near(L.tpsPerUser, spec.tpsDesign.point.tpsPerUser, 1e-9, 'published TPS/usr');
for (const [a, b] of [['computeUs', 'computeUs'], ['tmaHiddenUs', 'tmaHiddenUs'], ['commUs', 'commUs'], ['waitUs', 'dmaWaitUs'], ['overlapUs', 'overlapUs'], ['tmaExposedUs', 'tmaExposedUs']]) near(L[a], P[b], 1e-9, `ledger ${a}`);
near(L.computeUs - L.tmaHiddenUs + L.commUs + L.waitUs - L.overlapUs, L.rawUs, 1e-6, 'ledger identity');
const rec = E.reconcile(trace.traceEvents);
E.checkReconciliation(rec, L);
near(rec.computeBodyUs + rec.tmaExposedUs, rec.computeSlotUs, 1e-6, 'compute slot = kernel bodies + exposed fills');
near(rec.commUs, 393 * 1.15, 1e-6, '393 collectives at the tau floor');

// 4. Binding.
const ev = trace.traceEvents, xs = ev.filter(e => e.ph === 'X');
const tid = k => E.TRACKS[k].tid;
for (const e of xs) {
  assert.strictEqual(e.args.evidence, 'MODEL', `slice without evidence class: ${e.name}`);
  if (e.cat !== 'layer' && !(e.cat === 'wait' && e.args.operator_id === null)) {
    assert(Number.isInteger(e.args.operator_id), `slice not bound to an operator: ${e.name}`);
    assert.strictEqual(e.args.layer, m.plan.ops[e.args.operator_id].layer, `slice layer of ${e.name}`);
  }
}
const seen = new Array(m.plan.ops.length).fill(0);
for (const e of xs.filter(e => e.cat === 'op' || e.cat === 'comm')) {
  const o = m.plan.ops[e.args.operator_id];
  seen[o.id]++;
  assert.strictEqual(e.name, o.name);
  assert.strictEqual(e.tid, o.unit === 'COMM' ? tid('comm') : tid('compute'), `${o.name} on the wrong track`);
  assert.strictEqual(e.args.unit, o.unit);
  assert(e.args.timing && typeof e.args.timing === 'object', `${o.name} carries no timing breakdown`);
}
assert(seen.every(n => n === 1), 'every operator appears exactly once');
assert.strictEqual(xs.filter(e => e.cat === 'layer').length, 93, 'one slice per layer');
assert.strictEqual(xs.filter(e => e.cat === 'tma').length, m.plan.ops.filter(o => o.tma).length, 'one fill per TMA-filled operator');
const counters = ev.filter(e => e.ph === 'C');
assert(counters.length > 0 && counters.every(e => e.name === E.COUNTER && e.args.allocated >= 0 && e.args.live >= 0), 'SRAM counter samples');
assert(counters.every((e, i) => i === 0 || e.ts > counters[i - 1].ts), 'one counter sample per instant, in time order');

// 5. Shape.
const tracks = new Map();
for (const e of xs) {
  const k = `${e.tid}/${e.cat === 'protocol' ? 'protocol' : 'top'}`;
  if (!tracks.has(k)) tracks.set(k, []);
  tracks.get(k).push(e);
}
for (const [k, list] of tracks) {
  list.sort((a, b) => a.ts - b.ts);
  for (let i = 1; i < list.length; i++) assert(list[i - 1].ts + list[i - 1].dur <= list[i].ts + 1e-9, `overlapping slices on track ${k}: ${list[i - 1].name} / ${list[i].name}`);
  assert(list.every(e => e.dur >= 0 && e.ts >= 0 && e.ts + e.dur <= L.rawUs + 1e-9), `slice outside the step on track ${k}`);
}
assert.strictEqual(head.protocol.length, 5, 'one protocol sample per collective class');
for (const p of head.protocol) {
  const parent = xs.find(e => e.cat === 'comm' && e.args.operator_id === p.sampledOperatorId);
  const kids = xs.filter(e => e.cat === 'protocol' && e.args.operator_id === p.sampledOperatorId);
  assert(kids.length >= 2, `${p.collective}: nested protocol slices`);
  for (const c of kids) assert(c.ts >= parent.ts - 1e-12 && c.ts + c.dur <= parent.ts + parent.dur, `${p.collective}: ${c.name} outside its collective`);
  near(kids.reduce((a, c) => a + c.dur, 0), parent.dur, 1e-9, `${p.collective}: protocol terms sum to the collective`);
  near(p.phaseUs.reduce((a, b) => a + b, 0), p.memoryTransportUs, 1e-12, `${p.collective}: phases sum to memory transport`);
  near(p.protocolUs + p.tauFloorUs, p.durationUs, 1e-9, `${p.collective}: protocol + tau floor`);
  const peers = ev.filter(e => e.cat === 'rdma-peer' && e.args && e.args.operator_id === p.sampledOperatorId);
  assert.strictEqual(peers.length, 31 * p.phases, `${p.collective}: 31 peers per phase`);
}
const asyncOpen = new Map();
for (const e of ev.filter(e => e.cat === 'rdma-peer')) {
  const k = `${e.id}|${e.name}`;
  if (e.ph === 'b') asyncOpen.set(k, e.ts);
  else { assert(asyncOpen.has(k) && asyncOpen.get(k) <= e.ts + 1e-12, `async ${k} ends before it begins`); asyncOpen.delete(k); }
}
assert.strictEqual(asyncOpen.size, 0, 'every per-peer async slice is closed');

// 6. Diff: tmaLane switched back alone reproduces its published ablation, and advances attribute it exactly.
const mech = spec.tpsDesign.software.mechanisms.find(a => a.key === 'tmaLane');
const d = E.diff(x, E.mechanismPatch('tmaLane'), 'tmaLane');
near(d.variant.rawUs, mech.ablation.rawLatencyUs, 1e-9, 'tmaLane ablation raw');
near(d.base.rawUs, L.rawUs, 1e-12, 'diff base is the published point');
near(d.operators.reduce((a, o) => a + o.advanceDeltaUs, 0), d.delta.rawUs, 1e-6, 'operator advance deltas');
near(d.byLayer.reduce((a, l) => a + l.advanceDeltaUs, 0), d.delta.rawUs, 1e-6, 'layer advance deltas');
assert.deepStrictEqual(d.unmatched, {base: 0, variant: 0}, 'tmaLane does not change the operator list');
assert.deepStrictEqual({...O.OPT}, d.runs.a.opt, 'diff restores OPT');
const pv = E.diff(x, E.mechanismPatch('pvMerge'), 'pvMerge');
near(pv.operators.reduce((a, o) => a + o.advanceDeltaUs, 0), pv.delta.rawUs, 1e-6, 'pvMerge advance deltas');

console.log(`PASS execution trace: ${xs.length} slices reconcile with the ledger (raw ${L.rawUs.toFixed(2)} us), 5 protocol samples, tmaLane diff +${d.delta.rawUs.toFixed(2)} us`);
