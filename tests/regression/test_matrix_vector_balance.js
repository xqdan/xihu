'use strict';
// AI Core matrix:vector balance (teams/hardware/docs/02_AI_CORE.md section 2.5):
// the stored artifact must equal a fresh rebuild, the kernel bounds must agree
// with the limiter the detailed model reports at the published point, and the
// document must quote the artifact.
const assert = require('assert');
const fs = require('fs');
const M = require('../../integration/detailed/matrix_vector_balance.js');
const A = require('../../integration/detailed/k3_architecture_search.js');
const O = require('../../integration/detailed/k3_rdma_final_tuning_model.js');

const stored = JSON.parse(fs.readFileSync('out/detailed/matrix_vector_balance.json', 'utf8'));

// 1. The artifact replays exactly and TECH/OPT are left untouched.
const techBefore = JSON.stringify(A.TECH), optBefore = JSON.stringify(O.OPT);
const fresh = JSON.parse(JSON.stringify(M.build()));
assert.strictEqual(JSON.stringify(A.TECH), techBefore, 'build must restore A.TECH');
assert.strictEqual(JSON.stringify(O.OPT), optBefore, 'build must not change O.OPT');
const close = (a, b, path) => {
  if (typeof a === 'number' && typeof b === 'number') return assert(Math.abs(a - b) <= 1e-6 * Math.max(1, Math.abs(b)), `${path}: ${a} vs ${b}`);
  if (a && typeof a === 'object') {
    assert.deepStrictEqual(Object.keys(a).sort(), Object.keys(b).sort(), `${path}: keys`);
    for (const k of Object.keys(a)) close(a[k], b[k], `${path}.${k}`);
    return;
  }
  assert.strictEqual(a, b, path);
};
close(stored, fresh, 'matrixVectorBalance');
assert(!/FROZEN/.test(stored.status.replace('not FROZEN', '')), 'the balance is a MODEL result, not FROZEN');

// 2. The analytical bounds agree with the detailed model at the published point.
const x = stored.hardware.x, m = O.mapped(x);
const lOps = m.plan.ops.filter(o => o.unit === 'L');
const gemvHidden = stored.gemv[0].hiddenAtCurrent;
assert.strictEqual(lOps.every(o => o.mapping.limiter === 'unpack'), !gemvHidden, 'B=1 GEMV bound must match the L-op limiter of the detailed model');
const mla = stored.kernels.find(k => k.model === 'Kimi K3' && k.kernel === 'MLA QK+softmax+PV, FP8 KV');
const qk = m.plan.ops.filter(o => o.name.startsWith('QK'));
assert(qk.length && qk.every(o => (o.mapping.limiter !== 'unpack') === mla.hiddenAtCurrent), 'K3 MLA bound must match the QK limiter');
assert(Math.abs(stored.k3.sweep.vectorUnpack.find(r => r.vectorLanes === x.vectorLanes).tpsPerUser - stored.k3.publishedTpsPerUser) < 1e-6,
  'the sweep must replay the published point at the current lane count');

// 3. Decision invariants.
const d = stored.decision;
for (const scope of ['k3Only', 'allModels']) {
  assert(d[scope].nativeLowPrecision.lanesPerCore <= d[scope].vectorUnpack.lanesPerCore, `${scope}: native input cannot need more lanes`);
}
for (const premise of ['vectorUnpack', 'nativeLowPrecision']) {
  assert(d.allModels[premise].lanesPerCore >= d.k3Only[premise].lanesPerCore, `${premise}: supporting more models cannot need fewer lanes`);
}
for (const r of stored.k3.sweep.nativeLowPrecision) {
  const v = stored.k3.sweep.vectorUnpack.find(u => u.vectorLanes === r.vectorLanes);
  if (r.feasible && v.feasible) assert(r.tpsPerUser >= v.tpsPerUser - 1e-6, `native input must not lower TPS at ${r.vectorLanes} lanes`);
}

// 4. The document quotes the artifact.
const doc = fs.readFileSync('teams/hardware/docs/02_AI_CORE.md', 'utf8');
const f1 = v => v.toFixed(1), f2 = v => v.toFixed(2);
const u = stored.k3.unpackAttribution;
const must = [
  ['die ratio', f1(stored.hardware.ratio.die)],
  ...stored.gemv.filter(k => /B=(1|8)$/.test(k.kernel)).map(k => [k.kernel, f1(k.maxCoreRatio)]),
  // The table quotes the K3 MLA rows and every DSA indexer row.
  ...stored.kernels.filter(k => /indexer/.test(k.kernel) || (k.model === 'Kimi K3' && /^MLA/.test(k.kernel)))
    .map(k => [`${k.model} ${k.kernel}`, f1(k.maxCoreRatio)]),
  ...Object.values(stored.k3.sweep).flat().filter(r => r.feasible).map(r => [`sweep ${r.vectorLanes}`, f1(r.tpsPerUser)]),
  ['unpack total', f2(u.routedMxfp4Us + u.denseBf16Us + u.kvDequantUs)], ['unpack MXFP4', f2(u.routedMxfp4Us)], ['unpack BF16', f2(u.denseBf16Us)],
  ...['k3Only', 'allModels'].flatMap(s => ['vectorUnpack', 'nativeLowPrecision'].flatMap(p => [
    [`${s} ${p} lanes`, `| ${Math.round(d[s][p].lanesPerCore)} |`], [`${s} ${p} die`, f1(d[s][p].dieRatio)], [`${s} ${p} H`, f1(d[s][p].hCoreRatio)]]))
];
const missing = must.filter(([, v]) => !doc.includes(v));
assert.deepStrictEqual(missing, [], `02_AI_CORE.md section 2.5 is stale; rerun npm run aicore:balance and update:\n${missing.map(([k, v]) => `${k}: ${v}`).join('\n')}`);

console.log(`PASS matrix:vector balance: artifact replays, bounds match the detailed limiters, current ${f1(stored.hardware.ratio.die)}:1; `
  + `all models need ${f1(d.allModels.nativeLowPrecision.dieRatio)}:1 (native) / ${f1(d.allModels.vectorUnpack.dieRatio)}:1 (vector unpack)`);
