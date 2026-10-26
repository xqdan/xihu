'use strict';
// Mapping switches as rules (SW-CH-01; teams/council/docs/24_TRACE_AND_CHARON_ADOPTION_PLAN.md §2.8).
// 1. Each rule selects exactly the ops the mapper's former inline condition did, on the published
//    plan and on plans that exercise the other branches (repo-510, smaller head and KV tiles, BASE).
// 2. Each enforced precondition refuses an op that breaks it; each reported assumption flags one.
// 3. The fusion legality report of the published point: what is applied, refused and unmet.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const A = require('../../integration/detailed/k3_architecture_search.js');
const O = require('../../integration/detailed/k3_rdma_final_tuning_model.js');

const root = path.resolve(__dirname, '../..');
const x = JSON.parse(fs.readFileSync(path.join(root, 'teams/hardware/inputs/k3_mc_baseline.json'), 'utf8')).tpsDesign.hardware.x;
const withOpt = (patch, f) => { const saved = {...O.OPT}; Object.assign(O.OPT, patch); try { return f(); } finally { Object.assign(O.OPT, saved); } };
const ids = s => [...s].sort((a, b) => a - b);

// 1. The former inline conditions, verbatim in effect.
const before = {
  epilogueFusion: ops => ops.filter(o => A.EPILOGUE_OPS.test(o.name) && ops[o.id - 1] && ops[o.id - 1].unit !== 'COMM').map(o => o.id),
  softmaxFusion: ops => ops.filter(o => o.name === 'Online softmax').map(o => o.id),
  pvMerge: (ops, value) => {
    const last = {};
    for (const o of ops) if (o.name.startsWith('PV')) last[o.layer + '|' + o.detail.split(';')[1]] = o.id;
    return ops.filter(o => o.name.startsWith('PV') && (value === 'tile' || Object.values(last).includes(o.id))).map(o => o.id);
  }
};
const plans = {
  published: O.mapped(x).plan,
  repo510: withOpt({countBasis: 'repo-510'}, () => O.mapped(x).plan),
  smallTiles: O.mapped({...x, headTile: 16, kvTile: 4096}).plan,
  base: A.mappedPlan(A.BASE, 1, A.physical(A.BASE)).plan
};
for (const [tag, plan] of Object.entries(plans)) {
  for (const key of Object.keys(before)) for (const value of key === 'pvMerge' ? ['tile', 'layer'] : [true]) {
    assert.deepStrictEqual(ids(A.selectRules(key, plan.ops, value)), before[key](plan.ops, value).sort((a, b) => a - b), `${tag}: ${key}=${value}`);
  }
}
assert(A.selectRules('epilogueFusion', plans.repo510.ops).size < A.selectRules('epilogueFusion', plans.published.ops).size, 'repo-510: RoPE follows a collective');
// The mapper uses the selection: every fused op is a selected one, with no launch of its own.
const m = O.mapped(x), fused = A.selectRules('epilogueFusion', m.plan.ops);
assert.deepStrictEqual(ids(m.plan.ops.filter(o => o.mapping.fused).map(o => o.id)), ids(fused));
assert(m.plan.ops.filter(o => fused.has(o.id)).every(o => o.timing.launch === 0));

// 2. Preconditions refuse, assumptions flag.
const clone = plan => ({...plan, ops: plan.ops.map(o => ({...o}))});
{
  const p = clone(plans.published), rope = p.ops.find(o => o.name === 'RoPE');
  p.ops[rope.id - 1].unit = 'COMM';
  assert(!A.selectRules('epilogueFusion', p.ops).has(rope.id), 'an epilogue after a collective is not fused');
  const sm = p.ops.find(o => o.name === 'Online softmax');
  p.ops[sm.id - 1].detail = 'another tile';
  assert(!A.selectRules('softmaxFusion', p.ops).has(sm.id), 'softmax fuses only under the QK of its own tile');
}
{
  const p = clone(plans.published), fold = p.ops.find(o => o.name === 'Wup + Shared output all-reduce');
  p.ops.find(o => o.layer === fold.layer && o.name === 'Shared down').id = fold.id + 1;
  const cb = A.checkRules(p, O.OPT).find(r => r.key === 'countBasis');
  assert.deepStrictEqual(cb.unmet.map(u => u.ops), [{'Wup + Shared output all-reduce': 1}], 'a fold issued before its Shared down is flagged (B-007)');
}
const pv = A.checkRules(plans.smallTiles, O.OPT).find(r => r.key === 'pvMerge');
assert.strictEqual(pv.unmet.length, 1, 'headTile 16 interleaves six head tiles a layer; hLocalBytes reserves one accumulator');
assert.deepStrictEqual(A.checkRules(O.mapped({...x, headTile: 16, kvTile: 4096}).plan, {...O.OPT, pvMerge: 'tile'}).find(r => r.key === 'pvMerge').unmet, [], 'tile merges need no carried accumulator');
assert.deepStrictEqual(O.checkGainRules(), [], 'all GAIN factors neutral');
{
  const saved = O.GAIN.attentionFusion;
  O.GAIN.attentionFusion = .9;
  try { assert.deepStrictEqual(O.checkGainRules().map(r => r.key), ['attentionFusion']); } finally { O.GAIN.attentionFusion = saved; }
}

// 3. Published point. The over-cap epilogues are the ops whose shared-SRAM bytes do not fit the read/write/fabric
//    caps over the FUSED (kernel-only) time; the first op of the step has no kernel to fold into and is refused.
//    The set is a property of the point, not of the mechanism -- switching epilogueFusion off still costs TPS
//    (1020.35 against 1043.96), so the rule stays applied and the flag records which ops pay for it.
//    It was 5 ops at the 1138.48 point (RoPE, KV append source, Shared SiLU x up, Dispatch local pack, SiLU x up);
//    under ADR-0028's core definition (L 1x512x8, H 128x256x1) only two still cross the cap: the L core is wider
//    per core but the H-core rows fill 0.75 of the tile, so the fused bodies are long enough again for the
//    elementwise epilogues of the earlier list to fit. If the point moves, this set moves with it -- do not read
//    the shorter list as a weaker rule.
const report = Object.fromEntries(A.checkRules(m.plan, O.OPT).map(r => [r.key, r]));
assert.deepStrictEqual(Object.keys(report), ['epilogueFusion', 'softmaxFusion', 'pvMerge', 'countBasis']);
assert.deepStrictEqual(report.epilogueFusion.refused, {'Attention RMSNorm': 1});
assert.deepStrictEqual(report.epilogueFusion.unmet.map(u => u.ops),
  [{'KV append source': 24, 'Dispatch local pack': 92}]);
for (const k of ['softmaxFusion', 'countBasis']) {
  assert.strictEqual(report[k].applied, report[k].matched, k);
  assert.deepStrictEqual(report[k].unmet, [], k);
}
// pvMerge 'layer' merges on the LAST PV of each (layer, head tile) only; every other PV is refused by design, not
// unmet. While the published kvTile held one tile per layer, matched === applied. The published kvTile is 16384
// since ADR-0026, so a layer has two KV tiles: 48 PVs match, 24 carry the merge, the 24 first-tile PVs are refused.
const kvTilesPerLayer = Math.ceil(O.mapped(x).plan.c.context / 32 / x.kvTile);
assert.deepStrictEqual(report.pvMerge.unmet, [], 'pvMerge: no assumption is violated');
assert.strictEqual(report.pvMerge.matched, m.plan.model.softmaxLayers * kvTilesPerLayer, 'one PV per KV tile matches');
assert.strictEqual(report.pvMerge.applied, m.plan.model.softmaxLayers, 'published headTile 96: one head tile, one merge per layer');
assert.deepStrictEqual(report.pvMerge.refused, {'PV + rescale accumulation': report.pvMerge.matched - report.pvMerge.applied}, 'the PVs that are not the last of their layer are the refused ones');

console.log(`PASS mapping rules: ${Object.keys(A.RULES).length} mapper rules + ${O.GAIN_RULES.length} GAIN rules select as before; published report refuses 1 and flags ${Object.values(report.epilogueFusion.unmet[0].ops).reduce((a, b) => a + b, 0) > 0 ? Object.keys(report.epilogueFusion.unmet[0].ops).length : 0} over-cap epilogue ops`);
