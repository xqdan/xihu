'use strict';
/* Execution trace of one K3 decode step (ARCH-TR-01, HW-TR-01, ARCH-TR-02;
 * teams/council/docs/24_TRACE_AND_CHARON_ADOPTION_PLAN.md; contract:
 * docs/architecture/contracts/EXECUTION_TRACE.md).
 *
 * Replays a design point through the detailed simulator with {trace:true} and turns its event
 * stream into Chrome Trace Event JSON (Perfetto, chrome://tracing). Nothing here feeds back into
 * a timing path: the replay is the same mapped() + simulate() call evaluate() makes, so the
 * trace of the published point ends at the published rawUs.
 *
 * Evidence class: MODEL. A trace is a view of the model's schedule, not an observed timeline,
 * and never satisfies VALIDATED_EVENT_TIMING (integration/governance/evaluate_gates.js).
 *
 * Collective protocol (HW-TR-01): for one sampled instance of each collective class the RDMA
 * phase model is re-run with its per-peer trace and nested under the collective's slice. The
 * model's terms are additive (memory transport, TP reduce, card-local merge, port tail, tau
 * floor); they are drawn one after another in that order, which is how the duration is summed,
 * not a claim about how the hardware overlaps them.
 *
 * Diff (ARCH-TR-02): two replays at the same x are aligned operator by operator. Each operator
 * owns its "advance", the time from its issue to the next operator's issue (the last one owns
 * the rest of the step). Advances sum to rawUs exactly, so per-operator and per-layer deltas sum
 * to the rawUs delta, overlap and waiting included.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const O = require('./k3_rdma_final_tuning_model.js');
const R = require('./k3_sram_memory_rdma_model.js');
const T = require('./k3_tps_design_baseline.js');
const {simulate} = require('./k3_operator_sram_sim.js');
const BP = require('./baseline_point.js');

const root = path.resolve(__dirname, '../..');
const BASELINE_FILE = 'teams/hardware/inputs/k3_mc_baseline.json';
// The files whose content decides the timeline; their sha256 is the trace's provenance.
const SOURCE_FILES = [
  'integration/detailed/execution_trace.js',
  'integration/detailed/k3_operator_sram_sim.js',
  'integration/detailed/k3_architecture_search.js',
  'integration/detailed/k3_physical_basis.js',
  'integration/detailed/k3_sram_memory_rdma_model.js',
  'integration/detailed/k3_rdma_final_tuning_model.js'
];
const EVIDENCE = 'MODEL';
const FORMAT = 'k3-execution-trace/1';
const PID = 1;
// Thread ids are the track order in the viewer.
const TRACKS = {
  layers: {tid: 1, name: 'Layers'},
  compute: {tid: 2, name: 'Compute slot (L / H / V)'},
  comm: {tid: 3, name: 'Collective (TP32)'},
  wait: {tid: 4, name: 'Idle (wait)'},
  dma: {tid: 5, name: 'DMA (MC <-> shared SRAM)'},
  tmaL: {tid: 6, name: 'TMA-L (shared -> L local)'},
  tmaH: {tid: 7, name: 'TMA-H (shared -> H local)'}
};
const COUNTER = 'SRAM occupancy (MiB)';
const TIMING_TOL = 1e-6;

const sha256 = data => crypto.createHash('sha256').update(data).digest('hex');
const hashFile = relativePath => sha256(fs.readFileSync(path.join(root, relativePath)));
const readJson = relativePath => JSON.parse(fs.readFileSync(path.join(root, relativePath), 'utf8'));

// Run fn with a temporary OPT patch (the same save/restore as k3_tps_design_baseline.withOpt).
function withOpt(patch, fn) {
  return T.withOpt(patch, null, () => fn());
}

// The ARCH-TR-02 presets: every published mechanism switched back alone (21 doc section 5).
function mechanismPatch(key) {
  const m = T.MECHANISMS.find(a => a.key === key);
  if (!m) return null;
  return m.patch || {[m.key]: m.off};
}

// mapped() + simulate() exactly as O.evaluate does, with the event stream kept.
function replay(x, patch = {}) {
  return withOpt(patch, () => {
    const m = O.mapped(x);
    if (!m.feasible) return {feasible: false, reasons: m.reasons};
    const r = simulate(m.plan, m.window, {trace: true});
    if (!r.feasible) return {feasible: false, reasons: [r.reason]};
    return {feasible: true, x, m, r, opt: {...O.OPT}};
  });
}

// Coalesce back-to-back pieces (the simulator emits one per event-loop step) of the same op.
function coalesce(pieces) {
  const out = [];
  for (const p of pieces) {
    const last = out[out.length - 1];
    if (last && last.index === p.index && Math.abs(last.t + last.dur - p.t) < 1e-12) last.dur = p.t + p.dur - last.t;
    else out.push({...p});
  }
  return out;
}

const ledgerOf = r => ({
  rawUs: r.rawUs, computeUs: r.computeUs, tmaHiddenUs: r.tmaHiddenUs, commUs: r.commUs, waitUs: r.waitUs, overlapUs: r.overlapUs,
  tmaFillUs: r.tmaFillUs, tmaExposedUs: r.tmaExposedUs, e2eUs: r.e2eUs, tpsPerUser: r.tps
});

function opArgs(o, extra = {}) {
  const a = {operator_id: o.id, layer: o.layer, unit: o.unit, flops: o.flops, readBytes: o.read, writeBytes: o.write, linkBytes: o.linkBytes,
    durationUs: o.duration, timing: o.timing, evidence: EVIDENCE};
  if (o.detail) a.detail = o.detail;
  if (o.overlapComm) a.overlapComm = true;
  if (o.tma) a.tma = {us: o.tma.us, bytes: o.tma.bytes, domain: o.tma.domain};
  return {...a, ...extra};
}

// HW-TR-01: per collective class, the first instance in program order, re-run with the per-peer
// phase trace. The re-run must give the op's duration back (less the tau floor), or the nested
// slices would describe a different collective than the one on the timeline.
function protocolSamples(run) {
  const {m, x, opt} = run;
  const c = {...R.MEM, ...opt};
  const seen = new Map();
  for (const o of m.plan.ops) {
    if (o.unit !== 'COMM' || seen.has(o.name)) continue;
    const q = R.collective(o.name, o.mapping.payload, m.p, x, c, true);
    const drift = q.duration + o.timing.tauFloor - o.duration;
    if (Math.abs(drift) > 1e-9) throw new Error(`protocol re-run of ${o.name} (op ${o.id}) differs from the mapped duration by ${drift} us`);
    seen.set(o.name, {op: o, q});
  }
  return [...seen.values()];
}

function protocolSummary(samples) {
  return samples.map(({op, q}) => ({
    collective: op.name, kind: q.kind, sampledOperatorId: op.id, layer: op.layer, activeNICs: q.activeNICs, phases: q.phaseDetail.length,
    phaseUs: q.phaseDetail.map(p => p.duration), memoryTransportUs: q.timing.memoryTransport, tpReduceUs: q.timing.tpReduce,
    cardLocalUs: q.timing.cardLocal, portTailUs: q.timing.portTail, protocolUs: q.duration, tauFloorUs: op.timing.tauFloor, durationUs: op.duration
  }));
}

// Chrome Trace Event JSON of one replay. Times are microseconds, the format's own unit.
function chromeTrace(run, {protocol = true} = {}) {
  const {m, r} = run;
  const ops = m.plan.ops, jobs = m.plan.jobs;
  const ev = [];
  const meta = (name, tid, args) => ev.push({ph: 'M', pid: PID, tid, name, args});
  meta('process_name', 0, {name: 'K3 decode step, one rank of TP32 (MODEL)'});
  for (const k of Object.values(TRACKS)) {
    meta('thread_name', k.tid, {name: k.name});
    meta('thread_sort_index', k.tid, {sort_index: k.tid});
  }
  const slice = (track, cat, name, ts, dur, args) => ev.push({ph: 'X', pid: PID, tid: TRACKS[track].tid, cat, name, ts, dur, args});

  for (const l of r.layerStats) slice('layers', 'layer', `L${l.layer} ${l.kind}`, l.start, l.end - l.start,
    {layer: l.layer, kind: l.kind, moe: l.moe, firstOperator: l.first, lastOperator: l.last, waitUs: l.wait, evidence: EVIDENCE});

  const samples = protocol ? protocolSamples(run) : [];
  const sampled = new Map(samples.map(s => [s.op.id, s.q]));
  const waits = [], exposed = [], dmaOpen = new Map(), tmaOpen = new Map();
  const dmaSlice = (open, end, how) => {
    const j = jobs[open.job];
    // A read is bound to the operator that consumes it, a writeback to the operator that produced it.
    slice('dma', 'dma', `${j.kind}: ${j.category}`, open.t, end - open.t,
      {operator_id: j.kind === 'write' ? j.producer : j.consumer, layer: j.layer, job: j.id, kind: j.kind, category: j.category, bytes: j.bytes,
        segment: open.how, endedBy: how, evidence: EVIDENCE});
  };
  for (const e of r.events) {
    switch (e.type) {
      case 'op': {
        const o = ops[e.index];
        if (o.unit === 'COMM') {
          slice('comm', 'comm', o.name, e.start, e.end - e.start, opArgs(o, {async: e.async}));
          const q = sampled.get(o.id);
          if (q) protocolSlices(ev, o, q, e.start);
        } else {
          slice('compute', 'op', o.name, e.start, e.end - e.start, opArgs(o, {bodyUs: e.end - e.start, tmaPrefilled: e.filled}));
        }
        break;
      }
      case 'wait': waits.push(e); break;
      case 'TMA exposed': exposed.push(e); break;
      case 'DMA start': dmaOpen.set(e.job, {t: e.t, job: e.job, how: 'start'}); break;
      case 'DMA resume': dmaOpen.set(e.job, {t: e.t, job: e.job, how: 'resume'}); break;
      case 'DMA park': dmaSlice(dmaOpen.get(e.job), e.t, 'park'); dmaOpen.delete(e.job); break;
      case 'DMA end': dmaSlice(dmaOpen.get(e.job), e.t, 'end'); dmaOpen.delete(e.job); break;
      case 'TMA start': tmaOpen.set(e.index, e); break;
      case 'TMA end': {
        const s = tmaOpen.get(e.index), o = ops[e.index];
        slice(e.domain === 'L' ? 'tmaL' : 'tmaH', 'tma', `fill: ${o.name}`, s.t, e.t - s.t,
          {operator_id: o.id, layer: o.layer, bytes: o.tma.bytes, nominalUs: o.tma.us, halves: o.tma.halves, evidence: EVIDENCE});
        tmaOpen.delete(e.index);
        break;
      }
      case 'COMM end': break;
      default: throw new Error(`unknown simulator event ${e.type}`);
    }
  }
  if (dmaOpen.size || tmaOpen.size) throw new Error('simulator trace left DMA or TMA transfers open');
  for (const e of coalesce(exposed)) {
    const o = ops[e.index];
    slice('compute', 'tma-exposed', `exposed fill: ${o.name}`, e.t, e.dur, {operator_id: o.id, layer: o.layer, evidence: EVIDENCE});
  }
  for (const e of coalesce(waits)) {
    const o = e.index === null ? null : ops[e.index];
    slice('wait', 'wait', o ? `wait: ${o.name}` : 'wait: drain', e.t, e.dur,
      o ? {operator_id: o.id, layer: o.layer, evidence: EVIDENCE} : {operator_id: null, evidence: EVIDENCE});
  }
  // One counter sample per instant (the last state at that time).
  const occ = [];
  for (const p of r.occupancy) {
    if (occ.length && occ[occ.length - 1].t === p.t) occ[occ.length - 1] = p;
    else occ.push(p);
  }
  for (const p of occ) ev.push({ph: 'C', pid: PID, tid: 0, name: COUNTER, ts: p.t, args: {allocated: p.allocatedMiB, live: p.liveMiB}});
  return {events: ev, protocol: protocolSummary(samples)};
}

// HW-TR-01 nested slices under one collective, plus per-peer async slices of each RDMA phase.
function protocolSlices(ev, o, q, start) {
  const tid = TRACKS.comm.tid;
  const nest = (name, ts, dur, args) => ev.push({ph: 'X', pid: PID, tid, cat: 'protocol', name, ts, dur, args: {operator_id: o.id, layer: o.layer, evidence: EVIDENCE, ...args}});
  let t = start;
  q.phaseDetail.forEach((p, k) => {
    nest(`RDMA phase ${k + 1}/${q.phaseDetail.length}`, t, p.duration,
      {requests: p.requests, wireBytes: p.wireBytes, readyUs: p.ready, drainedUs: p.drained});
    for (const e of p.events) {
      const id = `${o.id}.${k}.${e.peer}`, cat = 'rdma-peer';
      const a = (ph, name, ts, args) => ev.push({ph, pid: PID, tid, cat, id, name, ts, ...(args ? {args} : {})});
      a('b', `${o.name}: peer ${e.peer}`, t + e.issue, {operator_id: o.id, phase: k + 1, peer: e.peer, evidence: EVIDENCE});
      a('b', 'wire', t + e.sendStart); a('e', 'wire', t + e.sendEnd);
      a('b', 'commit + notify', t + e.sendEnd); a('e', 'commit + notify', t + e.visible);
      a('b', 'ACK return', t + e.visible); a('e', 'ACK return', t + e.ack);
      a('e', `${o.name}: peer ${e.peer}`, t + e.ack);
    }
    t += p.duration;
  });
  const terms = [['tpReduce', 'TP reduce'], ['cardLocal', 'card-local merge (8 dies)'], ['portTail', 'shared-port tail'], ['tauFloor', 'tau floor (ADR-0004)']]
    .map(([key, name]) => [key, name, key === 'tauFloor' ? o.timing.tauFloor : q.timing[key]]).filter(([, , dur]) => dur > 0);
  terms.forEach(([key, name, dur], k) => {
    // The last term ends at the collective's end, so float rounding cannot push a child past its parent.
    nest(name, t, k === terms.length - 1 ? start + o.duration - t : dur, {term: key, termUs: dur});
    t += dur;
  });
}

// Reconcile the trace's tracks with the simulator's own time ledger. Works on the Chrome
// events alone, so a test can run it on the committed file.
function reconcile(events) {
  const xs = events.filter(e => e.ph === 'X');
  const sum = pred => xs.filter(pred).reduce((a, e) => a + e.dur, 0);
  const tid = k => TRACKS[k].tid;
  const busy = xs.filter(e => e.tid === tid('compute')).map(e => [e.ts, e.ts + e.dur]);
  const comm = xs.filter(e => e.tid === tid('comm') && e.cat === 'comm').map(e => [e.ts, e.ts + e.dur]);
  return {
    computeSlotUs: sum(e => e.tid === tid('compute')),
    computeBodyUs: sum(e => e.cat === 'op'),
    tmaExposedUs: sum(e => e.cat === 'tma-exposed'),
    commUs: sum(e => e.cat === 'comm'),
    waitUs: sum(e => e.cat === 'wait'),
    overlapUs: intersection(busy, comm),
    coveredUs: measure([...busy, ...comm, ...xs.filter(e => e.cat === 'wait').map(e => [e.ts, e.ts + e.dur])]),
    endUs: Math.max(...xs.map(e => e.ts + e.dur))
  };
}
function merge(iv) {
  const s = iv.filter(([a, b]) => b > a).sort((p, q) => p[0] - q[0]), out = [];
  for (const [a, b] of s) {
    if (out.length && a <= out[out.length - 1][1]) out[out.length - 1][1] = Math.max(out[out.length - 1][1], b);
    else out.push([a, b]);
  }
  return out;
}
const measure = iv => merge(iv).reduce((a, [s, e]) => a + e - s, 0);
function intersection(a, b) {
  const p = merge(a), q = merge(b);
  let i = 0, j = 0, total = 0;
  while (i < p.length && j < q.length) {
    const lo = Math.max(p[i][0], q[j][0]), hi = Math.min(p[i][1], q[j][1]);
    if (hi > lo) total += hi - lo;
    if (p[i][1] < q[j][1]) i++; else j++;
  }
  return total;
}

// The checks ARCH-TR-01 accepts the trace on; they throw rather than record a failure.
function checkReconciliation(rec, ledger) {
  const want = {
    computeSlotUs: ledger.computeUs - ledger.tmaHiddenUs, tmaExposedUs: ledger.tmaExposedUs, commUs: ledger.commUs,
    waitUs: ledger.waitUs, overlapUs: ledger.overlapUs, coveredUs: ledger.rawUs, endUs: ledger.rawUs
  };
  for (const [k, v] of Object.entries(want)) {
    if (!(Math.abs(rec[k] - v) < TIMING_TOL)) throw new Error(`trace does not reconcile: ${k} ${rec[k]} vs ledger ${v}`);
  }
  return want;
}

function provenance(x, opt) {
  return {
    baseline: BASELINE_FILE, baselineSha256: hashFile(BASELINE_FILE),
    sources: Object.fromEntries(SOURCE_FILES.map(f => [f, hashFile(f)])),
    xSha256: sha256(JSON.stringify(x)), x, opt, gain: 'all GAIN factors are 1 (k3_rdma_final_tuning_model.js)'
  };
}

// The published point (ARCH-TR-01): tpsDesign.hardware.x under the model's own OPT.
function buildPublished() {
  const spec = readJson(BASELINE_FILE);
  const x = BP.publishedX(spec, 'execution_trace.js');
  const run = replay(x);
  if (!run.feasible) throw new Error(`published point is infeasible: ${run.reasons}`);
  const {events, protocol} = chromeTrace(run);
  const ledger = ledgerOf(run.r);
  const published = spec.tpsDesign.point;
  if (Math.abs(ledger.rawUs - published.rawLatencyUs) > TIMING_TOL) throw new Error(`replay rawUs ${ledger.rawUs} is not the published ${published.rawLatencyUs}`);
  const rec = reconcile(events);
  checkReconciliation(rec, ledger);
  return {
    displayTimeUnit: 'ns',
    otherData: {format: FORMAT, evidenceClass: EVIDENCE, point: 'published (tpsDesign.hardware.x, model OPT)', unit: 'microseconds'},
    k3Trace: {
      format: FORMAT,
      status: 'MODEL: the detailed simulator\'s schedule of one Batch=1 decode step at the published point. Not an observed timeline; not VALIDATED_EVENT_TIMING; feeds no gate or baseline',
      evidenceClass: EVIDENCE,
      contract: 'docs/architecture/contracts/EXECUTION_TRACE.md',
      provenance: provenance(x, run.opt),
      ledger, reconciliation: rec, publishedPoint: published,
      counts: {operators: run.m.plan.ops.length, collectives: run.m.plan.ops.filter(o => o.unit === 'COMM').length,
        simulatorEvents: run.r.events.length, occupancySamples: run.r.occupancy.length, traceEvents: events.length},
      protocol
    },
    traceEvents: events
  };
}

// One event per line: viewers do not care, and a regeneration diff stays readable.
function serialize(trace) {
  const {traceEvents, ...head} = trace;
  const lines = traceEvents.map(e => JSON.stringify(e));
  const top = JSON.stringify(head, null, 2);
  return `${top.slice(0, -2)},\n  "traceEvents": [\n${lines.join(',\n')}\n  ]\n}\n`;
}

// ARCH-TR-02: per-operator "advance" (issue to next issue) of one replay.
function advances(run) {
  const ops = run.m.plan.ops, start = new Array(ops.length);
  for (const e of run.r.events) if (e.type === 'op') start[e.index] = e.start;
  const seen = new Map();
  return ops.map((o, k) => {
    const name = `${o.layer}|${o.name}`, n = seen.get(name) || 0;
    seen.set(name, n + 1);
    const next = k + 1 < ops.length ? start[k + 1] : run.r.rawUs;
    return {key: `${name}|${n}`, operator_id: o.id, layer: o.layer, name: o.name, unit: o.unit, detail: o.detail || '', start: start[k], advance: next - start[k], duration: o.duration};
  });
}

function diff(x, patch, label) {
  const a = replay(x), b = replay(x, patch);
  const head = {label, patch, evidenceClass: EVIDENCE, xSha256: sha256(JSON.stringify(x)), base: ledgerOf(a.r)};
  if (!b.feasible) return {...head, variant: {feasible: false, reasons: b.reasons}};
  const A = advances(a), B = advances(b), byKey = new Map(B.map(v => [v.key, v]));
  const ops = [], matched = new Set();
  for (const u of A) {
    const v = byKey.get(u.key);
    if (v) matched.add(u.key);
    ops.push({key: u.key, operator_id: u.operator_id, variantOperatorId: v ? v.operator_id : null, layer: u.layer, name: u.name, unit: u.unit, detail: u.detail,
      startShiftUs: v ? v.start - u.start : null, durationDeltaUs: v ? v.duration - u.duration : -u.duration,
      advanceDeltaUs: (v ? v.advance : 0) - u.advance, only: v ? undefined : 'base'});
  }
  for (const v of B) if (!matched.has(v.key)) ops.push({key: v.key, operator_id: null, variantOperatorId: v.operator_id, layer: v.layer, name: v.name, unit: v.unit, detail: v.detail,
    startShiftUs: null, durationDeltaUs: v.duration, advanceDeltaUs: v.advance, only: 'variant'});
  const layers = new Map();
  for (const o of ops) layers.set(o.layer, (layers.get(o.layer) || 0) + o.advanceDeltaUs);
  const byName = new Map();
  for (const o of ops) byName.set(o.name, (byName.get(o.name) || 0) + o.advanceDeltaUs);
  const vb = ledgerOf(b.r), delta = Object.fromEntries(Object.keys(head.base).map(k => [k, vb[k] - head.base[k]]));
  const sumAdvance = ops.reduce((s, o) => s + o.advanceDeltaUs, 0);
  if (Math.abs(sumAdvance - delta.rawUs) > TIMING_TOL) throw new Error(`advance deltas ${sumAdvance} do not sum to the rawUs delta ${delta.rawUs}`);
  return {
    ...head, variant: vb, delta,
    attribution: 'advance = issue of this operator to issue of the next (the last one owns the rest of the step); deltas sum to delta.rawUs',
    byLayer: [...layers].map(([layer, d]) => ({layer, advanceDeltaUs: d})).sort((p, q) => p.layer - q.layer),
    byOperatorName: [...byName].map(([name, d]) => ({name, advanceDeltaUs: d})).sort((p, q) => Math.abs(q.advanceDeltaUs) - Math.abs(p.advanceDeltaUs)),
    unmatched: {base: ops.filter(o => o.only === 'base').length, variant: ops.filter(o => o.only === 'variant').length},
    operators: ops,
    runs: {a, b}
  };
}

module.exports = {TRACKS, COUNTER, FORMAT, EVIDENCE, SOURCE_FILES, BASELINE_FILE, TIMING_TOL,
  replay, chromeTrace, reconcile, checkReconciliation, buildPublished, serialize, mechanismPatch, advances, diff, ledgerOf, provenance};
