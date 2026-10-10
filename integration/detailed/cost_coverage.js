'use strict';
/* Operator cost evidence coverage (ARCH-CH-02, teams/council/docs/24_TRACE_AND_CHARON_ADOPTION_PLAN.md).
 *
 * mappedPlan takes every compute op's kernel time from cost_provider.js: measured, fitted between
 * two measurements, or analytical. This module replays the published point and reports how much
 * of its raw latency stands on each kind of cost, and what would have to be measured to move it.
 *
 *  - ledger: the service lines of O.evaluate (services + wait = raw), with the kernel line split by
 *    costSource and evidence. Everything that is not a compute kernel (staging, launch, collectives,
 *    tau floor, DMA wait) and the hidden lines (commOverlap, tmaHidden, booked negative) are MODEL.
 *    The shares are gross: a measured kernel hidden under a collective still counts in full.
 *  - calibrationQueue: one row per compute op name in the plan's calibration order (attention
 *    path, then Linear, then Expert, then the rest), with the distinct shapes the published point
 *    needs measured and the kernel time each shape carries. Collectives are not here: their
 *    calibration is the tau derivation (HW-CH-01).
 *  - target: the HW_KEYS values of the published x, the hardware an observation must match.
 *
 * Evidence class of the report itself MODEL. With the observation table empty every kernel is
 * analytical and the measured share is zero.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const O = require('./k3_rdma_final_tuning_model.js');
const BP = require('./baseline_point.js');
const CP = require('./cost_provider.js');
const {simulate} = require('./k3_operator_sram_sim.js');

const root = path.resolve(__dirname, '../..');
const BASELINE_FILE = 'teams/hardware/inputs/k3_mc_baseline.json';
const SOURCE_FILES = [
  'integration/detailed/cost_coverage.js',
  'integration/detailed/cost_provider.js',
  'integration/detailed/k3_operator_sram_sim.js',
  'integration/detailed/k3_architecture_search.js',
  'integration/detailed/k3_physical_basis.js',
  'integration/detailed/k3_sram_memory_rdma_model.js',
  'integration/detailed/k3_rdma_final_tuning_model.js'
];
const FORMAT = 'k3-cost-coverage/1';
const EVIDENCE = 'MODEL';
const TOL = 1e-6;
// Calibration order of the plan (ARCH-CH-02): attention path first, then Linear, then Expert.
// The linear-attention state update is a custom attention kernel like QK/PV and goes with them.
const CLASSES = [
  {key: 'attention', test: o => /^(QK|Online softmax|PV|Linear recurrent)/.test(o.name)},
  {key: 'linear', test: o => o.unit === 'L' && !o.name.startsWith('Expert ')},
  {key: 'expert', test: o => o.unit === 'L'},
  {key: 'other', test: () => true}
];

const sha256 = data => crypto.createHash('sha256').update(data).digest('hex');
const hashFile = relativePath => sha256(fs.readFileSync(path.join(root, relativePath)));
const readJson = relativePath => JSON.parse(fs.readFileSync(path.join(root, relativePath), 'utf8'));
const add = (m, k, v) => { m[k] = (m[k] || 0) + v; };

function coverage(x) {
  const m = O.mapped(x);
  if (!m.feasible) throw new Error(`published point is infeasible: ${m.reasons}`);
  const r = simulate(m.plan, m.window);
  if (!r.feasible) throw new Error(`published point does not simulate: ${r.reasons}`);
  const services = {...m.services, commOverlap: -r.overlapUs, tmaHidden: -r.tmaHiddenUs};
  const booked = Object.values(services).reduce((a, v) => a + v, 0) + r.waitUs;
  if (Math.abs(booked - r.rawUs) > TOL) throw new Error(`services + wait ${booked} is not raw ${r.rawUs}`);

  const bySource = Object.fromEntries(CP.SOURCES.map(s => [s, 0]));
  const byEvidence = Object.fromEntries([...CP.EVIDENCE, 'MODEL'].map(e => [e, 0]));
  const groups = new Map();
  for (const o of m.plan.ops) {
    if (!CP.SOURCES.includes(o.costSource)) throw new Error(`op ${o.id} ${o.name} has no cost source`);
    if (o.unit === 'COMM') continue;
    const k = o.timing.kernel;
    add(bySource, o.costSource, k);
    add(byEvidence, o.costEvidence, k);
    if (!groups.has(o.name)) groups.set(o.name, {op: o.name, unit: o.unit, class: CLASSES.find(c => c.test(o)).key, count: 0, kernelUs: 0, costSource: {}, shapes: new Map()});
    const g = groups.get(o.name), key = CP.SHAPE_KEYS.map(s => o.costShape[s]).join(',');
    g.count++; g.kernelUs += k; add(g.costSource, o.costSource, 1);
    if (!g.shapes.has(key)) g.shapes.set(key, {shape: o.costShape, count: 0, kernelUsEach: k, costSource: o.costSource});
    g.shapes.get(key).count++;
  }
  const kernelUs = Object.values(bySource).reduce((a, v) => a + v, 0);
  if (Math.abs(kernelUs - services.kernel) > TOL) throw new Error(`kernel by source ${kernelUs} is not the kernel service ${services.kernel}`);
  const nonKernel = r.rawUs - kernelUs;
  byEvidence.MODEL += nonKernel;
  const order = CLASSES.map(c => c.key);
  const queue = [...groups.values()]
    .map(g => ({...g, shareOfRaw: g.kernelUs / r.rawUs, shapes: [...g.shapes.values()].sort((a, b) => b.count * b.kernelUsEach - a.count * a.kernelUsEach)}))
    .sort((a, b) => order.indexOf(a.class) - order.indexOf(b.class) || b.kernelUs - a.kernelUs)
    .map((g, i) => ({rank: i + 1, ...g}));
  const classes = order.map(k => {
    const rows = queue.filter(g => g.class === k);
    return {class: k, ops: rows.length, shapes: rows.reduce((a, g) => a + g.shapes.length, 0), kernelUs: rows.reduce((a, g) => a + g.kernelUs, 0)};
  });
  const observed = bySource.measured + bySource.fitted;
  return {
    ledger: {rawUs: r.rawUs, tpsPerUser: r.tps, waitUs: r.waitUs, services, kernelUs, nonKernelUs: nonKernel,
      bySource: {...bySource, nonKernel}, byEvidence},
    shares: {measured: bySource.measured / r.rawUs, fitted: bySource.fitted / r.rawUs, observed: observed / r.rawUs,
      analyticalKernel: bySource.analytical / r.rawUs, nonKernel: nonKernel / r.rawUs},
    classes,
    calibrationQueue: queue
  };
}

function build() {
  const spec = readJson(BASELINE_FILE);
  const x = BP.publishedX(spec, 'cost_coverage.js');
  const table = readJson(CP.OBSERVATIONS_FILE);
  const c = coverage(x);
  if (Math.abs(c.ledger.rawUs - spec.tpsDesign.point.rawLatencyUs) > TOL) throw new Error(`replay rawUs ${c.ledger.rawUs} is not the published ${spec.tpsDesign.point.rawLatencyUs}`);
  return {
    format: FORMAT,
    status: 'MODEL: share of the published raw latency whose kernel time is measured, fitted or analytical, and the shapes to measure. Feeds no gate or baseline',
    evidenceClass: EVIDENCE,
    workItem: 'ARCH-CH-02',
    plan: 'teams/council/docs/24_TRACE_AND_CHARON_ADOPTION_PLAN.md',
    method: 'Kernel line of every compute op from cost_provider.js (measured -> fitted -> analytical); all other service lines, DMA wait and the hidden lines are MODEL. Shares are gross (hidden kernels count in full).',
    provenance: {
      baseline: BASELINE_FILE, baselineSha256: hashFile(BASELINE_FILE),
      observations: CP.OBSERVATIONS_FILE, observationsSha256: hashFile(CP.OBSERVATIONS_FILE), observationCount: table.observations.length,
      sources: Object.fromEntries(SOURCE_FILES.map(f => [f, hashFile(f)]))
    },
    target: {point: 'published (tpsDesign.hardware.x, model OPT)', hardware: Object.fromEntries(CP.HW_KEYS.map(k => [k, x[k]]))},
    ...c
  };
}

module.exports = {FORMAT, EVIDENCE, SOURCE_FILES, BASELINE_FILE, CLASSES, TOL, coverage, build};
