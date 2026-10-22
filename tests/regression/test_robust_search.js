'use strict';

// The three margins of the final tuning search (integration/detailed/robust_model.js, ADR-0026).
//
// What it pins:
//  1. The incident that motivated them. The first HBM3E search ranked by TPS/usr and broke ties by die
//     area, and chose 2 MiB of H-core local SRAM where 4 MiB gives the SAME 1154.55 TPS/usr. That point
//     is feasible nominally but not under the joint-pessimistic replays ("H local tile"). Its 4 MiB
//     sibling survives both replays, but is a 375.80 mm2 die that leaves -16.54 mm2 at the observed
//     package keep-out, which the physical search only admitted by falling back to its unverified 0.10
//     keep-out. Squeezing that sibling into the keep-out (rdmaLanes 16 -> 8) gives a third point with a 1.43 us
//     collective, over the 1.15 us tau of the L1 contract's B-TAU; the Comm Core search then finds 0 of
//     216000 candidates feasible. Each point breaks a different margin, and the point the search now keeps
//     breaks none of the three.
//     The vector below is the first one, written out so the test does not move when the published point does.
//  2. The guarantee the search now gives: the published point and every row of the stored search are
//     feasible under both joint-pessimistic replays, fit the window less the observed keep-out and keep every
//     collective within tau, and the result file records the constraint.
//  3. The constraint is a feasibility requirement, not a TPS level, and it is opt-in: with it off the
//     search is the one test_final_search_parallel.js compares against the serial reference.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const O = require('../../integration/detailed/k3_rdma_final_tuning_model.js');
const T = require('../../integration/detailed/k3_tps_design_baseline.js');
const R = require('../../integration/detailed/robust_model.js');

const root = path.resolve(__dirname, '../..');
const results = JSON.parse(fs.readFileSync(path.join(root, 'out/rdma/k3_rdma_final_tuning_results.json'), 'utf8'));
const spec = JSON.parse(fs.readFileSync(path.join(root, 'teams/hardware/inputs/k3_mc_baseline.json'), 'utf8'));
const near = (a, b, tol, what) => assert(Math.abs(a - b) <= tol, `${what}: ${a} vs ${b}`);

// 1. The incident: the first HBM3E search point (hMiB 2) and its hMiB 4 sibling.
const FRAGILE = {
  nL: 8,
  nH: 4,
  lRows: 1,
  lCols: 256,
  lEngines: 8,
  hRows: 48,
  hCols: 128,
  hEngines: 6,
  ghz: 1,
  vectorLanes: 1024,
  lMiB: 1,
  hMiB: 2,
  lBanks: 64,
  hBanks: 64,
  bankBytes: 64,
  sharedMiB: 16,
  sharedSlices: 16,
  tmaEngines: 4,
  tmaBytes: 512,
  nocBytes: 256,
  nocLanes: 4,
  reduceLanes: 2048,
  ucieLanes: 128,
  ucieGbps: 64,
  mcGBs: 1152,
  rdmaLanes: 16,
  weightTileMiB: 8,
  kvTile: 16384,
  headTile: 96,
  depth: 4,
  windowFraction: 1
};
const SIBLING = {...FRAGILE, hMiB: 4};
const fragile = O.evaluate(FRAGILE), sibling = O.evaluate(SIBLING);
assert(fragile.feasible && sibling.feasible, 'both points are nominally feasible');
near(fragile.tps, 1154.5457130708246, 1e-9, 'the fragile point is the first HBM3E search point');
near(sibling.tps, fragile.tps, 1e-9, 'local SRAM does not change the nominal TPS/usr: the search could not tell the two apart');
assert(sibling.p.dieArea > fragile.p.dieArea, 'the 4 MiB point is the larger die, which is why the tie-break preferred 2 MiB');
assert.deepStrictEqual(R.failedReplays(FRAGILE), ['compute', 'allUnmeasured'], 'the 2 MiB point fails both joint-pessimistic replays');
assert.deepStrictEqual(R.failedReplays(SIBLING), [], 'the 4 MiB point survives both');
near(R.packageReserveMm2(fragile), 46.834, 1e-3, 'the 2 MiB point fits the observed keep-out with room to spare');
near(R.packageReserveMm2(sibling), -16.54, 1e-2, 'the 4 MiB point does not fit it');
for (const name of R.REQUIRED) {
  const q = T.replayJoint(T.JOINT_PESSIMISTIC[name], FRAGILE);
  assert.strictEqual(q.feasible, false);
  assert((q.reasons || [q.reason]).includes('H local tile'), `${name}: the 2 MiB point fails on the H-core local tile`);
}
// The constraint, as the pool sees it: an ordinary infeasible result that names the replay.
const refused = R.evaluate(FRAGILE);
assert.strictEqual(refused.feasible, false);
assert.deepStrictEqual(refused.reasons, ['joint pessimistic (compute) infeasible', 'joint pessimistic (allUnmeasured) infeasible']);
// The point the first two margins alone select -- the 4 MiB sibling shrunk to fit the keep-out by halving
// rdmaLanes -- has a 1.43 us collective, over tau: the third margin exists because of it.
const SQUEEZED = {...SIBLING, rdmaLanes: 8, kvTile: 32768, depth: 1};
const squeezed = O.evaluate(SQUEEZED);
assert(squeezed.feasible, 'the squeezed point is nominally feasible');
assert(R.slowestProtocolUs(squeezed) > R.TAU_CEILING_US, 'its slowest collective is over tau');
assert.deepStrictEqual(R.evaluate(SQUEEZED), {feasible: false, reasons: [R.TAU_REASON]});
// The 4 MiB sibling is robust but refused for the package: the constraint names which margin it breaks.
assert.deepStrictEqual(R.evaluate(SIBLING), {feasible: false, reasons: [`package keep-out ${R.KEEP_OUT}`]});
// A point that clears both margins comes back unchanged.
const best = results.search.best;
assert.strictEqual(R.evaluate(best.x).feasible, true);
near(R.evaluate(best.x).tps, O.evaluate(best.x).tps, 0, 'a point that clears both margins comes back unchanged');
// A point that is infeasible on its own is passed through, not relabelled as a robustness failure.
assert.deepStrictEqual(R.evaluate({...FRAGILE, hMiB: 1}), O.evaluate({...FRAGILE, hMiB: 1}));

// 2. What the search guarantees.
assert.deepStrictEqual(results.robustness.requiredFeasibleUnder, R.REQUIRED, 'the result file records which replays a point had to survive');
assert.strictEqual(results.robustness.adr, 'ADR-0026');
assert.deepStrictEqual(results.robustness.values, Object.fromEntries(R.REQUIRED.map(n => [n, T.JOINT_PESSIMISTIC[n]])), 'and the values they used');
assert.strictEqual(results.robustness.packageKeepOut.fraction, R.KEEP_OUT);
assert.strictEqual(results.robustness.collectiveCeiling.tauUs, R.TAU_CEILING_US);
assert.strictEqual(results.robustness.collectiveCeiling.controlPathBudgetUs, R.CONTROL_PATH_BUDGET_US);
assert.strictEqual(results.robustness.collectiveCeiling.evidence, 'ASSUMPTION', 'the control-path budget is a sizing assumption, and the record says so');
// One home for the observed keep-out: the matrix:vector space, pinned by its own test to the physical domain's observed option.
const space = JSON.parse(fs.readFileSync(path.join(root, 'teams/hardware/inputs/matrix_vector_design_space.json'), 'utf8'));
const physical = JSON.parse(fs.readFileSync(path.join(root, 'teams/hardware/inputs/physical_design_space.json'), 'utf8'));
assert.strictEqual(R.KEEP_OUT, space.requirements.packageFit.keepOutFraction);
assert.strictEqual(R.KEEP_OUT, physical.dimensions.reserveFraction.options['0.1254'].reserve, 'and it is the physical domain\'s observed keep-out, not an assumption');
assert(spec.computeDieCandidate.estimatedAreaMm2 > 0);
assert(R.packageReserveMm2({p: {dieArea: spec.computeDieCandidate.estimatedAreaMm2}}) >= 0, 'the published point fits the window less the observed keep-out');
assert.deepStrictEqual(R.failedReplays(spec.tpsDesign.hardware.x), [], 'the published point survives both joint-pessimistic replays');
assert.deepStrictEqual(R.failedReplays(results.search.best.x), [], 'so does the search best');
// Every kept row, not a sample: a row that is not robust means the constraint was not in force.
let checked = 0;
for (const row of results.search.rows) {
  assert.deepStrictEqual(R.failedReplays(row.x), [], `row ${row.id} is not robust`);
  assert(R.packageReserveMm2(row) >= -1e-9, `row ${row.id} does not fit the observed keep-out`);
  assert(R.slowestProtocolUs(row) + R.CONTROL_PATH_BUDGET_US <= R.TAU_CEILING_US + 1e-9, `row ${row.id} has a collective above tau`);
  checked += 1;
}
assert(checked > 100, 'the stored search has rows to check');
// The rejection count names the constraint, so a run that excluded nothing is visible as such.
const refusedBy = Object.keys(results.search.rejects).filter(k => k.startsWith('joint pessimistic') || k.startsWith('package keep-out') || k.startsWith('B-TAU'));
assert.deepStrictEqual(refusedBy.sort(), [R.TAU_REASON, 'joint pessimistic (allUnmeasured) infeasible', 'joint pessimistic (compute) infeasible', `package keep-out ${R.KEEP_OUT}`].sort());

// 3. A feasibility requirement, not a TPS level: the module never reads a TPS.
const source = fs.readFileSync(path.join(root, 'integration/detailed/robust_model.js'), 'utf8');
assert(!/\.tps\b|tpsPerUser/.test(source.replace(/\/\*[\s\S]*?\*\//, '')), 'robust_model.js gates on feasibility only');
// How far the pessimistic point falls is REPORTED here, not gated -- and it is below the 1000 TPS/usr
// target. That is the project's open AC-1 (PRODUCT_REQUIREMENTS.md): the pessimistic point was 921.63 /
// 906.51 TPS/usr before ADR-0026 and is 947.09 / 935.44 after it. The constraint makes the point
// survivable (feasible), it does not make it sufficient. This test pins the direction, so a change that
// quietly closes AC-1 or quietly widens the gap is seen, and it states the target is still missed.
const PESSIMISTIC_BEFORE_ADR_0026 = {compute: 921.63, allUnmeasured: 906.51};
for (const name of R.REQUIRED) {
  const q = T.replayJoint(T.JOINT_PESSIMISTIC[name], spec.tpsDesign.hardware.x);
  assert(q.feasible !== false, `${name}: the published point is feasible under the replay`);
  assert(q.tps > PESSIMISTIC_BEFORE_ADR_0026[name], `${name}: ${q.tps.toFixed(2)} TPS/usr must improve on the ${PESSIMISTIC_BEFORE_ADR_0026[name]} it was before ADR-0026`);
  assert(q.tps < results.target, `${name}: ${q.tps.toFixed(2)} TPS/usr is at or above the ${results.target} target; AC-1 would be closed, and that is a finding to write up, not a number to absorb silently`);
}

console.log(`PASS robust search: the first HBM3E point (hMiB 2) fails both joint-pessimistic replays at ${fragile.tps.toFixed(2)} TPS/usr, its hMiB 4 sibling survives them but misses the observed keep-out by ${(-R.packageReserveMm2(sibling)).toFixed(2)} mm2; the published point and all ${checked} stored rows clear both`);
