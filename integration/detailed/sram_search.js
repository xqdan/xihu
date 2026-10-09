'use strict';
/* SRAM domain design search (HW-03, teams/hardware/docs/03_TMA_AND_SRAM.md).
 *
 * The design space is HW-03's input, teams/hardware/inputs/sram_design_space.json:
 * the shared SRAM window per die, the local bank counts of the L and H cores, the
 * shared slices per die, the TMA engines per core and whether the shared-SRAM port
 * scaling (with the dedicated TMA port) is built. search() enumerates the product and
 * scores every candidate on
 *
 *  1. the contract's own clause -- B-SRAM-CAP, the shared window per die. It is a
 *     dimension of this space, so it is tested directly: a candidate below the floor
 *     is infeasible and is not replayed (the floor was derived at the split point, not
 *     at the published compute, so a below-floor window can still replay above the
 *     target here; analysis() shows the numbers, the contract decides);
 *  2. the K3 detailed replay (O.evaluate) at the published point with only these
 *     dimensions changed, which must be feasible (local tiles fit, the shared window
 *     holds the plan) and reach the contract's target.tpsPerUser;
 *  3. B-AREA's die area, die power and card power limits, read as the shared envelope
 *     every domain designs inside. Area and power include the shared-port charge
 *     (O.chargeSharedPortCost), which A.physical() does not carry.
 *
 * Feasible candidates are ranked by die area, then die power. The published point is
 * not the requirement: the winner is the cheapest die that satisfies the contract, and
 * it is expected to spend most of the TPS/usr margin the published point carries.
 * Whether it still holds next to the other domains' winners is L3 coupling's question,
 * not this search's.
 *
 * build() writes only the winner (out/detailed/sram_design.json); candidates() writes
 * the whole scored candidate set with a fingerprint over it
 * (out/detailed/sram_candidates.json). alternatives() gives every option with the other
 * dimensions held at the winner, and analysis() the clause sweep, the local-capacity
 * sweep (the ruled dimension, as numbers) and where the published combination ranks.
 *
 * Evidence class MODEL. The port-scaling coefficients are O-007 and must be replaced by
 * a bank-cycle simulation (03 section 7). This file and the space it reads were drafted
 * by an agent and are UNVERIFIED until a domain owner signs them.
 */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const A = require('./k3_architecture_search.js');
const O = require('./k3_rdma_final_tuning_model.js');
const P = require('./k3_physical_basis.js');
const CONTRACT = require('./design_contract.js');
const BP = require('./baseline_point.js');

const root = path.resolve(__dirname, '../..');
const SPACE_FILE = 'teams/hardware/inputs/sram_design_space.json';
const read = p => JSON.parse(fs.readFileSync(path.join(root, p), 'utf8'));
const EPS = 1e-9;
// The replay inputs this space moves. Everything else in x stays at the published point.
const FIELDS = ['sharedMiB', 'lBanks', 'hBanks', 'sharedSlices', 'tmaEngines', 'lMiB', 'hMiB'];
// The model's reasons become violation names: 'die area after shared-port scaling' and the
// contract check 'dieArea' are the same fault, so the suffix is dropped and the two dedupe.
const LIMIT_SUFFIX = ' after shared-port scaling';
const camel = s => s.replace(LIMIT_SUFFIX, '').split(/\s+/).map((w, i) => (i ? w[0].toUpperCase() + w.slice(1) : w.toLowerCase())).join('');

function fingerprint(candidates) {
  const n = v => (v === null ? null : Number(v.toFixed(9)));
  const canon = candidates.map(c => ({
    pick: Object.fromEntries(Object.entries(c.pick).sort(([a], [b]) => (a < b ? -1 : 1))),
    feasible: c.feasible,
    violations: [...c.violations].sort(),
    dieAreaMm2: n(c.dieAreaMm2),
    diePowerW: n(c.diePowerW),
    cardPowerW: n(c.cardPowerW),
    tpsPerUser: n(c.tpsPerUser),
  }));
  canon.sort((a, b) => (JSON.stringify(a.pick) < JSON.stringify(b.pick) ? -1 : 1));
  return crypto.createHash('sha256').update(JSON.stringify(canon)).digest('hex');
}

// K3 detailed replay with the SRAM fields of x and one port-scaling patch (cached). O.OPT
// is patched for the duration of the call and always restored. When the model rejects a
// candidate on a limit it reports no area, so the area is rebuilt from the physical
// sizing plus the port charge it did report -- an infeasible row still says by how much.
function replay(ctx, fields, portOption) {
  const key = JSON.stringify([FIELDS.map(f => fields[f]), portOption]);
  if (ctx.replays.has(key)) return ctx.replays.get(key);
  const x = {...ctx.x, ...fields};
  const patch = ctx.space.dimensions.sharedPortScaling.options[portOption].patch;
  const saved = {...O.OPT};
  let r;
  Object.assign(O.OPT, patch);
  try { r = O.evaluate(x); } finally { Object.assign(O.OPT, saved); }
  const p0 = P.resize(A.physical(x));
  const cost = r.feasible ? r.p.sharedPortCost : r.sharedPortCost;
  const port = cost ? {areaMm2: cost.areaMm2PerDie, powerW: cost.powerWPerDie} : {areaMm2: 0, powerW: 0};
  const out = r.feasible
    ? {feasible: true, reasons: [], tpsPerUser: r.tps, rawLatencyUs: r.rawUs,
      dieAreaMm2: r.p.dieArea, diePowerW: r.p.diePower, cardPowerW: r.p.cardPower, port, portCharged: true}
    : {feasible: false, reasons: r.reasons || [], tpsPerUser: null, rawLatencyUs: null,
      dieAreaMm2: p0.dieArea + port.areaMm2, diePowerW: p0.diePower + port.powerW,
      cardPowerW: p0.cardPower + A.LIMITS.dies * port.powerW, port, portCharged: Boolean(cost)};
  ctx.replays.set(key, out);
  return out;
}

function context() {
  const space = read(SPACE_FILE);
  CONTRACT.declared(space, 'sram', SPACE_FILE);
  const spec = read('teams/hardware/inputs/k3_mc_baseline.json');
  const x = BP.publishedX(spec, 'generate_sram_design.js');
  // The clause this domain answers for (23 section 4, L3): B-SRAM-CAP, the shared window
  // per die. The published point stays in ctx -- the replay runs on it and the artifacts
  // report against it -- but it is not the feasibility test.
  const contract = CONTRACT.load();
  const cap = CONTRACT.ownedBy(contract.contract, 'sram');
  const area = CONTRACT.entry(contract.contract, 'B-AREA');
  return {space, spec, x, point: spec.tpsDesign.point, replays: new Map(),
    contract, clause: CONTRACT.clause(contract, 'sram'), target: contract.contract.target,
    sharedMiBMin: cap.min, holdsBySharedMiB: cap.holdsBySharedMiB || [],
    // B-AREA is physical's clause; read here only as the shared envelope.
    limits: {dieAreaMm2: area.max, diePowerW: area.limits.diePowerW, cardPowerW: area.limits.cardPowerW},
    published: {lMiB: x.lMiB, hMiB: x.hMiB},
    sha256: crypto.createHash('sha256').update(fs.readFileSync(path.join(root, SPACE_FILE))).digest('hex')};
}

// The replay fields one pick sets. `local` overrides the ruled local capacity, which only
// analysis() does.
function fieldsOf(ctx, pick, local = ctx.published) {
  const D = ctx.space.dimensions, f = {...local};
  for (const d of ['sharedMiB', 'lBanks', 'hBanks', 'sharedSlices', 'tmaEngines']) f[d] = D[d].options[pick[d]][d];
  return f;
}

// Score one candidate. holdDims pins the dimensions the caller is not varying (the
// per-option tables hold everything else at the winner). `force` replays a candidate
// below the clause anyway, which only the analysis sweep asks for.
function evaluate(ctx, pick, holdDims = null, {local = ctx.published, force = false} = {}) {
  if (holdDims) pick = {...holdDims, ...pick};
  const fields = fieldsOf(ctx, pick, local);
  const violations = new Set();

  // 1. The contract's clause, on its own dimension. A window below the floor is not
  // replayed: the floor is the contract's statement that the plan needs it, and a
  // replay at the published compute is not the place to second-guess the split.
  const belowClause = fields.sharedMiB < ctx.sharedMiBMin - EPS;
  if (belowClause) violations.add('belowContractCapacity');
  const sys = belowClause && !force ? null : replay(ctx, fields, pick.sharedPortScaling);

  if (sys) {
    // 2. The replay: the model's own reasons (local tile, shared window, its limits), and
    // the contract target -- not the published 1101.77, which is a result, not a requirement.
    for (const r of sys.reasons) violations.add(camel(r));
    if (sys.feasible && sys.tpsPerUser < ctx.target.tpsPerUser - EPS) violations.add('belowContractTarget');
    // 3. B-AREA's envelope, on the port-charged figures.
    if (sys.dieAreaMm2 > ctx.limits.dieAreaMm2 + EPS) violations.add('dieArea');
    if (sys.diePowerW > ctx.limits.diePowerW + EPS) violations.add('diePower');
    if (sys.cardPowerW > ctx.limits.cardPowerW + EPS) violations.add('cardPower');
  }
  const v = [...violations];
  return {pick, feasible: !v.length, violations: v, fields, replayed: Boolean(sys),
    tpsPerUser: sys ? sys.tpsPerUser : null, rawLatencyUs: sys ? sys.rawLatencyUs : null,
    dieAreaMm2: sys ? sys.dieAreaMm2 : null, diePowerW: sys ? sys.diePowerW : null, cardPowerW: sys ? sys.cardPowerW : null,
    portAreaMm2: sys ? sys.port.areaMm2 : null, portPowerW: sys ? sys.port.powerW : null};
}

// Ranking: feasible, then least die area (port charge included), then least die power,
// then pick. Infeasible candidates are ordered by how little they violate, so the
// representative of an option that never works is its closest attempt.
function better(a, b) {
  if (a.feasible !== b.feasible) return a.feasible;
  if (!a.feasible) {
    if (a.violations.length !== b.violations.length) return a.violations.length < b.violations.length;
    if (a.replayed !== b.replayed) return a.replayed;
    return JSON.stringify([a.pick, a.violations]) < JSON.stringify([b.pick, b.violations]);
  }
  if (Math.abs(a.dieAreaMm2 - b.dieAreaMm2) > EPS) return a.dieAreaMm2 < b.dieAreaMm2;
  if (Math.abs(a.diePowerW - b.diePowerW) > EPS) return a.diePowerW < b.diePowerW;
  return JSON.stringify(a.pick) < JSON.stringify(b.pick);
}

function lostOn(a, w) {
  if (!a.feasible) return `infeasible: ${a.violations.join(', ')}`;
  if (Math.abs(a.dieAreaMm2 - w.dieAreaMm2) > EPS) return 'die area';
  if (Math.abs(a.diePowerW - w.diePowerW) > EPS) return 'die power';
  return 'tie';
}

function search(ctx = context()) {
  const D = ctx.space.dimensions, dims = Object.keys(D);
  let best = null, candidates = 0, feasible = 0;
  const all = [];
  const walk = (i, pick) => {
    if (i === dims.length) {
      candidates++;
      const e = evaluate(ctx, {...pick});
      if (e.feasible) feasible++;
      all.push(e);
      if (!best || better(e, best)) best = e;
      return;
    }
    for (const n of Object.keys(D[dims[i]].options)) { pick[dims[i]] = n; walk(i + 1, pick); }
  };
  walk(0, {});
  if (!best.feasible) throw new Error(`no SRAM candidate satisfies ${ctx.clause.id} and the contract target; the closest is ${JSON.stringify(best.pick)}: ${best.violations.join(', ')}`);
  return {ctx, best, all, counts: {candidates, feasible}};
}

const summary = e => ({pick: e.pick, feasible: e.feasible, violations: e.violations, replayed: e.replayed,
  tpsPerUser: e.tpsPerUser, dieAreaMm2: e.dieAreaMm2, diePowerW: e.diePowerW, cardPowerW: e.cardPowerW,
  portAreaMm2: e.portAreaMm2});

// Every option of every dimension, with the other dimensions held at the winner.
function alternatives(result = search()) {
  const {best, ctx} = result, out = {};
  for (const [d, opts] of Object.entries(ctx.space.dimensions)) {
    out[d] = {};
    for (const n of Object.keys(opts.options)) {
      const e = evaluate(ctx, {[d]: n}, best.pick);
      out[d][n] = {chosen: n === best.pick[d], lostOn: n === best.pick[d] ? null : lostOn(e, best), ...summary(e)};
    }
  }
  return out;
}

// The pick that reproduces the published point on every searched dimension.
function publishedPick(ctx) {
  const D = ctx.space.dimensions, pick = {};
  for (const [d, opts] of Object.entries(D)) {
    pick[d] = d === 'sharedPortScaling' ? 'published'
      : Object.keys(opts.options).find(n => opts.options[n][d] === ctx.x[d]);
    if (pick[d] === undefined) throw new Error(`${SPACE_FILE}: ${d} has no option at the published ${ctx.x[d]}`);
  }
  return pick;
}

const ranked = result => [...result.all].sort((a, b) => (better(a, b) ? -1 : better(b, a) ? 1 : 0));

function candidates(result = search()) {
  const {best, all, counts, ctx} = result;
  const entries = ranked(result).map((e, i) => ({
    rank: i + 1,
    optionId: Object.entries(e.pick).map(([d, n]) => `${d}=${n}`).join('|'),
    pick: e.pick,
    feasible: e.feasible,
    violations: e.violations,
    chosen: e === best,
    lostOn: e === best ? null : lostOn(e, best),
    replayed: e.replayed,
    tpsPerUser: e.tpsPerUser,
    rawLatencyUs: e.rawLatencyUs,
    dieAreaMm2: e.dieAreaMm2,
    diePowerW: e.diePowerW,
    cardPowerW: e.cardPowerW,
    portAreaMm2: e.portAreaMm2,
    portPowerW: e.portPowerW,
  }));
  const byCause = {};
  for (const e of all) if (!e.feasible) for (const v of e.violations) byCause[v] = (byCause[v] || 0) + 1;
  return {
    status: 'MODEL (search over the HW-03 design space; the candidate set behind out/detailed/sram_design.json, not FROZEN)',
    designSpace: {file: SPACE_FILE, sha256: ctx.sha256, dimensions: Object.keys(ctx.space.dimensions)},
    requirements: {models: ctx.space.requirements.models, contractEntry: ctx.space.requirements.contractEntry,
      sharedMiBMin: ctx.sharedMiBMin, targetTpsPerUser: ctx.target.tpsPerUser, limits: ctx.limits},
    contract: CONTRACT.provenance(ctx.contract),
    clause: ctx.clause,
    // The caliber the consumer compares against the contract (same reason as the
    // siblings: without it, a per-card window or a port-free area gets read as the
    // contract's per-die quantity).
    fieldCaliber: {
      areaIncludesPortCost: 'yes',
      powerScope: 'die (diePowerW) and card (cardPowerW)',
      sharedMiBCaliber: 'per compute die, MiB of shared SRAM data capacity; the contract\'s sharedMiBPerDie',
      note: 'dieAreaMm2 / diePowerW include O.chargeSharedPortCost (portAreaMm2 / portPowerW, 0 when the scaling is off); '
        + 'the port-scaling coefficients are MODEL (O-007), not a bank-cycle simulation; tpsPerUser is the K3 detailed '
        + 'replay at the published compute, null when the window is below B-SRAM-CAP and not replayed',
    },
    ranking: 'feasible first, then least die area including the shared-port charge, then least die power, then pick; infeasible by fewest violations',
    totalCandidates: counts.candidates,
    feasibleCandidates: counts.feasible,
    replayedCandidates: all.filter(e => e.replayed).length,
    infeasibleByCause: byCause,
    candidateSetSha256: fingerprint(entries),
    candidates: entries,
    regenerate: 'node integration/pipelines/generate_sram_design.js (npm run sram:search); enforced by tests/regression/test_sram_design.js',
  };
}

// Document tables. Every row holds the other dimensions at the winner.
//  - capacitySweep: the contract grid B-SRAM-CAP was derived on, replayed here even below
//    the floor, next to the contract's own holds verdict: the two differ because the
//    floor was derived at the split point (compute relaxed), not at the published compute.
//  - localSweep: the ruled local capacity, as numbers.
//  - published: where the published SRAM combination ranks, and what the winner saves.
function analysis(result = search()) {
  const {ctx, best} = result;
  const capacitySweep = ctx.holdsBySharedMiB.map(({sharedMiB, holds}) => {
    const fields = {...best.fields, sharedMiB};
    const sys = replay(ctx, fields, best.pick.sharedPortScaling);
    return {sharedMiB, contractHolds: holds, aboveFloor: sharedMiB >= ctx.sharedMiBMin - EPS, replayFeasible: sys.feasible,
      tpsPerUser: sys.tpsPerUser, dieAreaMm2: sys.dieAreaMm2, diePowerW: sys.diePowerW, cardPowerW: sys.cardPowerW, reasons: sys.reasons};
  });
  const localSweep = [];
  for (const lMiB of A.SPACE.lMiB) localSweep.push({lMiB, hMiB: ctx.published.hMiB, ...localRow(ctx, best, {lMiB, hMiB: ctx.published.hMiB})});
  for (const hMiB of A.SPACE.hMiB) if (hMiB !== ctx.published.hMiB) localSweep.push({lMiB: ctx.published.lMiB, hMiB, ...localRow(ctx, best, {lMiB: ctx.published.lMiB, hMiB})});
  const pub = evaluate(ctx, publishedPick(ctx));
  const order = ranked(result);
  return {capacitySweep, localSweep,
    published: {pick: pub.pick, rank: order.findIndex(e => JSON.stringify(e.pick) === JSON.stringify(pub.pick)) + 1,
      feasible: pub.feasible, tpsPerUser: pub.tpsPerUser, dieAreaMm2: pub.dieAreaMm2, diePowerW: pub.diePowerW, cardPowerW: pub.cardPowerW,
      winnerSavesMm2: pub.dieAreaMm2 - best.dieAreaMm2, winnerSavesW: pub.diePowerW - best.diePowerW,
      tpsGivenUp: pub.tpsPerUser - best.tpsPerUser},
    margins: {targetTpsPerUser: ctx.target.tpsPerUser, architectureGate: ctx.target.architectureGate,
      aboveTarget: best.tpsPerUser - ctx.target.tpsPerUser, aboveGate: best.tpsPerUser - ctx.target.architectureGate}};
}

function localRow(ctx, best, local) {
  const e = evaluate(ctx, best.pick, null, {local});
  return {chosen: local.lMiB === ctx.published.lMiB && local.hMiB === ctx.published.hMiB,
    feasible: e.feasible, violations: e.violations, tpsPerUser: e.tpsPerUser, dieAreaMm2: e.dieAreaMm2, diePowerW: e.diePowerW, cardPowerW: e.cardPowerW};
}

function build(result = search()) {
  const {ctx, best, counts} = result, {space, x, point} = ctx, D = space.dimensions;
  const design = Object.fromEntries(Object.entries(best.pick).map(([d, n]) => {
    const {evidence, ...value} = D[d].options[n];
    return [d, {option: n, ...value, evidence}];
  }));
  return {
    status: 'MODEL (search over the HW-03 design space: B-SRAM-CAP + K3 detailed replay against the contract target + B-AREA envelope; not FROZEN, does not change the published point)',
    owner: space.owner,
    document: space.document,
    designSpace: {file: SPACE_FILE, sha256: ctx.sha256, dimensions: Object.keys(D), candidates: counts.candidates, feasible: counts.feasible,
      constraints: space.constraints, objective: space.objective,
      note: 'only the winning design is written here; the alternatives stay in the design space, in out/detailed/sram_candidates.json and in the document'},
    requirements: {models: space.requirements.models, contractEntry: space.requirements.contractEntry,
      sharedMiBMin: ctx.sharedMiBMin, targetTpsPerUser: ctx.target.tpsPerUser, limits: ctx.limits},
    contract: CONTRACT.provenance(ctx.contract),
    clause: ctx.clause,
    caliber: space.caliber,
    hardware: {publishedX: {...x}, x: {...x, ...best.fields},
      opt: {...D.sharedPortScaling.options[best.pick.sharedPortScaling].patch}},
    design,
    ruled: Object.fromEntries(Object.entries(space.ruled).map(([k, v]) => [k, {chosen: v.chosen, reason: v.reason}])),
    evaluation: {
      k3System: {publishedTpsPerUser: point.tpsPerUser, tpsPerUser: best.tpsPerUser, rawLatencyUs: best.rawLatencyUs,
        contractTargetTpsPerUser: ctx.target.tpsPerUser, architectureGate: ctx.target.architectureGate},
      sharedMiB: best.fields.sharedMiB, dieAreaMm2: best.dieAreaMm2, diePowerW: best.diePowerW, cardPowerW: best.cardPowerW,
      portAreaMm2: best.portAreaMm2, portPowerW: best.portPowerW,
      note: 'the winner is the cheapest die that satisfies the contract at the published compute; whether it holds next to the other domains\' winners is design.coupling\'s question'
    },
    regenerate: 'node integration/pipelines/generate_sram_design.js (npm run sram:search); enforced by tests/regression/test_sram_design.js'
  };
}

module.exports = {SPACE_FILE, context, evaluate, search, candidates, alternatives, analysis, build, replay, publishedPick, fingerprint};
