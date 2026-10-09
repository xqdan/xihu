'use strict';
/* Comm Core design search (HW-07, teams/hardware/docs/10_COMM_CORE.md).
 *
 * The design space is HW-07's input, teams/hardware/inputs/comm_core_design_space.json:
 * placement, trigger, WQE generation, TX lanes, doorbell, commit counting,
 * signal delivery, graph storage, local SRAM and management cores, with their
 * cycle and area ASSUMPTIONs. search() enumerates the product, drops invalid
 * combinations (an option's `requires`), and scores every candidate:
 *
 *   per collective class k: latency_k = protocol_k(signal) + control_k
 *   control_k = trigger + graph fetch + WQE dispatch + doorbell + completion
 *
 * protocol_k is the pre-floor duration mapped() gives the class under the
 * candidate's signal delivery (k3_sram_memory_rdma_model.collective, from the
 * first WQE at the NIC); control_k is the path the protocol model does not
 * charge, built from the floorplan hop counts and the option cycles. A candidate
 * is feasible if every class stays within the spec tau (the published point is
 * then unchanged, and so is raw within the raw budget, because TPS does not
 * rise with tau), its graph fits the local SRAM and the Comm Core is busy for
 * at most maxUtilization of the token. Feasible candidates are ranked by AI
 * Core time spent on communication control, then spec-tau slack of the slowest
 * class, then area.
 *
 * build() writes only the winner (out/detailed/comm_core_design.json);
 * alternatives() gives the best candidate for every option of every dimension,
 * which the document quotes to show why each alternative lost.
 * Evidence class MODEL: cycle counts and areas are ASSUMPTIONs (O-018).
 */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const A = require('./k3_architecture_search.js');
const O = require('./k3_rdma_final_tuning_model.js');
const P = require('./k3_physical_basis.js');
const R = require('./k3_sram_memory_rdma_model.js');
const CONTRACT = require('./design_contract.js');

const root = path.resolve(__dirname, '../..');
const SPACE_FILE = 'teams/hardware/inputs/comm_core_design_space.json';
const read = p => JSON.parse(fs.readFileSync(path.join(root, p), 'utf8'));
const TAU_SWEEP = [1.0, 1.15, 1.35, 1.5, 2.0, 3.0];
const PEERS = 31; // inbound commits per slot (TP32)
const EPS = 1e-9;
const align = (n, a) => Math.ceil(n / a) * a;
const dist = (a, b) => Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]);

// Protocol-parameter overrides per signal delivery (O.OPT is merged over R.MEM
// before R.collective).
function signalOpt(name, x) {
  const M = R.MEM, f = x.ghz * 1000;
  if (name === 'putWithSignal') return {};
  if (name === 'separateSignal') return {issueCycles: 2 * M.issueCycles, headerBytes: M.headerBytes + align(M.headerBytes + M.flagBytes, M.packetAlign)};
  if (name === 'writeThenSignal') return {commitCycles: O.OPT.commitCycles + 2 * O.OPT.oneWayUs * f + O.OPT.ackCycles};
  throw new Error(`unknown signal delivery ${name}`);
}

// Run fn with O.OPT overridden by `opt` and a control path added to every
// collective (`controlUs`: a number, or a function of the collective name);
// O.OPT (values and key order) and R.collective are always restored.
function withProtocol({controlUs = 0, opt = {}}, fn) {
  const saved = {}, orig = R.collective;
  for (const [k, v] of Object.entries(opt)) { saved[k] = [k in O.OPT, O.OPT[k]]; O.OPT[k] = v; }
  R.collective = (name, ...args) => {
    const q = orig(name, ...args), c = typeof controlUs === 'function' ? controlUs(name) : controlUs;
    if (c) { q.timing.controlPath = c; q.duration += c; }
    return q;
  };
  try { return fn(); } finally {
    for (const [k, [had, v]] of Object.entries(saved)) { if (had) O.OPT[k] = v; else delete O.OPT[k]; }
    R.collective = orig;
  }
}

// Replay the detailed model with the control path, the tau floor at `tauUs`
// and optional protocol overrides.
function replay(x, {controlUs = 0, tauUs = O.OPT.tauUs, opt = {}} = {}) {
  return withProtocol({controlUs, opt: {...opt, tauUs}}, () => {
    const r = O.evaluate(x);
    if (!r.feasible) return {feasible: false, reasons: r.reasons || [r.reason]};
    return {feasible: true, tpsPerUser: r.tps, rawLatencyUs: r.rawUs, commUs: r.commUs};
  });
}

// Largest uniform control path (us per collective, no tau floor) that keeps raw
// latency within the budget.
function controlBudget(x, rawBudgetUs, opt = {}) {
  let lo = 0, hi = 2;
  for (let i = 0; i < 40; i++) {
    const mid = (lo + hi) / 2;
    if (replay(x, {controlUs: mid, tauUs: 0, opt}).rawLatencyUs <= rawBudgetUs) lo = mid; else hi = mid;
  }
  return lo;
}

// Collective classes under a signal delivery: pre-floor protocol time, count,
// WQEs, active NICs, whether a reduce follows; plus per-token wire bytes.
function protocolClasses(x, opt) {
  return withProtocol({opt}, () => {
    const m = O.mapped(x), classes = {};
    for (const o of m.plan.ops.filter(q => q.unit === 'COMM')) {
      const k = classes[o.name] || (classes[o.name] = {name: o.name, count: 0, protocolUs: o.duration - o.timing.tauFloor,
        requests: o.memory.requests, phases: o.memory.phases, activeNICs: o.memory.activeNICs, reduce: o.timing.tpReduce > 0});
      k.count++;
    }
    return {classes: Object.values(classes), wireBytesPerToken: m.wireBytes, p: m.p};
  });
}

function context() {
  const space = read(SPACE_FILE);
  CONTRACT.declared(space, 'comm', SPACE_FILE);
  const spec = read('teams/hardware/inputs/k3_mc_baseline.json');
  const x = spec.tpsDesign.hardware.x, point = spec.tpsDesign.point;
  const signals = {};
  for (const name of Object.keys(space.dimensions.signal.options)) {
    const opt = signalOpt(name, x);
    signals[name] = {opt, ...protocolClasses(x, opt), issueCycles: {...R.MEM, ...O.OPT, ...opt}.issueCycles};
  }
  const p = signals.putWithSignal.p;
  // The clause this domain answers for (23 section 4, L3): B-TAU, the time one collective
  // may take. This search was already a tau search -- it just read the ceiling off the
  // tuned model's own OPT.tauUs, which is the published design. Reading it from the
  // contract is what makes a different split able to move it: S-TAU widens tau and this
  // search widens with it, without an edit here.
  const contract = CONTRACT.load();
  const tau = CONTRACT.ownedBy(contract.contract, 'comm');
  return {space, x, point, p, signals, f: x.ghz * 1000, hop: A.TECH.routerCycles,
    contract, clause: CONTRACT.clause(contract, 'comm'), target: contract.contract.target, tauUsMax: tau.max,
    sha256: crypto.createHash('sha256').update(fs.readFileSync(path.join(root, SPACE_FILE))).digest('hex')};
}

// Score one candidate (an option name per dimension).
function evaluate(ctx, pick) {
  const {space, p, f, hop} = ctx, D = space.dimensions, F = space.floorplan, Q = space.requirements;
  const o = Object.fromEntries(Object.entries(pick).map(([d, n]) => [d, D[d].options[n]]));
  const sig = ctx.signals[pick.signal], classes = sig.classes;
  const xy = o.placement.xy, cores = Object.values(F.cores);
  const dCore = Math.max(...cores.map(c => dist(c, xy))), dGw = dist(xy, F.gateway), dRed = dist(xy, F.reduce);
  const dShared = Math.min(...Object.values(F.shared).map(s => dist(s, xy)));
  const coreOrigin = o.wqeGeneration.origin === 'core';
  const firmwareJobs = [o.trigger, o.wqeGeneration, o.commitCounting].filter(v => v.firmware).length;
  const contention = firmwareJobs > o.managementCores.count - 1 ? Q.firmwareContentionCycles : 0;
  const fw = v => (v.firmware ? contention : 0);

  // Graph storage in the Comm Core and where it is read from.
  const storage = o.wqeGeneration.storage;
  const graphBytes = !storage ? 0 : classes.reduce((a, k) => a + (storage === 'template' ? k.requests * Q.wqeBytes + k.count * Q.patchEntryBytes
    : k.activeNICs * PEERS * Q.peerEntryBytes + k.count * Q.descriptorBytes), 0);
  const local = storage && pick.graphStore === 'localSram';
  const fetch = !storage ? 0 : pick.graphStore === 'sharedSram' ? 2 * dShared * hop + o.graphStore.sramCycles
    : pick.graphStore === 'mc' ? o.graphStore.fetchUs * f : 0;

  const trigger = coreOrigin ? 0 : (o.trigger.viaDispatcher ? 2 * p.meshSide * hop : dCore * hop) + o.trigger.cycles + fw(o.trigger);
  const doorbellLeg = coreOrigin ? Math.max(...cores.map(c => dist(c, F.gateway))) : dGw;
  const doorbell = doorbellLeg * hop + o.doorbell.cycles + (o.doorbell.fetchSramCycles ? 2 * doorbellLeg * hop + o.doorbell.fetchSramCycles : 0);
  const lanes = o.wqeGeneration.usesLanes ? o.txLanes.lanes : 1;
  const perClass = classes.map(k => {
    const g = o.wqeGeneration, perNic = k.requests / (k.activeNICs * k.phases);
    const dispatch = g.fixedUs !== undefined ? g.fixedUs * f
      : g.cyclesPerWqe + Math.max(0, g.cyclesPerWqe * Math.ceil(k.activeNICs / lanes) - sig.issueCycles) * (perNic - 1) + fw(g);
    const c = o.commitCounting, commitIn = dGw * hop, reduceKick = k.reduce ? dRed * hop : 0;
    const completion = c.pollCycles !== undefined ? c.pollCycles + 2 * p.meshSide * hop
      : commitIn + reduceKick + dCore * hop + (c.cyclesPerCommit !== undefined
        ? c.cyclesPerCommit + Math.max(0, c.cyclesPerCommit - sig.issueCycles) * (PEERS - 1) + fw(c) : c.cycles);
    const steps = {trigger, fetch, dispatch, doorbell, completion};
    const controlUs = Object.values(steps).reduce((a, v) => a + v, 0) / f;
    return {name: k.name, count: k.count, requests: k.requests, activeNICs: k.activeNICs, reduce: k.reduce,
      protocolUs: k.protocolUs, steps: Object.fromEntries(Object.entries(steps).map(([s, v]) => [s, v / f])), controlUs,
      latencyUs: k.protocolUs + controlUs, slackUs: ctx.tauUsMax - k.protocolUs - controlUs};
  });
  const slowest = perClass.reduce((a, k) => (k.latencyUs > a.latencyUs ? k : a));
  const collectives = classes.reduce((a, k) => a + k.count, 0), wqes = classes.reduce((a, k) => a + k.count * k.requests, 0);
  const wqesPerToken = wqes * (pick.signal === 'separateSignal' ? 2 : 1);

  const aiCoreUsPerToken = coreOrigin ? collectives * o.wqeGeneration.fixedUs : collectives * (o.trigger.aiCoreCyclesPerCollective || 0) / f;
  // Busiest Comm Core resource per token: WQE generation, or firmware commit handling.
  const txBusy = coreOrigin ? 0 : (collectives * ((o.trigger.cycles || 0) + o.doorbell.cycles) + wqesPerToken * (o.wqeGeneration.cyclesPerWqe || 0) / lanes) / f;
  const rxBusy = wqesPerToken * (o.commitCounting.cyclesPerCommit || 0) / f;
  const busyUsPerToken = Math.max(txBusy, rxBusy), utilization = busyUsPerToken / ctx.point.rawLatencyUs;

  const sramMm2 = o.localSramKiB.kib / 1024 / A.TECH.sramMiBPerMm2 * P.PROCESS[P.BASIS.process].sram;
  const area = {trigger: coreOrigin ? 0 : o.trigger.areaMm2, lanes: (o.wqeGeneration.laneAreaMm2 || 0) * lanes, doorbell: o.doorbell.areaMm2,
    commitCounting: o.commitCounting.areaMm2, sram: sramMm2, managementCores: o.managementCores.count * Q.managementCoreAreaMm2};
  const areaMm2 = Object.values(area).reduce((a, v) => a + v, 0);

  const violations = [];
  if (slowest.slackUs < -EPS) violations.push('aboveContractTau');
  if (local ? graphBytes * Q.graphBuffers > o.localSramKiB.kib * 1024 : false) violations.push('sramCapacity');
  if (utilization > Q.maxUtilization) violations.push('utilization');
  return {pick, feasible: !violations.length, violations, aiCoreUsPerToken, specSlackUs: slowest.slackUs, areaMm2, area,
    classes: perClass, slowest: {name: slowest.name, latencyUs: slowest.latencyUs}, firmwareOnCriticalPath: firmwareJobs > 0,
    floorplan: {xy, hopsToFarthestCore: dCore, hopsToGateway: dGw, hopsToReduce: dRed, hopsToNearestShared: dShared},
    load: {collectivesPerToken: collectives, wqesPerToken, wireBytesPerToken: sig.wireBytesPerToken, busyUsPerToken, utilization,
      graphBytes, graphStoredLocally: !!local}};
}

// Invalid combinations: an option's `requires`, and dimensions that do not
// apply (lanes, graph storage and SRAM without a Comm Core generator) pinned
// to their first option so they do not multiply identical candidates.
function valid(space, pick) {
  const D = space.dimensions, first = d => Object.keys(D[d].options)[0];
  for (const [d, n] of Object.entries(pick)) {
    for (const [rd, allowed] of Object.entries(D[d].options[n].requires || {})) if (!allowed.includes(pick[rd])) return false;
  }
  const g = D.wqeGeneration.options[pick.wqeGeneration];
  if (!g.usesLanes && pick.txLanes !== first('txLanes')) return false;
  if (!g.storage && (pick.graphStore !== first('graphStore') || pick.localSramKiB !== first('localSramKiB'))) return false;
  if (g.storage && pick.graphStore !== 'localSram' && pick.localSramKiB !== first('localSramKiB')) return false;
  return true;
}

// Ranking: feasible, least AI Core time, largest spec slack, least area, name.
function better(a, b) {
  if (a.feasible !== b.feasible) return a.feasible;
  if (Math.abs(a.aiCoreUsPerToken - b.aiCoreUsPerToken) > EPS) return a.aiCoreUsPerToken < b.aiCoreUsPerToken;
  if (Math.abs(a.specSlackUs - b.specSlackUs) > EPS) return a.specSlackUs > b.specSlackUs;
  if (Math.abs(a.areaMm2 - b.areaMm2) > EPS) return a.areaMm2 < b.areaMm2;
  return JSON.stringify(a.pick) < JSON.stringify(b.pick);
}

// The criterion on which `a` loses to the winner `w`.
function lostOn(a, w) {
  if (!a.feasible) return `infeasible: ${a.violations.join(', ')}`;
  if (Math.abs(a.aiCoreUsPerToken - w.aiCoreUsPerToken) > EPS) return 'aiCoreTime';
  if (Math.abs(a.specSlackUs - w.specSlackUs) > EPS) return 'specSlack';
  if (Math.abs(a.areaMm2 - w.areaMm2) > EPS) return 'area';
  return 'tie';
}

const optionId = pick => Object.entries(pick).map(([d, n]) => `${d}=${n}`).join('|');

// Compact projection of an evaluate() result: exactly the fields the ranking
// reads, plus the numbers a reader needs to see why a candidate lost. The full
// result carries the per-class breakdown (classes, steps, area) and this grid
// scores 45900 candidates, so retaining the full objects is hundreds of
// megabytes; the projection is what candidates() needs and nothing more.
const score = e => ({
  optionId: optionId(e.pick), pick: {...e.pick}, feasible: e.feasible, violations: [...e.violations],
  aiCoreUsPerToken: e.aiCoreUsPerToken, specSlackUs: e.specSlackUs, areaMm2: e.areaMm2,
  controlUs: e.classes.reduce((a, k) => a + k.controlUs, 0), slowest: {...e.slowest},
  collectivesPerToken: e.load.collectivesPerToken, wqesPerToken: e.load.wqesPerToken,
  wireBytesPerToken: e.load.wireBytesPerToken, utilization: e.load.utilization,
  graphBytes: e.load.graphBytes, graphStoredLocally: e.load.graphStoredLocally,
});

function search(ctx = context()) {
  const D = ctx.space.dimensions, dims = Object.keys(D);
  let best = null, candidates = 0, validCount = 0, feasible = 0;
  const perOption = Object.fromEntries(dims.map(d => [d, {}]));
  // Every valid combination, as a scored projection. Invalid combinations never
  // reach here -- valid() drops them before evaluation, so they have no score to
  // report and appear only as the gap between counts.candidates and counts.valid.
  const all = [];
  const walk = (i, pick) => {
    if (i === dims.length) {
      candidates++;
      if (!valid(ctx.space, pick)) return;
      validCount++;
      const e = evaluate(ctx, {...pick});
      if (e.feasible) feasible++;
      all.push(score(e));
      if (!best || better(e, best)) best = e;
      for (const d of dims) { const cur = perOption[d][pick[d]]; if (!cur || better(e, cur)) perOption[d][pick[d]] = e; }
      return;
    }
    for (const n of Object.keys(D[dims[i]].options)) { pick[dims[i]] = n; walk(i + 1, pick); }
  };
  walk(0, {});
  return {ctx, best, perOption, all, counts: {candidates, valid: validCount, feasible}};
}

const controlOf = e => name => e.classes.find(k => k.name === name).controlUs;

// Best candidate per option of every dimension, replayed at the spec tau floor.
function alternatives(result = search()) {
  const {ctx, best, perOption} = result, out = {};
  for (const [d, opts] of Object.entries(perOption)) {
    out[d] = {};
    for (const [n, e] of Object.entries(opts)) {
      out[d][n] = {chosen: n === best.pick[d], lostOn: n === best.pick[d] ? null : lostOn(e, best), pick: e.pick, feasible: e.feasible,
        violations: e.violations, slowest: e.slowest, specSlackUs: e.specSlackUs, aiCoreUsPerToken: e.aiCoreUsPerToken, areaMm2: e.areaMm2,
        wqesPerToken: e.load.wqesPerToken, wireBytesPerToken: e.load.wireBytesPerToken, utilization: e.load.utilization,
        withSpecFloor: replay(ctx.x, {controlUs: controlOf(e), opt: ctx.signals[e.pick.signal].opt})};
    }
  }
  return out;
}

// The candidate set behind out/detailed/comm_core_design.json: the whole scored
// set is fingerprinted, the listed rows are bounded.
//
// The siblings (memory, physical, matrix:vector) list every scored candidate
// because their grids are small -- 400, 24 and a few hundred -- so the file is a
// few hundred kilobytes and "candidate X was excluded because Y" is answerable
// straight out of it. This grid scores 45900 combinations, and the projection
// above costs about 1 KB each: listing all of them would commit tens of
// megabytes to a repository that tracks out/, for a file whose only consumer
// (design.comm) reads the top 12 and slices to them anyway. So the split here is
// explicit rather than silent:
//
//   * candidateSetSha256 is taken over every scored candidate, so "these are the
//     candidates that were searched" is checkable from a fresh run whatever the
//     listing shows;
//   * the listed rows are the ranked head, `listed` says how many, and
//     `infeasibleByCause` counts every excluded candidate by its violation set,
//     so no exclusion reason disappears into the truncation.
//
// Ordering is the search's own (feasible first, then least AI Core time, then
// largest spec slack, then least area, then name); a consumer must not re-rank.
const CANDIDATE_LIMIT = 512;

// Fingerprint of a candidate set. Stable across runs and machines: fields
// sorted, numbers rounded to reported precision, digest over JSON with an
// explicit key order. A fingerprint that depends on enumeration order is worse
// than none -- it would disagree between two identical searches.
function fingerprint(entries) {
  const canon = entries.map(c => {
    const pick = Object.fromEntries(Object.entries(c.pick).sort(([a], [b]) => (a < b ? -1 : 1)));
    return {
      pick, feasible: c.feasible, violations: [...c.violations].sort(),
      aiCoreUsPerToken: Number(c.aiCoreUsPerToken.toFixed(9)), specSlackUs: Number(c.specSlackUs.toFixed(9)),
      areaMm2: Number(c.areaMm2.toFixed(9)), controlUs: Number(c.controlUs.toFixed(9)),
    };
  });
  canon.sort((a, b) => (JSON.stringify(a.pick) < JSON.stringify(b.pick) ? -1 : 1));
  return crypto.createHash('sha256').update(JSON.stringify(canon)).digest('hex');
}

function candidates(result = search()) {
  const {ctx, best, all, counts} = result, {space} = ctx;
  const ranked = [...all].sort((a, b) => (better(a, b) ? -1 : better(b, a) ? 1 : 0));
  const winner = optionId(best.pick);
  const entries = ranked.slice(0, CANDIDATE_LIMIT).map((e, i) => ({
    rank: i + 1,
    ...e,
    chosen: e.optionId === winner,
    lostOn: e.optionId === winner ? null : lostOn(e, best),
  }));
  // Every exclusion, by cause. The ranked head is dominated by feasible
  // candidates, so without this the reasons the other ~39000 were dropped would
  // be absent from the file that exists to make exclusions reproducible.
  const infeasibleByCause = {};
  for (const e of all) {
    if (e.feasible) continue;
    const k = [...e.violations].sort().join('+') || 'unspecified';
    infeasibleByCause[k] = (infeasibleByCause[k] || 0) + 1;
  }
  return {
    status: 'MODEL (search over the HW-07 design space on the detailed protocol model; the candidate set behind out/detailed/comm_core_design.json, not FROZEN)',
    designSpace: {file: SPACE_FILE, sha256: ctx.sha256, dimensions: Object.keys(space.dimensions)},
    requirements: {graphBuffers: space.requirements.graphBuffers, maxUtilization: space.requirements.maxUtilization,
      wqeBytes: space.requirements.wqeBytes, patchEntryBytes: space.requirements.patchEntryBytes,
      descriptorBytes: space.requirements.descriptorBytes, peerEntryBytes: space.requirements.peerEntryBytes,
      specTauUs: ctx.tauUsMax},
    contract: CONTRACT.provenance(ctx.contract),
    clause: ctx.clause,
    // The caliber the consumer compares against the spec. Same reason as the
    // siblings: without it, "the internal identity holds" gets read as "the
    // area meets the spec". Cycle counts and areas are ASSUMPTIONs (O-018).
    fieldCaliber: {
      areaIncludesPortCost: 'yes',
      powerScope: 'die',
      note: 'area sum includes the txLanes lane scaling (wqeGeneration.laneAreaMm2 x lanes) and the '
        + 'management-core area; cycle counts and areas are ASSUMPTIONs at the die clock (O-018), '
        + 'not calibrated values; this artifact carries no power field',
    },
    ranking: space.objective.join(', '),
    // Sibling convention: totalCandidates is the enumerated product, feasible the
    // feasible count. `valid` sits between them because this grid -- unlike the
    // siblings' -- drops invalid combinations before scoring, so the two counts
    // do not account for every enumerated combination on their own.
    totalCandidates: counts.candidates,
    validCandidates: counts.valid,
    feasibleCandidates: counts.feasible,
    listed: entries.length,
    truncated: counts.valid > entries.length,
    infeasibleByCause,
    candidateSetSha256: fingerprint(all),
    candidates: entries,
    regenerate: 'node integration/pipelines/generate_comm_core_design.js (npm run commcore:search); enforced by tests/regression/test_comm_core_design.js',
  };
}

function build(result = search()) {
  const {ctx, best, counts} = result, {space, x, point} = ctx, D = space.dimensions;
  const opt = ctx.signals[best.pick.signal].opt, control = controlOf(best);
  const hopUs = ctx.p.meshSide * ctx.hop / ctx.f;
  const design = Object.fromEntries(Object.entries(best.pick).map(([d, n]) => [d, {option: n, ...D[d].options[n]}]));
  return {
    status: 'MODEL (search over the HW-07 design space on the detailed protocol model; not FROZEN, does not change the published point)',
    owner: space.owner,
    document: space.document,
    designSpace: {file: SPACE_FILE, sha256: ctx.sha256, dimensions: Object.keys(D), candidates: counts.candidates, valid: counts.valid,
      feasible: counts.feasible, constraints: space.constraints, objective: space.objective,
      note: 'only the winning design is written here; the alternatives stay in the design space and in the document, section 7'},
    hardware: {x: {...x}, ghz: x.ghz, meshSide: ctx.p.meshSide, routerCyclesPerHop: ctx.hop},
    published: {tpsPerUser: point.tpsPerUser, rawLatencyUs: point.rawLatencyUs, rawBudgetUs: point.rawBudgetUs, specTauUs: ctx.tauUsMax,
      collectivesPerToken: best.load.collectivesPerToken},
    contract: CONTRACT.provenance(ctx.contract),
    clause: ctx.clause,
    design,
    ruled: Object.fromEntries(Object.entries(space.ruled).map(([k, v]) => [k, {chosen: v.chosen, reason: v.reason}])),
    controlPath: {floorplan: best.floorplan, classes: best.classes, slowest: best.slowest, specSlackUs: best.specSlackUs,
      firmwareOnCriticalPath: best.firmwareOnCriticalPath},
    evaluation: {
      aiCoreUsPerToken: best.aiCoreUsPerToken, areaMm2: best.areaMm2, area: best.area,
      withSpecFloor: replay(x, {controlUs: control, opt}),
      bottomUp: replay(x, {controlUs: control, tauUs: 0, opt}),
      controlUsWithinRawBudget: controlBudget(x, point.rawBudgetUs, opt),
      tauSweep: TAU_SWEEP.map(t => ({tauUs: t, ...replay(x, {tauUs: t, opt})}))
    },
    load: {...best.load, localSramKiB: design.localSramKiB.kib,
      graphKiB: best.load.graphBytes / 1024, sramMm2: best.area.sram},
    memorySemantics: {signal: best.pick.signal, aiCoreRemoteAccess: space.ruled.aiCoreRemoteAccess.chosen,
      // A remote load from an AI Core: to the NIC and back across the mesh plus
      // two one-way trips; the Core waits for all of it.
      remoteLoadMinUs: 2 * O.OPT.oneWayUs + 2 * hopUs},
    regenerate: 'node integration/pipelines/generate_comm_core_design.js (npm run commcore:search); enforced by tests/regression/test_comm_core_design.js'
  };
}

// withProtocol and protocolClasses are also what design.coupling's joint replay
// (coupling_search.js) needs to carry the comm winner's control path and B-TAU check.
module.exports = {SPACE_FILE, context, evaluate, search, alternatives, candidates, build, replay, signalOpt,
  withProtocol, protocolClasses};
