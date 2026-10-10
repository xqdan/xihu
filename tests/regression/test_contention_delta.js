'use strict';
// Foreground overlap contention (ARCH-CH-01; teams/council/docs/24_TRACE_AND_CHARON_ADOPTION_PLAN.md).
// 1. The default is the published model: no contention fields, the same numbers as {contention:'none'}.
// 2. 'proportional' conserves time (raw = compute - tmaHidden + comm + wait - overlap + contention) and,
//    on a plan where the overlapping pair does exceed the caps, slows it and books the loss.
// 3. The committed out/detailed/contention_delta.json is what the generator writes now and is bound to its sources.
const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const O = require('../../integration/detailed/k3_rdma_final_tuning_model.js');
const {simulate, CONTENTION} = require('../../integration/detailed/k3_operator_sram_sim.js');
const D = require('../../integration/detailed/contention_delta.js');

const root = path.resolve(__dirname, '../..');
const FILE = 'out/detailed/contention_delta.json';
const near = (a, b, tol, what) => assert(Math.abs(a - b) <= tol, `${what}: ${a} vs ${b}`);
const sha256 = data => crypto.createHash('sha256').update(data).digest('hex');
const spec = JSON.parse(fs.readFileSync(path.join(root, D.BASELINE_FILE), 'utf8'));
const x = spec.tpsDesign.hardware.x;
const conserved = (r, what) => near(r.rawUs, r.computeUs - r.tmaHiddenUs + r.commUs + r.waitUs - r.overlapUs + (r.contentionUs || 0), 1e-5, `${what} conservation`);

// 1. Default inert.
assert.deepStrictEqual(CONTENTION, ['none', 'proportional']);
assert.throws(() => simulate(O.mapped(x).plan, 1, {contention: 'calibrated'}), /unknown contention mode/);
const m = O.mapped(x);
const plain = simulate(m.plan, m.window), none = simulate(m.plan, m.window, {contention: 'none'});
assert(!('contentionUs' in plain) && !('contention' in plain), 'default reports no contention fields');
for (const k of Object.keys(plain)) if (typeof plain[k] === 'number') assert.strictEqual(none[k], plain[k], `contention 'none' changed ${k}`);
near(plain.rawUs, spec.tpsDesign.point.rawLatencyUs, 1e-6, 'published raw');
const ev = D.evaluate(x, 'none');
assert(!('contention' in ev.services), "contention 'none' books no contention service");

// 2. Proportional: conserved; zero at the published point; a real cost where the pair exceeds the caps.
const prop = simulate(m.plan, m.window, {contention: 'proportional'});
conserved(prop, 'published proportional');
near(prop.rawUs, plain.rawUs, 1e-6, 'published point under proportional sharing');
assert(Object.values(prop.contention.peakForegroundLoad).every(v => v.load < 1), 'published overlap stays under every cap');
const evp = D.evaluate(x, 'proportional');
near(Object.values(evp.services).reduce((a, v) => a + v, 0) + evp.waitUs, evp.rawUs, 1e-6, 'services + wait = raw with contention booked');
const c = m.plan.c, R = c.sramReadTBs * 1e6, F = c.fabricTBs * 1e6;
const heavy = o => o.overlapComm || o.name === 'Wdown + Router all-gather';
const plan = {...m.plan, ops: m.plan.ops.map(o => (heavy(o) ? {...o, read: 0.8 * R * o.duration, linkBytes: 0.8 * F * o.duration} : o))};
const ha = simulate(plan, m.window), hb = simulate(plan, m.window, {contention: 'proportional', trace: true});
conserved(ha, 'heavy none');
conserved(hb, 'heavy proportional');
assert(hb.contentionUs > 1, `heavy pair is slowed (contention ${hb.contentionUs})`);
assert(hb.rawUs > ha.rawUs + 1, 'heavy pair costs wall time');
assert(hb.rawUs - ha.rawUs <= hb.contentionUs + 1e-6, 'raw grows by at most the foreground time lost');
// Above 1.6 where a TMA-filled op's remaining read is drawn over its shorter body.
assert(hb.contention.peakForegroundLoad.read.load >= 1.6 - 1e-9, 'heavy read load is over the cap');
const sumLayers = hb.layerStats.reduce((a, l) => a + l.contention, 0);
near(sumLayers, hb.contentionUs, 1e-6, 'per-layer contention');
for (const e of hb.events) if (e.type === 'op') assert(e.end >= e.start, `op ${e.index} ends before it starts`);

// 3. Committed report.
const text = fs.readFileSync(path.join(root, FILE), 'utf8');
assert.strictEqual(sha256(`${JSON.stringify(D.build(), null, 2)}\n`), sha256(text), `${FILE} is stale: rerun npm run contention:delta`);
const report = JSON.parse(text);
assert.strictEqual(report.format, D.FORMAT);
assert.strictEqual(report.evidenceClass, 'MODEL');
assert.deepStrictEqual(Object.keys(report.provenance.sources), D.SOURCE_FILES);
for (const [f, h] of Object.entries(report.provenance.sources)) assert.strictEqual(h, sha256(fs.readFileSync(path.join(root, f))), `source hash of ${f}`);
assert.strictEqual(report.provenance.couplingSha256, sha256(fs.readFileSync(path.join(root, D.COUPLING_FILE))));
for (const p of report.points.filter(q => q.feasible)) {
  near(p.proportional.rawUs - p.none.rawUs, p.delta.rawUs, 1e-9, `${p.point} delta`);
  for (const r of [p.none, p.proportional]) near(r.rawUs, r.computeUs - r.tmaHiddenUs + r.commUs + r.waitUs - r.overlapUs + r.contentionUs, 1e-5, `${p.point} ledger`);
}

console.log(`PASS contention: default inert, published delta ${report.summary.maxAbsRawDeltaUs.toExponential(2)} us over ${report.summary.feasible} points (peak foreground load ${report.summary.maxPeakForegroundLoad.toFixed(2)}), synthetic heavy pair +${(hb.rawUs - ha.rawUs).toFixed(2)} us`);
