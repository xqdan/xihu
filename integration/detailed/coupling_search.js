'use strict';
/* Cross-domain joint replay (doc 23 section 4, L3 `design.coupling`).
 *
 * The design space is teams/hardware/inputs/coupling_design_space.json. Every domain search
 * (compute, sram, mc, comm, physical) chose its winner with the other domains held at the
 * published point, and each one spent the margin the published point carries on the
 * assumption that nobody else would. This module answers the question none of them could:
 *
 *  1. compose -- the five winners as one design point: the sram winner's x (its banks,
 *     slices, TMA engines and port patch), the compute winner's lanes, unpack and exp unit,
 *     the mc winner's tier, the comm winner's signal delivery and control path, at the
 *     physical winner's basis and reserve, with tau at B-TAU's ceiling;
 *  2. replay it (O.evaluate, the K3 detailed model) and check it against all five contract
 *     entries at once -- the composed point is a candidate like any other, and it can fail;
 *  3. replay a small grid around it on the three couplings the space fixes (SRAM x depth x
 *     MC, lanes x commOverlap with a tau sweep, and area moved between SRAM, matrix and
 *     Reduce/TMA/RDMA on the die_area_reallocation.js step lists).
 *
 * A row is feasible when the replay runs and reaches the contract target, every contract
 * entry holds on its own quantity, the compute winner's required H-core kernels still hide,
 * and the package and shoreline fit. Feasible rows are marked on the Pareto set of
 * (TPS/usr up, die area down, card power down) and ranked Pareto first, then die area, then
 * card power. Rows below a clause are still replayed: they are the rejected combinations
 * the integrator records, and when nothing is feasible they are what an L1-b re-split needs
 * (`backflow`: the shortfall, the closest row and each domain's own best).
 *
 * build() writes the best joint point (out/detailed/coupling_design.json); candidates() the
 * whole scored set with a fingerprint over it (out/detailed/coupling_candidates.json). Every
 * row carries its full x, OPT patch and model patch, so the row design.coupling lands is
 * itself the global design point.
 *
 * Evidence class MODEL; the space is UNVERIFIED until the domain owners sign it.
 */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const {isDeepStrictEqual} = require('util');
const A = require('./k3_architecture_search.js');
const O = require('./k3_rdma_final_tuning_model.js');
const P = require('./k3_physical_basis.js');
const CONTRACT = require('./design_contract.js');
const MV = require('./matrix_vector_search.js');
const COMM = require('./comm_core_search.js');
const {MOVES} = require('./die_area_reallocation.js');

const root = path.resolve(__dirname, '../..');
const SPACE_FILE = 'teams/hardware/inputs/coupling_design_space.json';
const BASELINE_FILE = 'teams/hardware/inputs/k3_mc_baseline.json';
const read = p => JSON.parse(fs.readFileSync(path.join(root, p), 'utf8'));
const exists = p => fs.existsSync(path.join(root, p));
const sha256 = p => crypto.createHash('sha256').update(fs.readFileSync(path.join(root, p))).digest('hex');
const EPS = 1e-9;
const LIMIT_SUFFIX = ' after shared-port scaling';
const camel = s => s.replace(LIMIT_SUFFIX, '').split(/\s+/).map((w, i) => (i ? w[0].toUpperCase() + w.slice(1) : w.toLowerCase())).join('');

function fingerprint(candidates) {
  const n = v => (v === null ? null : Number(v.toFixed(9)));
  const canon = candidates.map(c => ({
    optionId: c.optionId,
    feasible: c.feasible,
    pareto: c.pareto,
    violations: [...c.violations].sort(),
    tpsPerUser: n(c.tpsPerUser),
    dieAreaMm2: n(c.dieAreaMm2),
    diePowerW: n(c.diePowerW),
    cardPowerW: n(c.cardPowerW),
  }));
  canon.sort((a, b) => (a.optionId < b.optionId ? -1 : 1));
  return crypto.createHash('sha256').update(JSON.stringify(canon)).digest('hex');
}

// Each domain's winner: its design artifact, checked against the contract in force and the
// candidate set it came from. A landed winner (out/<d>/<d>_winner.json) that names another
// option is a decision this module cannot compose from the design artifact, so it stops.
function winners(space, prov) {
  const out = {};
  for (const [domain, w] of Object.entries(space.requirements.winners)) {
    const design = read(w.design), cands = read(w.candidates);
    if (!isDeepStrictEqual(design.contract, prov)) {
      throw new Error(`${w.design} was scored against ${JSON.stringify(design.contract && design.contract.splitId)} (${design.contract && design.contract.sha256}), not the contract in force; rerun the ${domain} search`);
    }
    const chosen = cands.candidates.find(c => c.chosen);
    if (!chosen) throw new Error(`${w.candidates} has no chosen row`);
    let landed = null;
    if (exists(w.landed)) {
      landed = read(w.landed).optionId;
      if (landed !== chosen.optionId) throw new Error(`${w.landed} lands ${landed} but the ${domain} search winner is ${chosen.optionId}; coupling composes the search winners`);
    }
    out[domain] = {design, provenance: {design: w.design, designSha256: sha256(w.design), candidates: w.candidates,
      candidateSetSha256: cands.candidateSetSha256, optionId: chosen.optionId, landed: landed ? w.landed : null}};
  }
  return out;
}

function context() {
  const space = read(SPACE_FILE);
  const contract = CONTRACT.load(), C = contract.contract, prov = CONTRACT.provenance(contract);
  const ids = C.split.map(e => e.id).sort();
  if (!isDeepStrictEqual([...space.requirements.contractEntries].sort(), ids)) {
    throw new Error(`${SPACE_FILE} declares contractEntries ${space.requirements.contractEntries.join(', ')} but the contract has ${ids.join(', ')}; coupling holds every entry`);
  }
  const spec = read(BASELINE_FILE), W = winners(space, prov);
  const mv = W.compute.design.design, sram = W.sram.design.hardware, mc = W.mc.design.design;
  const comm = W.comm.design, phys = W.physical.design.design;
  // The replay runs on P.BASIS (O.evaluate sizes the die on it); a physical winner on another
  // basis would be composed onto numbers it was not scored on.
  if (phys.process.process !== P.BASIS.process || phys.matrixTFPerMm2.tfPerMm2 !== P.BASIS.matrixTFPerMm2 || phys.cooling.cooling !== P.BASIS.cooling) {
    throw new Error(`the physical winner (${phys.process.process} / ${phys.matrixTFPerMm2.tfPerMm2} / ${phys.cooling.cooling}) is not the replay basis ${P.BASIS.process} / ${P.BASIS.matrixTFPerMm2} / ${P.BASIS.cooling}`);
  }
  // x.mcGBs is per cube; a winner with another cube count would need the card rescaled.
  if (mc.cubesPerCard.cubes !== spec.card.memoryCubes) {
    throw new Error(`the mc winner has ${mc.cubesPerCard.cubes} cubes per card, the replay ${spec.card.memoryCubes}`);
  }
  const x = {...sram.x, vectorLanes: mv.vectorLanes.lanes, mcGBs: mc.mcGBs.gbs};
  const tau = CONTRACT.entry(C, 'B-TAU'), area = CONTRACT.entry(C, 'B-AREA');
  const signalOpt = COMM.signalOpt(comm.design.signal.option, x);
  const opt = {...sram.opt, ...signalOpt, commOverlap: O.OPT.commOverlap, tauUs: tau.max};
  const model = {native: mv.lowPrecisionInput.native, softmaxOpsPerScore: mv.expUnit.softmaxOpsPerScore,
    matrixAreaOverhead: mv.lowPrecisionInput.matrixAreaOverhead, vectorAreaOverhead: mv.expUnit.vectorAreaOverhead,
    commCoreAreaMm2: comm.evaluation.areaMm2,
    controlUs: Object.fromEntries(comm.controlPath.classes.map(k => [k.name, k.controlUs]))};
  const mvSpace = read(MV.SPACE_FILE);
  return {space, spec, contract, prov, winners: W, x, opt, model, signalOpt,
    controlUs: model.controlUs,
    target: C.target,
    entries: {sram: CONTRACT.entry(C, 'B-SRAM-CAP'), mc: CONTRACT.entry(C, 'B-MEM-BW'), tau, area, compute: CONTRACT.entry(C, 'B-SERIAL-CMP')},
    limits: {dieAreaMm2: area.max, diePowerW: Math.min(area.limits.diePowerW, phys.cooling.diePowerLimitW),
      cardPowerW: Math.min(area.limits.cardPowerW, phys.cooling.cardPowerLimitW)},
    pkg: {dies: A.LIMITS.dies, windowMm2: spec.package.placementWindowMm2, cubes: mc.cubesPerCard.cubes,
      cubeAreaMm2: spec.package.memoryCubeAreaMm2Planning, reserveFraction: phys.reserveFraction.reserve},
    mvSpace, tp: read('out/rdma/k3_rdma_final_tuning_results.json').tp, shapes: MV.shapes(),
    replays: new Map(), kernels: new Map(), protocols: new Map(),
    sha256: sha256(SPACE_FILE)};
}

// The compute winner's own kernel check at a row: its required H-core kernels must still hide
// their vector work at the row's lanes and matrix shape (hRows / hEngines move the bound).
function kernelCheck(ctx, x) {
  const key = JSON.stringify(x);
  if (ctx.kernels.has(key)) return ctx.kernels.get(key);
  const hw = MV.hardware(x), req = ctx.mvSpace.requirements, r = MV.ratios(hw, x.vectorLanes);
  const rows = MV.kernelBounds({x, tp: ctx.tp, hw, shapes: ctx.shapes, space: ctx.mvSpace}, ctx.model.native, ctx.model.softmaxOpsPerScore)
    .filter(k => req.hiddenCoreClasses.includes(k.core) && req.models.includes(k.model));
  const binding = rows.reduce((a, k) => (k.minLanesPerCore > a.minLanesPerCore ? k : a));
  const coreRatio = k => (k.core === 'L' ? r.lCore : r.hCore);
  const out = {hidden: rows.every(k => coreRatio(k) <= k.maxCoreRatio + EPS), hCoreRatio: r.hCore,
    binding: {model: binding.model, kernel: binding.kernel, maxCoreRatio: binding.maxCoreRatio, minLanesPerCore: binding.minLanesPerCore}};
  ctx.kernels.set(key, out);
  return out;
}

// The slowest collective at a row: the protocol time under the comm winner's signal delivery
// plus its control path. B-TAU bounds this, whatever floor the schedule then pads it to.
function slowestCollective(ctx, x, opt) {
  const key = JSON.stringify([x, opt]);
  if (ctx.protocols.has(key)) return ctx.protocols.get(key);
  const {tauUs, ...rest} = opt;
  const classes = COMM.withProtocol({opt: rest}, () => COMM.protocolClasses(x, ctx.signalOpt).classes);
  const slowest = classes.map(k => ({name: k.name, latencyUs: k.protocolUs + (ctx.controlUs[k.name] || 0)}))
    .reduce((a, k) => (k.latencyUs > a.latencyUs ? k : a));
  ctx.protocols.set(key, slowest);
  return slowest;
}

// The scope a joint point is replayed in: the compute winner's model patch (unpack, softmax op
// count), the row's OPT patch (port scaling, signal delivery, overlap, tau) and the comm
// winner's control path, all restored afterwards. `point` is a row or a landed joint point
// ({opt, model}); anything replayed inside fn (O.evaluate and every helper built on it) sees
// the point, which is how a consumer (tps_attribution.js) replays it without a copy of this.
function withPoint({opt, model}, fn) {
  return MV.withModel({tech: model.native ? MV.NATIVE_TECH : {}, softmaxOpsPerScore: model.softmaxOpsPerScore},
    () => COMM.withProtocol({controlUs: name => model.controlUs[name] || 0, opt}, fn));
}

// K3 detailed replay at one joint point (withPoint). When the model rejects the point it
// reports no area, so the area is rebuilt from the physical sizing plus the port charge it
// did report.
function replay(ctx, x, opt) {
  const key = JSON.stringify([x, opt]);
  if (ctx.replays.has(key)) return ctx.replays.get(key);
  const m = ctx.model;
  const r = withPoint({opt, model: m}, () => O.evaluate(x));
  let p = r.feasible ? r.p : null;
  if (!p) {
    const p0 = P.resize(A.physical(x)), c = r.sharedPortCost || {areaMm2PerDie: 0, powerWPerDie: 0};
    p = {...p0, dieArea: p0.dieArea + c.areaMm2PerDie, diePower: p0.diePower + c.powerWPerDie, cardPower: p0.cardPower + A.LIMITS.dies * c.powerWPerDie};
  }
  const area = {die: p.dieArea, matrixOverhead: m.matrixAreaOverhead * p.area.matrix, vectorOverhead: m.vectorAreaOverhead * p.area.vector,
    commCore: m.commCoreAreaMm2};
  const out = {feasible: r.feasible, reasons: r.feasible ? [] : (r.reasons || [r.reason]),
    tpsPerUser: r.feasible ? r.tps : null, rawLatencyUs: r.feasible ? r.rawUs : null, commUs: r.feasible ? r.commUs : null,
    dieAreaMm2: Object.values(area).reduce((a, b) => a + b, 0), area, diePowerW: p.diePower, cardPowerW: p.cardPower,
    shorelineMm: p.shoreline, edgeBudgetMm: p.edgeBudget};
  ctx.replays.set(key, out);
  return out;
}

// Score one joint point against every contract entry and the shared limits.
function evaluate(ctx, x, opt) {
  const sys = replay(ctx, x, opt), k = kernelCheck(ctx, x), slow = slowestCollective(ctx, x, opt), E = ctx.entries;
  const violations = new Set(sys.reasons.map(camel));
  const pk = ctx.pkg, packagePlacedMm2 = pk.dies * sys.dieAreaMm2 + pk.cubes * pk.cubeAreaMm2;
  const packageReserveMm2 = pk.windowMm2 * (1 - pk.reserveFraction) - packagePlacedMm2;
  const clauses = {
    'B-SERIAL-CMP': {through: 'contract target', tpsPerUser: sys.tpsPerUser, target: ctx.target.tpsPerUser,
      holds: sys.tpsPerUser !== null && sys.tpsPerUser >= ctx.target.tpsPerUser - EPS},
    'B-SRAM-CAP': {sharedMiB: x.sharedMiB, min: E.sram.min, holds: x.sharedMiB >= E.sram.min - EPS},
    'B-MEM-BW': {mcGBs: x.mcGBs, min: E.mc.min, holds: x.mcGBs >= E.mc.min - EPS},
    'B-TAU': {slowest: slow.name, latencyUs: slow.latencyUs, tauUs: opt.tauUs, max: E.tau.max,
      holds: slow.latencyUs <= E.tau.max + EPS && opt.tauUs <= E.tau.max + EPS},
    'B-AREA': {dieAreaMm2: sys.dieAreaMm2, max: E.area.max, diePowerW: sys.diePowerW, cardPowerW: sys.cardPowerW, limits: ctx.limits,
      holds: sys.dieAreaMm2 <= ctx.limits.dieAreaMm2 + EPS && sys.diePowerW <= ctx.limits.diePowerW + EPS && sys.cardPowerW <= ctx.limits.cardPowerW + EPS}
  };
  if (sys.feasible && !clauses['B-SERIAL-CMP'].holds) violations.add('belowContractTarget');
  for (const id of ['B-SRAM-CAP', 'B-MEM-BW', 'B-TAU']) if (!clauses[id].holds) violations.add(`clause:${id}`);
  if (sys.dieAreaMm2 > ctx.limits.dieAreaMm2 + EPS) violations.add('dieArea');
  if (sys.diePowerW > ctx.limits.diePowerW + EPS) violations.add('diePower');
  if (sys.cardPowerW > ctx.limits.cardPowerW + EPS) violations.add('cardPower');
  if (packageReserveMm2 < -EPS) violations.add('packageArea');
  if (sys.shorelineMm > sys.edgeBudgetMm + EPS) violations.add('phyShoreline');
  if (!k.hidden) violations.add('hKernelExposed');
  const v = [...violations];
  return {feasible: !v.length, violations: v, clauses, replayFeasible: sys.feasible,
    tpsPerUser: sys.tpsPerUser, rawLatencyUs: sys.rawLatencyUs, commUs: sys.commUs,
    dieAreaMm2: sys.dieAreaMm2, area: sys.area, diePowerW: sys.diePowerW, cardPowerW: sys.cardPowerW,
    packagePlacedMm2, packageReserveMm2, shorelineMm: sys.shorelineMm, edgeBudgetMm: sys.edgeBudgetMm,
    kernel: k};
}

// The step list of one area field: die_area_reallocation.js MOVES, with the composed value
// inserted when the list does not carry it (the sram winner's lBanks 16 is below it).
function steps(field, value) {
  if (!MOVES[field]) throw new Error(`${SPACE_FILE}: ${field} has no step list in die_area_reallocation.js MOVES`);
  return [...new Set([...MOVES[field], value])].sort((a, b) => a - b);
}

// Every row the space asks for, as a change against the composed point. The same joint point
// reached from two couplings is one row, listed under both.
function grid(ctx) {
  const C = ctx.space.couplings, out = [{coupling: 'composed', change: {}}];
  const product = fields => Object.entries(fields).reduce((acc, [f, vs]) => acc.flatMap(c => vs.map(v => ({...c, [f]: v}))), [{}]);
  for (const name of ['sramDepthMc', 'tauOverlapCompute']) for (const change of product(C[name].fields)) out.push({coupling: name, change});
  const groups = C.areaReallocation.groups, groupOf = {};
  const down = [], up = [];
  for (const [g, fields] of Object.entries(groups)) {
    for (const f of fields) {
      groupOf[f] = g;
      const s = steps(f, ctx.x[f]), i = s.indexOf(ctx.x[f]);
      if (i > 0) down.push([f, s[i - 1]]);
      if (i < s.length - 1) up.push([f, s[i + 1]]);
    }
  }
  for (const [f, v] of [...down, ...up]) out.push({coupling: 'areaReallocation', change: {[f]: v}});
  for (const [fd, vd] of down) for (const [fu, vu] of up) if (groupOf[fd] !== groupOf[fu]) out.push({coupling: 'areaReallocation', change: {[fd]: vd, [fu]: vu}});
  return out;
}

const optionId = (coupling, change) => (coupling === 'composed' ? 'composed'
  : `${coupling}:${Object.entries(change).map(([f, v]) => `${f}=${v}`).join('|')}`);

// The point a change describes, split into hardware x and OPT patch.
function pointOf(ctx, change) {
  const optFields = new Set(Object.values(ctx.space.couplings).flatMap(c => c.optFields || []));
  const x = {...ctx.x}, opt = {...ctx.opt};
  for (const [f, v] of Object.entries(change)) {
    if (optFields.has(f)) opt[f] = v;
    else if (f in x) x[f] = v;
    else throw new Error(`${SPACE_FILE}: ${f} is neither a hardware field nor an optField`);
  }
  return {x, opt};
}

// Which domain winners a row departs from, field by field: the seats that must agree to it.
function departsFrom(ctx, x, opt) {
  const out = {}, value = (pt, f) => (f in pt.x ? pt.x[f] : pt.opt[f]);
  for (const [f, owner] of Object.entries(ctx.space.fieldOwners)) {
    if (value({x, opt}, f) !== value(ctx, f)) (out[owner] = out[owner] || []).push(f);
  }
  return out;
}

const dominates = (a, b) => a.tpsPerUser >= b.tpsPerUser - EPS && a.dieAreaMm2 <= b.dieAreaMm2 + EPS && a.cardPowerW <= b.cardPowerW + EPS
  && (a.tpsPerUser > b.tpsPerUser + EPS || a.dieAreaMm2 < b.dieAreaMm2 - EPS || a.cardPowerW < b.cardPowerW - EPS);

// Ranking: feasible, Pareto, least die area, least card power, optionId. Infeasible rows by how
// few constraints they break, then by how far below the target they replay (a replay that
// cannot run counts as furthest), so the head of an all-infeasible set is the closest attempt.
function better(a, b) {
  if (a.feasible !== b.feasible) return a.feasible;
  if (!a.feasible) {
    if (a.violations.length !== b.violations.length) return a.violations.length < b.violations.length;
    const sa = a.tpsPerUser === null ? -Infinity : a.tpsPerUser, sb = b.tpsPerUser === null ? -Infinity : b.tpsPerUser;
    if (Math.abs(sa - sb) > EPS) return sa > sb;
    return a.optionId < b.optionId;
  }
  if (a.pareto !== b.pareto) return a.pareto;
  if (Math.abs(a.dieAreaMm2 - b.dieAreaMm2) > EPS) return a.dieAreaMm2 < b.dieAreaMm2;
  if (Math.abs(a.cardPowerW - b.cardPowerW) > EPS) return a.cardPowerW < b.cardPowerW;
  return a.optionId < b.optionId;
}

function lostOn(a, w) {
  if (!a.feasible) return `infeasible: ${a.violations.join(', ')}`;
  if (!a.pareto) return 'dominated';
  if (Math.abs(a.dieAreaMm2 - w.dieAreaMm2) > EPS) return 'die area';
  if (Math.abs(a.cardPowerW - w.cardPowerW) > EPS) return 'card power';
  return 'tie';
}

function search(ctx = context()) {
  const rows = new Map();
  for (const {coupling, change} of grid(ctx)) {
    const {x, opt} = pointOf(ctx, change), key = JSON.stringify([x, opt]);
    if (rows.has(key)) {
      const row = rows.get(key);
      if (!row.couplings.includes(coupling)) row.couplings.push(coupling);
      continue;
    }
    rows.set(key, {optionId: optionId(coupling, change), couplings: [coupling], change, departsFrom: departsFrom(ctx, x, opt),
      ...evaluate(ctx, x, opt), x, opt, model: {...ctx.model}});
  }
  const all = [...rows.values()];
  const feasible = all.filter(r => r.feasible);
  for (const r of all) r.pareto = r.feasible && !feasible.some(o => o !== r && dominates(o, r));
  // The tau sensitivity of the rows the tau coupling covers: TPS/usr at each swept tau, and the
  // slack the slowest collective leaves under B-TAU's ceiling.
  const sweep = ctx.space.couplings.tauOverlapCompute.tauSweepUs;
  for (const r of all.filter(q => q.couplings.includes('tauOverlapCompute'))) {
    r.tauSweep = sweep.map(tauUs => {
      const s = replay(ctx, r.x, {...r.opt, tauUs});
      return {tauUs, tpsPerUser: s.tpsPerUser, meetsTarget: s.tpsPerUser !== null && s.tpsPerUser >= ctx.target.tpsPerUser - EPS};
    });
    r.tauHeadroomUs = ctx.entries.tau.max - r.clauses['B-TAU'].latencyUs;
  }
  const order = [...all].sort((a, b) => (better(a, b) ? -1 : better(b, a) ? 1 : 0));
  return {ctx, all, order, best: order[0], composed: all.find(r => r.optionId === 'composed'),
    counts: {candidates: all.length, feasible: feasible.length, pareto: all.filter(r => r.pareto).length}};
}

// Each domain alone (its own artifact's replay, the others at the published point) next to
// the composed point: the TPS/usr each one counted on that the composition does not deliver.
function composition(result) {
  const {ctx, composed} = result, W = ctx.winners;
  const alone = {
    compute: W.compute.design.evaluation.k3System.tpsPerUser,
    sram: W.sram.design.evaluation.k3System.tpsPerUser,
    mc: W.mc.design.evaluation.k3System.tpsPerUser,
    comm: W.comm.design.evaluation.withSpecFloor.tpsPerUser,
    physical: W.physical.design.evaluation.k3System.tpsPerUser
  };
  return {domainAlone: Object.fromEntries(Object.entries(alone).map(([d, tps]) => [d, {optionId: W[d].provenance.optionId, tpsPerUser: tps}])),
    composed: {feasible: composed.feasible, violations: composed.violations, tpsPerUser: composed.tpsPerUser,
      dieAreaMm2: composed.dieAreaMm2, diePowerW: composed.diePowerW, cardPowerW: composed.cardPowerW},
    targetTpsPerUser: ctx.target.tpsPerUser,
    note: 'each domain alone replays with the other domains at the published point; the composed point is all five winners at once'};
}

// When no joint point is feasible the run goes back to L1-b (doc 23 section 6) with what a
// re-split needs: how far the closest row is from the target and each domain's own best.
function backflow(result) {
  const {ctx, best, counts} = result;
  if (counts.feasible) return null;
  const replayed = result.all.filter(r => r.tpsPerUser !== null);
  const top = replayed.reduce((a, r) => (!a || r.tpsPerUser > a.tpsPerUser ? r : a), null);
  return {to: 'L1-b', routeTo: 'design.req.budget',
    reason: 'no joint point around the domain winners satisfies every contract entry at once',
    closest: {optionId: best.optionId, violations: best.violations, tpsPerUser: best.tpsPerUser},
    highestTps: top ? {optionId: top.optionId, tpsPerUser: top.tpsPerUser, violations: top.violations} : null,
    shortfallTpsPerUser: top ? Math.max(0, ctx.target.tpsPerUser - top.tpsPerUser) : null,
    domainBest: composition(result).domainAlone};
}

function candidates(result = search()) {
  const {ctx, best, order, counts} = result;
  const entries = order.map((e, i) => ({
    rank: i + 1,
    optionId: e.optionId,
    couplings: e.couplings,
    change: e.change,
    departsFrom: e.departsFrom,
    feasible: e.feasible,
    pareto: e.pareto,
    violations: e.violations,
    chosen: e === best && e.feasible,
    lostOn: e === best ? null : lostOn(e, best),
    tpsPerUser: e.tpsPerUser,
    rawLatencyUs: e.rawLatencyUs,
    commUs: e.commUs,
    dieAreaMm2: e.dieAreaMm2,
    area: e.area,
    diePowerW: e.diePowerW,
    cardPowerW: e.cardPowerW,
    packageReserveMm2: e.packageReserveMm2,
    shorelineMm: e.shorelineMm,
    edgeBudgetMm: e.edgeBudgetMm,
    kernel: e.kernel,
    clauses: e.clauses,
    ...(e.tauSweep ? {tauSweep: e.tauSweep, tauHeadroomUs: e.tauHeadroomUs} : {}),
    x: e.x,
    opt: e.opt,
    model: e.model,
  }));
  const byCause = {};
  for (const e of result.all) if (!e.feasible) for (const v of e.violations) byCause[v] = (byCause[v] || 0) + 1;
  return {
    status: 'MODEL (joint replay of the five domain winners and a grid on three couplings; the candidate set behind out/detailed/coupling_design.json, not FROZEN)',
    designSpace: {file: SPACE_FILE, sha256: ctx.sha256, dimensions: Object.keys(ctx.space.couplings)},
    requirements: {contractEntries: ctx.space.requirements.contractEntries, targetTpsPerUser: ctx.target.tpsPerUser,
      limits: ctx.limits, package: ctx.pkg, tauUs: ctx.opt.tauUs},
    contract: ctx.prov,
    clauses: Object.keys(CONTRACT.OWNS).map(d => CONTRACT.clause(ctx.contract, d)),
    winners: Object.fromEntries(Object.entries(ctx.winners).map(([d, w]) => [d, w.provenance])),
    fieldCaliber: {
      areaIncludesPortCost: 'yes',
      powerScope: 'die (diePowerW) and card (cardPowerW)',
      note: 'dieAreaMm2 is per compute die, SF4: the replay\'s die area with the shared-port charge, plus the compute winner\'s option overheads and the comm core (area.commCore); comm core power is not modelled. '
        + 'tpsPerUser is the K3 detailed replay at tau = B-TAU max, null when the replay cannot run',
    },
    ranking: 'feasible first, then Pareto on (TPS/usr up, die area down, card power down), then least die area, least card power, optionId; infeasible by fewest violations, then highest TPS/usr',
    totalCandidates: counts.candidates,
    feasibleCandidates: counts.feasible,
    paretoCandidates: counts.pareto,
    infeasibleByCause: byCause,
    composition: composition(result),
    backflow: backflow(result),
    candidateSetSha256: fingerprint(entries),
    candidates: entries,
    regenerate: 'node integration/pipelines/generate_coupling_design.js (npm run coupling:search); enforced by tests/regression/test_coupling_design.js',
  };
}

function build(result = search()) {
  const {ctx, best, counts} = result, space = ctx.space;
  return {
    status: 'MODEL (joint replay of the five domain winners against every contract entry; not FROZEN, does not change the published point)',
    owner: space.owner,
    document: space.document,
    designSpace: {file: SPACE_FILE, sha256: ctx.sha256, couplings: Object.keys(space.couplings),
      candidates: counts.candidates, feasible: counts.feasible, pareto: counts.pareto,
      constraints: space.constraints, objective: space.objective,
      note: 'only the best joint point is written here; the grid stays in out/detailed/coupling_candidates.json'},
    requirements: {contractEntries: space.requirements.contractEntries, targetTpsPerUser: ctx.target.tpsPerUser, limits: ctx.limits, package: ctx.pkg},
    contract: ctx.prov,
    winners: Object.fromEntries(Object.entries(ctx.winners).map(([d, w]) => [d, w.provenance])),
    composition: composition(result),
    jointPoint: best.feasible ? {optionId: best.optionId, couplings: best.couplings, change: best.change, departsFrom: best.departsFrom,
      x: best.x, opt: best.opt, model: best.model} : null,
    evaluation: {feasible: best.feasible, violations: best.violations, tpsPerUser: best.tpsPerUser, rawLatencyUs: best.rawLatencyUs,
      dieAreaMm2: best.dieAreaMm2, area: best.area, diePowerW: best.diePowerW, cardPowerW: best.cardPowerW,
      packageReserveMm2: best.packageReserveMm2, shorelineMm: best.shorelineMm, edgeBudgetMm: best.edgeBudgetMm,
      kernel: best.kernel, clauses: best.clauses},
    backflow: backflow(result),
    regenerate: 'node integration/pipelines/generate_coupling_design.js (npm run coupling:search); enforced by tests/regression/test_coupling_design.js'
  };
}

module.exports = {SPACE_FILE, context, evaluate, search, candidates, build, replay, withPoint, grid, steps, fingerprint, kernelCheck};
