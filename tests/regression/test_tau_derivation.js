'use strict';
// Link-level tau derivation (HW-CH-01; teams/council/docs/24_TRACE_AND_CHARON_ADOPTION_PLAN.md).
// 1. Routes: hop, switch, relay and die-hop counts of each candidate, and its lane budget.
// 2. Anchor: the abstract wire at OPT.oneWayUs with oneShot / phase-ACK reproduces the model's
//    memoryTransport for every collective class, and the published TPS/usr; replays leave the model untouched.
// 3. Each derived tau is the sum of its terms; latency only ever costs TPS/usr.
// 4. The committed out/detailed/tau_derivation.json is what the generator writes now and is bound to its sources.
const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const O = require('../../integration/detailed/k3_rdma_final_tuning_model.js');
const R = require('../../integration/detailed/k3_sram_memory_rdma_model.js');
const T = require('../../integration/detailed/collective_topology.js');

const root = path.resolve(__dirname, '../..');
const FILE = 'out/detailed/tau_derivation.json';
const near = (a, b, tol, what) => assert(Math.abs(a - b) <= tol, `${what}: ${a} vs ${b}`);
const sha256 = data => crypto.createHash('sha256').update(data).digest('hex');
const readJson = f => JSON.parse(fs.readFileSync(path.join(root, f), 'utf8'));
const spec = readJson(T.BASELINE_FILE), cand = readJson(T.CANDIDATES_FILE);
const x = spec.tpsDesign.hardware.x;
const nominal = t => ({...Object.fromEntries(cand.parameters.map(q => [q.key, q.nominal])), cableM: t.cableM ? t.cableM.nominal : 0, spineCableM: t.spineCableM ? t.spineCableM.nominal : 0});
const byKey = Object.fromEntries(cand.topologies.map(t => [t.key, t]));

// 1. Routes.
assert.strictEqual(cand.status, 'ASSUMPTION');
for (const q of cand.parameters) assert(q.evidence === 'ASSUMPTION' && q.low <= q.nominal && q.nominal <= q.high, `parameter ${q.key}`);
const worst = key => {
  const t = byKey[key], topo = T.topology(t, cand.card, nominal(t)), w = {links: 0, switches: 0, relays: 0, dieHops: 0};
  assert(topo.lanesUsed <= cand.card.dies * cand.card.lanesPerDie, `${key} lane budget`);
  for (let src = 0; src < 32; src++) for (let dst = 0; dst < 32; dst++) if (src !== dst) for (const die of cand.card.nicDies) {
    const r = topo.route(src, dst, die);
    for (const k of Object.keys(w)) w[k] = Math.max(w[k], k === 'links' ? r.links.length : r[k]);
  }
  return w;
};
assert.deepStrictEqual(worst('fullMesh'), {links: 1, switches: 0, relays: 0, dieHops: 4});
assert.deepStrictEqual(worst('singleSwitch'), {links: 2, switches: 1, relays: 0, dieHops: 0});
assert.deepStrictEqual(worst('leafSpine'), {links: 4, switches: 3, relays: 0, dieHops: 0});
const wt = worst('torus4x8'), wr = worst('ring32');
assert.deepStrictEqual([wt.links, wt.switches, wt.relays], [6, 0, 5], 'torus 4x8: 2 + 4 hops');
assert.deepStrictEqual([wr.links, wr.relays], [16, 15], 'ring of 32: 16 hops');
const order = T.ringOrder(byKey.torus4x8, 32), torus = T.topology(byKey.torus4x8, cand.card, nominal(byKey.torus4x8));
assert.deepStrictEqual([...order].sort((a, b) => a - b), Array.from({length: 32}, (_, i) => i), 'ring order is a permutation');
for (let i = 0; i < 32; i++) assert.strictEqual(torus.route(order[i], order[(i + 1) % 32], 0).links.length, 1, 'ring order steps one torus hop');
const P = nominal(byKey.singleSwitch);
near(T.pathLatency({links: [{cableM: 2}, {cableM: 2}], switches: 1, relays: 0, dieHops: 0}, P, cand.propagationUsPerM),
  P.macUs + 2 * (P.phyUs + P.fecUs + 2 * cand.propagationUsPerM) + P.switchUs, 1e-12, 'path latency');

// 2. Anchor, through the module's own replay; R.collective and OPT.tauUs come back unchanged.
const control = new Map(readJson(T.COMM_CORE_FILE).controlPath.classes.map(k => [k.name, k.controlUs]));
const ctx = P => ({P, card: cand.card, prop: cand.propagationUsPerM, controlUs: n => control.get(n)});
const wireP = {...nominal({}), controlScale: 0, ucieHopUs: require('../../integration/detailed/k3_architecture_search.js').TECH.ucieHopUs};
const wire = {topologyDef: {kind: 'published'}, algorithm: 'oneShot', ackDrain: 'phase', topo: {key: 'published', abstract: true, oneWayUs: O.OPT.oneWayUs}, P: wireP};
const orig = R.collective, tau = O.OPT.tauUs;
const anchor = T.replay(x, wire, ctx(wireP), O.OPT.tauUs);
assert.strictEqual(R.collective, orig, 'replay restores R.collective');
assert.strictEqual(O.OPT.tauUs, tau, 'replay restores OPT.tauUs');
near(anchor.tpsPerUser, spec.tpsDesign.point.tpsPerUser, 1e-9, 'anchor TPS/usr');
const m = O.mapped(x), model = new Map();
for (const o of m.plan.ops) if (o.unit === 'COMM') model.set(o.name, o.timing);
assert.strictEqual(anchor.classes.length, 5, 'five collective classes');
for (const k of anchor.classes) {
  const t = model.get(k.name);
  assert.strictEqual(k.timing.memoryTransport, t.memoryTransport, `anchor memoryTransport of ${k.name}`);
  assert.strictEqual(k.timing.tpReduce, t.tpReduce, `anchor tpReduce of ${k.name}`);
  near(k.timing.cardLocal, t.cardLocal, 1e-12, `anchor cardLocal of ${k.name}`);
  assert.strictEqual(k.timing.portTail, t.portTail, `anchor portTail of ${k.name}`);
  near(k.tauUs + t.tauFloor, tau, 1e-12, `anchor tau of ${k.name} under the floor`);
}

// 3. Terms and monotonicity, on fresh replays.
const t = byKey.fullMesh, Pm = nominal(t);
const cell = (algorithm, ackDrain, Pc) => ({topologyDef: t, algorithm, ackDrain, topo: T.topology(t, cand.card, Pc), P: Pc});
const nom = T.replay(x, cell('oneShot', 'phase', Pm), ctx(Pm), 0);
for (const k of nom.classes) near(Object.values(k.timing).reduce((a, v) => a + v, 0), k.tauUs, 1e-12, `terms of ${k.name}`);
const slow = {...Pm, fecUs: Pm.fecUs + 0.05};
assert(T.replay(x, cell('oneShot', 'phase', slow), ctx(slow), 0).tpsPerUser < nom.tpsPerUser, 'a slower link costs TPS/usr');
const deferred = T.replay(x, cell('oneShot', 'deferred', Pm), ctx(Pm), 0);
for (const [a, b] of nom.classes.map((k, i) => [k, deferred.classes[i]])) assert(b.timing.memoryTransport < a.timing.memoryTransport, `deferred ACK is shorter for ${a.name}`);
const hd = T.steps({op: 'scatter', bytes: 1024}, 'halvingDoubling', 1, order), ag = T.steps({op: 'gather', bytes: 1024}, 'halvingDoubling', 1, order);
assert.deepStrictEqual(hd.map(s => s.bytes), [512, 256, 128, 64, 32], 'reduce-scatter halves');
assert.deepStrictEqual(ag.map(s => s.bytes), [32, 64, 128, 256, 512], 'all-gather doubles');
assert.strictEqual(T.steps({op: 'gather', bytes: 1024}, 'ring', 1, order).length, 31, 'ring: 31 steps');

// 4. Committed report.
const text = fs.readFileSync(path.join(root, FILE), 'utf8');
assert.strictEqual(sha256(`${JSON.stringify(T.build(), null, 2)}\n`), sha256(text), `${FILE} is stale: rerun npm run tau:derivation`);
const report = JSON.parse(text);
assert.strictEqual(report.format, T.FORMAT);
assert.strictEqual(report.evidenceClass, 'MODEL');
assert.deepStrictEqual(Object.keys(report.provenance.sources), T.SOURCE_FILES);
for (const [f, h] of Object.entries(report.provenance.sources)) assert.strictEqual(h, sha256(fs.readFileSync(path.join(root, f))), `source hash of ${f}`);
for (const [k, f] of [['candidatesSha256', T.CANDIDATES_FILE], ['commCoreSha256', T.COMM_CORE_FILE], ['baselineSha256', T.BASELINE_FILE]]) assert.strictEqual(report.provenance[k], sha256(fs.readFileSync(path.join(root, f))), k);
near(report.published.tpsPerUser, spec.tpsDesign.point.tpsPerUser, 1e-9, 'published TPS/usr');
assert.strictEqual(report.published.specTauUs, 1.15, 'OPT.tauUs stays the spec tau (ADR-0004)');
assert.strictEqual(report.cells.length, cand.topologies.length * T.ALGORITHMS.length * T.ACK_DRAIN.length, 'every cell');
for (const c of report.cells) {
  const {optimistic, bottomUp, pessimistic} = c.tpsPerUser;
  assert(optimistic >= bottomUp - 1e-9 && bottomUp >= pessimistic - 1e-9, `${c.topology}/${c.algorithm}/${c.ackDrain}: corners bracket nominal`);
  for (const k of c.classes) near(k.memoryTransportUs + k.tpReduceUs + k.cardLocalUs + k.portTailUs + k.controlPathUs, k.tauUs, 1e-12, `${c.topology} ${k.name} terms`);
}
for (const c of report.conditions) for (const r of c.tornado) {
  if (r.verdict !== 'straddles') continue;
  assert(r.low.value <= r.breakEven && r.breakEven <= r.high.value, `${c.topology} ${r.param} break-even in range`);
}

const best = report.conditions.filter(c => c.ackDrain === 'phase').sort((a, b) => b.tpsPerUser.bottomUp - a.tpsPerUser.bottomUp)[0];
console.log(`PASS tau derivation: anchor reproduces 5 classes, ${report.cells.length} cells; best under phase ACK ${best.topology}/${best.bestAlgorithm} max tau ${best.maxTauUs.toFixed(3)} us, ${best.tpsPerUser.bottomUp.toFixed(2)} TPS/usr`);
