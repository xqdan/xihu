'use strict';
/* Physical domain design search (package / power / RAS,
 * teams/hardware/docs/09_PACKAGE_POWER_RAS.md).
 *
 * The design space is the domain's input,
 * teams/hardware/inputs/physical_design_space.json: which process basis the area
 * is derived on, the matrix density that sets the largest area term, which
 * cooling ceiling applies, and how much of the placement window is reserved.
 * search() enumerates the product and scores every candidate on
 *
 *  1. area conservation -- every placed unit area plus the reserve must equal the
 *     5248 mm2 placement window, with a zero residual. A non-zero residual means
 *     a term is unaccounted for, not that the budget is loose;
 *  2. the four per-unit limits -- die area (400 mm2), die power (300 W), card
 *     power (2800 W) on the searched cooling basis, and package utilizable area;
 *  3. the PHY shoreline against the die edge budget, which is what a naive lane
 *     increase breaks first (the published point sits at 24.21 / 52.95 mm);
 *  4. the K3 detailed replay (O.evaluate) at the published point, which must keep
 *     the published TPS/usr within the tolerance: the physical domain may not move
 *     the published point, only reach it more cheaply.
 *
 * A candidate is feasible if the limits hold, the reserve is non-negative and the
 * K3 replay keeps the published TPS/usr. Feasible candidates are ranked by the
 * largest remaining placement reserve (the window is the resource that cannot be
 * bought back later), then by the largest die power margin below the ceiling, then
 * by the lowest process risk (a scaled basis is a promise about a node, not a
 * measurement).
 *
 * build() writes only the winner (out/detailed/physical_design.json); candidates()
 * writes the whole scored candidate set with a fingerprint over it
 * (out/detailed/physical_candidates.json) -- see matrix_vector_search.js for why a
 * winner-only artifact cannot support "every exclusion is traceable".
 * alternatives() gives the best candidate of every option and analysis() the
 * process sensitivity, the cooling sensitivity and the reserve sweep, which the
 * document quotes.
 *
 * Evidence class MODEL. The limits, the process scaling and the matrix density come
 * from k3_physical_basis.js and the baseline (ADR-0018, ADR-0005, ASSUMPTION B-006).
 * There is no thermal model in the repository: cooling is carried as which ceiling
 * applies, not as a derived junction temperature (O-015). This file and the space it
 * reads were drafted by an agent and are UNVERIFIED until a domain owner signs them.
 */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const A = require('./k3_architecture_search.js');
const O = require('./k3_rdma_final_tuning_model.js');
const P = require('./k3_physical_basis.js');
const CONTRACT = require('./design_contract.js');

const root = path.resolve(__dirname, '../..');
const SPACE_FILE = 'teams/hardware/inputs/physical_design_space.json';
const read = p => JSON.parse(fs.readFileSync(path.join(root, p), 'utf8'));
const EPS = 1e-9;
// The 8-package fixed overhead the card power model charges (k3_architecture_search.js
// physical(): cardPower = dies x diePower + mcPower + 80).
const CARD_FIXED_W = 80;
// Options the space carries but the search may not choose. Each is a sensitivity the
// document reports, not a candidate: air cooling is superseded by ADR-0005, and N4-ref
// is a historical basis kept so old models replay. Without this, an option that hits a
// looser or different definition of the same quantity can win on margin alone while
// asserting a decision the repository has already closed -- the same failure the memory
// search hit with its unscored routes.
const HELD_OUT_OPTIONS = {
  cooling: {
    air: 'superseded by ADR-0005 (decision 2026-09-25); reported as the sensitivity that shows what the liquid decision bought, not as a candidate',
  },
  process: {
    'N4-ref': 'the N4 reference basis, kept so every historical model replays unchanged; reported as a sensitivity unless the domain owner reopens the node decision',
  },
};

// Fingerprint of a candidate set. Stable across runs and across machines: fields
// sorted, numbers rounded to reported precision, digest over JSON with an explicit
// key order. A fingerprint that depends on enumeration order is worse than none.
function fingerprint(candidates) {
  const canon = candidates.map(c => ({
    pick: Object.fromEntries(Object.entries(c.pick).sort(([a], [b]) => (a < b ? -1 : 1))),
    feasible: c.feasible,
    violations: [...c.violations].sort(),
    dieAreaMm2: Number(c.dieAreaMm2.toFixed(9)),
    diePowerW: Number(c.diePowerW.toFixed(9)),
    cardPowerW: Number(c.cardPowerW.toFixed(9)),
    packageAreaMm2: Number(c.packageAreaMm2.toFixed(9)),
    reserveMm2: Number(c.reserveMm2.toFixed(9)),
    tpsPerUser: c.tpsPerUser === null ? null : Number(c.tpsPerUser.toFixed(9)),
  }));
  canon.sort((a, b) => (JSON.stringify(a.pick) < JSON.stringify(b.pick) ? -1 : 1));
  return crypto.createHash('sha256').update(JSON.stringify(canon)).digest('hex');
}

// K3 detailed replay at the published point under one area basis and cooling
// ceiling (cached). The process and matrix density change the area terms through
// P.resize; the cooling only changes which ceiling the limits are compared against,
// because the repository has no thermal model to derive one from.
//
// One correction against P.resize, stated here rather than patched into the frozen
// basis file: resize rebuilds dieArea from the classified terms only, so the charged
// shared-port cost drops out -- 357.565 mm2 where tpsDesign.hardware publishes 365.34
// and 280.530 W where it publishes 283.269. The missing term is
// O.chargeSharedPortCost()'s sharedPorts entry (MODEL, O-007), which is a function of
// the card-level shared-SRAM bandwidth the plan asks for beyond what physical() sized.
// It is re-derived here on the searched basis: the port area scales with the process
// logic factor exactly as the model charges it, the port power does not scale.
// edgeBudget deliberately stays on the pre-port area, matching the published
// 52.946 = 4 x sqrt(357.565) x 0.70. P.resize also checks its limits against the module
// constant BASIS.limits, so the cooling ceilings are applied in evaluate() instead.
function replay(ctx, process, matrixTFPerMm2, cooling) {
  const key = `${process}|${matrixTFPerMm2}|${cooling.cooling}`;
  if (ctx.replays[key]) return ctx.replays[key];
  const x = ctx.x, T = A.TECH;
  const p = P.resize(A.physical(x), {process, matrixTFPerMm2, cooling: cooling.cooling});
  const sliceTBs = 512 * x.ghz / 1000 * T.bankUtil;
  const portAreaMm2 = ctx.portTBsPerDie / sliceTBs * 32 * T.bankArea * P.PROCESS[process].logic;
  const portPowerW = ctx.portTBsPerDie * T.sharedPortWPerTB;
  const dieAreaMm2 = p.dieArea + portAreaMm2;
  const diePowerW = p.diePower + portPowerW;
  const cardPowerW = ctx.dies * diePowerW + p.mcPower + CARD_FIXED_W;
  const packageAreaMm2 = ctx.dies * dieAreaMm2 + ctx.cubes * ctx.cubeAreaMm2;
  const r = O.evaluate(x);
  const base = {dieAreaMm2, diePowerW, cardPowerW, packageAreaMm2, portAreaMm2, portPowerW,
    mcPowerW: p.mcPower, shorelineMm: p.shoreline, edgeBudgetMm: p.edgeBudget,
    area: {...p.area, sharedPorts: portAreaMm2}, power: {...p.power, sharedPorts: portPowerW}};
  return (ctx.replays[key] = r.feasible
    ? {...base, feasible: true, tpsPerUser: r.tps, rawLatencyUs: r.rawUs}
    : {...base, feasible: false, physicsReasons: r.reasons || []});
}

function context() {
  const space = read(SPACE_FILE);
  CONTRACT.declared(space, 'physical', SPACE_FILE);
  const spec = read('teams/hardware/inputs/k3_mc_baseline.json');
  const x = spec.tpsDesign.hardware.x;
  // The shared-port bandwidth charge physical() does not carry, read from the model's
  // own accounting rather than re-derived: O.chargeSharedPortCost() prices the card-level
  // shared-SRAM bandwidth the plan asks for beyond what physical() sized, one entry per
  // die. Re-deriving it by hand got the card/die split wrong (57.87 vs 7.586 TB/s).
  const port = O.evaluate(x).p.sharedPortCost;
  // The clause this domain answers for (23 section 4, L3): B-AREA, the die area and the
  // die/card power limits behind it. The published point stays in ctx -- the replay runs on
  // it and the artifacts report against it -- but it is no longer the feasibility test.
  const contract = CONTRACT.load();
  const area = CONTRACT.ownedBy(contract.contract, 'physical');
  return {space, spec, x, point: spec.tpsDesign.point, replays: {},
    contract, clause: CONTRACT.clause(contract, 'physical'), target: contract.contract.target,
    limits: {dieAreaMm2: area.max, diePowerW: area.limits.diePowerW, cardPowerW: area.limits.cardPowerW},
    dies: A.LIMITS.dies,
    cubes: spec.card.memoryCubes,
    cubeAreaMm2: spec.package.memoryCubeAreaMm2Planning,
    portTBsPerDie: port.extraTBsPerDie,
    publishedPortAreaMm2: port.areaMm2PerDie,
    publishedPortPowerW: port.powerWPerDie,
    published: spec.tpsDesign.hardware,
    sha256: crypto.createHash('sha256').update(fs.readFileSync(path.join(root, SPACE_FILE))).digest('hex')};
}

// Score one candidate (an option name per dimension) against the requirements.
// holdDims pins the dimensions the caller is not varying, so a sweep row reads the
// option it names instead of the winner's value.
function evaluate(ctx, pick, req = ctx.space.requirements, holdDims = null) {
  if (holdDims) pick = {...holdDims, ...pick};
  const D = ctx.space.dimensions;
  const o = Object.fromEntries(Object.entries(pick).map(([d, n]) => [d, D[d].options[n]]));
  const proc = o.process.process, tf = o.matrixTFPerMm2.tfPerMm2, cooling = o.cooling, reserve = o.reserveFraction.reserve;
  const sys = replay(ctx, proc, tf, cooling);
  const violations = [];

  // 1. Area conservation against the placement window, with the reserve held back.
  // reserveFraction is the keep-out share the space names (published 0.1254 = 658.29 /
  // 5248), so the usable budget is window x (1 - reserve) and the reserve left over is
  // what the placed units do not consume of it.
  const placedMm2 = ctx.dies * sys.dieAreaMm2 + ctx.cubes * ctx.cubeAreaMm2;
  const usableMm2 = req.placementWindowMm2 * (1 - reserve);
  const reserveMm2 = usableMm2 - placedMm2;
  if (reserveMm2 < -EPS) violations.push('packageArea');
  // 2. The per-unit limits. The die area ceiling is B-AREA's own max -- that is the clause
  // this domain answers for, and reading it from the contract is what makes a different
  // split able to move it. The power ceilings stay the searched cooling option's: the
  // contract's limits are stated on the liquid basis (B-AREA.basis), so an air-cooled
  // candidate has to be held to air's stricter pair or the sensitivity would score itself
  // against a premise it does not run on.
  if (sys.dieAreaMm2 > ctx.limits.dieAreaMm2 + EPS) violations.push('dieArea');
  if (sys.diePowerW > cooling.diePowerLimitW + EPS) violations.push('diePower');
  if (sys.cardPowerW > cooling.cardPowerLimitW + EPS) violations.push('cardPower');

  // 3. PHY shoreline against the die edge budget.
  if (sys.shorelineMm > sys.edgeBudgetMm + EPS) violations.push('phyShoreline');

  // 4. The replay must clear the contract's system target -- not reproduce the published
  // point. A package that reaches 1000 TPS/usr more cheaply satisfies the contract; the
  // published 1101.77 is the design that was shipped, not the requirement it was shipped
  // against, and anchoring to it made the published point its own acceptance test.
  if (!sys.feasible) violations.push('systemInfeasible');
  else if (sys.tpsPerUser < ctx.target.tpsPerUser - EPS) violations.push('belowContractTarget');
  // 5. Options the space carries but the search may not choose. Reported as a
  // violation so a held-out option cannot win; the sensitivity is in analysis().
  for (const [d, opts] of Object.entries(HELD_OUT_OPTIONS)) if (pick[d] in opts) violations.push(`optionHeldOut:${d}=${pick[d]}`);

  return {pick, feasible: !violations.length, violations, process: proc, matrixTFPerMm2: tf, cooling: cooling.cooling,
    reserveFraction: reserve, keepOutFraction: reserve, dies: ctx.dies,
    dieAreaMm2: sys.dieAreaMm2, diePowerW: sys.diePowerW, mcPowerW: sys.mcPowerW, cardPowerW: sys.cardPowerW,
    packageAreaMm2: placedMm2, placedMm2, reserveMm2, usableMm2, shorelineMm: sys.shorelineMm, edgeBudgetMm: sys.edgeBudgetMm,
    diePowerMarginW: cooling.diePowerLimitW - sys.diePowerW,
    cardPowerMarginW: cooling.cardPowerLimitW - sys.cardPowerW,
    area: sys.area, power: sys.power, limitReasons: sys.limitReasons,
    tpsPerUser: sys.feasible ? sys.tpsPerUser : null, rawLatencyUs: sys.feasible ? sys.rawLatencyUs : null};
}

// Ranking: feasible first, then the most conservative keep-out premise, then the
// largest placement reserve within that premise, then the largest die power margin,
// then the lowest process risk, then name.
//
// The first two keys are in that order for an epistemic reason, and it matters: the
// reserve is not a resource the design spends, it is a prediction about the vendor's
// stitch map, RDL and keep-out. Ranking on leftover alone would systematically elect
// the most generous assumption -- a 10% keep-out leaves 200.5 mm2 of "reserve" and
// outranks the observed 12.54%, which leaves 67.2 mm2, purely because it claims less
// about the vendor. An option whose premise the repository cannot verify does not earn
// rank on the budget that premise frees; the same rule holds for what a held-out route
// would have bought. Within one keep-out level, more leftover is strictly better.
// Violations of the form optionHeldOut:<dim>=<opt> are exclusions, not design faults.
const heldOutCount = e => e.violations.filter(v => v.startsWith('optionHeldOut:')).length;

function better(a, b) {
  if (a.feasible !== b.feasible) return a.feasible;
  // Among infeasible candidates the ranking keys below are meaningless -- a candidate
  // that fails its limits has not earned the right to be ordered by how generous its
  // premise was. Order by how little they violate instead, so the representative
  // reported for an option that never works is the closest attempt rather than whichever
  // combination happens to sort first. Exclusions are counted first: when every candidate
  // for an option is held out, the row still wants the story about the design (area, power)
  // rather than about which second option was unavailable.
  if (!a.feasible) {
    if (heldOutCount(a) !== heldOutCount(b)) return heldOutCount(a) < heldOutCount(b);
    if (a.violations.length !== b.violations.length) return a.violations.length < b.violations.length;
    if (a.keepOutFraction !== b.keepOutFraction) return a.keepOutFraction > b.keepOutFraction;
    return JSON.stringify([a.pick, a.violations]) < JSON.stringify([b.pick, b.violations]);
  }
  if (a.keepOutFraction !== b.keepOutFraction) return a.keepOutFraction > b.keepOutFraction;
  if (Math.abs(a.reserveMm2 - b.reserveMm2) > EPS) return a.reserveMm2 > b.reserveMm2;
  if (Math.abs(a.diePowerMarginW - b.diePowerMarginW) > EPS) return a.diePowerMarginW > b.diePowerMarginW;
  if (a.process !== b.process) return a.process === 'SF4';
  return JSON.stringify(a.pick) < JSON.stringify(b.pick);
}

function lostOn(a, w) {
  if (!a.feasible) return `infeasible: ${a.violations.join(', ')}`;
  if (a.keepOutFraction !== w.keepOutFraction) return 'keep-out premise (a smaller keep-out is a stronger unverified claim)';
  if (Math.abs(a.reserveMm2 - w.reserveMm2) > EPS) return 'placement reserve';
  if (Math.abs(a.diePowerMarginW - w.diePowerMarginW) > EPS) return 'die power margin';
  if (a.process !== w.process) return 'process risk';
  return 'tie';
}

// The window identity the space demands (areaConservationTolerance: 0), stated as a
// check rather than an always-true rearrangement: placed + keep-out must fit the
// window, with `satisfied` computed and `overUnderMm2` = window - placed - keep-out
// (the published point leaves 67.172 mm2 since ADR-0023; it was 0.189 mm2 before the shared-port reclaim).
function conservation(req, reserveFraction, placedMm2) {
  const windowMm2 = req.placementWindowMm2;
  const keepOutMm2 = windowMm2 * reserveFraction;
  const overUnderMm2 = windowMm2 - placedMm2 - keepOutMm2;
  return {windowMm2, placedMm2, keepOutMm2, overUnderMm2, toleranceMm2: req.areaConservationTolerance,
    satisfied: overUnderMm2 >= -req.areaConservationTolerance};
}

function search(ctx = context(), req = ctx.space.requirements) {
  const D = ctx.space.dimensions, dims = Object.keys(D);
  let best = null, candidates = 0, feasible = 0;
  const all = [];
  const perOption = Object.fromEntries(dims.map(d => [d, {}]));
  const walk = (i, pick) => {
    if (i === dims.length) {
      candidates++;
      const e = evaluate(ctx, {...pick}, req);
      if (e.feasible) feasible++;
      all.push(e);
      if (!best || better(e, best)) best = e;
      for (const d of dims) { const cur = perOption[d][pick[d]]; if (!cur || better(e, cur)) perOption[d][pick[d]] = e; }
      return;
    }
    for (const n of Object.keys(D[dims[i]].options)) { pick[dims[i]] = n; walk(i + 1, pick); }
  };
  walk(0, {});
  return {ctx, req, best, perOption, all, counts: {candidates, feasible}};
}

const summary = e => ({pick: e.pick, feasible: e.feasible, violations: e.violations, process: e.process,
  matrixTFPerMm2: e.matrixTFPerMm2, cooling: e.cooling, dieAreaMm2: e.dieAreaMm2, diePowerW: e.diePowerW,
  cardPowerW: e.cardPowerW, packageAreaMm2: e.packageAreaMm2, reserveMm2: e.reserveMm2,
  diePowerMarginW: e.diePowerMarginW, shorelineMm: e.shorelineMm, edgeBudgetMm: e.edgeBudgetMm,
  tpsPerUser: e.tpsPerUser});

// Best candidate of every option of every dimension, with the other dimensions
// held at the winner. Holding them matters: taking the best candidate that
// merely *contains* an option lets the other dimensions drift, so the row's
// numbers and violations describe a combination the reader did not ask about
// (the 1.6 TF/mm2 row would report the reserve of a 0.15 keep-out it never
// chose). Each row must be that option's own doing.
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

// The whole scored candidate set, with a fingerprint over it.
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
    process: e.process,
    matrixTFPerMm2: e.matrixTFPerMm2,
    cooling: e.cooling,
    reserveFraction: e.reserveFraction,
    keepOutFraction: e.keepOutFraction,
    dieAreaMm2: e.dieAreaMm2,
    diePowerW: e.diePowerW,
    mcPowerW: e.mcPowerW,
    cardPowerW: e.cardPowerW,
    packageAreaMm2: e.packageAreaMm2,
    reserveMm2: e.reserveMm2,
    diePowerMarginW: e.diePowerMarginW,
    cardPowerMarginW: e.cardPowerMarginW,
    shorelineMm: e.shorelineMm,
    edgeBudgetMm: e.edgeBudgetMm,
    tpsPerUser: e.tpsPerUser,
    rawLatencyUs: e.rawLatencyUs,
  }));
  return {
    status: 'MODEL (search over the physical design space; the candidate set behind out/detailed/physical_design.json, not FROZEN)',
    designSpace: {file: SPACE_FILE, sha256: ctx.sha256, dimensions: Object.keys(ctx.space.dimensions)},
    requirements: {models: req.models, contractEntry: req.contractEntry, dieAreaLimitMm2: ctx.limits.dieAreaMm2,
      diePowerLimitW: ctx.limits.diePowerW, cardPowerLimitW: ctx.limits.cardPowerW, placementWindowMm2: req.placementWindowMm2},
    contract: CONTRACT.provenance(ctx.contract),
    clause: ctx.clause,
    ranking: 'feasible first, then most conservative keep-out premise, then largest placement reserve within that premise, then largest die power margin, then lowest process risk, then pick',
    totalCandidates: counts.candidates,
    feasibleCandidates: counts.feasible,
    candidateSetSha256: fingerprint(entries),
    candidates: entries,
    regenerate: 'node integration/pipelines/generate_physical_design.js (npm run physical:search); enforced by tests/regression/test_physical_design.js',
  };
}

// Document tables: the process sensitivity, the cooling sensitivity (what the
// liquid decision bought) and the reserve sweep. Every row holds the other
// dimensions at the winner.
function analysis(result = search()) {
  const {ctx} = result, D = ctx.space.dimensions, req = ctx.space.requirements;
  const base = result.best.pick;
  const process = Object.keys(D.process.options).map(n => {
    const e = evaluate(ctx, {process: n}, req, base);
    return {process: e.process, dieAreaMm2: e.dieAreaMm2, packageAreaMm2: e.packageAreaMm2, reserveMm2: e.reserveMm2,
      diePowerW: e.diePowerW, cardPowerW: e.cardPowerW, tpsPerUser: e.tpsPerUser, feasible: e.feasible, violations: e.violations};
  });
  const cooling = Object.keys(D.cooling.options).map(n => {
    const e = evaluate(ctx, {cooling: n}, req, base);
    return {cooling: e.cooling, diePowerW: e.diePowerW, cardPowerW: e.cardPowerW, diePowerLimitW: D.cooling.options[n].diePowerLimitW,
      cardPowerLimitW: D.cooling.options[n].cardPowerLimitW, diePowerMarginW: e.diePowerMarginW, cardPowerMarginW: e.cardPowerMarginW,
      tpsPerUser: e.tpsPerUser, feasible: e.feasible, violations: e.violations};
  });
  const matrix = Object.keys(D.matrixTFPerMm2.options).map(n => {
    const e = evaluate(ctx, {matrixTFPerMm2: n}, req, base);
    return {matrixTFPerMm2: e.matrixTFPerMm2, matrixAreaMm2: e.area.matrix, dieAreaMm2: e.dieAreaMm2,
      packageAreaMm2: e.packageAreaMm2, reserveMm2: e.reserveMm2, tpsPerUser: e.tpsPerUser,
      feasible: e.feasible, violations: e.violations};
  });
  const reserve = Object.keys(D.reserveFraction.options).map(n => {
    const e = evaluate(ctx, {reserveFraction: n}, req, base);
    return {reserveFraction: e.reserveFraction, reserveMm2: e.reserveMm2, feasible: e.feasible, violations: e.violations};
  });
  // Where the published point actually sits, so the document can quote the margin
  // rather than the assumption behind it.
  const pub = evaluate(ctx, base, req);
  return {process, cooling, matrix, reserve,
    published: {dieAreaMm2: ctx.published.dieAreaMm2, diePowerW: ctx.published.diePowerW, cardPowerW: ctx.published.perCard.powerW,
      packageAreaMm2: ctx.published.perCard.packageAreaMm2, shorelineMm: ctx.published.perCard.shorelineMm,
      shorelineBudgetMm: ctx.published.perCard.shorelineBudgetMm},
    areaConservation: conservation(req, pub.reserveFraction, pub.placedMm2)};
}

function build(result = search()) {
  const {ctx, req, best, counts} = result, {space, x, spec, point} = ctx, D = space.dimensions;
  const design = Object.fromEntries(Object.entries(best.pick).map(([d, n]) => [d, {option: n, ...D[d].options[n]}]));
  const pub = evaluate(ctx, best.pick, req);
  return {
    status: 'MODEL (search over the physical design space: area conservation + per-unit limits + K3 detailed replay; not FROZEN, does not change the published point)',
    owner: space.owner,
    document: space.document,
    designSpace: {file: SPACE_FILE, sha256: ctx.sha256, dimensions: Object.keys(D), candidates: counts.candidates, feasible: counts.feasible,
      constraints: space.constraints, objective: space.objective,
      note: 'only the winning design is written here; the alternatives stay in the design space and in the document'},
    requirements: {models: req.models, contractEntry: req.contractEntry, dieAreaLimitMm2: ctx.limits.dieAreaMm2,
      diePowerLimitW: ctx.limits.diePowerW, cardPowerLimitW: ctx.limits.cardPowerW, placementWindowMm2: req.placementWindowMm2},
    contract: CONTRACT.provenance(ctx.contract),
    clause: ctx.clause,
    caliber: space.caliber,
    assumptions: {dies: ctx.dies, memoryCubes: ctx.cubes, cubeAreaMm2Planning: ctx.cubeAreaMm2,
      cardFixedOverheadW: CARD_FIXED_W, cooling: best.cooling, coolingNote: 'ASSUMPTION (O-015): the repository has no thermal model; cooling selects which ceiling applies, it does not derive one',
      processSource: 'integration/detailed/k3_physical_basis.js (ASSUMPTION B-006: public node figures, not PDK or macro data)'},
    hardware: {publishedX: {...x}, publishedDieAreaMm2: ctx.published.dieAreaMm2, publishedDiePowerW: ctx.published.diePowerW,
      publishedCardPowerW: ctx.published.perCard.powerW},
    design,
    ruled: Object.fromEntries(Object.entries(space.ruled).map(([k, v]) => [k, {chosen: v.chosen, reason: v.reason}])),
    evaluation: {
      k3System: {publishedTpsPerUser: point.tpsPerUser, tpsPerUser: best.tpsPerUser, rawLatencyUs: best.rawLatencyUs,
        contractTargetTpsPerUser: ctx.target.tpsPerUser},
      process: best.process, matrixTFPerMm2: best.matrixTFPerMm2,
      dieAreaMm2: best.dieAreaMm2, diePowerW: best.diePowerW, diePowerLimitW: D.cooling.options[best.pick.cooling].diePowerLimitW,
      cardPowerW: best.cardPowerW, cardPowerLimitW: D.cooling.options[best.pick.cooling].cardPowerLimitW,
      mcPowerW: best.mcPowerW, packageAreaMm2: best.packageAreaMm2, reserveMm2: best.reserveMm2,
      shorelineMm: best.shorelineMm, edgeBudgetMm: best.edgeBudgetMm,
      area: best.area, power: best.power,
      areaConservation: conservation(req, best.reserveFraction, pub.placedMm2)
    },
    regenerate: 'node integration/pipelines/generate_physical_design.js (npm run physical:search); enforced by tests/regression/test_physical_design.js'
  };
}

module.exports = {SPACE_FILE, context, evaluate, search, candidates, alternatives, analysis, build, replay, CARD_FIXED_W, HELD_OUT_OPTIONS};
