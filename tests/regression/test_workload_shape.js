'use strict';
// Workload shape (ARCH-CH-03; teams/council/docs/24_TRACE_AND_CHARON_ADOPTION_PLAN.md).
// 1. The context knob is inert at its default: O.mapped(x) and O.mapped(x, {context: LIMITS.context})
//    give the same plan and the published numbers; a shorter context shortens only the KV tiles and the
//    KV store, and the Linear recurrent op does not depend on it.
// 2. The Pareto front helper keeps exactly the non-dominated points.
// 3. The committed out/detailed/workload_shape.json was built from the current sources (sha256), its
//    rows replay from the model, and its summaries follow from its rows. A full rebuild takes about a
//    minute (npm run shape:explore), so the test replays a sample instead.
const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const O = require('../../integration/detailed/k3_rdma_final_tuning_model.js');
const A = require('../../integration/detailed/k3_architecture_search.js');
const S = require('../../integration/detailed/workload_shape.js');

const root = path.resolve(__dirname, '../..');
const FILE = 'out/detailed/workload_shape.json';
const near = (a, b, tol, what) => assert(Math.abs(a - b) <= tol, `${what}: ${a} vs ${b}`);
const sha256 = data => crypto.createHash('sha256').update(data).digest('hex');
const spec = JSON.parse(fs.readFileSync(path.join(root, S.BASELINE_FILE), 'utf8'));
const x = spec.tpsDesign.hardware.x;

// 1. Context knob.
const base = O.evaluate(x), full = O.evaluate(x, {context: A.LIMITS.context});
for (const k of Object.keys(base)) if (typeof base[k] === 'number') assert.strictEqual(full[k], base[k], `context default changed ${k}`);
near(base.rawUs, spec.tpsDesign.point.rawLatencyUs, 1e-9, 'published raw');
const mFull = O.mapped(x), mShort = O.mapped(x, {context: 8192});
assert.strictEqual(mFull.plan.c.context, A.LIMITS.context);
assert.strictEqual(mShort.plan.c.context, 8192);
const kvTiles = m => m.plan.jobs.filter(j => j.kind === 'kv');
assert.strictEqual(kvTiles(mShort).length, mShort.plan.model.softmaxLayers, '8K context: one KV tile of 256 tokens per softmax layer');
near(kvTiles(mShort)[0].bytes, 8192 / 32 * mShort.plan.kvBytesPerToken, 1e-9, '8K KV tile bytes');
near(mFull.plan.stateStore - mShort.plan.stateStore, mFull.plan.model.softmaxLayers * (A.LIMITS.context - 8192) * mFull.plan.kvBytesPerToken / 32, 1e-3, 'KV store scales with context');
const kda = m => m.plan.ops.filter(o => o.name.startsWith('Linear recurrent')).map(o => o.duration);
assert.deepStrictEqual(kda(mShort), kda(mFull), 'the Linear recurrent op does not depend on the context');
assert.strictEqual(mFull.plan.ops.length, mShort.plan.ops.length, 'same DAG shape: one KV tile per layer at the published kvTile in both');
assert.throws(() => O.mapped(x, {context: 1000}), /Invalid input/, 'context must split evenly over TP');

// 2. Pareto front.
const pts = [{tpsPerUser: 10, tpsPerCard: 1}, {tpsPerUser: 5, tpsPerCard: 5}, {tpsPerUser: 4, tpsPerCard: 4}, {tpsPerUser: 5, tpsPerCard: 5}, {tpsPerUser: 1, tpsPerCard: 6}];
assert.deepStrictEqual(S.paretoFront(pts), [pts[0], pts[1], pts[4]]);
assert.deepStrictEqual(S.mappings(x)[0], {kvTile: x.kvTile, headTile: x.headTile, weightTileMiB: x.weightTileMiB, depth: x.depth}, 'published mapping first');
const grid = Object.values(S.MAPPING_GRID).reduce((a, v) => a * v.length, 1);
assert.strictEqual(S.mappings(x).length, grid, 'the published mapping is a grid point and is counted once');

// 3. Committed report.
const report = JSON.parse(fs.readFileSync(path.join(root, FILE), 'utf8'));
assert.strictEqual(report.format, S.FORMAT);
assert.strictEqual(report.evidenceClass, S.EVIDENCE);
assert.strictEqual(report.provenance.baselineSha256, sha256(fs.readFileSync(path.join(root, S.BASELINE_FILE))), `${FILE} is stale vs the baseline; run npm run shape:explore`);
assert.deepStrictEqual(Object.keys(report.provenance.sources), S.SOURCE_FILES);
for (const f of S.SOURCE_FILES) {
  assert.strictEqual(report.provenance.sources[f], sha256(fs.readFileSync(path.join(root, f))), `${FILE} is stale vs ${f}; run npm run shape:explore`);
}
assert.deepStrictEqual(report.provenance.publishedX, x);
assert.deepStrictEqual(report.mappingGrid, S.MAPPING_GRID);
assert.deepStrictEqual(report.batchSweep.map(b => [b.context, b.union]), S.BATCH_CONTEXTS.flatMap(c => S.UNIONS.map(u => [c, u])));
assert.deepStrictEqual(report.contextScan.map(c => c.context), S.SCAN_CONTEXTS);

// The published point is the B = 1, 1M row and the 1M scan point.
const at1M = report.batchSweep.find(b => b.context === A.LIMITS.context && b.union === 'worst');
near(at1M.rows[0].best.tpsPerUser, base.tps, 1e-9, 'B = 1 at 1M is the published TPS/usr');
const scan1M = report.contextScan.find(c => c.context === A.LIMITS.context);
near(scan1M.rawUs, base.rawUs, 1e-9, 'scan at 1M is the published raw');
assert.strictEqual(scan1M.lse.count, mFull.plan.model.softmaxLayers, 'one LSE merge per softmax layer');

// Every best row and front point replays; the summaries follow from the rows.
const replay = (b, p) => S.evalPoint({x: {...x, ...p.mapping}, tokens: p.batch, context: b.context, union: b.union});
for (const b of report.batchSweep) {
  const ok = b.rows.filter(r => r.best);
  for (const r of b.rows) {
    assert.strictEqual(r.mappings, S.mappings(x).length);
    assert.strictEqual(r.feasible + Object.values(r.infeasible).reduce((a, v) => a + v, 0), r.mappings);
    if (!r.best) continue;
    near(r.best.tpsPerCard, r.batch * r.best.tpsPerUser / S.TP, 1e-9, 'TPS/card = B x TPS/usr / TP');
    // Replaying every row is the slow part; the 8K rows are the cheapest and cover the short-tile path.
    if (b.context === 8192 || r.batch === 1) near(replay(b, r.best).tpsPerUser, r.best.tpsPerUser, 1e-9, `replay ${b.context}/${b.union}/B${r.batch}`);
  }
  for (const p of b.paretoFront) assert(ok.some(r => r.batch === p.batch), 'front points come from feasible batches');
  for (let i = 1; i < b.paretoFront.length; i++) {
    assert(b.paretoFront[i].tpsPerUser < b.paretoFront[i - 1].tpsPerUser && b.paretoFront[i].tpsPerCard > b.paretoFront[i - 1].tpsPerCard, 'front is monotone');
  }
  const card = ok.reduce((a, r) => (r.best.tpsPerCard > a.tpsPerCard ? r.best : a), ok[0].best);
  near(b.summary.maxTpsPerCard.tpsPerCard, card.tpsPerCard, 1e-12, 'max TPS/card');
  near(b.summary.cardGainOverBatch1, card.tpsPerCard / ok[0].best.tpsPerCard, 1e-12, 'card gain');
  assert(b.paretoFront.some(p => p.tpsPerCard === card.tpsPerCard), 'the max TPS/card point is on the front');
}
for (const c of report.contextScan) {
  assert(c.feasible);
  if (c.context <= 8192 || c.context === A.LIMITS.context) {
    const r = S.evalPoint({x, tokens: 1, context: c.context});
    near(r.rawUs, c.rawUs, 1e-9, `scan replay ${c.context}`);
    near(r.lse.us, c.lse.us, 1e-12, `scan LSE ${c.context}`);
  }
  const h = c.headParallel;
  assert.strictEqual(h.evidenceClass, 'PLANNING_ESTIMATE');
  near(h.savedUs, c.lse.us, 1e-12, 'head-parallel saves the LSE merges');
  assert(h.tpsPerUser.kvHidden >= h.tpsPerUser.kvExposed, 'hidden bound is the optimistic one');
  assert(h.tpsPerUser.kvHidden > c.tpsPerUser, 'without the extra KV read head-parallel only saves time');
  assert.strictEqual(h.tpsPerUser.kvExposed > c.tpsPerUser, c.context < h.breakEvenContext, `break-even ${c.context}`);
}

console.log(`PASS workload shape: ${report.batchSweep.length} batch sweeps and ${report.contextScan.length} context points bound to their sources; the published point replays at B = 1, 1M`);
