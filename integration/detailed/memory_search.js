'use strict';
/* Memory domain design search (HW-04, teams/hardware/docs/04_MEMORY_SUBSYSTEM_MC.md).
 *
 * The design space is HW-04's input, teams/hardware/inputs/memory_design_space.json:
 * link bandwidth per cube, cubes per card, usable capacity per cube, which of the
 * document's section 5 routes the design commits to, and the ECC overhead charged
 * to raw capacity. search() enumerates the product and scores every candidate on
 *
 * Port topology (confirmed by the project owner, 2026-10-02): each memory cube has
 * its own UCIe port, so the port limit applies per cube and there is no shared-port
 * term to charge. The per-cube cap min(tier x mcUtil, port) below is therefore the
 * model, not a simplification.
 *
 *  1. the per-die deliverable bandwidth -- min(mcGBs x TECH.mcUtil, the UCIe port
 *     bandwidth) x cubesPerComputeDie. The link is the limit, not the cube: a
 *     candidate whose cube count x tier implies more than the port can carry is
 *     infeasible, not merely expensive;
 *  2. the capacity floor -- cubesPerCard x capacityGBPerCube x (1 - eccOverhead)
 *     against the K3 per-rank backing requirement at 1M context;
 *  3. the K3 detailed replay (O.evaluate) at the published point with only mcGBs
 *     changed, which must keep the published TPS/usr within the tolerance;
 *  4. the package and card limits (P.resize), which the cube count and the tier
 *     move through packageArea and mcPower.
 *
 * A candidate is feasible if the capacity floor holds, the K3 replay keeps the
 * published TPS/usr within the tolerance, the die/package/card limits hold and the
 * route is consistent with the tier and the cube count it picked (picking route
 * mcX while asking for the reference 320 GB/s part is a contradiction, and the
 * search must reject it rather than let it win on price).
 *
 * Feasible candidates are ranked by manufacturing risk class (a REFERENCE part is
 * not the same product as a STRETCH_AGGRESSIVE one), then by card-level MC power,
 * then by capacity margin above the floor.
 *
 * build() writes only the winner (out/detailed/memory_design.json); candidates()
 * writes the whole scored candidate set with a fingerprint over it
 * (out/detailed/memory_candidates.json) -- see matrix_vector_search.js for why a
 * winner-only artifact cannot support "every exclusion is traceable".
 * alternatives() gives the best candidate of every option and analysis() the tier
 * sweep, the cube-count sweep and the route consistency table, which the document
 * quotes.
 *
 * Evidence class MODEL. The tiers, the cube grid, the capacity options and the
 * reference part are baseline values (ADR-0019, references/README.md); the
 * capacity floor is taken from the K3 planning workload; the ECC overhead is an
 * ASSUMPTION the domain owner must replace or delete. This file and the space it
 * reads were drafted by an agent and are UNVERIFIED until a domain owner signs them.
 */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const A = require('./k3_architecture_search.js');
const O = require('./k3_rdma_final_tuning_model.js');
const P = require('./k3_physical_basis.js');
const E = require('../../teams/model/src/design_engine.js');
const CONTRACT = require('./design_contract.js');

const root = path.resolve(__dirname, '../..');
const SPACE_FILE = 'teams/hardware/inputs/memory_design_space.json';
const read = p => JSON.parse(fs.readFileSync(path.join(root, p), 'utf8'));
const EPS = 1e-9;
const MiB = 1024 * 1024;
// Risk order of the tier classifications. Lower is a safer product to promise:
// a REFERENCE part is shipping silicon, a STRETCH_AGGRESSIVE one is a target.
const RISK = {REFERENCE: 0, GRID: 1, DEFAULT_SEARCH_CAP: 2, AGGRESSIVE: 3, STRETCH_AGGRESSIVE: 4};
// Routes the search cannot score because the mechanism they name is outside this
// module's dimensions. They stay in the design space and in the routes table, but
// they cannot be the winner: a winner has to be a combination the numbers actually
// describe. Each one names what would have to be modelled to score it.
const HELD_OUT_ROUTES = {
  dualDataPlane: 'a second 320 GB/s data plane per cube (doubled PHY, bumps and controllers): the model carries one bandwidth number per cube',
  nearMemoryCompute: 'compute inside the cube: architectureRoute keeps it out of the baseline, and the cube area would no longer be the planning 100 mm2',
};

// Routes that ARE scored but cannot be the baseline winner yet, because the thing they rely on is
// an open decision rather than a model gap. `variant` names the replay input they change.
// A conditional candidate is held to every limit except the published-point tolerance and the
// B-MEM-BW clause (it moves the point, and the bytes the clause is priced on, by design); it is
// reported next to the winner as the alternative if the condition closes.
const CONDITIONAL_ROUTES = {
  fewerBytesPerToken: {
    variant: 'fp8Dense',
    conditionedOn: 'FP8 accuracy sign-off for the dense (attention, shared-expert, latent) projections: B-001 / O-012, PRECISION_POLICY.md section 2.3',
    meaning: 'K3 dense projections stored as FP8 (the GLM-5.2 / DeepSeek-V4-Pro dense policy); routed experts, KV and activations unchanged',
    limitation: 'the detailed replay applies FP8 to every dense matrix including the router and LM head (about 1% of the rank bytes); the planning comparison model keeps those two in BF16'
  }
};
// Software knobs re-tuned per (variant, tier). The published knobs were searched for BF16: with FP8 dense
// they leave TPS non-monotonic in the MC tier (a deeper prefetch thrashes the shared window), so replaying
// them unchanged would understate the route. Hardware stays at the published point.
const RETUNE = {depth: [1, 2, 4], weightTileMiB: [4, 8], windowFraction: [0.5, 0.75, 1], kvTile: [16384, 32768]};
const DENSE_BYTES = {fp8Dense: 1};
const variantReplays = new Map();

// Fingerprint of a candidate set. Stable across runs and across machines: fields
// sorted, numbers rounded to reported precision, digest over JSON with an explicit
// key order. A fingerprint that depends on enumeration order is worse than none --
// it would disagree between two identical searches.
function fingerprint(candidates) {
  const canon = candidates.map(c => ({
    pick: Object.fromEntries(Object.entries(c.pick).sort(([a], [b]) => (a < b ? -1 : 1))),
    feasible: c.feasible,
    violations: [...c.violations].sort(),
    cubesPerCard: c.cubesPerCard,
    capacityGBPerCard: Number(c.capacityGBPerCard.toFixed(9)),
    dieGBs: Number(c.dieGBs.toFixed(9)),
    mcPowerW: Number(c.mcPowerW.toFixed(9)),
    cardPowerW: Number(c.cardPowerW.toFixed(9)),
    tpsPerUser: c.tpsPerUser === null ? null : Number(c.tpsPerUser.toFixed(9)),
  }));
  canon.sort((a, b) => (JSON.stringify(a.pick) < JSON.stringify(b.pick) ? -1 : 1));
  return crypto.createHash('sha256').update(JSON.stringify(canon)).digest('hex');
}

// K3 per-rank capacity requirement at 1M context, from the planning workload.
// The value is a model output, not a hand-written constant: it is read back from
// the detailed replay's backing bytes so that a model change moves it.
function capacityFloor(ctx) {
  const r = O.evaluate(ctx.x);
  if (!r.feasible) throw new Error('the published point does not replay; capacity floor unavailable');
  return r.backingGB;
}

// K3 detailed replay at the published point with only mcGBs changed (cached).
function replay(ctx, mcGBs) {
  if (ctx.replays[mcGBs]) return ctx.replays[mcGBs];
  const x = {...ctx.x, mcGBs};
  const p = P.resize(A.physical(x));
  const r = O.evaluate(x);
  const base = {dieAreaMm2: p.dieArea, diePowerW: p.diePower, cardPowerW: p.cardPower, packageAreaMm2: p.packageArea,
    mcPowerW: p.mcPower, mcDieGBs: A.physical(x).mcDieGB, uciePortGBs: A.physical(x).uciePortGB,
    reasons: p.reasons};
  return (ctx.replays[mcGBs] = r.feasible
    ? {...base, feasible: true, tpsPerUser: r.tps, rawLatencyUs: r.rawUs, dmaTBs: r.dmaTBs}
    : {...base, feasible: false, reasons: [...p.reasons, ...(r.reasons || [])]});
}

// The K3 replay with a changed byte demand, best over the RETUNE software grid. The model preset is
// patched in place for the duration of the call and always restored.
function replayVariant(ctx, mcGBs, variant) {
  const key = `${variant}|${mcGBs}`;
  if (variantReplays.has(key)) return variantReplays.get(key);
  const base = replay(ctx, mcGBs);
  if (!base.feasible) { variantReplays.set(key, base); return base; }
  const preset = E.MODEL_PRESETS.kimiK3, saved = preset.dtype.dense;
  let top = null;
  preset.dtype.dense = DENSE_BYTES[variant];
  try {
    for (const depth of RETUNE.depth) for (const weightTileMiB of RETUNE.weightTileMiB)
      for (const windowFraction of RETUNE.windowFraction) for (const kvTile of RETUNE.kvTile) {
        const r = O.evaluate({...ctx.x, mcGBs, depth, weightTileMiB, windowFraction, kvTile});
        if (r.feasible && (!top || r.tps > top.tps)) top = {tps: r.tps, rawUs: r.rawUs, dmaTBs: r.dmaTBs, readBytes: r.readBytes, tuned: {depth, weightTileMiB, windowFraction, kvTile}};
      }
  } finally { preset.dtype.dense = saved; }
  const out = top
    ? {...base, feasible: true, tpsPerUser: top.tps, rawLatencyUs: top.rawUs, dmaTBs: top.dmaTBs, readBytesPerRank: top.readBytes, tuned: top.tuned, variant}
    : {...base, feasible: false, reasons: [...base.reasons, `no feasible software tuning for ${variant}`]};
  variantReplays.set(key, out);
  return out;
}

function context() {
  const space = read(SPACE_FILE);
  CONTRACT.declared(space, 'mc', SPACE_FILE);
  const spec = read('teams/hardware/inputs/k3_mc_baseline.json');
  const x = spec.tpsDesign.hardware.x;
  // The clause this domain answers for (23 section 4, L3): B-MEM-BW, the sustained payload
  // one memory cube must deliver. The published point stays in ctx -- the replay runs on it
  // and the artifacts report against it -- but it is no longer the feasibility test.
  const contract = CONTRACT.load();
  const bw = CONTRACT.ownedBy(contract.contract, 'mc');
  const area = CONTRACT.entry(contract.contract, 'B-AREA');
  const ctx = {space, spec, x, point: spec.tpsDesign.point, replays: {},
    contract, clause: CONTRACT.clause(contract, 'mc'), target: contract.contract.target,
    mcPayloadGBsPerCubeMin: bw.min,
    // B-AREA is physical's clause, not this domain's; it is read here only as the shared
    // envelope every domain designs inside, which is what it was in the space's own
    // requirements block too. The difference is that it is now one number in one file.
    limits: {dieAreaMm2: area.max, cardPowerW: area.limits.cardPowerW},
    cubesPerComputeDie: spec.card.memoryCubesPerComputeDie,
    cubeAreaMm2Planning: spec.package.memoryCubeAreaMm2Planning,
    dies: A.LIMITS.dies,
    sha256: crypto.createHash('sha256').update(fs.readFileSync(path.join(root, SPACE_FILE))).digest('hex')};
  ctx.capacityFloorGB = capacityFloor(ctx);
  return ctx;
}

// Score one candidate (an option name per dimension) against the requirements.
// holdDims pins dimensions to a fixed option, which is how the per-option tables
// ask a controlled question: "holding everything else at the winner, what does
// this option do on its own?". Without it, the best candidate of an option is
// free to move the OTHER dimensions, so a cube-count row would be reported with a
// different tier and its violation would name the wrong cause.
function evaluate(ctx, pick, req = ctx.space.requirements, holdDims = null) {
  // holdDims fills in the dimensions the caller is not varying; the caller's own
  // pick wins on any dimension it sets, so a sweep row reads the option it names.
  if (holdDims) pick = {...holdDims, ...pick};
  const D = ctx.space.dimensions;
  const o = Object.fromEntries(Object.entries(pick).map(([d, n]) => [d, D[d].options[n]]));
  const tier = o.mcGBs, cubes = o.cubesPerCard.cubes, cap = o.capacityGBPerCube.capacityGB;
  const ecc = o.eccOverhead.overhead, route = o.route.route;
  const sys = replay(ctx, tier.gbs);
  const violations = [];

  // The detailed replay is built for the spec's cubes per compute die (2); it has no
  // cube-count input. A different cube count changes the per-die bandwidth by
  // cubesPerDie / specCubesPerDie, so the replay is fed that share of the tier (the
  // HBM-style bandwidth the die actually has) and the cube-proportional MC power is
  // scaled the same way. Without this a card with half the cubes replays the full
  // 16-cube bandwidth and reports the same TPS/usr, so cube count would win or lose
  // on capacity margin alone. Above the spec count the replay cannot carry the extra
  // bandwidth (it caps per cube at the port) and the candidate is not scored.
  const cubesPerDie = cubes / ctx.dies;
  const cubeScale = cubesPerDie / ctx.cubesPerComputeDie;
  const conditional = CONDITIONAL_ROUTES[route];
  const perf = cubeScale > 1 ? null
    : conditional ? replayVariant(ctx, tier.gbs * cubeScale, conditional.variant) : replay(ctx, tier.gbs * cubeScale);
  if (cubeScale > 1) violations.push('cubesAboveReplayModel');
  const specCubes = ctx.cubesPerComputeDie * ctx.dies;
  const mcPowerW = sys.mcPowerW * cubes / specCubes;
  const cardPowerW = sys.cardPowerW - sys.mcPowerW + mcPowerW;

  // 1. Capacity floor, after the ECC overhead is charged to raw capacity.
  const capacityGBPerCard = cubes * cap * (1 - ecc);
  if (capacityGBPerCard < ctx.capacityFloorGB - EPS) violations.push('capacityFloor');

  // 2. The link is the limit: per-die deliverable bytes are capped by the UCIe
  // port, so a cube count x tier that outruns the port is infeasible.
  const dieGBs = cubesPerDie * Math.min(tier.gbs * A.TECH.mcUtil, sys.uciePortGBs);
  const portCapped = tier.gbs * A.TECH.mcUtil > sys.uciePortGBs + EPS;
  // The header states a tier the port cannot carry is infeasible, not merely expensive.
  if (portCapped) violations.push('portCapped');

  // 3. The contract's own clause, and the system target behind it. B-MEM-BW prices one
  // memory cube's sustained payload, and that is a dimension of this space -- so unlike the
  // compute search, this one tests the entry directly: the tier either delivers the
  // contract's GB/s per cube or it does not. The replay is then held to the contract's
  // TARGET, not to the published point: a candidate that reaches 1000 TPS/usr satisfies
  // the contract, and scoring against the published 1101.77 made the shipped design its
  // own requirement. Both are checked; neither implies the other -- a tier at the clause
  // can still miss the target once the cube count scales it down, and the old pair
  // (`k3Tps`, `belowProgramGoal`) said the same thing with the published point standing in
  // for the clause.
  //
  // A conditional route is the one exception to the clause, as it was to the published-point
  // tolerance: B-MEM-BW is priced on the BF16 workload's bytes per token, and a route that
  // changes those bytes is not measured by it -- it is a proposal to re-split the entry. It is
  // still held to the target, and its summary names the entry it would re-split.
  if (!conditional && tier.gbs < ctx.mcPayloadGBsPerCubeMin - EPS) violations.push('belowContractBandwidth');
  if (!perf) { /* cubesAboveReplayModel already recorded: no TPS/usr is claimed */ }
  else if (!perf.feasible) violations.push('systemInfeasible');
  else if (perf.tpsPerUser < ctx.target.tpsPerUser - EPS) violations.push('belowContractTarget');

  // 4. Package window, die area and card power, with the cube count and the tier
  // charged. The card power here is this domain's own caliber (compute dies plus
  // the MC term); the requirements block states how that differs from the
  // physical domain's figure, so the comparison is between like quantities.
  const packageAreaMm2 = ctx.dies * sys.dieAreaMm2 + cubes * ctx.cubeAreaMm2Planning;
  if (packageAreaMm2 > ctx.spec.package.placementWindowMm2 + EPS) violations.push('packageArea');
  if (sys.dieAreaMm2 > ctx.limits.dieAreaMm2 + EPS) violations.push('dieArea');
  if (cardPowerW > ctx.limits.cardPowerW + EPS) violations.push('cardPower');

  // 5. Route consistency. The route is not a preference to be ranked: it is a
  // claim about how the gap is closed. A claim the search did not model must not
  // be able to win, or the winner would assert a mechanism nothing in the numbers
  // reflects -- a pick of `fewerBytesPerToken` at the published tier closes no gap,
  // it merely relabels one, and it would have won on alphabetical order.
  //
  // The routes the search CAN score are the ones the dimensions carry:
  //   mcX          -> the mcGBs dimension (a tier above REFERENCE, priced by mcPower)
  //   moreCubes    -> the cubesPerCard dimension (priced by package area)
  // The other three change something this module does not model (a lower byte
  // demand, a second data plane, compute inside the cube), so they are held out of
  // the ranking and reported in the routes table instead. See routesHeldOut().
  if (route === 'mcX' && tier.classification === 'REFERENCE') violations.push('routeContradiction:mcX-at-reference-tier');
  if (route === 'moreCubes' && cubes < 32) violations.push('routeContradiction:moreCubes-below-the-grid-max');
  if (route in HELD_OUT_ROUTES) violations.push(`routeNotScored:${route}`);
  if (conditional) violations.push(`conditional:${route}`);

  const capacityMarginGB = capacityGBPerCard - ctx.capacityFloorGB;
  return {pick, feasible: !violations.length, violations, tier, cubes, capacityGBPerCube: cap, route,
    capacityGBPerCard, capacityMarginGB, eccOverhead: ecc, dieGBs, portCapped, uciePortGBs: sys.uciePortGBs,
    mcGBs: tier.gbs, risk: RISK[tier.classification], classification: tier.classification,
    mcPowerW, cardPowerW, packageAreaMm2, dieAreaMm2: sys.dieAreaMm2,
    areaReserveMm2: ctx.spec.package.placementWindowMm2 - packageAreaMm2,
    tpsPerUser: perf && perf.feasible ? perf.tpsPerUser : null, rawLatencyUs: perf && perf.feasible ? perf.rawLatencyUs : null,
    ...(conditional ? {conditionalOn: conditional.conditionedOn, tuned: perf && perf.feasible ? perf.tuned : null} : {})};
}

// Violations of the form routeNotScored:<route> are exclusions, not design faults.
const heldOutCount = e => e.violations.filter(v => v.startsWith('routeNotScored:')).length;

// Ranking: feasible, then lowest manufacturing risk, then least card-level MC
// power, then largest capacity margin, then name.
//
// Among infeasible candidates the keys below are meaningless -- a candidate that
// fails its limits has not earned the right to be ordered by price. Order them by
// how little they violate instead, with an exclusion counted before a design fault,
// so the representative reported for an option that never works is the closest
// attempt rather than whichever combination happens to sort first.
function better(a, b) {
  if (a.feasible !== b.feasible) return a.feasible;
  if (!a.feasible) {
    if (heldOutCount(a) !== heldOutCount(b)) return heldOutCount(a) < heldOutCount(b);
    if (a.violations.length !== b.violations.length) return a.violations.length < b.violations.length;
    if (a.risk !== b.risk) return a.risk < b.risk;
    return JSON.stringify([a.pick, a.violations]) < JSON.stringify([b.pick, b.violations]);
  }
  if (a.risk !== b.risk) return a.risk < b.risk;
  if (Math.abs(a.mcPowerW - b.mcPowerW) > EPS) return a.mcPowerW < b.mcPowerW;
  if (Math.abs(a.capacityMarginGB - b.capacityMarginGB) > EPS) return a.capacityMarginGB > b.capacityMarginGB;
  return JSON.stringify(a.pick) < JSON.stringify(b.pick);
}

// A conditional candidate that would be feasible if its condition closed (every other limit holds).
const wouldBeFeasible = e => e.violations.length > 0 && e.violations.every(v => v.startsWith('conditional:'));
const betterAlt = (a, b) => better({...a, feasible: wouldBeFeasible(a)}, {...b, feasible: wouldBeFeasible(b)});

function lostOn(a, w) {
  if (!a.feasible) return `infeasible: ${a.violations.join(', ')}`;
  if (a.risk !== w.risk) return 'manufacturing risk class';
  if (Math.abs(a.mcPowerW - w.mcPowerW) > EPS) return 'MC power';
  if (Math.abs(a.capacityMarginGB - w.capacityMarginGB) > EPS) return 'capacity margin';
  return 'tie';
}

function search(ctx = context(), req = ctx.space.requirements) {
  const D = ctx.space.dimensions, dims = Object.keys(D);
  let best = null, conditionalBest = null, candidates = 0, feasible = 0;
  const all = [];
  const perOption = Object.fromEntries(dims.map(d => [d, {}]));
  const walk = (i, pick) => {
    if (i === dims.length) {
      candidates++;
      const e = evaluate(ctx, {...pick}, req);
      if (e.feasible) feasible++;
      all.push(e);
      if (!best || better(e, best)) best = e;
      if (wouldBeFeasible(e) && (!conditionalBest || betterAlt(e, conditionalBest))) conditionalBest = e;
      for (const d of dims) { const cur = perOption[d][pick[d]]; if (!cur || better(e, cur)) perOption[d][pick[d]] = e; }
      return;
    }
    for (const n of Object.keys(D[dims[i]].options)) { pick[dims[i]] = n; walk(i + 1, pick); }
  };
  walk(0, {});
  return {ctx, req, best, conditionalBest, perOption, all, counts: {candidates, feasible}};
}

const summary = e => ({pick: e.pick, feasible: e.feasible, violations: e.violations, classification: e.classification,
  mcGBs: e.mcGBs, cubes: e.cubes, capacityGBPerCard: e.capacityGBPerCard, capacityMarginGB: e.capacityMarginGB,
  dieGBs: e.dieGBs, mcPowerW: e.mcPowerW, cardPowerW: e.cardPowerW, areaReserveMm2: e.areaReserveMm2,
  tpsPerUser: e.tpsPerUser});

// Best candidate of every option of every dimension, with the other dimensions held
// at the winner. The per-option table answers "what would this option have cost, all
// else equal"; reading it off the global candidate pool instead lets an option's best
// candidate move the other dimensions, so the violation reported names the wrong cause
// (a cubesPerCard row reporting a tier failure, when the row is about cube count).
function alternatives(result = search()) {
  const {best, ctx, req} = result, D = ctx.space.dimensions, out = {};
  for (const [d, opts] of Object.entries(D)) {
    out[d] = {};
    for (const n of Object.keys(opts.options)) {
      const e = evaluate(ctx, {[d]: n}, req, best.pick);
      out[d][n] = {chosen: n === best.pick[d], lostOn: n === best.pick[d] ? null : lostOn(e, best), ...summary(e)};
    }
  }
  return out;
}

// The best candidate of the conditional routes, next to the winner it would replace if its condition closed.
function conditionalSummary(result) {
  const {best, conditionalBest: c} = result;
  if (!c) return null;
  const route = CONDITIONAL_ROUTES[c.route];
  return {
    route: c.route, pick: c.pick, conditionedOn: route.conditionedOn, meaning: route.meaning, limitation: route.limitation,
    tunedSoftwareKnobs: c.tuned, mcGBs: c.mcGBs, classification: c.classification, cubes: c.cubes,
    tpsPerUser: c.tpsPerUser, dieGBs: c.dieGBs, mcPowerW: c.mcPowerW, cardPowerW: c.cardPowerW,
    versusWinner: {winnerMcGBs: best.mcGBs, winnerTpsPerUser: best.tpsPerUser, mcGBsRatio: c.mcGBs / best.mcGBs,
      mcPowerSavedW: best.mcPowerW - c.mcPowerW, tpsDeltaPct: (c.tpsPerUser / best.tpsPerUser - 1) * 100,
      riskClassWinner: best.classification, riskClassAlternative: c.classification},
    resplit: c.mcGBs < result.ctx.mcPayloadGBsPerCubeMin
      ? {entry: 'B-MEM-BW', quantity: 'mcPayloadGBsPerCube', currentMin: result.ctx.mcPayloadGBsPerCubeMin, proposedMin: c.mcGBs}
      : null,
    status: 'NOT the baseline: reported so that the cost of the open precision decision is a number; it cannot win until the condition closes'
  };
}

// The whole scored candidate set, with a fingerprint over it. Written next to the
// winner so that "candidate X was excluded because Y" is reproducible from a
// stored file rather than from a console log. Ordering is the search's own.
function candidates(result = search()) {
  const {best, req, all, counts, ctx} = result;
  const ranked = [...all].sort((a, b) => (better(a, b) ? -1 : better(b, a) ? 1 : 0));
  const entries = ranked.map(e => ({
    optionId: Object.entries(e.pick).map(([d, n]) => `${d}=${n}`).join('|'),
    pick: e.pick,
    feasible: e.feasible,
    violations: e.violations,
    chosen: e === best,
    lostOn: e === best ? null : lostOn(e, best),
    classification: e.classification,
    risk: e.risk,
    mcGBs: e.mcGBs,
    cubesPerCard: e.cubes,
    capacityGBPerCube: e.capacityGBPerCube,
    capacityGBPerCard: e.capacityGBPerCard,
    capacityMarginGB: e.capacityMarginGB,
    eccOverhead: e.eccOverhead,
    dieGBs: e.dieGBs,
    portCapped: e.portCapped,
    uciePortGBs: e.uciePortGBs,
    mcPowerW: e.mcPowerW,
    cardPowerW: e.cardPowerW,
    packageAreaMm2: e.packageAreaMm2,
    areaReserveMm2: e.areaReserveMm2,
    tpsPerUser: e.tpsPerUser,
    rawLatencyUs: e.rawLatencyUs,
    ...(e.conditionalOn ? {conditionalOn: e.conditionalOn, tuned: e.tuned} : {}),
  }));
  return {
    status: 'MODEL (search over the HW-04 design space; the candidate set behind out/detailed/memory_design.json, not FROZEN)',
    designSpace: {file: SPACE_FILE, sha256: ctx.sha256, dimensions: Object.keys(ctx.space.dimensions)},
    requirements: {models: req.models, contractEntry: req.contractEntry, capacityFloorGBPerRank: ctx.capacityFloorGB,
      minTpsPerUser: req.minTpsPerUser},
    contract: CONTRACT.provenance(ctx.contract),
    clause: ctx.clause,
    ranking: 'feasible first, then lowest manufacturing risk class, then least card-level MC power, then largest capacity margin, then pick',
    totalCandidates: counts.candidates,
    feasibleCandidates: counts.feasible,
    candidateSetSha256: fingerprint(entries),
    conditionalAlternative: conditionalSummary(result),
    candidates: entries,
    regenerate: 'node integration/pipelines/generate_memory_design.js (npm run memory:search); enforced by tests/regression/test_memory_design.js',
  };
}

// Document tables: the tier sweep at the published cube count, the cube-count
// sweep at the published tier, and the route consistency table. Every row holds
// the other dimensions at the winner, so an infeasibility names its own cause.
function analysis(result = search()) {
  const {ctx} = result, D = ctx.space.dimensions, req = ctx.space.requirements;
  const base = result.best.pick;
  const rows = [];
  for (const g of Object.keys(D.mcGBs.options)) {
    const e = evaluate(ctx, {mcGBs: g}, req, base);
    rows.push({mcGBs: D.mcGBs.options[g].gbs, classification: e.classification, dieGBs: e.dieGBs, portCapped: e.portCapped,
      mcPowerW: e.mcPowerW, cardPowerW: e.cardPowerW, tpsPerUser: e.tpsPerUser, feasible: e.feasible, violations: e.violations});
  }
  const cubeRows = [];
  for (const c of Object.keys(D.cubesPerCard.options)) {
    const e = evaluate(ctx, {cubesPerCard: c}, req, base);
    cubeRows.push({cubesPerCard: D.cubesPerCard.options[c].cubes, capacityGBPerCard: e.capacityGBPerCard,
      packageAreaMm2: e.packageAreaMm2, areaReserveMm2: e.areaReserveMm2, cardPowerW: e.cardPowerW,
      tpsPerUser: e.tpsPerUser, feasible: e.feasible, violations: e.violations});
  }
  // How each route scores when the tier and cube count are free: this is the
  // table that answers "could the cheaper route have worked?" with a number, so
  // here the other dimensions are deliberately NOT held.
  const routeRows = [];
  for (const r of Object.keys(D.route.options)) {
    let best = null;
    const cmp = r in CONDITIONAL_ROUTES ? betterAlt : better;
    for (const g of Object.keys(D.mcGBs.options)) for (const c of Object.keys(D.cubesPerCard.options)) {
      const e = evaluate(ctx, {...base, route: r, mcGBs: g, cubesPerCard: c}, req);
      if (!best || cmp(e, best)) best = e;
    }
    routeRows.push({route: r, scored: !(r in HELD_OUT_ROUTES), conditional: r in CONDITIONAL_ROUTES, ...summary(best)});
  }
  return {sweep: rows, cubesSweep: cubeRows, routes: routeRows, heldOutRoutes: routesHeldOut(), conditionalRoutes: CONDITIONAL_ROUTES,
    conditionalAlternative: conditionalSummary(result),
    capacityFloorGB: ctx.capacityFloorGB, cubesFloor: Math.ceil(ctx.capacityFloorGB / ctx.space.dimensions.capacityGBPerCube.options['16'].capacityGB),
    publishedDieGBs: ctx.cubesPerComputeDie * Math.min(ctx.x.mcGBs * A.TECH.mcUtil, A.physical(ctx.x).uciePortGB)};
}

// The routes that are in the design space but cannot win, and what each would
// need before it could be scored. Reported so that "route X was not chosen" is
// distinguishable from "route X was never costed".
function routesHeldOut() {
  return Object.fromEntries(Object.entries(HELD_OUT_ROUTES).map(([r, why]) => [r, {scored: false, needsModelling: why}]));
}

function build(result = search()) {
  const {ctx, req, best, counts} = result, {space, x, spec, point} = ctx, D = space.dimensions;
  const design = Object.fromEntries(Object.entries(best.pick).map(([d, n]) => [d, {option: n, ...D[d].options[n]}]));
  return {
    status: 'MODEL (search over the HW-04 design space: capacity floor + K3 detailed replay + package limits; not FROZEN, does not change the published point)',
    owner: space.owner,
    document: space.document,
    designSpace: {file: SPACE_FILE, sha256: ctx.sha256, dimensions: Object.keys(D), candidates: counts.candidates, feasible: counts.feasible,
      constraints: space.constraints, objective: space.objective,
      note: 'only the winning design is written here; the alternatives stay in the design space and in the document'},
    requirements: {models: req.models, contractEntry: req.contractEntry, capacityFloorGBPerRank: ctx.capacityFloorGB,
      dieAreaLimitMm2: ctx.limits.dieAreaMm2, cardPowerLimitW: ctx.limits.cardPowerW, placementWindowMm2: ctx.spec.package.placementWindowMm2},
    contract: CONTRACT.provenance(ctx.contract),
    clause: ctx.clause,
    caliber: space.caliber,
    assumptions: {sustainedEfficiency: A.TECH.mcUtil, capacityFloorSource: 'K3 per-rank backing at 1M context, read from the detailed replay (r.backingGB)',
      eccOverhead: best.eccOverhead, cubeAreaMm2Planning: ctx.cubeAreaMm2Planning},
    hardware: {publishedX: {...x}, cubesPerComputeDie: ctx.cubesPerComputeDie, publishedDieGBs: ctx.cubesPerComputeDie * Math.min(x.mcGBs * A.TECH.mcUtil, A.physical(x).uciePortGB),
      publishedTier: x.mcGBs},
    design,
    ruled: Object.fromEntries(Object.entries(space.ruled).map(([k, v]) => [k, {chosen: v.chosen, reason: v.reason}])),
    evaluation: {
      k3System: {publishedTpsPerUser: point.tpsPerUser, tpsPerUser: best.tpsPerUser, rawLatencyUs: best.rawLatencyUs,
        contractTargetTpsPerUser: ctx.target.tpsPerUser},
      classification: best.classification, mcGBs: best.mcGBs, dieGBs: best.dieGBs, portCapped: best.portCapped,
      capacityGBPerCard: best.capacityGBPerCard, capacityMarginGB: best.capacityMarginGB,
      mcPowerW: best.mcPowerW, cardPowerW: best.cardPowerW, packageAreaMm2: best.packageAreaMm2, areaReserveMm2: best.areaReserveMm2,
      dieAreaMm2: best.dieAreaMm2
    },
    conditionalAlternative: conditionalSummary(result),
    regenerate: 'node integration/pipelines/generate_memory_design.js (npm run memory:search); enforced by tests/regression/test_memory_design.js'
  };
}

module.exports = {SPACE_FILE, context, evaluate, search, candidates, alternatives, analysis, build, replay, replayVariant, capacityFloor, RISK, HELD_OUT_ROUTES, CONDITIONAL_ROUTES};
