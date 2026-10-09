'use strict';
/* Compute-die area / power reallocation study (EXPLORATORY).
 *
 * Question: the published K3 compute die spends its envelope where the NOMINAL model says TPS is
 * bought (docs/architecture/21_TPS_DESIGN_BASELINE.md sections 3.5 and 6). Several of those units
 * (Reduce lanes, TMA engines, RDMA lanes) buy almost nothing nominally, while the unmeasured compute
 * parameters (matrix / vector utilisation, unpack rate, layout imbalance, KV tile) are exactly what the
 * joint pessimistic point stresses. Can area and power be moved from the first group to the second
 * without giving up the nominal result?
 *
 * Method (all through the production model, O.evaluate and replayJoint; nothing is re-implemented):
 *   1. envelope: which limit binds at the published point;
 *   2. one-step marginals of every hardware field, nominal and under the joint pessimistic point;
 *   3. hill-climb over pairs of one-step moves from the published point, maximising TPS under the
 *      joint pessimistic COMPUTE point while the nominal TPS stays above a floor. The climb is tuned
 *      on `JOINT_PESSIMISTIC.compute` and then scored, untouched, on `JOINT_PESSIMISTIC.allUnmeasured`
 *      (which also moves mcUtil, prediction and launch scale): a gain that only exists at the tuning
 *      point is over-fitting to an invented scenario and is reported as such.
 * The result is a proposal for HW-01/HW-02 owners. It changes no baseline, no gate and no published
 * number. Values off the search grid (for example vectorLanes 768) are not powers of two and need
 * the unit owner's sign-off before they mean anything.
 */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const O = require('./k3_rdma_final_tuning_model.js');
const B = require('./k3_tps_design_baseline.js');
const BP = require('./baseline_point.js');

const root = path.resolve(__dirname, '../..');
const BASELINE_FILE = 'teams/hardware/inputs/k3_mc_baseline.json';
const SPACE_FILE = 'teams/hardware/inputs/memory_design_space.json';
// Neighbour values per field. The published value must be in each list.
const MOVES = {
  vectorLanes: [256, 384, 512, 640, 768, 1024],
  reduceLanes: [1024, 2048, 3072, 4096],
  tmaEngines: [1, 2, 3, 4],
  rdmaLanes: [8, 12, 16],
  hRows: [40, 48, 56, 64],
  hEngines: [4, 5, 6],
  sharedSlices: [8, 12, 16],
  lCols: [128, 256],
  nocLanes: [2, 3, 4],
  lBanks: [32, 64],
  hBanks: [32, 64]
};
const FLOORS = [{name: 'nominalWithin1Percent', factor: 0.99}, {name: 'nominalAtGoal', goal: true}];
const MAX_STEPS = 4;

const nominal = x => O.evaluate(x);
const pessimistic = (name, x) => B.replayJoint(B.JOINT_PESSIMISTIC[name], x);
const snap = r => (r.feasible ? {tps: r.tps, dieAreaMm2: r.p.dieArea, diePowerW: r.p.diePower, cardPowerW: r.p.cardPower, packageAreaMm2: r.p.packageArea}
  : {tps: null, infeasible: (r.reasons || [r.reason || 'infeasible']).join(', ')});

function score(x) {
  const n = nominal(x);
  if (!n.feasible) return {feasible: false, nominal: snap(n)};
  const c = pessimistic('compute', x), a = pessimistic('allUnmeasured', x);
  return {feasible: c.feasible && a.feasible, nominal: snap(n), compute: snap(c), allUnmeasured: snap(a)};
}

function marginals(x, baseScore) {
  const rows = [];
  for (const [field, values] of Object.entries(MOVES)) {
    const i = values.indexOf(x[field]);
    if (i < 0) throw Error(`published ${field}=${x[field]} is not in the move list`);
    for (const j of [i - 1, i + 1]) {
      if (j < 0 || j >= values.length) continue;
      const s = score({...x, [field]: values[j]});
      rows.push({field, from: x[field], to: values[j], feasible: s.feasible,
        reason: s.feasible ? null : (s.nominal.infeasible || (s.compute && s.compute.infeasible) || (s.allUnmeasured && s.allUnmeasured.infeasible) || 'infeasible under a pessimistic point'),
        nominalTps: s.nominal.tps, dNominalTps: s.nominal.tps === null ? null : s.nominal.tps - baseScore.nominal.tps,
        computeTps: s.compute ? s.compute.tps : null, dComputeTps: s.compute && s.compute.tps !== null ? s.compute.tps - baseScore.compute.tps : null,
        dDieAreaMm2: s.nominal.dieAreaMm2 === undefined ? null : s.nominal.dieAreaMm2 - baseScore.nominal.dieAreaMm2,
        dDiePowerW: s.nominal.diePowerW === undefined ? null : s.nominal.diePowerW - baseScore.nominal.diePowerW});
    }
  }
  return rows;
}

// Pair hill-climb on the joint pessimistic compute TPS under a nominal floor.
function climb(x0, floor) {
  let x = {...x0}, cur = score(x);
  const path = [];
  for (let step = 0; step < MAX_STEPS; step++) {
    let best = null;
    const fields = Object.keys(MOVES);
    const singles = [];
    for (const f of fields) for (const v of MOVES[f]) if (v !== x[f]) singles.push([f, v]);
    // Pairs include single moves (a move paired with "no move") so a power-neutral single is not missed.
    const candidates = singles.map(m => [m]);
    for (let a = 0; a < singles.length; a++) for (let b = a + 1; b < singles.length; b++) if (singles[a][0] !== singles[b][0]) candidates.push([singles[a], singles[b]]);
    for (const move of candidates) {
      const y = {...x};
      for (const [f, v] of move) y[f] = v;
      const n = nominal(y);
      if (!n.feasible || n.tps < floor) continue;
      const c = pessimistic('compute', y);
      if (!c.feasible || c.tps <= (best ? best.compute.tps : cur.compute.tps) + 0.05) continue;
      best = {move, y, compute: snap(c)};
    }
    if (!best) break;
    x = best.y;
    cur = score(x);
    path.push({step: step + 1, move: best.move.map(([f, v]) => ({field: f, to: v})), nominalTps: cur.nominal.tps, computeTps: cur.compute.tps,
      allUnmeasuredTps: cur.allUnmeasured ? cur.allUnmeasured.tps : null, dieAreaMm2: cur.nominal.dieAreaMm2, diePowerW: cur.nominal.diePowerW, cardPowerW: cur.nominal.cardPowerW});
  }
  return {x, score: cur, path};
}

function build() {
  const text = fs.readFileSync(path.join(root, BASELINE_FILE), 'utf8');
  const spec = JSON.parse(text), x0 = BP.publishedX(spec, 'generate_die_area_reallocation.js');
  const goal = JSON.parse(fs.readFileSync(path.join(root, SPACE_FILE), 'utf8')).requirements.minTpsPerUser;
  const base = score(x0);
  const limits = spec.tpsDesign.hardware.limits;
  const envelope = {
    published: {dieAreaMm2: base.nominal.dieAreaMm2, diePowerW: base.nominal.diePowerW, cardPowerW: base.nominal.cardPowerW, packageAreaMm2: base.nominal.packageAreaMm2},
    limits,
    headroom: {dieAreaMm2: limits.dieAreaMm2 - base.nominal.dieAreaMm2, diePowerW: limits.diePowerW - base.nominal.diePowerW,
      cardPowerW: limits.cardPowerW - base.nominal.cardPowerW, packageAreaMm2: limits.packageAreaMm2 - base.nominal.packageAreaMm2},
    headroomFraction: {dieArea: 1 - base.nominal.dieAreaMm2 / limits.dieAreaMm2, diePower: 1 - base.nominal.diePowerW / limits.diePowerW,
      cardPower: 1 - base.nominal.cardPowerW / limits.cardPowerW, packageArea: 1 - base.nominal.packageAreaMm2 / limits.packageAreaMm2}
  };
  const proposals = FLOORS.map(f => {
    const floor = f.goal ? goal : base.nominal.tps * f.factor;
    const r = climb(x0, floor);
    const changed = Object.fromEntries(Object.keys(MOVES).filter(k => r.x[k] !== x0[k]).map(k => [k, {from: x0[k], to: r.x[k]}]));
    return {floor: f.name, nominalFloorTps: floor, changed, x: r.x, result: r.score, path: r.path,
      holdOut: {allUnmeasuredGainTps: r.score.allUnmeasured && r.score.allUnmeasured.tps !== null ? r.score.allUnmeasured.tps - base.allUnmeasured.tps : null,
        note: 'tuned on the compute point, scored on the point that also moves mcUtil, prediction and launch scale'}};
  });
  return {
    status: 'EXPLORATORY: proposal for HW-01/HW-02 owners. Changes no baseline, gate or published number',
    unit: {tps: 'tokens/s per user', area: 'mm2 per compute die', power: 'W (die and card)'},
    inputs: {baseline: BASELINE_FILE, baselineSha256: crypto.createHash('sha256').update(text).digest('hex'), goalTpsPerUser: goal,
      pessimisticPoints: B.JOINT_PESSIMISTIC, seed: 'deterministic (no random inputs)'},
    caveats: [
      'the joint pessimistic points are invented stress scenarios, not measurements; tuning to one is over-fitting unless the hold-out point agrees',
      'values off the power-of-two grid (e.g. vectorLanes 768) need unit-owner sign-off and a floorplan',
      'every number is a PLANNING model result at TP32 / 1M context / Batch=1'],
    published: base, envelope, marginals: marginals(x0, base), proposals,
    regenerate: 'node integration/pipelines/generate_die_area_reallocation.js (npm run area:explore); checked by tests/regression/test_die_area_reallocation.js'
  };
}

module.exports = {MOVES, FLOORS, MAX_STEPS, score, marginals, climb, build, nominal, pessimistic, BASELINE_FILE};
