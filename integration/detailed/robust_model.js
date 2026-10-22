'use strict';
/* Worker-side evaluation for the final tuning search with three margins the model's own limits do not
 * see (ADR-0026).
 *
 * The search ranks feasible points by TPS/usr and breaks ties by smaller die area. Both are blind to:
 *
 *  1. Margin against the parameters nobody has measured. Two points with the same nominal TPS/usr can
 *     differ in whether they survive the pessimistic ends of those parameters, and the smaller die wins
 *     the tie. Under ADR-0026 the tie fell to a point with 2 MiB of H-core local SRAM instead of 4 MiB,
 *     the same 1154.55 TPS/usr, and a joint-pessimistic replay that no longer fits an H-core tile
 *     ("H local tile") where the 4 MiB point still gave 1021.85 TPS/usr. So a point must ALSO be feasible
 *     under both joint-pessimistic replays of k3_tps_design_baseline.js: `compute` (the die side) and
 *     `allUnmeasured` (adds the memory and software side). This is a feasibility requirement, not a TPS
 *     level: how far the pessimistic point falls is reported, not gated.
 *
 *  2. The package keep-out. The model checks the 5248 mm2 placement window with no keep-out, but the
 *     physical domain holds back the OBSERVED share of it (0.1254 of the window; ADR-0023: "not a
 *     verified floor, and not to be relaxed to obtain a feasible point"). The 4 MiB point above is a
 *     375.80 mm2 die that leaves -16.54 mm2 at the observed keep-out; downstream the physical search
 *     quietly fell back to its unverified 0.10 keep-out to admit it. So a point must also fit the window
 *     less the observed keep-out, with the same arithmetic as matrix_vector_search.js and the physical
 *     search: 8 dies at the evaluated die area (shared-port charge included) plus the memory cubes.
 *
 *  3. The per-collective ceiling. The L1 contract's B-TAU bounds the slowest collective: its protocol time
 *     plus the Comm Core's control path must stay under tau (1.15 us), and the Comm Core search and the
 *     coupling search both judge it. The tuning model does not: it books max(protocol, tau) per collective
 *     (services.tauFloor), so a point whose slowest class takes 1.43 us still reports a throughput. Without
 *     this, the point the first two margins select (373.00 mm2, rdmaLanes 8) has a 1.43 us collective, and
 *     the Comm Core search finds 0 of 216000 candidates feasible and the coupling search 0 of 76.
 *     The control path is the Comm Core search's product and that search reads the published point this
 *     search produces, so it cannot be read here without a cycle. The ceiling is therefore tested against
 *     the protocol time plus CONTROL_PATH_BUDGET_US, a constant taken from the largest per-class control path
 *     of the committed Comm Core design (0.042 us). ASSUMPTION: that design's cycle counts are themselves
 *     unverified (O-018) and the Comm Core search may choose another winner; the constant is a sizing
 *     input, and the Comm Core search remains the judge of whether its own control path fits.
 *
 * It runs inside the worker pool: `evaluate` has the signature the pool calls, and an excluded point is
 * returned as an ordinary infeasible result, so the search loop counts it under `rejects` without any
 * change to its bookkeeping or to the shape of the rows it keeps.
 */
const fs = require('fs');
const path = require('path');
const A = require('./k3_architecture_search.js');
const O = require('./k3_rdma_final_tuning_model.js');
const T = require('./k3_tps_design_baseline.js');

const root = path.resolve(__dirname, '../..');
const readJson = file => JSON.parse(fs.readFileSync(path.join(root, file), 'utf8'));
const SPEC_FILE = 'teams/hardware/inputs/k3_mc_baseline.json';
// The observed keep-out has one home: the matrix:vector space, whose test pins it to the physical
// domain's `reserveFraction` option recorded as observed (0.1254 = 658.29 / 5248).
const KEEP_OUT_FILE = 'teams/hardware/inputs/matrix_vector_design_space.json';

const REQUIRED = ['compute', 'allUnmeasured'];
// out/detailed/comm_core_design.json#evaluation: the largest per-class control path (LSE merge 0.042 us;
// the others 0.040-0.042). A constant on purpose -- see the cycle note above.
const CONTROL_PATH_BUDGET_US = 0.042;
const spec = readJson(SPEC_FILE);
const KEEP_OUT = readJson(KEEP_OUT_FILE).requirements.packageFit.keepOutFraction;
const WINDOW_MM2 = spec.package.placementWindowMm2;
const CUBE_MM2 = spec.package.memoryCubeAreaMm2Planning;
const CUBES = spec.card.memoryCubes;
const EPS = 1e-9;
const TAU_REASON = 'B-TAU: slowest collective above tau';
// B-TAU's ceiling is the L1 contract's own tau: the spec basis the tuning model floors every collective at.
const TAU_CEILING_US = O.OPT.tauUs;

// Room left in the window after the keep-out, for an evaluated point (negative: it does not fit).
const packageReserveMm2 = r => WINDOW_MM2 * (1 - KEEP_OUT) - (A.LIMITS.dies * r.p.dieArea + CUBES * CUBE_MM2);

// Single slowest collective of an evaluated point: protocol time of the worst class, per collective.
const slowestProtocolUs = r => Math.max(...r.protocol.map(k => k.timeUs / k.count));

// Names of the joint-pessimistic replays x does not survive (empty: x is robust).
const failedReplays = x => REQUIRED.filter(name => T.replayJoint(T.JOINT_PESSIMISTIC[name], x).feasible === false);

function evaluate(x) {
  const r = O.evaluate(x);
  if (!r.feasible) return r;
  if (packageReserveMm2(r) < -EPS) return {feasible: false, reasons: [`package keep-out ${KEEP_OUT}`]};
  if (slowestProtocolUs(r) + CONTROL_PATH_BUDGET_US > TAU_CEILING_US + EPS) return {feasible: false, reasons: [TAU_REASON]};
  const failed = failedReplays(x);
  return failed.length
    ? {feasible: false, reasons: failed.map(name => `joint pessimistic (${name}) infeasible`)}
    : r;
}

// What the result file records about the constraint a search ran under.
const describe = () => ({
  adr: 'ADR-0026',
  requiredFeasibleUnder: REQUIRED,
  values: Object.fromEntries(REQUIRED.map(name => [name, T.JOINT_PESSIMISTIC[name]])),
  packageKeepOut: {fraction: KEEP_OUT, windowMm2: WINDOW_MM2, cubes: CUBES, cubeAreaMm2: CUBE_MM2, source: `${KEEP_OUT_FILE}#requirements.packageFit.keepOutFraction`},
  collectiveCeiling: {tauUs: TAU_CEILING_US, controlPathBudgetUs: CONTROL_PATH_BUDGET_US, evidence: 'ASSUMPTION', source: 'out/detailed/comm_core_design.json#evaluation (largest per-class control path); a constant because that search reads this search\'s published point'},
  note: 'a point is feasible only if it is also feasible under every listed joint-pessimistic replay, fits the placement window less the observed keep-out, and its slowest collective (protocol time plus the control-path budget) stays within tau; feasibility, not a TPS level'
});

module.exports = {evaluate, failedReplays, packageReserveMm2, slowestProtocolUs, describe, REQUIRED, KEEP_OUT, CONTROL_PATH_BUDGET_US, TAU_CEILING_US, TAU_REASON};
