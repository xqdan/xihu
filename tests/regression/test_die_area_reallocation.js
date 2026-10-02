'use strict';
// Compute-die area/power reallocation study (docs/architecture/21_TPS_DESIGN_BASELINE.md section 6.5).
// The artifact is EXPLORATORY and isolated; this test makes it reproducible rather than trusted:
// the published point and every stored score are re-evaluated through the production model, every
// proposal stays inside the limits and the nominal floor, and the document quotes the artifact.
const assert = require('assert');
const fs = require('fs');
const D = require('../../integration/detailed/die_area_reallocation.js');
const B = require('../../integration/detailed/k3_tps_design_baseline.js');

const art = JSON.parse(fs.readFileSync('out/detailed/die_area_reallocation.json', 'utf8'));
const spec = JSON.parse(fs.readFileSync(D.BASELINE_FILE, 'utf8'));
const x0 = spec.tpsDesign.hardware.x, limits = spec.tpsDesign.hardware.limits;
const text = fs.readFileSync(D.BASELINE_FILE);
const near = (a, b, what, tol = 1e-9) => assert(Math.abs(a - b) <= tol * Math.max(1, Math.abs(b)), `${what}: ${a} vs ${b}`);

assert(/^EXPLORATORY/.test(art.status), 'artifact must declare itself EXPLORATORY');
assert.strictEqual(art.inputs.baselineSha256, require('crypto').createHash('sha256').update(text).digest('hex'), 'artifact was built from a different baseline; rerun npm run area:explore');

// The published point is the baseline, and the stress points are the ones doc 21 section 6.1.1 quotes.
const base = D.score(x0);
near(base.nominal.tps, spec.tpsDesign.point.tpsPerUser, 'published nominal TPS');
near(art.published.nominal.tps, base.nominal.tps, 'stored published nominal');
near(art.published.compute.tps, B.replayJoint(B.JOINT_PESSIMISTIC.compute, x0).tps, 'stored published compute-pessimistic');
near(art.published.allUnmeasured.tps, base.allUnmeasured.tps, 'stored published all-unmeasured');
assert.deepStrictEqual(art.envelope.limits, limits);
// Power, not area, is the binding limit of the published die.
const frac = art.envelope.headroomFraction;
assert(frac.cardPower < frac.dieArea && frac.cardPower < frac.packageArea && frac.diePower < frac.dieArea, 'power must be the tighter envelope than area at the published point');

// Every move list contains the published value; every marginal row replays.
for (const [f, values] of Object.entries(D.MOVES)) assert(values.includes(x0[f]), `${f}: published ${x0[f]} must be in the move list`);
const replayed = D.marginals(x0, base);
assert.strictEqual(art.marginals.length, replayed.length, 'marginal row count');
replayed.forEach((r, i) => {
  const a = art.marginals[i];
  assert.deepStrictEqual([a.field, a.from, a.to, a.feasible], [r.field, r.from, r.to, r.feasible], `marginal ${i} identity`);
  for (const k of ['nominalTps', 'dNominalTps', 'computeTps', 'dComputeTps', 'dDieAreaMm2', 'dDiePowerW']) {
    if (r[k] === null) assert.strictEqual(a[k], null, `${r.field} ${k}`); else near(a[k], r[k], `${r.field}->${r.to} ${k}`);
  }
});
// The statement the proposals rest on: the vector unit is idle nominally and valuable under stress.
const vec = art.marginals.find(m => m.field === 'vectorLanes' && m.to === 640);
assert(Math.abs(vec.dNominalTps) < 0.5 && vec.dComputeTps > 10, 'vectorLanes must be ~free nominally and valuable at the pessimistic point');
const rdma = art.marginals.find(m => m.field === 'rdmaLanes' && m.to === 12);
assert(Math.abs(rdma.dNominalTps) < 0.5 && rdma.dDiePowerW < 0, 'rdmaLanes 16->12 must be ~free nominally and free power');

// Proposals: inside the limits, above the nominal floor, consistent with their path, and replayable.
assert(art.proposals.length >= 1);
for (const p of art.proposals) {
  const s = D.score(p.x);
  assert(s.feasible, `${p.floor}: proposal must be feasible under every point`);
  for (const point of ['nominal', 'compute', 'allUnmeasured']) near(p.result[point].tps, s[point].tps, `${p.floor} ${point} TPS`);
  const n = s.nominal;
  assert(n.dieAreaMm2 <= limits.dieAreaMm2 && n.diePowerW <= limits.diePowerW && n.cardPowerW <= limits.cardPowerW && n.packageAreaMm2 <= limits.packageAreaMm2, `${p.floor}: limits`);
  assert(n.tps >= p.nominalFloorTps, `${p.floor}: nominal ${n.tps} below its floor ${p.nominalFloorTps}`);
  assert(n.tps >= art.inputs.goalTpsPerUser, 'a proposal may never drop the nominal result below the goal');
  assert(s.compute.tps > base.compute.tps, `${p.floor}: a proposal must beat the published point under the stress it was tuned for`);
  for (const k of Object.keys(x0)) {
    const changed = p.x[k] !== x0[k];
    assert.strictEqual(Boolean(p.changed[k]), changed, `${p.floor}: changed list must match x for ${k}`);
    if (changed) assert(D.MOVES[k] && D.MOVES[k].includes(p.x[k]), `${p.floor}: ${k}=${p.x[k]} is outside the move list`);
  }
  near(p.holdOut.allUnmeasuredGainTps, s.allUnmeasured.tps - base.allUnmeasured.tps, `${p.floor} hold-out gain`);
  assert(p.holdOut.allUnmeasuredGainTps > 0, `${p.floor}: the hold-out point must agree in sign, otherwise the proposal is over-fitted to the tuning point`);
  const last = p.path.at(-1);
  near(last.computeTps, s.compute.tps, `${p.floor} path end`);
  for (let i = 1; i < p.path.length; i++) assert(p.path[i].computeTps > p.path[i - 1].computeTps, `${p.floor}: climb must be monotone`);
}

// Documentation.
const state = fs.readFileSync('docs/architecture/21_TPS_DESIGN_BASELINE.md', 'utf8');
const doc = state.slice(state.indexOf('### 6.5'), state.indexOf('## 7.'));
assert(/EXPLORATORY/.test(doc) && /不是基线/.test(doc), 'doc 21 section 6.5 must say the study is exploratory and not the baseline');
const p0 = art.proposals[0], f1 = v => v.toFixed(1), f2 = v => v.toFixed(2);
for (const needle of [f1(art.published.nominal.dieAreaMm2), f1(art.published.nominal.diePowerW), f1(art.published.nominal.cardPowerW), f1(art.envelope.headroom.cardPowerW),
  f2(base.nominal.tps), f2(p0.result.compute.tps).replace(/0$/, '') , f2(base.compute.tps), f2(base.allUnmeasured.tps), f2(p0.result.allUnmeasured.tps),
  f1(p0.result.nominal.dieAreaMm2), f1(p0.result.nominal.diePowerW), f1(p0.result.nominal.cardPowerW), f1(limits.cardPowerW - p0.result.nominal.cardPowerW)])
  assert(doc.includes(needle), `doc 21 section 6.5 is stale: missing ${needle}`);
for (const [f, v] of Object.entries(p0.changed)) assert(doc.includes(String(v.to)) && doc.includes(String(v.from)), `doc 21 section 6.5 must quote ${f} ${v.from} -> ${v.to}`);
for (const f of fs.readdirSync('out/governance')) assert(!fs.readFileSync(`out/governance/${f}`, 'utf8').includes('die_area_reallocation'), `${f}: no gate may depend on the exploratory study`);

console.log(`PASS die-area reallocation: ${art.marginals.length} marginals and ${art.proposals.length} proposals replay; `
  + `compute-pessimistic ${f1(base.compute.tps)} -> ${f1(p0.result.compute.tps)}, hold-out ${f1(base.allUnmeasured.tps)} -> ${f1(p0.result.allUnmeasured.tps)}, nominal ${f1(p0.result.nominal.tps)} (EXPLORATORY)`);
