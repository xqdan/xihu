'use strict';
/* Link-level derivation of the per-collective latency tau (HW-CH-01, teams/council/docs/
 * 24_TRACE_AND_CHARON_ADOPTION_PLAN.md; method borrowed from Charon section 5; B-008 / B-004 / B-005 / O-018).
 *
 * The published point charges every collective max(protocol, tau = 1.15 us) (ADR-0004), and the
 * protocol model (k3_sram_memory_rdma_model.phase) puts one abstract wire with a fixed one-way
 * latency OPT.oneWayUs = 0.05 us between any two cards. This module replaces that wire with a
 * scale-out topology and derives each collective bottom-up:
 *
 *   tau = memoryTransport (link-level, below) + tpReduce (model) + cardLocal (model, die hops rescaled)
 *       + portTail (model floor, recomputed) + controlPath (Comm Core, out/detailed/comm_core_design.json)
 *
 * memoryTransport is a sequence of steps. Each step is the model's phase(): every active NIC of
 * every rank sends one message to each of its destinations through the same issue / outstanding-
 * window / serialization chain, with the fixed one-way latency replaced by the path latency
 *
 *   macUs + links x (phyUs + fecUs + cable m x propagation) + switches x switchUs
 *         + relay cards x relayUs + die hops x ucieHopUs
 *
 * and a link floor: the busiest directed link, with all 32 ranks running the step, must carry its
 * bytes at its lane bandwidth, so no message serializes faster than that link's time / messages.
 * The step ends when the last write is visible, plus (ackDrain 'phase', the model's semantics) the
 * last ACK; 'deferred' starts the next step at visibility and leaves ACKs to the epoch slots.
 * Algorithms: oneShot (the model's direct 31-peer writes, 1 or 2 phases), halvingDoubling (5 + 5
 * pairwise steps, the tree class), ring (31 + 31 neighbour steps).
 *
 * The topology `published` keeps the abstract wire; with it, oneShot, 'phase', no control path
 * and the model's die hop, every class reproduces the model's memoryTransport exactly (the anchor).
 *
 * Each cell (topology x algorithm x ackDrain) replays the published point with every collective
 * at its derived tau and no floor (bottom-up), with the 1.15 us floor (spec basis), and at the
 * optimistic and pessimistic corners of the parameter ranges. The best oneShot / phase-semantics
 * cell of each topology gets a tornado and, for parameters whose range straddles 1000 TPS/usr,
 * the break-even value. Every latency is an ASSUMPTION (teams/hardware/inputs/
 * scaleout_topology_candidates.json); the report is MODEL and changes no baseline or OPT.tauUs.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const A = require('./k3_architecture_search.js');
const R = require('./k3_sram_memory_rdma_model.js');
const O = require('./k3_rdma_final_tuning_model.js');
const BP = require('./baseline_point.js');

const root = path.resolve(__dirname, '../..');
const BASELINE_FILE = 'teams/hardware/inputs/k3_mc_baseline.json';
const CANDIDATES_FILE = 'teams/hardware/inputs/scaleout_topology_candidates.json';
const COMM_CORE_FILE = 'out/detailed/comm_core_design.json';
const SOURCE_FILES = [
  'integration/detailed/collective_topology.js',
  'integration/detailed/k3_sram_memory_rdma_model.js',
  'integration/detailed/k3_rdma_final_tuning_model.js',
  'integration/detailed/k3_operator_sram_sim.js',
  'integration/detailed/k3_architecture_search.js',
  'integration/detailed/cost_provider.js',
  'teams/vv/inputs/operator_cost_observations.json',
  'integration/detailed/k3_physical_basis.js'
];
const FORMAT = 'k3-tau-derivation/1';
const EVIDENCE = 'MODEL';
const TARGET_TPS = 1000;
const ALGORITHMS = ['oneShot', 'halvingDoubling', 'ring'];
const ACK_DRAIN = ['phase', 'deferred'];
const TP = 32;
const BISECT_STEPS = 20;
// Floors replayed on the unmodified protocol model: below the spec tau the published point turns DMA-bound.
const UNIFORM_TAU_SWEEP = [0, 0.5, 0.9, 1.15, 1.35, 1.5, 2.0];
const TOL = 1e-9;

const sha256 = data => crypto.createHash('sha256').update(data).digest('hex');
const hashFile = relativePath => sha256(fs.readFileSync(path.join(root, relativePath)));
const readJson = relativePath => JSON.parse(fs.readFileSync(path.join(root, relativePath), 'utf8'));
const align = (n, a) => Math.ceil(n / a) * a;

// ---- topologies ---------------------------------------------------------------------------------

// Dies a port's lanes touch, lanes taken in port order from die 0 upward.
function portDies(port, lanes, lanesPerDie) {
  const first = Math.floor(port * lanes / lanesPerDie), last = Math.floor(((port + 1) * lanes - 1) / lanesPerDie);
  return Array.from({length: last - first + 1}, (_, i) => first + i);
}
const ringDist = (a, b, n) => Math.min(Math.abs(a - b), n - Math.abs(a - b));
const setDist = (as, bs, n) => Math.min(...as.flatMap(a => bs.map(b => ringDist(a, b, n))));

// A topology instance: route(src, dst, nicDie) -> {links: [{id, lanes, cableM}], switches, relays, dieHops}.
// `params` supplies cableM / spineCableM. The abstract `published` wire has no route, only oneWayUs.
function topology(t, card, params) {
  const D = card.dies, lpd = card.lanesPerDie;
  if (t.kind === 'published') return {key: t.key, abstract: true, oneWayUs: t.oneWayUs};
  const cableM = params.cableM;
  if (t.kind === 'fullMesh') {
    const ports = card.ranks - 1;
    if (ports * t.lanesPerPort > D * lpd) throw new Error(`${t.key}: ${ports} x ${t.lanesPerPort} lanes exceed the card`);
    const dies = Array.from({length: ports}, (_, k) => portDies(k, t.lanesPerPort, lpd));
    return {key: t.key, ports, lanesPerPort: t.lanesPerPort, lanesUsed: ports * t.lanesPerPort,
      route: (src, dst, die) => {
        const port = (dst - src + card.ranks) % card.ranks - 1;
        return {links: [{id: `${src}>${dst}`, lanes: t.lanesPerPort, cableM}], switches: 0, relays: 0, dieHops: setDist([die], dies[port], D)};
      }};
  }
  if (t.kind === 'railSwitch') {
    if (t.lanesPerPort !== lpd) throw new Error(`${t.key}: a rail is one die's ${lpd} lanes`);
    const up = (src, g) => ({id: `u${src}.${g}`, lanes: lpd, cableM});
    const down = (dst, g) => ({id: `d${dst}.${g}`, lanes: lpd, cableM});
    if (t.levels === 1) return {key: t.key, ports: D, lanesPerPort: lpd, lanesUsed: D * lpd,
      route: (src, dst, g) => ({links: [up(src, g), down(dst, g)], switches: 1, relays: 0, dieHops: 0})};
    const uplinkLanes = t.leafCards * lpd / t.spines, leaf = r => Math.floor(r / t.leafCards);
    return {key: t.key, ports: D, lanesPerPort: lpd, lanesUsed: D * lpd,
      route: (src, dst, g) => {
        if (leaf(src) === leaf(dst)) return {links: [up(src, g), down(dst, g)], switches: 1, relays: 0, dieHops: 0};
        const s = dst % t.spines;
        return {links: [up(src, g), {id: `L${leaf(src)}.${g}>S${s}`, lanes: uplinkLanes, cableM: params.spineCableM},
          {id: `S${s}>L${leaf(dst)}.${g}`, lanes: uplinkLanes, cableM: params.spineCableM}, down(dst, g)], switches: 3, relays: 0, dieHops: 0};
      }};
  }
  if (t.kind === 'torus') {
    const dims = t.dims, ports = 2 * dims.length;
    if (dims.reduce((a, d) => a * d, 1) !== card.ranks) throw new Error(`${t.key}: dims do not cover ${card.ranks} ranks`);
    if (ports * t.lanesPerPort > D * lpd) throw new Error(`${t.key}: ${ports} x ${t.lanesPerPort} lanes exceed the card`);
    const dies = Array.from({length: ports}, (_, k) => portDies(k, t.lanesPerPort, lpd));
    const coords = r => dims.map((d, i) => Math.floor(r / dims.slice(0, i).reduce((a, b) => a * b, 1)) % d);
    const index = c => c.reduce((a, v, i) => a + v * dims.slice(0, i).reduce((p, b) => p * b, 1), 0);
    // Port 2i is +, 2i+1 is - along dimension i; dimension order, shortest direction, ties to +.
    return {key: t.key, ports, lanesPerPort: t.lanesPerPort, lanesUsed: ports * t.lanesPerPort,
      route: (src, dst, die) => {
        const cur = coords(src), target = coords(dst), moves = [];
        dims.forEach((d, i) => {
          const delta = ((target[i] - cur[i]) % d + d) % d, plus = delta <= d - delta;
          for (let s = 0; s < (plus ? delta : d - delta); s++) moves.push({dim: i, port: 2 * i + (plus ? 0 : 1), step: plus ? 1 : -1});
        });
        const links = [];
        let dieHops = setDist([die], dies[moves[0].port], D);
        moves.forEach((m, k) => {
          const from = index(cur);
          cur[m.dim] = (cur[m.dim] + m.step + dims[m.dim]) % dims[m.dim];
          links.push({id: `${from}>${index(cur)}`, lanes: t.lanesPerPort, cableM});
          if (k + 1 < moves.length) dieHops += setDist(dies[m.port ^ 1], dies[moves[k + 1].port], D);
        });
        return {links, switches: 0, relays: moves.length - 1, dieHops};
      }};
  }
  throw new Error(`unknown topology kind ${t.kind}`);
}

function pathLatency(route, P, prop) {
  return P.macUs + route.links.reduce((a, l) => a + P.phyUs + P.fecUs + l.cableM * prop, 0)
    + route.switches * P.switchUs + route.relays * P.relayUs + route.dieHops * P.ucieHopUs;
}

// Logical rank -> card for the ring algorithm (a Hamiltonian cycle of one-hop neighbours).
function ringOrder(t, ranks) {
  if (t.kind !== 'torus' || t.dims.length === 1) return Array.from({length: ranks}, (_, i) => i);
  const [w, h] = t.dims, order = [];
  for (let y = 0; y < h; y++) for (let k = 0; k < w; k++) order.push(y * w + (y % 2 ? w - 1 - k : k));
  return order;
}

// ---- collectives --------------------------------------------------------------------------------

// The passes of a collective class, as k3_sram_memory_rdma_model.collective decides them.
function passes(name, payload, q) {
  const isLse = name.includes('LSE'), isGather = name.includes('all-gather') || name.includes('sampling');
  if (isGather) return [{op: 'gather', bytes: payload}];
  if (isLse) return [{op: 'scatter', bytes: q.transportBytes}];
  return [{op: 'scatter', bytes: q.transportBytes}, {op: 'gather', bytes: payload}];
}

// Steps of one pass: {bytes per message per NIC, dsts(rank)}.
function steps(pass, algorithm, n, order) {
  const all = r => Array.from({length: TP - 1}, (_, j) => (r + j + 1) % TP);
  if (algorithm === 'oneShot') return [{bytes: pass.bytes / TP / n, dsts: all}];
  const log = Math.log2(TP);
  if (algorithm === 'halvingDoubling') return Array.from({length: log}, (_, k) => pass.op === 'scatter'
    ? {bytes: pass.bytes / n / 2 ** (k + 1), dsts: r => [r ^ (1 << k)]}
    : {bytes: pass.bytes / n / TP * 2 ** k, dsts: r => [r ^ (1 << (log - 1 - k))]});
  if (algorithm === 'ring') {
    const pos = new Map(order.map((c, i) => [c, i]));
    return Array.from({length: TP - 1}, () => ({bytes: pass.bytes / n / TP, dsts: r => [order[(pos.get(r) + 1) % TP]]}));
  }
  throw new Error(`unknown algorithm ${algorithm}`);
}

// One step on every rank and NIC; the chain is k3_sram_memory_rdma_model.phase with a per-message
// one-way latency and the link floor.
function step(s, n, topo, ctx) {
  const {P, p, x, c, card, prop} = ctx;
  const packet = align(s.bytes + c.headerBytes + c.flagBytes, c.packetAlign);
  const networkGBs = Math.min(p.rdmaDieGB, A.LIMITS.networkGBs / n);
  const serialization = Math.max(packet / (networkGBs * 1000), s.bytes / (p.sharedRead * 1e6), (s.bytes + c.flagBytes) / (p.sharedWrite * 1e6), (2 * s.bytes + c.flagBytes) / (p.nocTB * 1e6));
  const laneGB = p.rdmaDieGB / card.lanesPerDie, load = new Map(), chains = [];
  for (let r = 0; r < TP; r++) for (let k = 0; k < n; k++) {
    const lat = [];
    for (const d of s.dsts(r)) {
      if (topo.abstract) { lat.push(topo.oneWayUs); continue; }
      const route = topo.route(r, d, card.nicDies[k]);
      lat.push(pathLatency(route, P, prop));
      for (const l of route.links) load.set(l.id, {lanes: l.lanes, bytes: ((load.get(l.id) || {}).bytes || 0) + packet});
    }
    chains.push(lat);
  }
  let linkFloorUs = 0;
  for (const l of load.values()) linkFloorUs = Math.max(linkFloorUs, l.bytes / (l.lanes * laneGB * 1000));
  const issue = c.issueCycles / (x.ghz * 1000), lagCycles = (c.rxCycles + c.commitCycles + c.notifyCycles) / (x.ghz * 1000), ackCycles = c.ackCycles / (x.ghz * 1000);
  let ready = 0, drained = 0, worstOneWayUs = 0;
  for (const lat of chains) {
    const ser = linkFloorUs ? Math.max(serialization, linkFloorUs / lat.length) : serialization;
    let issueFree = 0, wireFree = 0;
    const outstanding = [];
    for (const L of lat) {
      let at = issueFree;
      while (outstanding.length >= c.outstandingPerNIC) { outstanding.sort((a, b) => a - b); at = Math.max(at, outstanding.shift()); while (outstanding.length && outstanding[0] <= at) outstanding.shift(); }
      const issued = at + issue, start = Math.max(issued, wireFree), end = start + ser;
      const visible = end + (L + lagCycles), ack = visible + L + ackCycles;
      outstanding.push(ack); issueFree = issued; wireFree = end;
      ready = Math.max(ready, visible); drained = Math.max(drained, ack); worstOneWayUs = Math.max(worstOneWayUs, L);
    }
  }
  return {ready, drained, linkFloorUs, worstOneWayUs};
}

// Derived timing of one collective; q is the model's own result for it.
function derive(name, payload, q, cell, ctx) {
  const {P, p, card} = ctx, n = q.activeNICs;
  const order = ringOrder(cell.topologyDef, TP);
  let memoryTransport = 0, count = 0, worstOneWayUs = 0;
  for (const pass of passes(name, payload, q)) for (const s of steps(pass, cell.algorithm, n, order)) {
    const r = step(s, n, cell.topo, ctx);
    memoryTransport += cell.ackDrain === 'phase' ? Math.max(r.ready, r.drained) : r.ready;
    count++; worstOneWayUs = Math.max(worstOneWayUs, r.worstOneWayUs);
  }
  const D = card.dies;
  const cardLocal = q.timing.cardLocal + 6 * (P.ucieHopUs - A.TECH.ucieHopUs);
  const floor = Math.max(q.readBytes / (D * p.sharedRead * 1e6), q.writeBytes / (D * p.sharedWrite * 1e6), q.nocBytes / (D * p.nocTB * 1e6));
  const raw = memoryTransport + q.timing.tpReduce + cardLocal;
  const portTail = Math.max(0, floor - raw);
  const controlPath = P.controlScale * ctx.controlUs(name);
  const timing = {memoryTransport, tpReduce: q.timing.tpReduce, cardLocal, portTail, controlPath};
  return {steps: count, worstOneWayUs, timing, tauUs: raw + portTail + controlPath};
}

// Run fn with every collective of the detailed model at its derived timing and the floor at tauUs.
// cell === null leaves the protocol model alone (only the floor moves).
function withCell(cell, ctx, tauUs, fn) {
  const orig = R.collective, hadTau = O.OPT.tauUs, derived = new Map();
  if (cell) R.collective = (name, payload, p, x, c, trace) => {
    const q = orig(name, payload, p, x, c, trace), key = `${name}|${payload}`;
    if (!derived.has(key)) derived.set(key, {name, payload, kind: q.kind, activeNICs: q.activeNICs, ...derive(name, payload, q, cell, {...ctx, p, x, c})});
    const d = derived.get(key);
    q.timing = {...d.timing}; q.duration = d.tauUs;
    return q;
  };
  O.OPT.tauUs = tauUs;
  try { return fn(derived); } finally { R.collective = orig; O.OPT.tauUs = hadTau; }
}

function replay(x, cell, ctx, tauUs) {
  return withCell(cell, ctx, tauUs, derived => {
    const r = O.evaluate(x);
    if (!r.feasible) throw new Error(`replay infeasible: ${r.reasons || r.reason}`);
    return {rawUs: r.rawUs, tpsPerUser: r.tps, commUs: r.commUs, waitUs: r.waitUs, classes: [...derived.values()]};
  });
}

// Largest v in [lo, hi] with f(v) >= target, f decreasing; f(lo) >= target > f(hi) is the caller's job.
function bisect(f, lo, hi, target) {
  for (let i = 0; i < BISECT_STEPS; i++) { const mid = (lo + hi) / 2; if (f(mid) >= target) lo = mid; else hi = mid; }
  return lo;
}

// ---- report -------------------------------------------------------------------------------------

function params(spec, t, corner) {
  const P = Object.fromEntries(spec.parameters.map(q => [q.key, q[corner]]));
  P.cableM = t.cableM ? t.cableM[corner] : 0;
  P.spineCableM = t.spineCableM ? t.spineCableM[corner] : 0;
  return P;
}
// The parameters a topology actually uses, with their range.
function ranges(spec, t) {
  const list = spec.parameters.map(q => ({key: q.key, nominal: q.nominal, low: q.low, high: q.high}));
  if (t.cableM) list.push({key: 'cableM', ...t.cableM});
  if (t.spineCableM) list.push({key: 'spineCableM', ...t.spineCableM});
  const used = {switchUs: t.kind === 'railSwitch', relayUs: t.kind === 'torus'};
  return list.filter(q => used[q.key] !== false);
}

function topologySummary(t, spec, ctx) {
  const P = params(spec, t, 'nominal'), topo = topology(t, spec.card, P);
  const stats = {links: 0, switches: 0, relays: 0, dieHops: 0}, lat = [];
  for (let k = 0; k < spec.card.dies; k++) for (let d = 1; d < TP; d++) {
    const r = topo.route(0, d, spec.card.nicDies[k]);
    stats.links = Math.max(stats.links, r.links.length); stats.switches = Math.max(stats.switches, r.switches);
    stats.relays = Math.max(stats.relays, r.relays); stats.dieHops = Math.max(stats.dieHops, r.dieHops);
    lat.push(pathLatency(r, P, ctx.prop));
  }
  const nearest = topo.route(0, 1, spec.card.nicDies[0]);
  return {key: t.key, name: t.name, candidateIn06: t.candidateIn06, description: t.description, risks: t.risks,
    ports: topo.ports, lanesPerPort: topo.lanesPerPort, lanesUsed: topo.lanesUsed, linkGBs: topo.lanesPerPort * ctx.laneGB,
    worst: stats, oneWayUs: {min: Math.min(...lat), mean: lat.reduce((a, v) => a + v, 0) / lat.length, max: Math.max(...lat)},
    nearestPeerOneWayUs: pathLatency(nearest, P, ctx.prop)};
}

function cellOf(t, spec, algorithm, ackDrain, corner, P = params(spec, t, corner)) {
  return {topologyDef: t, algorithm, ackDrain, topo: topology(t, spec.card, P), P};
}

function build() {
  const baseline = readJson(BASELINE_FILE), spec = readJson(CANDIDATES_FILE), core = readJson(COMM_CORE_FILE);
  const x = BP.publishedX(baseline, 'collective_topology.js');
  const control = new Map(core.controlPath.classes.map(k => [k.name, k.controlUs]));
  const controlUs = name => { if (!control.has(name)) throw new Error(`no control path for ${name} in ${COMM_CORE_FILE}`); return control.get(name); };
  const m = O.mapped(x);
  if (!m.feasible) throw new Error(`published point is infeasible: ${m.reasons}`);
  const counts = {};
  for (const o of m.plan.ops) if (o.unit === 'COMM') counts[o.name] = (counts[o.name] || 0) + 1;
  const prop = spec.propagationUsPerM, laneGB = m.p.rdmaDieGB / spec.card.lanesPerDie;
  const base = (P) => ({P, card: spec.card, prop, controlUs});
  const tps = (cell, tauUs) => replay(x, cell, base(cell.P), tauUs);

  // Published point and the anchor: the abstract wire reproduces the model.
  const published = replay(x, null, base({}), O.OPT.tauUs);
  if (Math.abs(published.rawUs - baseline.tpsDesign.point.rawLatencyUs) > 1e-6) throw new Error(`replay rawUs ${published.rawUs} is not the published ${baseline.tpsDesign.point.rawLatencyUs}`);
  const wire = oneWayUs => ({key: 'published', kind: 'published', oneWayUs});
  const anchorP = {...params(spec, {}, 'nominal'), controlScale: 0, ucieHopUs: A.TECH.ucieHopUs};
  const anchorCell = cellOf(wire(O.OPT.oneWayUs), spec, 'oneShot', 'phase', 'nominal', anchorP);
  const anchorRun = tps(anchorCell, O.OPT.tauUs);
  const model = new Map();
  for (const o of m.plan.ops) if (o.unit === 'COMM' && !model.has(o.name)) model.set(o.name, o.timing.memoryTransport);
  const anchor = {topology: 'published (abstract wire, OPT.oneWayUs)', algorithm: 'oneShot', ackDrain: 'phase', controlScale: 0, ucieHopUs: A.TECH.ucieHopUs,
    classes: anchorRun.classes.map(k => ({name: k.name, modelMemoryTransportUs: model.get(k.name), derivedMemoryTransportUs: k.timing.memoryTransport})),
    tpsPerUser: anchorRun.tpsPerUser, publishedTpsPerUser: published.tpsPerUser};
  for (const k of anchor.classes) if (k.modelMemoryTransportUs !== k.derivedMemoryTransportUs) throw new Error(`anchor: ${k.name} ${k.derivedMemoryTransportUs} vs model ${k.modelMemoryTransportUs}`);
  if (Math.abs(anchor.tpsPerUser - published.tpsPerUser) > TOL) throw new Error(`anchor TPS ${anchor.tpsPerUser} vs published ${published.tpsPerUser}`);

  // Budgets on the published protocol: the uniform tau, and the one-way latency of the abstract wire.
  const uniformTps = tau => replay(x, null, base({}), tau).tpsPerUser;
  const uniformTauSweep = UNIFORM_TAU_SWEEP.map(tauUs => { const r = replay(x, null, base({}), tauUs); return {tauUs, rawUs: r.rawUs, tpsPerUser: r.tpsPerUser, commUs: r.commUs, dmaWaitUs: r.waitUs}; });
  const tauBreakEvenUs = bisect(uniformTps, O.OPT.tauUs, 3, TARGET_TPS);
  const nominalWire = L => tps(cellOf(wire(L), spec, 'oneShot', 'phase', 'nominal'), 0).tpsPerUser;
  const wireAtModel = nominalWire(O.OPT.oneWayUs);
  const oneWayBudgetUs = wireAtModel >= TARGET_TPS ? bisect(nominalWire, O.OPT.oneWayUs, 2, TARGET_TPS) : null;

  const summarise = (cell, run) => {
    const classes = run.classes.map(k => ({name: k.name, count: counts[k.name], kind: k.kind, activeNICs: k.activeNICs, steps: k.steps,
      worstOneWayUs: k.worstOneWayUs, ...Object.fromEntries(Object.entries(k.timing).map(([f, v]) => [`${f}Us`, v])), tauUs: k.tauUs,
      withinSpecTau: k.tauUs <= O.OPT.tauUs, withinBreakEvenTau: k.tauUs <= tauBreakEvenUs}));
    const commUs = classes.reduce((a, k) => a + k.count * k.tauUs, 0);
    return {classes, maxTauUs: Math.max(...classes.map(k => k.tauUs)), meanTauUs: commUs / classes.reduce((a, k) => a + k.count, 0), collectiveUs: commUs};
  };

  const topologies = [], cells = [], conditions = [];
  for (const t of spec.topologies) {
    topologies.push(topologySummary(t, spec, {prop, laneGB}));
    const own = [];
    for (const algorithm of ALGORITHMS) for (const ackDrain of ACK_DRAIN) {
      const nominal = cellOf(t, spec, algorithm, ackDrain, 'nominal'), run = tps(nominal, 0);
      const row = {topology: t.key, algorithm, ackDrain, ...summarise(nominal, run),
        tpsPerUser: {bottomUp: run.tpsPerUser, specFloor: tps(nominal, O.OPT.tauUs).tpsPerUser,
          optimistic: tps(cellOf(t, spec, algorithm, ackDrain, 'low'), 0).tpsPerUser,
          pessimistic: tps(cellOf(t, spec, algorithm, ackDrain, 'high'), 0).tpsPerUser}};
      row.meetsTarget = Object.fromEntries(Object.entries(row.tpsPerUser).map(([k, v]) => [k, v >= TARGET_TPS]));
      cells.push(row); own.push(row);
    }
    // Tornado and break-even on the best algorithm of each ACK semantics: one parameter at a time
    // across its range, the others nominal. A parameter whose range straddles the target gets the
    // value at which the cell reaches it.
    for (const ackDrain of ACK_DRAIN) {
      const best = own.filter(r => r.ackDrain === ackDrain).reduce((a, r) => r.tpsPerUser.bottomUp > a.tpsPerUser.bottomUp ? r : a);
      const nominalP = params(spec, t, 'nominal'), at = (key, v) => {
        if (v === nominalP[key]) return best.tpsPerUser.bottomUp;
        return tps(cellOf(t, spec, best.algorithm, ackDrain, 'nominal', {...nominalP, [key]: v}), 0).tpsPerUser;
      };
      const tornado = ranges(spec, t).map(q => {
        const low = at(q.key, q.low), high = at(q.key, q.high);
        const row = {param: q.key, nominal: q.nominal, low: {value: q.low, tpsPerUser: low}, high: {value: q.high, tpsPerUser: high}, swing: low - high};
        if (low >= TARGET_TPS && high < TARGET_TPS) { row.verdict = 'straddles'; row.breakEven = bisect(v => at(q.key, v), q.low, q.high, TARGET_TPS); }
        else row.verdict = high >= TARGET_TPS ? 'passes across range' : 'fails across range';
        return row;
      }).sort((a, b) => b.swing - a.swing);
      conditions.push({topology: t.key, ackDrain, bestAlgorithm: best.algorithm,
        tpsPerUser: best.tpsPerUser, meetsTarget: best.meetsTarget, maxTauUs: best.maxTauUs,
        mustHold: tornado.filter(r => r.verdict === 'straddles').map(r => ({param: r.param, atMost: r.breakEven, nominal: r.nominal})),
        failsAcrossRange: tornado.filter(r => r.verdict === 'fails across range').map(r => r.param),
        tornado});
    }
  }

  return {
    format: FORMAT,
    status: 'MODEL: bottom-up tau per collective class on self-chosen scale-out topology candidates (ASSUMPTION latencies), with the TPS/usr each implies. Feeds no gate or baseline; OPT.tauUs stays 1.15 us (ADR-0004)',
    evidenceClass: EVIDENCE,
    workItem: 'HW-CH-01',
    plan: 'teams/council/docs/24_TRACE_AND_CHARON_ADOPTION_PLAN.md',
    issues: ['B-008', 'B-005', 'B-004', 'O-018'],
    candidatesStatus: spec.status,
    method: 'tau = memoryTransport (phase chain per step with per-path one-way latency and the busiest-link floor) + tpReduce (model) + cardLocal (model, 6 die hops at ucieHopUs) + portTail (model floor) + controlPath (Comm Core). bottomUp replays with OPT.tauUs = 0, specFloor with 1.15 us; optimistic / pessimistic put every parameter at the low / high end of its range.',
    provenance: {
      baseline: BASELINE_FILE, baselineSha256: hashFile(BASELINE_FILE),
      candidates: CANDIDATES_FILE, candidatesSha256: hashFile(CANDIDATES_FILE),
      commCore: COMM_CORE_FILE, commCoreSha256: hashFile(COMM_CORE_FILE),
      sources: Object.fromEntries(SOURCE_FILES.map(f => [f, hashFile(f)]))
    },
    targetTpsPerUser: TARGET_TPS,
    published: {rawUs: published.rawUs, tpsPerUser: published.tpsPerUser, specTauUs: O.OPT.tauUs, modelOneWayUs: O.OPT.oneWayUs,
      tauBreakEvenUs, uniformTauSweep, abstractWire: {bottomUpTpsAtModelOneWay: wireAtModel, oneWayBudgetUs}},
    anchor,
    parameters: spec.parameters,
    topologies,
    cells,
    conditions
  };
}

module.exports = {FORMAT, EVIDENCE, SOURCE_FILES, BASELINE_FILE, CANDIDATES_FILE, COMM_CORE_FILE, TARGET_TPS, ALGORITHMS, ACK_DRAIN,
  topology, pathLatency, ringOrder, passes, steps, step, derive, withCell, replay, build};
