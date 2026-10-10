'use strict';
/* Foreground overlap contention (ARCH-CH-01, teams/council/docs/24_TRACE_AND_CHARON_ADOPTION_PLAN.md;
 * method borrowed from Charon's bandwidth redistribution, without its calibrated slow-down factors).
 *
 * The published model gives the running op and an in-flight collective their mapped service time
 * whatever runs beside them; only DMA and TMA fills take what is left. simulate(..., {contention:
 * 'proportional'}) advances the two foreground requesters by remaining work instead, sharing the
 * shared-SRAM read port, write port and fabric in proportion to demand wherever their sum exceeds
 * the cap (k3_operator_sram_sim.js). This module replays the published point and every feasible
 * joint point of out/detailed/coupling_candidates.json in both modes and reports the difference.
 *
 * What is reported per point:
 *  - both ledgers and the TPS/usr delta; contentionUs, the wall time the foreground lost to sharing
 *    (raw = compute - tmaHidden + comm + wait - overlap + contention), and the layers it fell in;
 *  - peakForegroundLoad: the highest summed foreground demand / cap seen while two requesters ran
 *    together, per resource, with the pair. 1 / load is the headroom before sharing costs anything;
 *  - overCap: ops whose own demand exceeds a cap with nothing beside them, and the time they would
 *    add at the cap. That is a mapper inconsistency (epilogue ops whose mapped time is below their
 *    bytes / port bandwidth), not contention; it is listed so it is not mistaken for either.
 *
 * Evidence class MODEL. The default stays 'none'; changing it is an ADR (plan decision D3).
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const O = require('./k3_rdma_final_tuning_model.js');
const C = require('./coupling_search.js');
const BP = require('./baseline_point.js');
const {simulate} = require('./k3_operator_sram_sim.js');

const root = path.resolve(__dirname, '../..');
const BASELINE_FILE = 'teams/hardware/inputs/k3_mc_baseline.json';
const COUPLING_FILE = 'out/detailed/coupling_candidates.json';
const SOURCE_FILES = [
  'integration/detailed/contention_delta.js',
  'integration/detailed/k3_operator_sram_sim.js',
  'integration/detailed/k3_architecture_search.js',
  'integration/detailed/cost_provider.js',
  'teams/vv/inputs/operator_cost_observations.json',
  'integration/detailed/k3_physical_basis.js',
  'integration/detailed/k3_sram_memory_rdma_model.js',
  'integration/detailed/k3_rdma_final_tuning_model.js',
  'integration/detailed/coupling_search.js',
  'integration/detailed/matrix_vector_search.js',
  'integration/detailed/comm_core_search.js'
];
const FORMAT = 'k3-contention-delta/1';
const EVIDENCE = 'MODEL';
const MODES = ['none', 'proportional'];
const TOL = 1e-6;

const sha256 = data => crypto.createHash('sha256').update(data).digest('hex');
const hashFile = relativePath => sha256(fs.readFileSync(path.join(root, relativePath)));
const readJson = relativePath => JSON.parse(fs.readFileSync(path.join(root, relativePath), 'utf8'));

const ledgerOf = r => ({rawUs: r.rawUs, computeUs: r.computeUs, tmaHiddenUs: r.tmaHiddenUs, commUs: r.commUs, waitUs: r.waitUs,
  overlapUs: r.overlapUs, contentionUs: r.contentionUs || 0, tpsPerUser: r.tps});

// O.evaluate's mapped() + simulate(), with the contention mode passed through (evaluate itself
// takes none: its source is bound by sha256 into the planning workload and Stage B, and the
// default path is unchanged). Services are booked as evaluate books them, plus contention.
function evaluate(x, contention) {
  const m = O.mapped(x);
  if (!m.feasible) return m;
  const r = simulate(m.plan, m.window, {contention});
  if (!r.feasible) return r;
  const services = {...m.services, commOverlap: -r.overlapUs, tmaHidden: -r.tmaHiddenUs};
  if (contention !== 'none') services.contention = r.contentionUs;
  return {...r, services};
}

// One point in both modes. `run(contention)` is evaluate() at the point, inside whatever scope the point needs.
function comparePoint(label, run) {
  const [a, b] = MODES.map(run);
  if (!a.feasible || !b.feasible) return {point: label, feasible: false, reasons: [a.reason || a.reasons, b.reason || b.reasons].flat().filter(Boolean)};
  if ('contentionUs' in a) throw new Error(`${label}: contention 'none' reported contentionUs`);
  const rawDelta = b.rawUs - a.rawUs;
  const layers = [];
  a.layerStats.forEach((la, i) => {
    const lb = b.layerStats[i], d = lb.duration - la.duration;
    if (Math.abs(d) > 1e-9 || lb.contention > 1e-9) layers.push({layer: i, durationDeltaUs: d, contentionUs: lb.contention});
  });
  const load = b.contention.peakForegroundLoad;
  return {
    point: label, feasible: true,
    none: ledgerOf(a), proportional: ledgerOf(b),
    delta: {rawUs: rawDelta, tpsPerUser: b.tps - a.tps, overlapUs: b.overlapUs - a.overlapUs, waitUs: b.waitUs - a.waitUs},
    contentionUs: b.contentionUs,
    // The overlap gain under 'none': what sharing could at most take back (24 doc §2, ARCH-CH-01).
    overlapGainUs: a.overlapUs,
    peakForegroundLoad: load,
    headroom: Object.fromEntries(Object.entries(load).map(([k, v]) => [k, v.load > 0 ? 1 / v.load : null])),
    layers,
    overCap: b.contention.overCap
  };
}

function build() {
  const spec = readJson(BASELINE_FILE);
  const x = BP.publishedX(spec, 'contention_delta.js');
  const points = [comparePoint('published (tpsDesign.hardware.x, model OPT)', mode => evaluate(x, mode))];
  const published = spec.tpsDesign.point;
  if (Math.abs(points[0].none.rawUs - published.rawLatencyUs) > TOL) throw new Error(`replay rawUs ${points[0].none.rawUs} is not the published ${published.rawLatencyUs}`);
  const coupling = readJson(COUPLING_FILE);
  for (const row of coupling.candidates.filter(r => r.feasible)) {
    const p = comparePoint(`joint ${row.optionId}`, mode => C.withPoint(row, () => evaluate(row.x, mode)));
    if (p.feasible && Math.abs(p.none.tpsPerUser - row.tpsPerUser) > TOL) throw new Error(`${row.optionId}: replay TPS/usr ${p.none.tpsPerUser} is not the candidate's ${row.tpsPerUser}`);
    points.push({...p, rank: row.rank, chosen: row.chosen, pareto: row.pareto});
  }
  const feasible = points.filter(p => p.feasible);
  const maxDelta = Math.max(...feasible.map(p => Math.abs(p.delta.rawUs)));
  const maxLoad = Math.max(...feasible.flatMap(p => Object.values(p.peakForegroundLoad).map(v => v.load)));
  return {
    format: FORMAT,
    status: 'MODEL: foreground overlap contention, the published model (contention none) against proportional sharing of the shared-SRAM ports and fabric. Feeds no gate or baseline; changing the default needs an ADR (24 doc D3)',
    evidenceClass: EVIDENCE,
    workItem: 'ARCH-CH-01',
    plan: 'teams/council/docs/24_TRACE_AND_CHARON_ADOPTION_PLAN.md',
    method: 'Running op and in-flight collective advance by remaining work. Per resource (shared read, shared write, fabric) the foreground demand, each clipped to the cap, is summed; above the cap every requester gets cap/sum and progresses at its slowest resource. DMA and TMA fills keep the historical priority: they take what the foreground actually draws. No calibration factor.',
    provenance: {
      baseline: BASELINE_FILE, baselineSha256: hashFile(BASELINE_FILE),
      coupling: COUPLING_FILE, couplingSha256: hashFile(COUPLING_FILE),
      sources: Object.fromEntries(SOURCE_FILES.map(f => [f, hashFile(f)]))
    },
    summary: {points: points.length, feasible: feasible.length, maxAbsRawDeltaUs: maxDelta, maxPeakForegroundLoad: maxLoad,
      zeroDelta: maxDelta <= TOL},
    points
  };
}

module.exports = {FORMAT, EVIDENCE, MODES, SOURCE_FILES, BASELINE_FILE, COUPLING_FILE, TOL, evaluate, comparePoint, build};
