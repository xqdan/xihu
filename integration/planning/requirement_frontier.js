'use strict';
/* L1-b requirement frontier and candidate budget contracts (MODEL).
 *
 * Question (teams/council/docs/23_DESIGN_QUESTION_WORKFLOW_PROPOSAL.md, L1-b): to reach the target
 * TPS/usr (raw budget), how much sustained MC bandwidth, how much effective compute and how large a
 * per-collective tau does the design need; how does compute trade against tau; how does on-die SRAM
 * buy back bandwidth.
 *
 * Method (all through the production models; nothing is re-implemented):
 *   1. planning (token_time.js slotTime), every non-blocked model x TP on P1: the memory lane alone
 *      fixes the bandwidth floor (the two lanes run in parallel, so bandwidth does not trade against
 *      tau or compute there); the serial lane flop / computeScale + fixed + exposed TMA
 *      + n x max(tau, bandwidth floor) <= budget is the (computeScale, tau) line;
 *   2. detailed (O.evaluate, K3 TP32 at the published x): the smallest MC payload per cube that holds
 *      the budget over a sharedMiB x depth grid, i.e. how much bandwidth the shared window and the
 *      prefetch lookahead buy back; and how the lanes couple there (DMA wait hides under compute and
 *      collectives, so taking bandwidth to its floor costs tau room, which the planning lanes cannot show);
 *   3. splits: each relaxes some axes of the published point (tau at the spec basis, compute scale 1,
 *      MC640) to the boundary where every non-blocked planning slot at TP32 AND the detailed K3 point
 *      still hold. Each split is a complete candidate contract (budget-contract-v0.1).
 *
 * Agents in design.req.budget choose between splits and judge physical reachability; they never write
 * a number. This file changes no baseline, gate or published number.
 */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const TT = require('./token_time.js');
const RES = require('../../teams/hardware/src/resource_profiles');
const A = require('../detailed/k3_architecture_search.js');
const O = require('../detailed/k3_rdma_final_tuning_model.js');
const B = require('../detailed/k3_tps_design_baseline.js');
const P = require('../detailed/k3_physical_basis.js');
const BP = require('../detailed/baseline_point.js');

const root = path.resolve(__dirname, '../..');
const BASELINE_FILE = 'teams/hardware/inputs/k3_mc_baseline.json';
const WORKLOAD_FILE = 'out/workload/planning_operator_workload.json';
const KERNEL_FILE = 'integration/planning/requirement_frontier.js';
const OUT_FILE = 'out/requirements/budget_frontier.json';
const SCHEMA_VERSION = 'budget-frontier-v0.1';
const CONTRACT_SCHEMA = 'budget-contract-v0.1';
const TPS_LIST = [8, 16, 32];
// The contract is written for the published TP (detailed K3 TP32); the other TPs are reported only.
const CONTRACT_TP = 32;
const PROFILE = 'P1';
const REF_MC = 'MC640';
const COMPUTE_SCALES = [0.5, 0.75, 1, 1.5, 2];
const TAUS = [1.0, 1.15, 1.3, 1.5, 2.0];
const SHARED_GRID = [8, 10, 12, 13, 14, 16, 20, 24];
const DEPTH_GRID = [0, 1, 2, 4];
// Detailed compute scale: the achieved fraction of every engine peak, scaled together (the planning
// computeCapacity scales the same peaks).
const COMPUTE_TECH = ['matrixUtil', 'vectorUtil', 'reduceUtil', 'unpackParamsPerLaneCycle'];
// Search ranges per axis: [published side is easy, far end is hard]. The MC payload stops at the
// published MC640 (above it the card power limit binds first).
const HARD = {tauUs: 3, computeScale: 0.3, mcGBs: 160};
const ITER = 16;

const OWNER_AGENT = {mc: 'memory-expert', sram: 'memory-expert', compute: 'compute-expert', comm: 'comm-expert', physical: 'physical-expert'};

const sha256 = text => crypto.createHash('sha256').update(text).digest('hex');
const safe = fn => {
  try { return fn(); } catch (e) { return {feasible: false, reasons: [`model error: ${e.message}`]}; }
};
const snap = r => {
  if (r && r.feasible !== false) return {feasible: true, tpsPerUser: r.tps, rawUs: r.rawUs, dieAreaMm2: r.p.dieArea, diePowerW: r.p.diePower, cardPowerW: r.p.cardPower};
  const reasons = ((r && (r.reasons || [r.reason])) || []).filter(Boolean);
  return {feasible: false, reasons: reasons.length ? reasons : ['infeasible']};
};

function context(options = {}) {
  const text = options.text || fs.readFileSync(path.join(root, BASELINE_FILE), 'utf8');
  const workloadText = options.workloadText || fs.readFileSync(path.join(root, WORKLOAD_FILE), 'utf8');
  const spec = JSON.parse(text);
  const workload = JSON.parse(workloadText);
  const x = BP.publishedX(spec, 'generate_budget_frontier.js');
  const models = Object.keys(workload.provenance);
  const planning = Object.fromEntries(models.map(m => [m, TT.planningModel(workload, m)]));
  return {spec, workload, x, planning,
    active: models.filter(m => planning[m]),
    blocked: models.filter(m => !planning[m]),
    tech: Object.fromEntries(COMPUTE_TECH.map(k => [k, A.TECH[k]])),
    target: {tpsPerUser: spec.goal.target, architectureGate: spec.acceptance.architectureGateTpsPerUser,
      rawBudgetUs: spec.goal.rawLatencyBudgetUs, engineeringMargin: spec.goal.engineeringMargin},
    published: {tauUs: O.OPT.tauUs, computeScale: 1, mcGBs: x.mcGBs},
    sourceArtifacts: [{path: BASELINE_FILE, sha256: sha256(text)}, {path: WORKLOAD_FILE, sha256: sha256(workloadText)}],
    memo: new Map()};
}

const budgetFor = tps => 1e6 / (tps * TT.MARGIN);
const slot = tp => ({tp, physicalProfile: PROFILE, mcProfile: REF_MC});
const refPayload = () => RES.mcProfiles[REF_MC].payloadGBsPerCube;

// ---- the two models at one point {tauUs, computeScale, mcGBs} ---------------------------------

function planningAt(ctx, model, tp, point) {
  return TT.slotTime(ctx.planning[model], slot(tp), ctx.workload.calibration,
    {...TT.NOMINAL, bandwidth: point.mcGBs / refPayload(), computeCapacity: point.computeScale, tauUs: point.tauUs});
}

function detailedAt(ctx, point, {sharedMiB = ctx.x.sharedMiB, depth = ctx.x.depth} = {}) {
  const key = JSON.stringify([point.tauUs, point.computeScale, point.mcGBs, sharedMiB, depth]);
  if (!ctx.memo.has(key)) {
    const tech = Object.fromEntries(COMPUTE_TECH.map(k => [k, ctx.tech[k] * point.computeScale]));
    ctx.memo.set(key, snap(safe(() => B.withOpt({tauUs: point.tauUs}, {...ctx.x, mcGBs: point.mcGBs, sharedMiB, depth},
      y => B.withTech(tech, () => O.evaluate(y))))));
  }
  return ctx.memo.get(key);
}

const planningHolds = (ctx, budgetUs, models = ctx.active) => point => models.every(m => planningAt(ctx, m, CONTRACT_TP, point).rawUs <= budgetUs);
const detailedHolds = (ctx, budgetUs, where) => point => {
  const s = detailedAt(ctx, point, where);
  return s.feasible && s.rawUs <= budgetUs;
};

// Value closest to `hard` at which ok() still holds, bisecting from `easy` (assumed monotone).
// null when the easy end already fails; the hard end when it holds across the range.
function edge(ok, easy, hard, iter = ITER) {
  if (!ok(easy)) return null;
  if (ok(hard)) return hard;
  let good = easy, bad = hard;
  for (let i = 0; i < iter; i++) {
    const mid = (good + bad) / 2;
    if (ok(mid)) good = mid; else bad = mid;
  }
  return good;
}

// ---- 1. planning frontier ----------------------------------------------------------------------

function planningSlot(ctx, model, tp, budgetUs) {
  const ref = planningAt(ctx, model, tp, ctx.published);
  const floorUs = TT.laneTimes(ctx.planning[model], slot(tp), {...TT.NOMINAL, tauUs: 0}).perCollectiveUs;
  const n = ref.collectivesPerToken;
  const rest = ref.fixedUs + ref.tmaExposedUs;
  const scale = ref.memoryLaneUs / budgetUs;
  const payload = scale * refPayload();
  const tauMax = s => {
    const t = (budgetUs - ref.flopUs / s - rest) / n;
    return t >= floorUs ? t : null;
  };
  const scaleMin = tau => {
    const room = budgetUs - rest - n * Math.max(tau, floorUs);
    return room > 0 ? ref.flopUs / room : null;
  };
  const nominal = Object.fromEntries(Object.keys(RES.mcProfiles).map(mc => {
    const t = TT.slotTime(ctx.planning[model], {tp, physicalProfile: PROFILE, mcProfile: mc}, ctx.workload.calibration);
    return [mc, {rawUs: t.rawUs, tpsPerUser: t.tpsPerUser, bound: t.bound}];
  }));
  return {tp,
    memoryLaneUsAtMC640: ref.memoryLaneUs,
    bandwidthMin: {mcPayloadGBsPerCube: payload, effectiveBytesPerSecond: scale * RES.mcProfiles[REF_MC].effectiveBytesPerSecond,
      withinMC320: payload <= RES.mcProfiles.MC320.payloadGBsPerCube, withinMC640: payload <= refPayload()},
    serial: {flopUs: ref.flopUs, fixedUs: ref.fixedUs, tmaExposedUs: ref.tmaExposedUs, collectivesPerToken: n, collectiveBandwidthFloorUs: floorUs},
    tauMaxByComputeScale: COMPUTE_SCALES.map(s => ({computeScale: s, tauMaxUs: tauMax(s)})),
    tauMaxAtUnboundedComputeUs: tauMax(Infinity),
    computeScaleMinByTau: TAUS.map(tau => ({tauUs: tau, computeScaleMin: scaleMin(tau)})),
    // Bytes per collective / tau: the network bandwidth below which the collective leaves the tau floor.
    networkMinBytesPerSecondByTau: TAUS.map(tau => ({tauUs: tau, bytesPerSecond: floorUs * RES.networkBandwidth / tau})),
    nominal};
}

function planningFrontier(ctx, budgetUs) {
  return {
    slot: {physicalProfile: PROFILE, bandwidthReference: REF_MC, calibration: `${WORKLOAD_FILE}#/calibration`, networkBytesPerSecond: RES.networkBandwidth},
    definitions: {
      bandwidthMin: 'memory lane at MC640 x MC640 bandwidth / raw budget (the memory lane is linear in 1 / bandwidth); mcPayloadGBsPerCube is at the sustained fraction of resource_profiles.mcProfiles',
      tauMax: '(budget - flopUs / computeScale - fixedUs - tmaExposedUs) / collectivesPerToken; null below the collective bandwidth floor',
      computeScaleMin: 'flopUs / (budget - fixedUs - tmaExposedUs - collectivesPerToken x max(tau, floor)); null when the rest of the serial lane alone exceeds the budget',
      lanes: 'raw = max(memory lane, serial lane): bandwidth must hold on its own; compute and tau share the serial lane'
    },
    blocked: ctx.blocked,
    models: ctx.active.map(model => ({model, status: ctx.workload.provenance[model].status,
      slots: TPS_LIST.map(tp => planningSlot(ctx, model, tp, budgetUs))}))
  };
}

// ---- 2. detailed grid --------------------------------------------------------------------------

function detailedGrid(ctx, budgetUs) {
  const cells = [];
  for (const sharedMiB of SHARED_GRID) for (const depth of DEPTH_GRID) {
    const where = {sharedMiB, depth};
    const at640 = detailedAt(ctx, ctx.published, where);
    const min = edge(mc => detailedHolds(ctx, budgetUs, where)({...ctx.published, mcGBs: mc}), ctx.published.mcGBs, HARD.mcGBs);
    cells.push({sharedMiB, depth, mcPayloadGBsPerCubeMin: min, atMC640: at640.feasible
      ? {feasible: true, rawUs: at640.rawUs, dieAreaMm2: at640.dieAreaMm2}
      : {feasible: false, reasons: at640.reasons}});
  }
  const atDepth = cells.filter(c => c.depth === ctx.x.depth && c.mcPayloadGBsPerCubeMin !== null);
  const substitution = atDepth.slice(1).map((c, i) => ({fromSharedMiB: atDepth[i].sharedMiB, toSharedMiB: c.sharedMiB,
    dMcGBsPerSharedMiB: (c.mcPayloadGBsPerCubeMin - atDepth[i].mcPayloadGBsPerCubeMin) / (c.sharedMiB - atDepth[i].sharedMiB)}));
  return {sharedMiB: SHARED_GRID, depth: DEPTH_GRID, at: {tauUs: ctx.published.tauUs, computeScale: 1}, cells,
    substitutionAtPublishedDepth: {depth: ctx.x.depth, rows: substitution}};
}

// ---- 3. splits ---------------------------------------------------------------------------------

const AXES = ['tauUs', 'computeScale', 'mcGBs'];
// Single-axis bound under one model family (planning: every active model; detailed: K3).
function axisBound(ok, ctx, axis, base = ctx.published) {
  return edge(v => ok({...base, [axis]: v}), base[axis], HARD[axis]);
}
const tighter = (axis, a, b) => {
  if (a === null || b === null) return null;
  return axis === 'tauUs' ? Math.min(a, b) : Math.max(a, b);
};

function singleAxis(ctx, axis, budgetUs) {
  const perModel = ctx.active.map(m => ({model: m, value: axisBound(planningHolds(ctx, budgetUs, [m]), ctx, axis)}));
  const valid = perModel.filter(p => p.value !== null);
  const pBind = valid.length < perModel.length ? null
    : valid.reduce((a, b) => (tighter(axis, a.value, b.value) === a.value ? a : b));
  const planning = pBind && pBind.value;
  const detailed = axisBound(detailedHolds(ctx, budgetUs), ctx, axis);
  const value = tighter(axis, planning, detailed);
  return {axis, value, planning: {value: planning, binding: pBind ? pBind.model : null, perModel}, detailed: {value: detailed, model: 'K3'},
    binding: value === null ? null : (value === detailed ? 'detailed:K3' : `planning:${pBind.model}`)};
}

// Equal share f of every axis's single-axis room, the largest f at which both models still hold.
function balanced(ctx, rooms, budgetUs) {
  const at = f => Object.fromEntries(AXES.map(a => [a, ctx.published[a] + f * (rooms[a] - ctx.published[a])]));
  const ok = f => planningHolds(ctx, budgetUs)(at(f)) && detailedHolds(ctx, budgetUs)(at(f));
  const pf = edge(f => planningHolds(ctx, budgetUs)(at(f)), 0, 1);
  const df = edge(f => detailedHolds(ctx, budgetUs)(at(f)), 0, 1);
  const f = edge(ok, 0, 1);
  return {f, planning: pf, detailed: df, binding: f === df ? 'detailed:K3' : 'planning', point: at(f)};
}

const SPLITS = [
  {splitId: 'S-TAU', relaxes: ['tauUs'], intent: 'tau wide: compute at the published P1 rate and MC640 held; tau takes the whole serial room'},
  {splitId: 'S-CMP', relaxes: ['computeScale'], intent: 'compute wide: tau at the spec basis and MC640 held; effective compute may drop to the boundary'},
  {splitId: 'S-BW', relaxes: ['mcGBs'], intent: 'bandwidth wide: tau at the spec basis and published compute held; MC payload may drop to the boundary'},
  {splitId: 'S-BAL', relaxes: AXES, intent: 'balanced: every axis gives up the same share of its single-axis room'}
];

function entries(ctx, point, budgetUs, derivedBounds) {
  const set = axis => (derivedBounds[axis] ? 'derived' : 'fixed by split');
  const bound = axis => (derivedBounds[axis] ? {bound: derivedBounds[axis]} : {});
  // Smallest shared window (published depth) at which the detailed point still holds.
  const sram = SHARED_GRID.map(sharedMiB => ({sharedMiB, holds: detailedHolds(ctx, budgetUs, {sharedMiB})(point)}));
  const sramMin = (sram.find(s => s.holds) || {}).sharedMiB;
  const atPublished = detailedAt(ctx, point);
  const atSramMin = sramMin === undefined ? null : detailedAt(ctx, point, {sharedMiB: sramMin});
  const area = s => (s && s.feasible ? {dieAreaMm2: s.dieAreaMm2, diePowerW: s.diePowerW, cardPowerW: s.cardPowerW} : null);
  const entry = (id, lane, quantity, kind, value, owner, extra) => ({id, lane, quantity, [kind]: value, owner, ownerAgent: OWNER_AGENT[owner], ...extra});
  return [
    entry('B-MEM-BW', 'memory', 'mcPayloadGBsPerCube', 'min', point.mcGBs, 'mc', {
      effectiveBytesPerSecond: point.mcGBs / refPayload() * RES.mcProfiles[REF_MC].effectiveBytesPerSecond,
      sustainedFraction: A.TECH.mcUtil, set: set('mcGBs'), ...bound('mcGBs')}),
    entry('B-SERIAL-CMP', 'serial', 'computeScale', 'min', point.computeScale, 'compute', {
      reference: 'P1 engine peaks x A.TECH achieved fractions (matrixUtil, vectorUtil, reduceUtil, unpackParamsPerLaneCycle) = 1',
      serialComputeUsMax: ctx.active.map(m => {
        const t = planningAt(ctx, m, CONTRACT_TP, point);
        return {model: m, serialComputeUsMax: budgetUs - t.commUs};
      }),
      set: set('computeScale'), ...bound('computeScale')}),
    entry('B-TAU', 'serial', 'tauUs', 'max', point.tauUs, 'comm', {set: set('tauUs'), ...bound('tauUs')}),
    entry('B-SRAM-CAP', 'memory', 'sharedMiBPerDie', 'min', sramMin === undefined ? null : sramMin, 'sram', {
      scope: 'detailed K3 TP32 only (the planning model has no SRAM term); other models UNCORROBORATED',
      depth: ctx.x.depth, holdsBySharedMiB: sram, set: 'derived'}),
    // The limits the detailed model enforces (O.evaluate resizes through k3_physical_basis), not the
    // air-cooled A.LIMITS powers.
    entry('B-AREA', 'physical', 'dieAreaMm2', 'max', P.BASIS.limits.dieArea, 'physical', {
      limits: {dieAreaMm2: P.BASIS.limits.dieArea, diePowerW: P.BASIS.limits.diePower, cardPowerW: P.BASIS.limits.cardPower},
      basis: {process: P.BASIS.process, cooling: P.BASIS.cooling},
      atPublishedSram: area(atPublished), atSramMin: area(atSramMin), set: 'k3_physical_basis.BASIS.limits'})
  ];
}

function contract(ctx, split, point, budgetUs, derivedBounds) {
  const planning = ctx.active.map(m => {
    const t = planningAt(ctx, m, CONTRACT_TP, point);
    return {model: m, rawUs: t.rawUs, tpsPerUser: t.tpsPerUser, bound: t.bound, memoryLaneUs: t.memoryLaneUs, serialLaneUs: t.serialLaneUs};
  });
  const detailed = detailedAt(ctx, point);
  return {
    schemaVersion: CONTRACT_SCHEMA,
    layer: 'L1',
    splitId: split.splitId,
    intent: split.intent,
    generatedBy: KERNEL_FILE,
    sourceArtifacts: ctx.sourceArtifacts,
    target: ctx.target,
    scope: {tp: CONTRACT_TP, physicalProfile: PROFILE, planningModels: ctx.active, blockedModels: ctx.blocked, detailedModel: 'K3 TP32 at tpsDesign.hardware.x'},
    point,
    split: entries(ctx, point, budgetUs, derivedBounds),
    coupling: [
      {between: ['B-SERIAL-CMP', 'B-TAU'], via: 'planning serial lane: flopUs / computeScale + fixedUs + tmaExposedUs + collectivesPerToken x max(tau, floor) <= budget', source: `${OUT_FILE}#/planning`},
      {between: ['B-SRAM-CAP', 'B-MEM-BW'], via: 'detailed shared window x prefetch depth: a smaller window needs more MC payload', source: `${OUT_FILE}#/detailed/sharedDepthGrid`},
      {between: ['B-MEM-BW', 'B-TAU'], via: 'detailed DMA wait hides under compute and collectives: bandwidth at its floor leaves less tau room', source: `${OUT_FILE}#/detailed/laneCoupling`}
    ],
    check: {holds: planning.every(p => p.rawUs <= budgetUs) && detailed.feasible && detailed.rawUs <= budgetUs, budgetUs, planning, detailed},
    evidenceLevel: 'MODEL'
  };
}

function build(options = {}) {
  const ctx = options.context || context(options);
  const budgetUs = ctx.target.rawBudgetUs;
  if (Math.abs(budgetUs - budgetFor(ctx.target.tpsPerUser)) > 1e-9) throw new Error('raw budget does not match target and margin');
  const single = Object.fromEntries(AXES.map(a => [a, singleAxis(ctx, a, budgetUs)]));
  const missing = AXES.filter(a => single[a].value === null);
  if (missing.length) throw new Error(`published point misses the budget on ${missing.join(', ')}`);
  const bal = balanced(ctx, Object.fromEntries(AXES.map(a => [a, single[a].value])), budgetUs);
  const splits = SPLITS.map(split => {
    const point = split.splitId === 'S-BAL' ? bal.point
      : {...ctx.published, [split.relaxes[0]]: single[split.relaxes[0]].value};
    const derived = split.splitId === 'S-BAL'
      ? Object.fromEntries(AXES.map(a => [a, {share: bal.f, planningShare: bal.planning, detailedShare: bal.detailed, binding: bal.binding, singleAxisRoom: single[a].value}]))
      : {[split.relaxes[0]]: single[split.relaxes[0]]};
    return {splitId: split.splitId, relaxes: split.relaxes, contract: contract(ctx, split, point, budgetUs, derived)};
  });
  const bwFloor = single.mcGBs.value;
  const laneCoupling = [ctx.published.mcGBs, bwFloor].map(mc => ({mcPayloadGBsPerCube: mc,
    tauMaxUs: axisBound(detailedHolds(ctx, budgetUs), ctx, 'tauUs', {...ctx.published, mcGBs: mc}),
    planningTauMaxUs: axisBound(planningHolds(ctx, budgetUs), ctx, 'tauUs', {...ctx.published, mcGBs: mc})}));
  return {
    schemaVersion: SCHEMA_VERSION,
    status: 'MODEL (planning token time + detailed K3 TP32 replay); not a measurement',
    question: 'how much sustained bandwidth, effective compute and tau the target needs, and how they trade',
    generatedBy: KERNEL_FILE,
    inputs: {sourceArtifacts: ctx.sourceArtifacts, publishedPoint: `${BASELINE_FILE}#tpsDesign.hardware.x`, published: {...ctx.published, sharedMiB: ctx.x.sharedMiB, depth: ctx.x.depth}},
    target: ctx.target,
    gateBudgetUs: budgetFor(ctx.target.architectureGate),
    planning: planningFrontier(ctx, budgetUs),
    detailed: {model: 'K3 TP32', published: detailedAt(ctx, ctx.published), sharedDepthGrid: detailedGrid(ctx, budgetUs),
      laneCoupling: {note: 'tau room at the published MC payload and at the S-BW floor; the planning lanes do not couple, the detailed ones do', rows: laneCoupling}},
    singleAxis: single,
    splits,
    caveats: [
      'every number is MODEL: planning factors are fitted on K3 only (ADR-0006); the detailed model covers K3 TP32 only',
      'software switches stay at the published OPT on every replay (no re-tuning), as in the attribution cards',
      'B-SRAM-CAP and the detailed half of every bound are K3 only; the other models are bounded by the planning model alone',
      'tau below the planning collective bandwidth floor makes no difference; tau physical reachability is open (B-008)',
      'the MC payload search stops at MC640; a split that needs more than MC640 is not offered'
    ]
  };
}

module.exports = {build, context, planningAt, detailedAt, edge, BASELINE_FILE, WORKLOAD_FILE, OUT_FILE, SCHEMA_VERSION, CONTRACT_SCHEMA,
  CONTRACT_TP, SHARED_GRID, DEPTH_GRID, COMPUTE_TECH, SPLITS};
