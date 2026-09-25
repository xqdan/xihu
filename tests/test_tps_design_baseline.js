'use strict';
// TPS/usr design baseline (docs/design/21_TPS_DESIGN_BASELINE.md, ADR-0005):
// the spec block must equal a fresh rebuild, every listed mechanism must carry
// its weight, and the document's numbers must match the spec.
const assert = require('assert');
const fs = require('fs');
const T = require('../src/rdma/k3_tps_design_baseline.js');
const O = require('../src/rdma/k3_rdma_final_tuning_model.js');

const spec = JSON.parse(fs.readFileSync('docs/design/spec/k3_mc_baseline.json', 'utf8'));
const best = require('../data/rdma/k3_rdma_final_tuning_results.json').search.best;
const t = spec.tpsDesign;
assert(t, 'spec must carry tpsDesign; run npm run baseline:sync');

// 1. The stored block replays exactly (and OPT is left untouched by the ablations).
const optBefore = JSON.stringify(O.OPT);
const fresh = JSON.parse(JSON.stringify(T.build(best.x, spec.goal.rawLatencyBudgetUs)));
assert.equal(JSON.stringify(O.OPT), optBefore, 'building the baseline must restore OPT');
const close = (a, b, path) => {
  if (typeof a === 'number' && typeof b === 'number') return assert(Math.abs(a - b) <= 1e-6 * Math.max(1, Math.abs(b)), `${path}: ${a} vs ${b}`);
  if (a && typeof a === 'object') {
    assert.deepStrictEqual(Object.keys(a).sort(), Object.keys(b).sort(), `${path}: keys`);
    for (const k of Object.keys(a)) close(a[k], b[k], `${path}.${k}`);
    return;
  }
  assert.strictEqual(a, b, path);
};
close(t, fresh, 'tpsDesign');
assert(Math.abs(t.point.tpsPerUser - best.tps) < 1e-7, 'tpsDesign must describe the published point');
assert(!/FROZEN/.test(t.status.replace('not FROZEN', '')), 'the TPS design baseline must not be FROZEN (ADR-0003)');

// 2. The ledger reconciles.
const L = t.ledger;
assert(Math.abs(L.computeUs - L.tmaHiddenUs + L.commUs + L.dmaWaitUs - L.overlapUs - t.point.rawLatencyUs) < 1e-6, 'raw identity');
const cat = Object.values(L.opTimeUsByCategory).reduce((a, v) => a + v, 0);
assert(Math.abs(cat - (L.computeUs + L.commUs)) < 1e-6, 'op categories must cover compute + comm');
assert(Math.abs(L.opTimeUsByCategory.collective - L.commUs) < 1e-6);

// 3. Every mechanism is on, and switching it back alone costs TPS (or feasibility).
for (const m of t.software.mechanisms) {
  assert.notDeepStrictEqual(m.on, m.off, `${m.key} must be enabled at the published point`);
  if (m.off && typeof m.off === 'object') for (const k of Object.keys(m.off)) assert.deepStrictEqual(m.on[k], O.OPT[k], `${m.key}.${k} must match OPT`);
  else assert.deepStrictEqual(m.on, O.OPT[m.key], `${m.key} must match OPT`);
  assert(!m.ablation.feasible || m.ablation.tpsPerUser < t.point.tpsPerUser - 1e-6, `${m.key}: switching back must lower TPS`);
}
for (const n of t.software.noEffectAtPublishedPoint)
  assert(n.ablation.feasible && Math.abs(n.ablation.tpsPerUser - t.point.tpsPerUser) < 1e-6, `${n.key} is listed as no-effect but moves TPS`);
assert(t.software.gainAllNeutral, 'GAIN must be neutral');
assert(t.hardware.sharedPortScalingCost.dieAreaMm2 > 0, 'shared-port scaling cost must stay visible');

// 4. The document quotes the spec, not hand-copied numbers.
const doc = fs.readFileSync('docs/design/21_TPS_DESIGN_BASELINE.md', 'utf8');
const f2 = v => v.toFixed(2);
const must = [
  ['TPS', t.point.tpsPerUser], ['raw', t.point.rawLatencyUs], ['e2e', t.point.e2eLatencyUs], ['margin', t.point.rawMarginUs],
  ['compute', L.computeUs], ['tmaHidden', L.tmaHiddenUs], ['comm', L.commUs], ['wait', L.dmaWaitUs], ['overlap', L.overlapUs],
  ['tmaExposed', L.tmaExposedUs],
  ...Object.entries(L.services).filter(([, v]) => Math.abs(v) > 0.005).map(([k, v]) => ['service ' + k, Math.abs(v)]),
  ...Object.entries(L.opTimeUsByCategory).map(([k, v]) => ['category ' + k, v]),
  ...t.software.mechanisms.filter(m => m.ablation.feasible).flatMap(m => [['ablation ' + m.key, m.ablation.tpsPerUser], ['ablation raw ' + m.key, m.ablation.rawLatencyUs]]),
  ['repo-510', t.software.countBasis.ablation.tpsPerUser],
  ...Object.entries(t.sensitivity.mcGBs).filter(([, r]) => r.feasible).map(([g, r]) => ['MC' + g, r.tpsPerUser]),
  ['depth 1', t.sensitivity.depth[1].tpsPerUser],
  ...Object.entries(t.sensitivity.kvTile16384).filter(([, r]) => r.feasible).map(([k, r]) => ['kv16k ' + k, r.tpsPerUser]),
  ['die area', t.hardware.dieAreaMm2], ['die power', t.hardware.diePowerW], ['card power', t.hardware.perCard.powerW],
  ['port area', t.hardware.sharedPortScalingCost.dieAreaMm2], ['port power', t.hardware.sharedPortScalingCost.diePowerW],
  ['L TF', t.hardware.perDie.lTensorTflops], ['H TF', t.hardware.perDie.hTensorTflops], ['vector', t.hardware.perDie.vectorTops],
  ['shared window', t.dataMovement.sharedWindowMiBPerCard], ['shared peak', t.dataMovement.sharedPeakReservedMiBPerCard]
];
const missing = must.filter(([, v]) => !doc.includes(f2(v))).map(([k, v]) => `${k}=${f2(v)}`);
assert.deepStrictEqual(missing, [], 'doc 21 is out of date: ' + missing.join(', '));
for (const m of t.software.mechanisms) assert(doc.includes('`' + m.key + '`'), `doc 21 must list mechanism ${m.key}`);
assert(doc.includes(String(t.dataMovement.dmaPreemptions)) && doc.includes(String(t.dataMovement.kvBytesPerTokenPerLayer)));
assert(doc.includes(`${Object.keys(O.GAIN).length} 个经验因子`), 'doc 21 must state the GAIN table size');

console.log('PASS TPS design baseline', f2(t.point.tpsPerUser), 'TPS/usr;', t.software.mechanisms.length, 'mechanisms ablated,', must.length, 'doc numbers checked');
