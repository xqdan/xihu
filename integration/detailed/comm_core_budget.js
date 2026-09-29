'use strict';
/* Comm Core control-path budget (HW-07 decision input, teams/hardware/docs/10_COMM_CORE.md).
 *
 * Question: who triggers a collective, writes its RDMA work requests (WQEs) and
 * tracks the inbound commits, and how much of the per-collective latency floor
 * (OPT.tauUs = 1.15 us, no physical derivation yet, B-008) that control path
 * may take at B=1 decode.
 *
 * The protocol model (k3_sram_memory_rdma_model.collective) times the wire,
 * SRAM, NIC and reduce steps from the moment the first WQE reaches the NIC, and
 * the published point then floors every collective at tauUs. Nothing charges
 * the path before that (producer completion -> trigger -> WQE -> doorbell) or
 * the completion notify after it. Here each control scheme adds that path to
 * every collective, tauUs is set to 0, and the detailed model is replayed, so
 * the per-collective latency is built bottom-up instead of floored.
 *
 * Schemes (Meta references in the doc):
 *  - commCore: hardware trigger on a producer completion counter, WQE templates
 *    precompiled into Comm Core SRAM and patched per epoch, direct NIC doorbell,
 *    hardware commit counters on receive (MTIA 300 Message Engine style,
 *    device-triggered collectives).
 *  - coreDoorbell: the producer AI Core posts the WQEs itself (MTIA 300 PE
 *    one-sided path, about 450 ns measured).
 *  - firmwareDispatch: a control processor dispatches each collective (MTIA 300
 *    CPU-C dispatch, 2.9 us measured).
 * Memory semantics: the data path is a one-sided put into remote Shared SRAM,
 * and the commit is a signal on a counter address. Three ways to deliver the
 * signal are replayed the same way (SIGNAL below), with the Comm Core control
 * path on every collective.
 * Evidence class MODEL: cycle counts below are ASSUMPTIONs; the measured Meta
 * figures are for a different chip and are used only as order-of-magnitude
 * references.
 */
const fs = require('fs');
const path = require('path');
const A = require('./k3_architecture_search.js');
const O = require('./k3_rdma_final_tuning_model.js');
const P = require('./k3_physical_basis.js');
const R = require('./k3_sram_memory_rdma_model.js');

const root = path.resolve(__dirname, '../..');
const read = p => JSON.parse(fs.readFileSync(path.join(root, p), 'utf8'));

const PEERS = 31; // WQEs per NIC per phase and inbound commits per slot (TP32)
const CONTROL = {
  commCore: {triggerCompareCycles: 2, patchCyclesPerWqe: 2, doorbellCycles: 2,
    evidence: 'ASSUMPTION: counter compare, one template patch per WQE and a doorbell write are single-digit cycles'},
  coreDoorbell: {postUs: 0.45, evidence: 'reference: MTIA 300 PE posts WQEs to the NIC doorbell, about 450 ns (HCCL, arXiv 2608.00358)'},
  firmwareDispatch: {dispatchUs: 2.9, evidence: 'reference: MTIA 300 CPU-C collective dispatch, 2.9 us (HCCL, arXiv 2608.00358)'},
  patchEntryBytes: 16
};
const TAU_SWEEP = [1.0, 1.15, 1.35, 1.5, 2.0, 3.0];
const align = (n, a) => Math.ceil(n / a) * a;

// How the commit signal reaches the remote counter, as overrides of the
// protocol parameters the detailed model passes to R.collective (O.OPT is
// merged over R.MEM there).
function signals(x) {
  const M = R.MEM, f = x.ghz * 1000;
  return {
    putWithSignal: {opt: {},
      evidence: 'the 16 B flag rides at the tail of the data packet (flagBytes) and is applied as an atomic add on the remote counter after the data is visible: the protocol model as published'},
    separateSignal: {opt: {issueCycles: 2 * M.issueCycles, headerBytes: M.headerBytes + align(M.headerBytes + M.flagBytes, M.packetAlign)},
      evidence: 'a second WQE per peer on the same ordered QP carries the flag: twice the NIC issue and one more header+flag packet per message'},
    writeThenSignal: {opt: {commitCycles: O.OPT.commitCycles + 2 * O.OPT.oneWayUs * f + O.OPT.ackCycles},
      evidence: 'the flag is sent only after the data write is acknowledged (unordered fabric, no remote fence): one more round trip per message before the commit'}
  };
}

// Control-path latency added to every collective, split by step (us). Control
// packets cross the die mesh the way the model charges the Reduce router hop:
// meshSide hops x TECH.routerCycles.
function schemes(p, x) {
  const us = cycles => cycles / (x.ghz * 1000), hop = us(p.meshSide * A.TECH.routerCycles), c = CONTROL.commCore;
  // The Comm Core patches one WQE per patchCyclesPerWqe while the NIC issues one
  // per issueCycles; only the first patch is exposed if it keeps pace.
  const issue = R.MEM.issueCycles, patchExposed = c.patchCyclesPerWqe + Math.max(0, c.patchCyclesPerWqe - issue) * (PEERS - 1);
  return {
    commCore: {trigger: hop + us(c.triggerCompareCycles), dispatch: us(patchExposed), doorbell: hop + us(c.doorbellCycles), completion: hop},
    coreDoorbell: {trigger: 0, dispatch: CONTROL.coreDoorbell.postUs, doorbell: hop, completion: hop},
    firmwareDispatch: {trigger: hop, dispatch: CONTROL.firmwareDispatch.dispatchUs, doorbell: hop, completion: hop}
  };
}
const total = s => s.trigger + s.dispatch + s.doorbell + s.completion;

// Run fn with O.OPT overridden by `opt` and `controlUs` added to every
// collective; O.OPT (values and key order) and R.collective are always restored.
function withProtocol({controlUs = 0, opt = {}}, fn) {
  const saved = {}, orig = R.collective;
  for (const [k, v] of Object.entries(opt)) { saved[k] = [k in O.OPT, O.OPT[k]]; O.OPT[k] = v; }
  R.collective = (...args) => {
    const q = orig(...args);
    if (controlUs) { q.timing.controlPath = controlUs; q.duration += controlUs; }
    return q;
  };
  try { return fn(); } finally {
    for (const [k, [had, v]] of Object.entries(saved)) { if (had) O.OPT[k] = v; else delete O.OPT[k]; }
    R.collective = orig;
  }
}

// Replay with `controlUs` added to every collective, the tau floor set to
// `tauUs` and optional protocol overrides.
function replay(x, {controlUs = 0, tauUs = O.OPT.tauUs, opt = {}} = {}) {
  return withProtocol({controlUs, opt: {...opt, tauUs}}, () => {
    const r = O.evaluate(x);
    if (!r.feasible) return {feasible: false, reasons: r.reasons || [r.reason]};
    return {feasible: true, tpsPerUser: r.tps, rawLatencyUs: r.rawUs, commUs: r.commUs};
  });
}

// Pre-floor protocol time of the slowest collective class and the per-token
// wire bytes and requests under protocol overrides.
function protocolSummary(x, opt) {
  return withProtocol({opt}, () => {
    const m = O.mapped(x), comm = m.plan.ops.filter(o => o.unit === 'COMM');
    const slowest = comm.reduce((a, o) => (o.duration - o.timing.tauFloor > a.us ? {name: o.name, us: o.duration - o.timing.tauFloor} : a), {name: '', us: 0});
    return {slowest, wireBytesPerToken: m.wireBytes, requestsPerToken: comm.reduce((a, o) => a + o.memory.requests, 0)};
  });
}

// Largest control path (us, same on every collective, no tau floor) that keeps
// raw latency within the budget.
function controlBudget(x, rawBudgetUs, opt = {}) {
  let lo = 0, hi = 2;
  for (let i = 0; i < 40; i++) {
    const mid = (lo + hi) / 2;
    if (replay(x, {controlUs: mid, tauUs: 0, opt}).rawLatencyUs <= rawBudgetUs) lo = mid; else hi = mid;
  }
  return lo;
}

function build() {
  const spec = read('teams/hardware/inputs/k3_mc_baseline.json');
  const x = spec.tpsDesign.hardware.x, point = spec.tpsDesign.point, f = x.ghz * 1000;
  const m = O.mapped(x), p = m.p;

  // Per collective class: protocol time before the tau floor, as mapped() has it.
  const classes = {}, comm = m.plan.ops.filter(o => o.unit === 'COMM');
  for (const o of comm) {
    const protocolUs = o.duration - o.timing.tauFloor;
    const k = classes[o.name] || (classes[o.name] = {name: o.name, count: 0, protocolUs, requests: o.memory.requests,
      phases: o.memory.phases, activeNICs: o.memory.activeNICs, timing: {memoryTransport: o.timing.memoryTransport,
        cardLocal: o.timing.cardLocal, tpReduce: o.timing.tpReduce, portTail: o.timing.portTail}});
    k.count++;
  }
  const rows = Object.values(classes);
  const slowest = rows.reduce((a, b) => (b.protocolUs > a.protocolUs ? b : a));

  const S = schemes(p, x);
  const out = {};
  for (const [name, s] of Object.entries(S)) {
    const controlUs = total(s);
    out[name] = {steps: s, controlUs, controlCycles: controlUs * f,
      maxLatencyUs: slowest.protocolUs + controlUs,
      keepsSpecTau: slowest.protocolUs + controlUs <= O.OPT.tauUs + 1e-12,
      bottomUp: replay(x, {controlUs, tauUs: 0}),
      withSpecFloor: replay(x, {controlUs})};
    out[name].meetsBudget = out[name].bottomUp.feasible && out[name].bottomUp.rawLatencyUs <= point.rawBudgetUs;
  }
  // The producer AI Core is busy posting WQEs instead of computing.
  out.coreDoorbell.aiCoreUsPerToken = comm.length * CONTROL.coreDoorbell.postUs;

  // Comm Core load per token, all collectives on one die (conservative: most
  // collectives use one active NIC).
  const c = CONTROL.commCore, wqes = comm.reduce((a, o) => a + o.memory.requests, 0);
  const busyUs = (comm.length * (c.triggerCompareCycles + c.doorbellCycles) + wqes * c.patchCyclesPerWqe) / f;
  const budgetUs = controlBudget(x, point.rawBudgetUs);
  const specSlackUs = O.OPT.tauUs - slowest.protocolUs;
  for (const s of Object.values(out)) s.marginUs = budgetUs - s.controlUs;
  const templateBytes = rows.reduce((a, k) => a + k.requests * R.MEM.wqeCqeBytes, 0) + comm.length * CONTROL.patchEntryBytes;
  const templateMiB = templateBytes / 1048576;

  // Memory semantics: signal delivery with the Comm Core control path.
  const cc = out.commCore.controlUs, signaling = {};
  for (const [name, sig] of Object.entries(signals(x))) {
    const q = protocolSummary(x, sig.opt), wqeFactor = name === 'separateSignal' ? 2 : 1;
    const bottomUp = replay(x, {controlUs: cc, tauUs: 0, opt: sig.opt});
    signaling[name] = {opt: sig.opt, evidence: sig.evidence, slowestCollective: q.slowest.name, slowestProtocolUs: q.slowest.us,
      maxLatencyUs: q.slowest.us + cc, keepsSpecTau: q.slowest.us + cc <= O.OPT.tauUs + 1e-12,
      wireBytesPerToken: q.wireBytesPerToken, wqesPerToken: q.requestsPerToken * wqeFactor,
      bottomUp, withSpecFloor: replay(x, {controlUs: cc, opt: sig.opt}),
      meetsBudget: bottomUp.feasible && bottomUp.rawLatencyUs <= point.rawBudgetUs,
      controlUsWithinRawBudget: name === 'putWithSignal' ? budgetUs : controlBudget(x, point.rawBudgetUs, sig.opt)};
  }
  const hopUs = p.meshSide * A.TECH.routerCycles / f;
  return {
    status: 'MODEL (control-path budget over the detailed protocol model; not FROZEN, does not change the published point)',
    owner: 'HW-07 Comm-Core (co-sign SW-05 Collective/Comm-Compute, SW-01 Runtime)',
    document: 'teams/hardware/docs/10_COMM_CORE.md',
    method: 'per collective: latency = control path (trigger + WQE dispatch + doorbell + completion notify) + protocol model time; tauUs set to 0 and the detailed model replayed',
    assumptions: {control: JSON.parse(JSON.stringify(CONTROL)), hops: p.meshSide, routerCyclesPerHop: A.TECH.routerCycles,
      nicIssueCyclesPerWqe: R.MEM.issueCycles, peers: PEERS, specTauUs: O.OPT.tauUs,
      evidence: 'ASSUMPTION (cycle counts, O-018); protocol constants are the model OPT/MEM values (B-008)'},
    hardware: {x: {...x}, ghz: x.ghz, meshSide: p.meshSide},
    published: {tpsPerUser: point.tpsPerUser, rawLatencyUs: point.rawLatencyUs, rawBudgetUs: point.rawBudgetUs, collectivesPerToken: comm.length},
    collectives: rows,
    slowestCollective: {name: slowest.name, protocolUs: slowest.protocolUs},
    schemes: out,
    tauSweep: TAU_SWEEP.map(t => ({tauUs: t, ...replay(x, {tauUs: t})})),
    budget: {
      controlUsWithinRawBudget: budgetUs,
      controlCyclesWithinRawBudget: budgetUs * f,
      controlUsWithinSpecTau: specSlackUs,
      controlCyclesWithinSpecTau: specSlackUs * f,
      // If the receive side counted inbound commits in firmware, serially, one
      // slot would get this many cycles per message out of what the Comm Core
      // path leaves.
      rxFirmwareCyclesPerMessageMax: {withinSpecTau: (specSlackUs - out.commCore.controlUs) * f / PEERS,
        withinRawBudget: (budgetUs - out.commCore.controlUs) * f / PEERS}
    },
    memorySemantics: {
      signaling,
      // A remote load from an AI Core: to the NIC and back across the mesh plus
      // two one-way trips; the Core waits for all of it.
      remoteLoadMinUs: 2 * O.OPT.oneWayUs + 2 * hopUs,
      chosen: 'putWithSignal'
    },
    commCoreLoad: {wqesPerToken: wqes, busyUsPerToken: busyUs, utilization: busyUs / point.rawLatencyUs,
      templateSramKiB: templateBytes / 1024,
      templateSramMm2: templateMiB / A.TECH.sramMiBPerMm2 * P.PROCESS[P.BASIS.process].sram},
    decision: {
      scheme: 'commCore',
      notes: [
        'Firmware dispatch per collective (MTIA 300 CPU-C scale) does not fit the raw budget. An AI Core doorbell fits it with little margin, exceeds the spec tau on the LSE merge and keeps the producer cores busy posting WQEs; a hardware-triggered, template-based Comm Core uses a small fraction of the budget.',
        'Below the spec tau the published point is bound by the memory chain: a shorter collective barely raises TPS. The Comm Core is there to keep the per-collective latency from growing past the break-even, not to shrink it.',
        'Inbound commits must be counted in hardware: a firmware receive loop would get only a few cycles per message.',
        'Memory semantics: the collective path is put-with-signal (the flag at the tail of the data packet, applied as an atomic add after the data is visible). A separate signal WQE doubles the Comm Core and NIC issue; signalling only after the write is acknowledged adds a round trip to every message. Neither changes TPS at the published point (the memory chain binds), but both eat the spec-tau slack and the control budget. AI Cores get posted stores and atomics only; remote loads stall the Core for a round trip and stay off the decode critical path.',
        'The Comm Core RISC-V loads the collective graph and templates, advances epochs and handles timeout/poison/retry; it is not on the per-collective critical path.'
      ]
    },
    regenerate: 'node integration/pipelines/generate_comm_core_budget.js (npm run commcore:budget); enforced by tests/regression/test_comm_core_budget.js'
  };
}

module.exports = {build, CONTROL, schemes, signals, replay};
