'use strict';
// In-card die topology (B-004; ADR-0016 basis 2026-10-10): the 8 dies sit on one bidirectional ring,
// and every in-card hop count and cut bandwidth of the model is read from A.dieRing.
// 1. The ring itself: cut, diameter, hop counts and distances.
// 2. The model terms that read it: the cut bandwidth, the collective's in-card stage (cardLocal),
//    the pvMerge 'tile' gather and the scale-out die hops of the tau derivation.
// 3. At the published point every collective's protocol time stays under tau = 1.15 us, so the
//    ring basis moves time from tauFloor to cardLocal and leaves TPS/usr at its published value.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const A = require('../../integration/detailed/k3_architecture_search.js');
const R = require('../../integration/detailed/k3_sram_memory_rdma_model.js');
const O = require('../../integration/detailed/k3_rdma_final_tuning_model.js');
const P = require('../../integration/detailed/k3_physical_basis.js');

const root = path.resolve(__dirname, '../..');
const near = (a, b, tol, what) => assert(Math.abs(a - b) <= tol, `${what}: ${a} vs ${b}`);
const spec = JSON.parse(fs.readFileSync(path.join(root, 'teams/hardware/inputs/k3_mc_baseline.json'), 'utf8'));
const x = spec.tpsDesign.hardware.x;

// 1. Ring.
const ring = A.dieRing();
assert.deepStrictEqual({dies: ring.dies, cutLinks: ring.cutLinks, diameter: ring.diameter, allReduceHops: ring.allReduceHops, gatherHops: ring.gatherHops},
  {dies: A.LIMITS.dies, cutLinks: 2, diameter: 4, allReduceHops: 8, gatherHops: 4});
const d0 = Array.from({length: 8}, (_, k) => ring.dist(0, k));
assert.deepStrictEqual(d0, [0, 1, 2, 3, 4, 3, 2, 1]);
near(d0.reduce((a, b) => a + b, 0) / 8, ring.meanHops, 0, 'mean distance');
assert.strictEqual(ring.meanHops, 2, 'the DMA startup budget, 2 hops');
for (let a = 0; a < 8; a++) for (let b = 0; b < 8; b++) assert.strictEqual(ring.dist(a, b), ring.dist(b, a));
assert.strictEqual(A.dieRing(4).diameter, 2);

// 2. Model terms.
const p = P.resize(A.physical(x));
near(p.dieCutGB, 2 * p.uciePortGB, 1e-12, 'ring cut: two links');
for (const name of ['Attention output all-reduce', 'Wdown + Router all-gather']) {
  const q = R.collective(name, 65536, p, x, {...R.MEM, ...O.OPT});
  const hopFree = q.logicalPayload * 2 / (p.dieCutGB * 1000) + q.logicalPayload / 4 * 2 / (8 * p.reduceTOP * 1e6) + p.meshSide * A.TECH.routerCycles / (x.ghz * 1000);
  near(q.timing.cardLocal - hopFree, ring.allReduceHops * A.TECH.ucieHopUs, 1e-12, `${name}: in-card stage is 8 ring hops`);
}
{
  // Per-tile merges need the tile's partials in H local memory: the published 32K KV tile does not fit.
  const y = {...x, kvTile: 8192}, m = A.mappedPlan(y, 1, P.resize(A.physical(y)), {pvMerge: 'tile'});
  assert(m.feasible, m.reasons);
  const g = m.plan.ops.find(o => o.name.startsWith('PV') && o.timing.dieLink > 0);
  const part = y.headTile * (512 + 2) * 4, ringBytes = (8 - 1) * part;
  near(g.timing.dieLink, ring.gatherHops * A.TECH.ucieHopUs + ringBytes / (p.dieCutGB * 1000), 1e-12, 'pvMerge tile: gather over the ring diameter');
}

// 3. Published point.
const m = O.mapped(x), r = O.evaluate(x);
const comm = m.plan.ops.filter(o => o.unit === 'COMM');
assert.strictEqual(comm.length, 393);
const protocol = Math.max(...comm.map(o => o.duration - o.timing.tauFloor));
assert(protocol < O.OPT.tauUs, `the slowest collective (${protocol} us) is under tau`);
near(r.services.cardLocal + r.services.tauFloor, comm.length * O.OPT.tauUs - r.services.memoryTransport - r.services.tpReduce - r.services.portTail, 1e-9, 'tau absorbs the in-card stage');
near(r.rawUs, spec.tpsDesign.point.rawLatencyUs, 1e-9, 'published raw');

console.log(`PASS die ring: 8 dies, cut 2 links, ${ring.allReduceHops} hops per in-card collective stage; slowest collective ${protocol.toFixed(3)} us < tau, published raw ${r.rawUs.toFixed(2)} us unchanged`);
