'use strict';
// AI Core matrix:vector design search (teams/hardware/docs/02_AI_CORE.md section
// 2.5): the stored artifact is the winner of a fresh search over the HW-02
// design space and holds no alternatives; the winner hides every required
// H-core kernel and keeps the published point; the kernel bounds agree with the
// limiters of the detailed model; every other option loses on a stated
// criterion; the document quotes the design, the comparison and the analysis.
const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const S = require('../../integration/detailed/matrix_vector_search.js');
const A = require('../../integration/detailed/k3_architecture_search.js');
const O = require('../../integration/detailed/k3_rdma_final_tuning_model.js');

const stored = JSON.parse(fs.readFileSync('out/detailed/matrix_vector_design.json', 'utf8'));
const space = JSON.parse(fs.readFileSync(S.SPACE_FILE, 'utf8'));

// 1. The artifact is a fresh build; TECH/OPT/mappedPlan are left untouched.
const techBefore = JSON.stringify(A.TECH), optBefore = JSON.stringify(O.OPT), mappedPlan = A.mappedPlan;
const result = S.search();
const fresh = JSON.parse(JSON.stringify(S.build(result)));
const alt = S.alternatives(result), an = S.analysis(result);
assert.strictEqual(JSON.stringify(A.TECH), techBefore, 'search must restore A.TECH');
assert.strictEqual(JSON.stringify(O.OPT), optBefore, 'search must not change O.OPT');
assert.strictEqual(A.mappedPlan, mappedPlan, 'search must restore A.mappedPlan');
const close = (a, b, path) => {
  if (typeof a === 'number' && typeof b === 'number') return assert(Math.abs(a - b) <= 1e-6 * Math.max(1, Math.abs(b)), `${path}: ${a} vs ${b}`);
  if (a && typeof a === 'object') {
    assert.deepStrictEqual(Object.keys(a).sort(), Object.keys(b).sort(), `${path}: keys`);
    for (const k of Object.keys(a)) close(a[k], b[k], `${path}.${k}`);
    return;
  }
  assert.strictEqual(a, b, path);
};
close(stored, fresh, 'matrixVectorDesign');
assert(!/FROZEN/.test(stored.status.replace('not FROZEN', '')), 'the design is a MODEL result, not FROZEN');
assert.strictEqual(stored.designSpace.sha256, crypto.createHash('sha256').update(fs.readFileSync(S.SPACE_FILE)).digest('hex'), 'design space hash');

// 2. out/ holds only the final design.
assert.deepStrictEqual(Object.keys(stored.design), Object.keys(space.dimensions), 'one entry per searched dimension');
for (const [d, v] of Object.entries(stored.design)) assert(v.option in space.dimensions[d].options, `${d}: ${v.option} is not in the design space`);
assert.deepStrictEqual(Object.keys(stored.ruled), Object.keys(space.ruled));
for (const v of Object.values(stored.ruled)) assert(!('alternatives' in v), 'ruled alternatives stay in the design space');
assert(!/"(alternatives|candidates|perOption|sweep)"\s*:\s*[[{]/.test(JSON.stringify(stored)), 'no alternative lists in out/');
assert(stored.designSpace.feasible > 0 && stored.designSpace.feasible <= stored.designSpace.candidates);

// 3. The winner hides every required kernel and keeps the published point.
const lanes = stored.design.vectorLanes.lanes, ev = stored.evaluation;
for (const k of stored.kernels.filter(q => q.required)) assert(k.hidden && k.coreRatio <= k.maxCoreRatio + 1e-9, `${k.model} ${k.kernel} must hide`);
assert(lanes >= stored.binding.minLanesPerCore, 'lanes cover the binding kernel');
assert.strictEqual(stored.binding.minLanesPerCore, Math.max(...stored.kernels.filter(q => q.required).map(q => q.minLanesPerCore)));
assert(ev.k3System.tpsPerUser >= ev.k3System.publishedTpsPerUser * (1 - stored.requirements.tpsTolerance), 'K3 TPS within tolerance');
assert(ev.areaMm2 <= ev.dieAreaLimitMm2);
close(ev.areaMm2, Object.values(ev.area).reduce((a, v) => a + v, 0), 'area adds up');
assert.deepStrictEqual(stored.requirements.models, space.requirements.models);
// Under the winner's other options, every smaller lane count is infeasible.
const ctx = result.ctx, winPick = Object.fromEntries(Object.entries(stored.design).map(([d, v]) => [d, v.option]));
for (const [n, o] of Object.entries(space.dimensions.vectorLanes.options)) {
  if (o.lanes < lanes) assert(!S.evaluate(ctx, {...winPick, vectorLanes: n}).feasible, `${n} lanes with the winner's options must be infeasible`);
}

// 4. The bounds agree with the detailed model at the published point, and the
// replay at the published lanes reproduces the published TPS.
const x = stored.hardware.publishedX, m = O.mapped(x);
const gemvB1 = an.kernels.find(k => k.kernel === 'GEMV B=1').maxCoreRatio['vectorUnpack/sfu'];
const pRatio = stored.hardware.publishedRatio;
assert.strictEqual(m.plan.ops.filter(o => o.unit === 'L').every(o => o.mapping.limiter === 'unpack'), pRatio.lCore > gemvB1,
  'B=1 GEMV bound must match the L-op limiter of the detailed model');
const mla = an.kernels.find(k => k.model === 'Kimi K3' && k.kernel === 'MLA').maxCoreRatio['vectorUnpack/sfu'];
const qk = m.plan.ops.filter(o => o.name.startsWith('QK'));
assert(qk.length && qk.every(o => (o.mapping.limiter !== 'unpack') === (pRatio.hCore <= mla)), 'K3 MLA bound must match the QK limiter');
const p1 = an.sweep.find(r => r.vectorLanes === x.vectorLanes);
close(p1['vectorUnpack/sfu'], ev.k3System.publishedTpsPerUser, 'sweep replays the published point');
for (const r of an.sweep) {
  if (r['vectorUnpack/sfu'] !== null && r['vectorUnpack/polynomial'] !== null) assert(r['vectorUnpack/polynomial'] <= r['vectorUnpack/sfu'] + 1e-9, 'polynomial exp cannot raise TPS');
  if (r['vectorUnpack/sfu'] !== null && r['nativeTensor/sfu'] !== null) assert(r['nativeTensor/sfu'] >= r['vectorUnpack/sfu'] - 1e-6, 'native input cannot lower TPS');
}
for (const k of an.kernels) {
  const b = k.maxCoreRatio;
  if (b['nativeTensor/sfu'] !== null) assert(b['nativeTensor/sfu'] >= b['vectorUnpack/sfu'] - 1e-9, `${k.model} ${k.kernel}: native cannot lower the bound`);
  assert(b['vectorUnpack/polynomial'] <= b['vectorUnpack/sfu'] + 1e-9, `${k.model} ${k.kernel}: polynomial exp cannot raise the bound`);
}

// 5. The search: every other option loses on a criterion; the K3-only variant
// needs no more lanes; the break-even overhead separates the premises.
for (const [d, opts] of Object.entries(alt)) {
  assert.deepStrictEqual(Object.keys(opts), Object.keys(space.dimensions[d].options), `${d}: every option has a best candidate`);
  for (const [n, v] of Object.entries(opts)) {
    assert.strictEqual(v.chosen, n === stored.design[d].option);
    assert.strictEqual(v.pick[d], n);
    if (v.chosen) { assert.strictEqual(v.lostOn, null); close(v.areaMm2, ev.areaMm2, `${d}.${n} area`); continue; }
    assert(v.lostOn && v.lostOn !== 'tie', `${d}.${n} must lose on a criterion`);
  }
}
const again = S.evaluate(S.context(), winPick);
assert(again.feasible && Math.abs(again.areaMm2 - ev.areaMm2) < 1e-12);
assert(an.k3Only.lanes <= lanes, 'K3 alone cannot need more lanes than three models');
const overhead = space.dimensions.lowPrecisionInput.options.nativeTensor.matrixAreaOverhead;
assert.strictEqual(stored.design.lowPrecisionInput.option === 'nativeTensor', overhead < an.nativeBreakEvenMatrixOverhead, 'break-even decides the premise');

// 6. The candidate set is persisted next to the winner with a reproducible
// fingerprint. The design artifact deliberately holds no candidate list (see
// section 2); this file is where the excluded candidates survive, so that a
// downstream consumer which merges or excludes them can be checked against a
// stored set instead of against a console log.
const candStored = JSON.parse(fs.readFileSync('out/detailed/matrix_vector_candidates.json', 'utf8'));
const candFresh = JSON.parse(JSON.stringify(S.candidates(result)));
close(candStored, candFresh, 'matrixVectorCandidates');
assert.strictEqual(candStored.candidates.length, candStored.totalCandidates, 'every enumerated candidate is listed');
assert.strictEqual(candStored.feasibleCandidates, candStored.candidates.filter(c => c.feasible).length, 'feasible count matches the list');
assert.strictEqual(candStored.designSpace.sha256, stored.designSpace.sha256, 'candidate set comes from the same design space as the winner');
assert.strictEqual(candStored.candidates.filter(c => c.chosen).length, 1, 'exactly one candidate is the winner');
assert.deepStrictEqual(candStored.candidates.find(c => c.chosen).pick, winPick, 'the chosen candidate is the winner of the design artifact');
// The ranking is the search's own: feasible first, then area, then power.
for (let i = 1; i < candStored.candidates.length; i++) {
  const a = candStored.candidates[i - 1], b = candStored.candidates[i];
  assert(a.feasible >= b.feasible, `candidate ${i} ranks a feasible candidate below an infeasible one`);
  if (a.feasible === b.feasible && a.feasible) assert(a.areaMm2 <= b.areaMm2 + 1e-9, `candidate ${i} breaks the area ranking`);
  if (b.feasible) assert(b.tpsPerUser >= stored.requirements.models.length && b.tpsPerUser > 0, `candidate ${i} has no replay`);
}
// The fingerprint must be over the scored set, not over the file: recomputing
// it after a re-serialization of the same candidates must not change it.
const reshuffled = {...candStored, candidates: [...candStored.candidates].reverse()};
assert.strictEqual(S.candidates(result).candidateSetSha256, candStored.candidateSetSha256, 'fingerprint is not stable across runs');
assert.strictEqual(candStored.candidateSetSha256, (() => {
  const canon = reshuffled.candidates.map(c => ({pick: Object.fromEntries(Object.entries(c.pick).sort(([p], [q]) => (p < q ? -1 : 1))),
    feasible: c.feasible, violations: [...c.violations].sort(), lanes: c.lanes,
    areaMm2: Number(c.areaMm2.toFixed(9)), diePowerW: Number(c.diePowerW.toFixed(9)),
    tpsPerUser: c.tpsPerUser === null ? null : Number(c.tpsPerUser.toFixed(9))}));
  canon.sort((a, b) => (JSON.stringify(a.pick) < JSON.stringify(b.pick) ? -1 : 1));
  return crypto.createHash('sha256').update(JSON.stringify(canon)).digest('hex');
})(), 'fingerprint depends on enumeration order');

// 7. The document quotes the design, the comparison and the analysis.
const doc = fs.readFileSync('teams/hardware/docs/02_AI_CORE.md', 'utf8');
const f1 = v => (v === null ? '—' : v.toFixed(1)), f2 = v => (v === null ? '—' : v.toFixed(2));
const combos = ['vectorUnpack/sfu', 'vectorUnpack/polynomial', 'nativeTensor/sfu', 'nativeTensor/polynomial'];
const u = an.unpackAttribution, k3 = an.k3Only, bind = stored.binding;
const must = [
  ['candidates', `${stored.designSpace.candidates} 个组合、${stored.designSpace.feasible} 个可行`], ['space hash', stored.designSpace.sha256.slice(0, 12)],
  ...Object.entries(stored.design).map(([d, v]) => [`design ${d}`, `| ${d} | \`${v.option}\` |`]),
  ['die ratio', `**${f1(stored.ratio.die)}:1**`], ['L ratio', `**${f1(stored.ratio.lCore)}:1**`], ['H ratio', `**${f1(stored.ratio.hCore)}:1**`],
  ['binding', `${bind.model} DSA indexer`], ['binding bound', `上限 ${f1(bind.maxCoreRatio)}:1`], ['binding lanes', `至少 ${f1(bind.minLanesPerCore)} lane`],
  ['K3 TPS', `K3 回放 ${f2(ev.k3System.tpsPerUser)} TPS/usr（发布值 ${f2(ev.k3System.publishedTpsPerUser)}）`], ['raw', `raw ${f2(ev.k3System.rawLatencyUs)} µs`],
  ['area', `面积 ${f2(ev.areaMm2)} mm²（Die ${f2(ev.area.die)} mm² + SFU ${f2(ev.area.vectorOverhead)} mm²）`], ['power', `功耗 ${f1(ev.diePowerW)} W`],
  ...Object.entries(alt).flatMap(([d, opts]) => Object.entries(opts).map(([n, v]) => [`alt ${d}.${n}`,
    `| ${d} | \`${n}\` | ${v.chosen ? '**选中**' : `\`${v.lostOn}\``} | ${v.pick.vectorLanes} / ${v.pick.lowPrecisionInput} / ${v.pick.expUnit} | `
    + `${f1(v.hCoreRatio)}:1 | ${f2(v.tpsPerUser)} | ${f2(v.areaMm2)} mm² | ${f1(v.diePowerW)} W |`])),
  ['break-even', `**${(an.nativeBreakEvenMatrixOverhead * 100).toFixed(1)}%**`],
  ...an.kernels.map(k => {
    const w = stored.kernels.find(q => q.model === k.model && q.kernel === k.kernel);
    return [`bound ${k.model} ${k.kernel}`, `| ${k.core} | ${combos.map(c => f1(k.maxCoreRatio[c])).join(' | ')} | ${w ? f1(w.minLanesPerCore) : '—'} |`];
  }),
  ...an.sweep.map(r => [`sweep ${r.vectorLanes}`, ` | ${f1(r.dieRatio)}:1 | ${f1(r.hCoreRatio)}:1 | ${combos.map(c => f2(r[c])).join(' | ')} | ${f2(r.dieAreaMm2)} mm² |`]),
  ...an.sweep.filter(r => r.reasons).map(r => [`sweep ${r.vectorLanes} reason`, r.reasons[0]]),
  ['unpack total', f2(u.routedMxfp4Us + u.denseBf16Us + u.kvDequantUs)], ['unpack MXFP4', f2(u.routedMxfp4Us)], ['unpack BF16', f2(u.denseBf16Us)],
  ['k3Only', `${k3.counts.candidates} 个组合、${k3.counts.feasible} 个可行，最优为 ${k3.pick.vectorLanes} / ${k3.pick.lowPrecisionInput} / ${k3.pick.expUnit}`],
  ['k3Only area', `面积 ${f2(k3.areaMm2)} mm²`], ['k3Only binding', `${k3.binding.model} KDA state update（上限 ${f1(k3.binding.maxCoreRatio)}:1，至少 ${f1(k3.binding.minLanesPerCore)} lane）`],
  ['k3Only native', `原生输入的最优为 ${k3.bestPerPremise.nativeTensor.lanes} lane（${f1(k3.bestPerPremise.nativeTensor.dieRatio)}:1），面积 ${f2(k3.bestPerPremise.nativeTensor.areaMm2)} mm²`]
];
const missing = must.filter(([, v]) => !doc.includes(v));
assert.deepStrictEqual(missing, [], `02_AI_CORE.md section 2.5 is stale; rerun npm run aicore:search and update:\n${missing.map(([k, v]) => `${k}: ${v}`).join('\n')}`);

console.log(`PASS matrix:vector design: ${stored.designSpace.feasible} feasible of ${stored.designSpace.candidates} candidates; winner `
  + `${Object.values(stored.design).map(v => v.option).join(' / ')} (${f1(stored.ratio.die)}:1, H ${f1(stored.ratio.hCore)}:1), `
  + `${f2(ev.areaMm2)} mm2, K3 ${f2(ev.k3System.tpsPerUser)} TPS; only the winner is in out/`);
