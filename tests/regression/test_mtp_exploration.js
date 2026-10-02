'use strict';
// Batch=1 + MTP verify scenario (docs/architecture/21_TPS_DESIGN_BASELINE.md section 6.4).
// 1. The simulator change (tokens vs sequences) is inert at the defaults: every published number stays.
// 2. seqs < batch really shares KV and state traffic and nothing else.
// 3. The EXPLORATORY artifact is reproducible: every row's recorded knobs re-evaluate to the stored step
//    time, the TPS/acceptance tables follow from the rows, and the model preset is left untouched.
// 4. The artifact is isolated from the baseline, and the document quotes it.
const assert = require('assert');
const fs = require('fs');
const {build} = require('../../integration/detailed/k3_operator_sram_sim.js');
const O = require('../../integration/detailed/k3_rdma_final_tuning_model.js');
const E = require('../../teams/model/src/design_engine.js');
const M = require('../../integration/detailed/mtp_exploration.js');

const art = JSON.parse(fs.readFileSync('out/detailed/mtp_exploration.json', 'utf8'));
const base = M.readBaseline();
const near = (a, b, tol, what) => assert(Math.abs(a - b) <= tol * Math.max(1, Math.abs(b)), `${what}: ${a} vs ${b}`);

// 1. Defaults are unchanged.
const published = O.evaluate(base.x);
near(published.rawUs, base.point.rawLatencyUs, 1e-9, 'published raw latency');
near(O.evaluate(base.x, {tokens: 1, seqs: 1}).rawUs, published.rawUs, 1e-12, 'explicit tokens=1,seqs=1 equals the default');
const sig = plan => JSON.stringify({ops: plan.ops.map(o => [o.name, o.duration, o.read, o.write]), jobs: plan.jobs.map(j => [j.kind, j.bytes]), store: plan.backingBytes});
assert.strictEqual(sig(build({batch: 3})), sig(build({batch: 3, seqs: 3})), 'seqs defaults to batch');

// 2. seqs < batch shares KV and state, not activations or experts.
const shared = build({batch: 4, seqs: 1, context: 1048576}), indep = build({batch: 4, context: 1048576});
const bytes = (plan, kind) => plan.jobs.filter(j => j.kind === kind).reduce((a, j) => a + j.bytes, 0);
near(bytes(shared, 'kv') * 4, bytes(indep, 'kv'), 1e-9, 'KV read bytes scale with sequences');
near(bytes(shared, 'state') * 4, bytes(indep, 'state'), 1e-9, 'linear-state bytes scale with sequences');
near(shared.stateStore * 4, indep.stateStore, 1e-9, 'stored KV/state scales with sequences');
assert.strictEqual(bytes(shared, 'expert'), bytes(indep, 'expert'), 'routed-expert bytes depend on tokens, not sequences');
assert.strictEqual(shared.U, indep.U, 'expert union depends on tokens');
assert.throws(() => build({batch: 2, seqs: 3}), /Invalid seqs/);
assert.throws(() => build({batch: 2, seqs: 0}), /Invalid seqs/);
assert(shared.ops.find(o => o.name === 'QK (absorbed MLA)').flops === indep.ops.find(o => o.name === 'QK (absorbed MLA)').flops, 'attention FLOPs depend on tokens');

// 3. The artifact reproduces.
assert(/^EXPLORATORY/.test(art.status), 'the artifact must declare itself EXPLORATORY');
assert.strictEqual(art.inputs.baselineSha256, base.sha256, 'artifact was built from a different k3_mc_baseline.json; rerun npm run mtp:explore');
assert.strictEqual(art.inputs.goalTpsPerUser, base.goal);
near(art.checkRow.verifyRawUs, base.point.rawLatencyUs, 1e-9, 'k=1 BF16 MC640 row is the published step');
const denseBefore = E.MODEL_PRESETS.kimiK3.dtype.dense;
for (const r of art.rows) {
  assert(r.feasible && r.tunedKnobs, `row ${r.dtype}/${r.mcGBs}/${r.union}/k${r.verifyTokens} has no feasible tuning`);
  const got = M.step(base.x, {dtype: r.dtype, mcGBs: r.mcGBs, tokens: r.verifyTokens, union: r.union === 'n/a' ? undefined : r.union, knobs: r.tunedKnobs});
  assert(got.feasible, 'recorded knobs must stay feasible');
  near(got.rawUs, r.verifyRawUs, 1e-9, `row ${r.dtype}/${r.mcGBs}/${r.union}/k${r.verifyTokens}`);
}
assert.strictEqual(E.MODEL_PRESETS.kimiK3.dtype.dense, denseBefore, 'the scenario must restore the model preset');
assert.strictEqual(art.rows.length, M.SCENARIO.mcGBs.length * Object.keys(M.SCENARIO.dtypes).length * (1 + 2 * (M.SCENARIO.verifyTokens.length - 1)), 'row count');

const find = (dtype, mcGBs, union, k) => art.rows.find(r => r.dtype === dtype && r.mcGBs === mcGBs && r.verifyTokens === k && r.union === (k === 1 ? 'n/a' : union));
// Physics sanity: more tokens per step cost more time; FP8 dense never slower than BF16; expected union never above worst.
for (const dtype of Object.keys(M.SCENARIO.dtypes)) for (const mc of M.SCENARIO.mcGBs) for (const union of M.SCENARIO.unions) {
  for (let k = 2; k <= 4; k++) assert(find(dtype, mc, union, k).verifyRawUs > find(dtype, mc, union, k - 1).verifyRawUs, `${dtype}/${mc}/${union}: step time must grow with k`);
  for (let k = 2; k <= 4; k++) assert(find(dtype, mc, 'expected', k).verifyRawUs <= find(dtype, mc, 'worst', k).verifyRawUs * (1 + 1e-9), `${dtype}/${mc}/k${k}: expected union cannot cost more than worst`);
}
for (const mc of M.SCENARIO.mcGBs) for (let k = 1; k <= 4; k++) {
  const bf = find('bf16Dense', mc, 'worst', k), fp = find('fp8Dense', mc, 'worst', k);
  assert(fp.verifyRawUs <= bf.verifyRawUs * 1.02, `MC${mc} k${k}: FP8 dense must not be slower than BF16 (beyond tuning noise)`);
}

// The perf and acceptance tables follow from the rows.
assert.strictEqual(M.expectedTokens(0.5, 1), 1);
near(M.expectedTokens(0.5, 3), 1.75, 1e-12, 'expected tokens per step');
for (const p of art.perf) {
  const one = find(p.dtype, p.mcGBs, p.union, 1);
  let best = 0, bestK = null;
  for (const k of M.SCENARIO.verifyTokens) {
    const tps = M.tpsPerUser(find(p.dtype, p.mcGBs, p.union, k).verifyRawUs, k, p.acceptance, one.verifyRawUs / M.LAYERS, p.draftLayerEquiv);
    if (tps > best) { best = tps; bestK = k; }
  }
  near(p.tpsPerUser, best, 1e-9, `perf ${p.dtype}/${p.mcGBs}/${p.union}/a${p.acceptance}/d${p.draftLayerEquiv}`);
  assert.strictEqual(p.bestVerifyTokens, bestK);
  assert.strictEqual(p.meetsGoal, best >= base.goal);
}
near(art.perf.find(p => p.dtype === 'bf16Dense' && p.mcGBs === 640 && p.acceptance === 0.2 && p.union === 'worst' && p.draftLayerEquiv === 1).tpsPerUser,
  base.point.tpsPerUser, 1e-9, 'at the published point and the reported 0.2 acceptance gain k=1 stays optimal and equals the baseline');
for (const r of art.alphaForGoal) {
  if (r.minAcceptance === null) continue;
  const at = a => {
    const one = find(r.dtype, r.mcGBs, r.union, 1);
    return Math.max(...M.SCENARIO.verifyTokens.map(k => M.tpsPerUser(find(r.dtype, r.mcGBs, r.union, k).verifyRawUs, k, a, one.verifyRawUs / M.LAYERS, r.draftLayerEquiv)));
  };
  assert(at(r.minAcceptance) >= base.goal, `${r.dtype}/${r.mcGBs}/${r.union}: minAcceptance ${r.minAcceptance} must reach the goal`);
  if (r.minAcceptance > 0) assert(at(r.minAcceptance - M.SCENARIO.alphaStep + 1e-9) < base.goal, `${r.dtype}/${r.mcGBs}/${r.union}: one step lower must not reach the goal`);
}

// 4. Isolation and documentation.
const state = fs.readFileSync('docs/architecture/21_TPS_DESIGN_BASELINE.md', 'utf8');
const doc = state.slice(state.indexOf('### 6.4'), state.indexOf('## 7.'));
assert(/EXPLORATORY/.test(doc) && /不是基线/.test(doc), 'doc 21 section 6.4 must say the scenario is exploratory and not the baseline');
const table = [];
for (const dtype of ['bf16Dense', 'fp8Dense']) {
  const cells = M.SCENARIO.mcGBs.map(mc => {
    const g = u => art.alphaForGoal.find(r => r.dtype === dtype && r.mcGBs === mc && r.union === u && r.draftLayerEquiv === 1).minAcceptance;
    return `${g('worst')} / ${g('expected')}`;
  });
  table.push(`| ${dtype === 'bf16Dense' ? 'BF16' : 'FP8 稠密'} | ${cells.join(' | ')} |`);
}
for (const row of table) assert(doc.includes(row), `doc 21 section 6.4 table is stale: ${row}`);
const step640 = k => find('bf16Dense', 640, 'worst', k).verifyRawUs.toFixed(1);
for (const k of [1, 2, 3, 4]) assert(doc.includes(step640(k)), `doc 21 section 6.4 must quote the k=${k} step time ${step640(k)}`);
const mc640 = a => Math.round(art.perf.find(p => p.dtype === 'bf16Dense' && p.mcGBs === 640 && p.acceptance === a && p.union === 'worst' && p.draftLayerEquiv === 1).tpsPerUser);
assert(doc.includes(`${mc640(0.4)} / ${mc640(0.6)} / ${mc640(0.8)} TPS/usr`), 'doc 21 section 6.4 MC640 TPS list is stale');
for (const f of fs.readdirSync('out/governance')) assert(!fs.readFileSync(`out/governance/${f}`, 'utf8').includes('mtp_exploration'), `${f}: no gate may depend on the exploratory scenario`);

console.log(`PASS MTP exploration: ${art.rows.length} rows reproduce, defaults unchanged (${published.rawUs.toFixed(2)} us), `
  + `MC640 BF16 TPS at acceptance 0.4/0.6/0.8 = ${mc640(0.4)}/${mc640(0.6)}/${mc640(0.8)} (EXPLORATORY, baseline untouched)`);
