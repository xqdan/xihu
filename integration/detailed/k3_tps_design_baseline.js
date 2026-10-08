'use strict';
/* K3 TPS/usr design baseline (docs/architecture/21_TPS_DESIGN_BASELINE.md, ADR-0005).
 *
 * Collects, for the published Final Tuning point, everything the TPS/usr claim
 * rests on: the time ledger, the hardware sizing, and every software mechanism
 * with the value it would fall back to and the replayed TPS when only that one
 * is switched back. Ablations are recomputed from the model, never hand-copied.
 *
 * Written into teams/hardware/inputs/k3_mc_baseline.json#tpsDesign by
 * integration/pipelines/sync_baseline_spec.js; tests/regression/test_tps_design_baseline.js rebuilds it
 * and compares.
 */
const A = require('./k3_architecture_search.js');
const O = require('./k3_rdma_final_tuning_model.js');
const P = require('./k3_physical_basis.js');

const pick = r => r.feasible === false
  ? {feasible: false, reasons: r.reasons || [r.reason]}
  : {feasible: true, tpsPerUser: r.tps, rawLatencyUs: r.rawUs};

// Evaluate with a temporary OPT patch; OPT is always restored.
function withOpt(patch, x, fn = O.evaluate) {
  const saved = {...O.OPT};
  Object.assign(O.OPT, patch);
  try { return fn(x); } finally { Object.assign(O.OPT, saved); }
}

// Evaluate with a temporary A.TECH patch; TECH is always restored.
function withTech(patch, fn) {
  const saved = {...A.TECH};
  Object.assign(A.TECH, patch);
  try { return fn(); } finally { Object.assign(A.TECH, saved); }
}

// Expert prediction accuracy is built into the plan as a constant (0.8); the simulator
// reads plan.c.prediction when it adopts or discards a predicted tile, and nothing
// else depends on it (job sizes do not), so overriding it on the plan is the replay of
// "the predictor is right p of the time". mappedPlan is always restored.
function withPrediction(prediction, fn) {
  const orig = A.mappedPlan;
  A.mappedPlan = (...args) => {
    const r = orig(...args);
    if (r.plan) r.plan.c.prediction = prediction;
    return r;
  };
  try { return fn(); } finally { A.mappedPlan = orig; }
}

const SHARED_PORT_UNSCALED = {localWriteRatio: 1, tmaDedicatedPort: false, sharedReadScale: 1, sharedReadPerWrite: 0};
// Mechanisms the published point relies on. `off` is the value the mechanism
// falls back to (a `patch` of several OPT keys for composite mechanisms); each
// one must lower TPS (or make the point infeasible) when switched back alone.
const MECHANISMS = [
  {key: 'tmaLane', off: false, layer: 'scheduler/TMA', evidence: 'MODEL', role: 'shared->local fills issued ahead on per-domain (L/H) TMA lanes'},
  {key: 'kvPrefetch', off: 'layer', layer: 'scheduler/DMA', evidence: 'MODEL', role: 'KV context tiles of the next x.depth layers prefetched into shared SRAM'},
  {key: 'dmaPreempt', off: false, layer: 'scheduler/DMA', evidence: 'MODEL', role: 'demand fetches (routed-expert misses) park in-flight prefetches'},
  {key: 'commOverlap', off: false, layer: 'scheduler/collective', evidence: 'MODEL', role: 'shared experts run under the Wdown + Router all-gather'},
  {key: 'softmaxFusion', off: false, layer: 'kernel mapping', evidence: 'MODEL', role: 'online softmax pipelined on H vector lanes under QK; coupled to kvCache -- under fp8 the in-kernel dequant shares the same lanes and is charged against this hiding budget, so the two are not independent and their per-mechanism ablations understate the joint effect'},
  {key: 'launchBatching', off: false, layer: 'runtime', evidence: 'ASSUMPTION', role: 'launch cost scaled once by OPT.launchScale'},
  {key: 'epilogueFusion', off: false, layer: 'kernel mapping', evidence: 'MODEL', role: 'elementwise ops folded into the adjacent kernel'},
  {key: 'pvMerge', off: 'tile', layer: 'kernel mapping', evidence: 'MODEL', role: 'PV m/l/O merged once per layer, cross-die ring reduce-scatter by heads'},
  {key: 'kvCache', off: 'bf16', layer: 'model format', evidence: 'MODEL (precision open, B-001)', role: 'FlashMLA FP8 KV layout, BF16 compute with in-kernel dequant; coupled to softmaxFusion -- the dequant runs on the H vector lanes and is charged against the softmax hiding budget, so ablating either alone understates the joint effect'},
  {key: 'sharedPortScaling', patch: SHARED_PORT_UNSCALED, layer: 'hardware/SRAM ports', evidence: 'MODEL (O-007)', role: 'shared-SRAM write/read port scaling and dedicated TMA port, charged in area/power'}
];
// Switches that are on but do not move TPS at the published point; listed so
// nobody reads them as contributors.
const NO_EFFECT = [
  {key: 'tilePartialReady', patch: {tilePartialReady: false}, note: 'acts on duration only through GAIN, which is 1'}
];

// Parameters the published TPS rests on that nothing in the repository measures.
// `lowerIsWorse` fixes the direction of the break-even search; `floor` is where the
// search stops (a value this low is no longer a plausible silicon figure, so a goal
// that still holds there is reported as holding down to the floor).
const ASSUMPTION_SWEEPS = [
  {key: 'mcUtil', where: 'A.TECH.mcUtil', baseline: () => A.TECH.mcUtil, values: [0.6, 0.65, 0.75], floor: 0.4, lowerIsWorse: true,
    run: (v, x) => withTech({mcUtil: v}, () => O.evaluate(x)), note: 'sustained fraction of the MC payload bandwidth (detailed model); the planning model reads the same number from spec.bandwidthTiers.sustainedEfficiency'},
  {key: 'matrixUtil', where: 'A.TECH.matrixUtil', baseline: () => A.TECH.matrixUtil, values: [0.55, 0.6, 0.7], floor: 0.3, lowerIsWorse: true,
    run: (v, x) => withTech({matrixUtil: v}, () => O.evaluate(x)), note: 'achieved fraction of the tensor-engine peak'},
  {key: 'vectorUtil', where: 'A.TECH.vectorUtil', baseline: () => A.TECH.vectorUtil, values: [0.25, 0.3, 0.45], floor: 0.1, lowerIsWorse: true,
    run: (v, x) => withTech({vectorUtil: v}, () => O.evaluate(x)), note: 'achieved fraction of the vector-lane peak'},
  {key: 'prediction', where: 'plan.c.prediction (simulator input, 0.8)', baseline: () => 0.8, values: [0.6, 0.7, 0.9], floor: 0.3, lowerIsWorse: true,
    run: (v, x) => withPrediction(v, () => O.evaluate(x)), note: 'expert prefetch hit rate; ASSUMPTION (B-003)'},
  {key: 'unpackParamsPerLaneCycle', where: 'A.TECH.unpackParamsPerLaneCycle', baseline: () => A.TECH.unpackParamsPerLaneCycle, values: [1.5, 1, 0.8, 0.5], floor: 0.2, lowerIsWorse: true,
    run: (v, x) => withTech({unpackParamsPerLaneCycle: v}, () => O.evaluate(x)), note: 'weight parameters unpacked (MXFP4/FP8 to the MAC format) per vector lane per cycle; limits the L-core kernels (not MAC-bound); ASSUMPTION, no RTL or microbenchmark'},
  {key: 'layoutImbalance', where: 'A.TECH.layoutImbalance', baseline: () => A.TECH.layoutImbalance, values: [1.3, 1.4, 1.8], ceiling: 2.5, lowerIsWorse: false,
    run: (v, x) => withTech({layoutImbalance: v}, () => O.evaluate(x)), note: 'slowest-bank factor on every kernel time AND on the local-SRAM tile capacity check (H local 81% used): too large makes the point infeasible, not just slower; ASSUMPTION'},
  {key: 'launchScale', where: 'OPT.launchScale', baseline: () => O.OPT.launchScale, values: [0.7, 1], floor: null, lowerIsWorse: false,
    run: (v, x) => withOpt({launchScale: v}, x), note: 'launch cost saved by batching; ASSUMPTION (B-003)'}
];

// Break-even of an unmeasured parameter by bisection: the worst value at which the raw budget still
// holds. For lowerIsWorse sweeps that is the smallest value; for the others the largest, searched up
// to `ceiling`. null: the budget holds all the way to the floor/ceiling.
function breakEven(sweep, x, budgetUs) {
  const meets = v => { const r = sweep.run(v, x); return r.feasible !== false && r.rawUs <= budgetUs; };
  const limit = sweep.lowerIsWorse ? sweep.floor : sweep.ceiling;
  let good = sweep.baseline(), bad = limit;
  if (!meets(good)) return {valueAtBudget: null, note: 'the published value does not meet the budget'};
  if (meets(bad)) return {valueAtBudget: null, [sweep.lowerIsWorse ? 'floor' : 'ceiling']: limit, note: `the budget holds all the way to ${limit}`};
  for (let i = 0; i < 40; i++) {
    const mid = (good + bad) / 2;
    if (meets(mid)) good = mid; else bad = mid;
  }
  return {valueAtBudget: good};
}

// Mechanism groups ablated together. A single switch-back hides that the budget needs
// several mechanisms at once, so the groups are replayed jointly too. kvCache is left
// out (its switch-back is infeasible on its own) and so is the port scaling (hardware).
const MECHANISM_GROUPS = {
  scheduler: ['tmaLane', 'kvPrefetch', 'dmaPreempt', 'commOverlap'],
  kernelMapping: ['softmaxFusion', 'epilogueFusion', 'pvMerge', 'launchBatching']
};
const groupPatch = keys => Object.assign({}, ...keys.map(k => ({[k]: MECHANISMS.find(m => m.key === k).off})));

const category = o => o.unit === 'COMM' ? 'collective'
  : /^QK|softmax|^PV|RoPE|KV append|MLA Q|Q \/ new-KV/.test(o.name) ? 'mlaAttention'
  : /Linear recurrent|Linear projections/.test(o.name) ? 'linearAttention'
  : /Attention output projection|Attention RMSNorm|Attention residual/.test(o.name) ? 'attentionCommon'
  : /Expert|Routed|Router|Dispatch|Wup|Wdown|SiLU|Shared|MoE|Top-k/.test(o.name) ? 'moe'
  : 'headAndSampling';

// Unmeasured parameters taken at a pessimistic value TOGETHER. One-at-a-time sweeps show each margin
// alone; the budget has to hold when several of them are wrong at once. `compute` is the die side
// (utilisation, unpack rate, bank imbalance, KV tile); `allUnmeasured` adds the memory/software side
// (sustained MC efficiency, expert prediction, launch batching). The values are the pessimistic ends
// of the sweeps above, not forecasts.
const JOINT_PESSIMISTIC = {
  compute: {matrixUtil: 0.5, vectorUtil: 0.25, unpackParamsPerLaneCycle: 1, layoutImbalance: 1.3, kvTile: 16384},
  allUnmeasured: {matrixUtil: 0.5, vectorUtil: 0.25, unpackParamsPerLaneCycle: 1, layoutImbalance: 1.3, kvTile: 16384,
    mcUtil: 0.65, prediction: 0.7, launchScale: 0.7}
};
function replayJoint(values, x) {
  const {kvTile, prediction, launchScale, ...tech} = values;
  const xx = kvTile === undefined ? x : {...x, kvTile};
  const run = () => withTech(tech, () => withOpt(launchScale === undefined ? {} : {launchScale}, xx, y => O.evaluate(y)));
  return prediction === undefined ? run() : withPrediction(prediction, run);
}

function build(x, budgetUs) {
  const r = O.evaluate(x);
  if (!r.feasible) throw new Error('published point is infeasible');
  const m = O.mapped(x), p = r.p;
  const unscaled = withOpt(SHARED_PORT_UNSCALED, x).p;
  const collectiveTotal = r.protocol.reduce((s, a) => s + a.count, 0);
  const opTimeUsByCategory = {};
  for (const o of m.plan.ops) opTimeUsByCategory[category(o)] = (opTimeUsByCategory[category(o)] || 0) + o.duration;
  return {
    status: 'BASELINE (model-derived, not FROZEN; ADR-0003, ADR-0005)',
    document: 'docs/architecture/21_TPS_DESIGN_BASELINE.md',
    adr: 'teams/council/adr/ADR-0005-tps-design-baseline.md',
    point: {tpsPerUser: r.tps, rawLatencyUs: r.rawUs, e2eLatencyUs: r.e2eUs, rawBudgetUs: budgetUs, rawMarginUs: budgetUs - r.rawUs},
    ledger: {
      identity: 'raw = compute - tmaHidden + comm + wait - overlap; TPS = 1e6 / (raw x engineeringMargin)',
      computeUs: r.computeUs, tmaHiddenUs: r.tmaHiddenUs, commUs: r.commUs, dmaWaitUs: r.waitUs, overlapUs: r.overlapUs,
      tmaFillUs: r.tmaFillUs, tmaExposedUs: r.tmaExposedUs,
      services: r.services,
      opTimeUsByCategory,
      collectives: r.protocol.map(a => ({name: a.name, count: a.count, timeUs: a.timeUs, avgProtocolUs: a.timeUs / a.count, workspaceBytes: a.workspace}))
    },
    dataMovement: {
      readBytesPerRankPerToken: r.readBytes, predictedExpertBytes: r.predBytes, mispredictedBytes: r.wrongBytes,
      dmaBusyUs: r.dmaBusyUs, effectiveDmaTBsPerCard: r.dmaTBs, dmaPreemptions: r.dmaPreemptions, tmaCancels: r.tmaCancels,
      kvBytesPerTokenPerLayer: m.plan.kvBytesPerToken, backingGBPerRank: r.backingGB,
      sharedWindowMiBPerCard: r.sramMiB, sharedPeakReservedMiBPerCard: r.peakReservedMiB,
      localTileMiB: {lCore: r.localL, hCore: r.localH}, rdmaWorkspaceMiB: r.rdmaReserveMiB
    },
    hardware: {
      x: {...x},
      perDie: {
        lTensorTflops: p.lTF, hTensorTflops: p.hTF, vectorTops: p.vectorTOP, reduceTops: p.reduceTOP,
        localSramMiB: p.localMiB, dataSramMiB: p.totalMiB,
        localReadTBs: {lCore: p.lRead, hCore: p.hRead}, sharedReadTBs: p.sharedRead, sharedWriteTBs: p.sharedWrite,
        nocMesh: [p.meshSide, p.meshSide], nocTBs: p.nocTB, coreTmaTBs: p.coreTma,
        uciePortGBs: p.uciePortGB, mcGBsPerDie: p.mcDieGB, dieCutGBs: p.dieCutGB, rdmaGBsPerDie: p.rdmaDieGB
      },
      perCard: {rdmaGBs: p.rdmaCardGB, powerW: p.cardPower, mcPowerW: p.mcPower, packageAreaMm2: p.packageArea, shorelineMm: p.shoreline, shorelineBudgetMm: p.edgeBudget},
      areaMm2: p.area, powerW: p.power, dieAreaMm2: p.dieArea, diePowerW: p.diePower,
      limits: {dieAreaMm2: P.BASIS.limits.dieArea, diePowerW: P.BASIS.limits.diePower, cardPowerW: P.BASIS.limits.cardPower, packageAreaMm2: P.BASIS.limits.packageArea},
      sharedPortScalingCost: {dieAreaMm2: p.dieArea - unscaled.dieArea, diePowerW: p.diePower - unscaled.diePower, cardPowerW: p.cardPower - unscaled.cardPower},
      // Physical basis (P.BASIS); dieAreaMm2AtN4Ref is physical() on the historical
      // N4 reference coefficients, before the charged shared-port area.
      basis: {process: P.BASIS.process, areaScale: {...P.PROCESS[P.BASIS.process]}, matrixTFPerMm2: P.BASIS.matrixTFPerMm2,
        matrixTFPerMm2N4Ref: A.TECH.matrixTFPerMm2, cooling: P.BASIS.cooling, dieAreaMm2AtN4Ref: A.physical(x).dieArea},
      tech: {matrixUtil: A.TECH.matrixUtil, vectorUtil: A.TECH.vectorUtil, launchUs: A.TECH.launchUs, unpackParamsPerLaneCycle: A.TECH.unpackParamsPerLaneCycle}
    },
    software: {
      opt: {...O.OPT},
      gainAllNeutral: Object.values(O.GAIN).every(v => v === 1),
      mechanisms: MECHANISMS.map(d => {
        const off = d.patch || {[d.key]: d.off};
        const on = d.patch ? Object.fromEntries(Object.keys(d.patch).map(k => [k, O.OPT[k]])) : O.OPT[d.key];
        return {key: d.key, on, off: d.patch || d.off, layer: d.layer, evidence: d.evidence, role: d.role, ablation: pick(withOpt(off, x))};
      }),
      jointAblation: Object.fromEntries([
        ...Object.entries(MECHANISM_GROUPS),
        ['schedulerAndKernelMapping', [...MECHANISM_GROUPS.scheduler, ...MECHANISM_GROUPS.kernelMapping]]
      ].map(([name, keys]) => [name, {keys, ablation: pick(withOpt(groupPatch(keys), x))}])),
      noEffectAtPublishedPoint: NO_EFFECT.map(n => ({key: n.key, note: n.note, ablation: pick(withOpt(n.patch, x))})),
      countBasis: {on: O.OPT.countBasis, off: 'repo-510', ablation: pick(withOpt({countBasis: 'repo-510'}, x)), note: 'counting basis, not an optimization (ADR-0004)'}
    },
    sensitivity: {
      tauBreakEvenUs: O.OPT.tauUs + (budgetUs - r.rawUs) / collectiveTotal,
      tauHeadroomUsPerCollective: (budgetUs - r.rawUs) / collectiveTotal,
      assumptions: Object.fromEntries(ASSUMPTION_SWEEPS.map(sw => [sw.key, {
        where: sw.where, published: sw.baseline(), note: sw.note,
        replays: Object.fromEntries(sw.values.map(v => [String(v), pick(sw.run(v, x))])),
        lowerIsWorse: sw.lowerIsWorse,
        ...(sw.lowerIsWorse || sw.ceiling ? {breakEven: breakEven(sw, x, budgetUs)} : {})
      }])),
      jointPessimistic: Object.fromEntries(Object.entries(JOINT_PESSIMISTIC).map(([name, values]) => [name, {values, replay: pick(replayJoint(values, x))}])),
      depth: Object.fromEntries([1, 2, 3, 4].map(d => [d, pick(O.evaluate({...x, depth: d}))])),
      mcGBs: Object.fromEntries([320, 400, 480, 560, 640].map(g => [g, pick(O.evaluate({...x, mcGBs: g}))])),
      kvTile16384: {fp8: pick(O.evaluate({...x, kvTile: 16384})), bf16: pick(withOpt({kvCache: 'bf16'}, {...x, kvTile: 16384}))}
    },
    regenerate: 'npm run search:final && npm run baseline:sync && npm run model:planning; enforced by tests/regression/test_tps_design_baseline.js'
  };
}

// The replay helpers and sweeps are exported for integration/detailed/tps_attribution.js,
// which asks the same questions per design dimension; it must not keep a second copy.
module.exports = {build, MECHANISMS, NO_EFFECT, SHARED_PORT_UNSCALED, JOINT_PESSIMISTIC, replayJoint,
  ASSUMPTION_SWEEPS, breakEven, withOpt, withTech, withPrediction, category};
