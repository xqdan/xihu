'use strict';
/* L1-a per-token workload and arithmetic intensity (MODEL).
 *
 * Question (teams/council/docs/23_DESIGN_QUESTION_WORKFLOW_PROPOSAL.md, L1-a): how much FLOP does one
 * token of each model cost on each operator class, how many bytes does it move (dense weights,
 * routed experts, KV/state), how many collectives and how many bytes per collective -- and which
 * operators decide "how much compute is needed" versus "how much bandwidth is needed".
 *
 * Method: nothing is recomputed here. The operator rows come from the derivation kernel
 * (integration/pipelines/generate_planning_operator_workload.js -> out/workload/planning_operator_workload.json)
 * and every time is TT.laneTimes / TT.slotTime (integration/planning/token_time.js), the same two
 * lanes L1-b's requirement_frontier.js uses. What this file adds is the view L1-a needs and L1-b
 * does not have: the FLOP/byte split by core class and by byte class, the arithmetic-intensity
 * histogram, the roofline side of every operator, and the collective count on both the
 * reference-393 and repo-510 bases (ADR-0004).
 *
 * This is the question that used to be answered late, by design.detail.workload in the D group,
 * after the domains had already been designed. It is answered here, before L1-b and L2.
 *
 * Read-only: no baseline, gate or published number moves. Run through
 * integration/pipelines/generate_workload_requirements.js (npm run workload:requirements), which
 * writes out/requirements/workload_requirements.json for design.req.workload to read.
 */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const TT = require('./token_time.js');
const RES = require('../../teams/hardware/src/resource_profiles');

const root = path.resolve(__dirname, '../..');
const BASELINE_FILE = 'teams/hardware/inputs/k3_mc_baseline.json';
const WORKLOAD_FILE = 'out/workload/planning_operator_workload.json';
const PROFILES_FILE = 'teams/hardware/src/resource_profiles.js';
const KERNEL_FILE = 'integration/planning/requirement_workload.js';
const OUT_FILE = 'out/requirements/workload_requirements.json';
const SCHEMA_VERSION = 'workload-requirements-v0.1';
const TPS_LIST = [8, 16, 32];
const PROFILE = 'P1';
// Bandwidth reference of the summary: the fitted planning point of the calibration (MC640).
const MC_REFERENCE = 'MC640';
// The baseline is the K3 spec, so its collectiveCount block is K3's; GLM-5.2 and DeepSeek-V4-Pro
// carry only their own per-layer ASSUMPTION counts (ADR-0024) and have no second basis.
const BASELINE_MODEL = 'K3';
// FLOP/byte buckets of the arithmetic-intensity histogram. The top bucket is open.
const INTENSITY_BUCKETS = [[0, 0.25], [0.25, 1], [1, 4], [4, 16], [16, 64], [64, Infinity]];
// The three sizing ratios of the absorbed design.detail.workload, redefined on the planning lanes:
// each is that domain's own lane time as a fraction of the raw budget. They are NOT additive --
// raw = max(memory lane, serial lane), so compute and bandwidth overlap by construction.
const RATIOS = [
  {ratio: 'requiredToAvailableRatio', lane: 'compute', field: 'flopUs', note: 'calibrated compute time (kFlop x planning compute) against the raw budget'},
  {ratio: 'requiredToAvailableBandwidthRatio', lane: 'memory', field: 'memoryLaneUs', note: 'memory lane (bandwidth-limited, with expert re-read) against the raw budget'},
  {ratio: 'requiredToAvailableNetworkRatio', lane: 'network', field: 'commUs', note: 'collectives per token x per-collective time against the raw budget'}
];

const sha256 = text => crypto.createHash('sha256').update(text).digest('hex');

function context(options = {}) {
  const baselineText = options.baselineText || fs.readFileSync(path.join(root, BASELINE_FILE), 'utf8');
  const workloadText = options.workloadText || fs.readFileSync(path.join(root, WORKLOAD_FILE), 'utf8');
  const spec = JSON.parse(baselineText);
  const workload = JSON.parse(workloadText);
  const models = Object.keys(workload.provenance);
  const planning = Object.fromEntries(models.map(m => [m, TT.planningModel(workload, m)]));
  return {spec, workload, planning,
    active: models.filter(m => planning[m]),
    blocked: models.filter(m => !planning[m]),
    target: {tpsPerUser: spec.goal.target, architectureGateTpsPerUser: spec.acceptance.architectureGateTpsPerUser,
      rawLatencyBudgetUs: spec.goal.rawLatencyBudgetUs, engineeringMargin: spec.goal.engineeringMargin},
    sourceArtifacts: [{path: BASELINE_FILE, sha256: sha256(baselineText)},
      {path: WORKLOAD_FILE, sha256: sha256(workloadText)},
      {path: PROFILES_FILE, sha256: sha256(fs.readFileSync(path.join(root, PROFILES_FILE), 'utf8'))}]};
}

const budgetUs = ctx => ctx.target.rawLatencyBudgetUs;
const slot = tp => ({tp, physicalProfile: PROFILE, mcProfile: MC_REFERENCE});
const refProfile = () => RES.coreProfiles[PROFILE];
const refMc = () => RES.mcProfiles[MC_REFERENCE];
// Compute side of the roofline at the reference point: engine peak x the planning derates, exactly
// the denominator laneTimes() charges an operator's FLOP to.
const coreComputeRate = coreClass => refProfile().peakByCore[coreClass] * RES.utilization * RES.dutyCycle;
const mcBytesPerSecond = () => refMc().effectiveBytesPerSecond;

// ---- per-operator rows -------------------------------------------------------------------------

// One row of the model's operator table, per rank at this TP, on the roofline, with its own time.
function row(model, tp, [operatorId, coreClass, globalFlops, globalBytes, bytesClass]) {
  const flops = globalFlops / tp;
  const bytes = globalBytes / tp;
  const intensity = bytes > 0 ? flops / bytes : null;
  const computeUs = flops / coreComputeRate(coreClass) * 1e6;
  const collective = bytesClass === 'collective';
  const memoryUs = collective ? null : bytes / mcBytesPerSecond() * 1e6;
  // The roofline side: what one byte costs on the MC against what one byte's worth of FLOP costs on
  // this core class. collective rows are byte-transport only and are classified by the network.
  const balance = coreComputeRate(coreClass) / mcBytesPerSecond();
  return {operatorId, coreClass, bytesClass, globalFlops, globalBytes, flops, bytes, flopPerByte: intensity,
    computeUs, memoryUs, balanceFlopPerByte: collective ? null : balance,
    bound: collective ? (bytes / model.collectivesPerToken / RES.networkBandwidth * 1e6 >= TT.TAU_US ? 'network' : 'tau')
      : (intensity >= balance ? 'compute' : 'bandwidth')};
}

function histogram(rows) {
  const buckets = INTENSITY_BUCKETS.map(([lo, hi]) => ({loFlopPerByte: lo, hiFlopPerByte: hi === Infinity ? null : hi,
    operators: [], globalFlops: 0, globalBytes: 0}));
  for (const r of rows) {
    if (r.flopPerByte === null) continue;
    const i = INTENSITY_BUCKETS.findIndex(([lo, hi]) => r.flopPerByte >= lo && r.flopPerByte < hi);
    buckets[i].operators.push(r.operatorId);
    buckets[i].globalFlops += r.globalFlops;
    buckets[i].globalBytes += r.globalBytes;
  }
  return buckets;
}

// Aggregate a set of rows by a key, largest first.
function byKey(rows, key, value) {
  const totals = new Map();
  for (const r of rows) totals.set(r[key], (totals.get(r[key]) || 0) + value(r));
  return [...totals].map(([k, v]) => ({[key]: k, value: v})).sort((a, b) => b.value - a.value);
}

const coreClassSplit = (rows, kFlop) => byKey(rows, 'coreClass', r => r.computeUs)
  .map(({coreClass, value}) => ({coreClass, computeUs: value, computeUsCalibrated: value * kFlop,
    globalFlops: rows.filter(r => r.coreClass === coreClass).reduce((s, r) => s + r.globalFlops, 0),
    shareOfComputeUs: value / rows.reduce((s, r) => s + r.computeUs, 0)}));

const bytesClassSplit = rows => byKey(rows.filter(r => r.bytesClass !== 'collective'), 'bytesClass', r => r.bytes)
  .map(({bytesClass, value}) => ({bytesClass, bytes: value,
    memoryUs: rows.filter(r => r.bytesClass === bytesClass).reduce((s, r) => s + r.memoryUs, 0),
    globalBytes: rows.filter(r => r.bytesClass === bytesClass).reduce((s, r) => s + r.globalBytes, 0)}));

// ---- collectives, on every basis the repository states -----------------------------------------

function collectiveBases(ctx, modelId) {
  const perToken = ctx.workload.collectivesPerToken[modelId];
  if (modelId !== BASELINE_MODEL) {
    return [{basis: 'ADR-0024-per-layer-assumption', count: perToken,
      source: ctx.workload.provenance[modelId].shapeSource,
      note: 'per-layer collective count is an ASSUMPTION (ADR-0024); this model has no reference-page basis, so no second caliber is stated'}];
  }
  const c = ctx.spec.collectiveCount;
  return [
    {basis: c.countBasis, count: c.total, byPhase: c.byPhase, source: `${BASELINE_FILE}#collectiveCount.total`,
      referencePageSource: c.referencePageSource, status: c.status},
    {basis: `repo-${c.repoBaselineTotal}`, count: c.repoBaselineTotal, source: `${BASELINE_FILE}#collectiveCount.repoBaselineTotal`,
      reconciliation: c.reconciliation, note: c.note}
  ];
}

// ---- one slot ----------------------------------------------------------------------------------

function slotSummary(ctx, modelId, tp) {
  const model = ctx.planning[modelId];
  const calibration = ctx.workload.calibration;
  const rows = model.rows.map(r => row(model, tp, r));
  const lane = TT.laneTimes(model, slot(tp));
  const time = TT.slotTime(model, slot(tp), calibration);
  const budget = budgetUs(ctx);
  const globalFlops = rows.reduce((s, r) => s + r.globalFlops, 0);
  const globalBytes = rows.reduce((s, r) => s + r.globalBytes, 0);
  const nonCollectiveBytes = rows.filter(r => r.bytesClass !== 'collective').reduce((s, r) => s + r.bytes, 0);
  const collectiveBytes = rows.filter(r => r.bytesClass === 'collective').reduce((s, r) => s + r.bytes, 0);
  const top = (key, n = 3) => [...rows].sort((a, b) => b[key] - a[key]).slice(0, n).map(r => r.operatorId);
  const bases = collectiveBases(ctx, modelId);
  const perCollectiveUs = count => Math.max(TT.TAU_US, collectiveBytes / count / RES.networkBandwidth * 1e6);
  return {
    tp,
    layers: model.layers,
    operators: rows.map(r => ({...r, shareOfComputeUs: r.computeUs / lane.computeUs, shareOfMemoryUs: r.memoryUs === null ? null : r.memoryUs / lane.memoryUs})),
    totals: {
      globalFlopsPerToken: globalFlops,
      globalBytesPerToken: globalBytes,
      flopsPerTokenPerRank: globalFlops / tp,
      bytesPerTokenPerRank: globalBytes / tp,
      nonCollectiveBytesPerTokenPerRank: nonCollectiveBytes,
      collectiveBytesPerTokenPerRank: collectiveBytes,
      aggregateFlopPerByte: globalFlops / globalBytes
    },
    coreClassSplit: coreClassSplit(rows, calibration.kFlop),
    bytesClassSplit: bytesClassSplit(rows),
    intensityHistogram: histogram(rows),
    intensity: {minFlopPerByte: Math.min(...rows.map(r => r.flopPerByte).filter(v => v !== null)),
      maxFlopPerByte: Math.max(...rows.map(r => r.flopPerByte).filter(v => v !== null)),
      machineBalanceFlopPerByte: Object.fromEntries(Object.keys(refProfile().peakByCore).map(c => [c, coreComputeRate(c) / mcBytesPerSecond()]))},
    lanes: {
      memoryLaneUs: time.memoryLaneUs,
      serialLaneUs: time.serialLaneUs,
      serialComputeUs: time.serialComputeUs,
      flopUs: time.flopUs,
      fixedUs: time.fixedUs,
      tmaExposedUs: time.tmaExposedUs,
      commUs: time.commUs,
      rawUs: time.rawUs,
      e2eUs: time.e2eUs,
      tpsPerUser: time.tpsPerUser,
      bound: time.bound,
      boundingOperator: TT.boundingOperator(model, slot(tp), time),
      uncalibrated: {memoryUs: lane.memoryUs, expertMemoryUs: lane.expertMemoryUs, computeUs: lane.computeUs, computeUsByCore: lane.computeUsByCore}
    },
    sizing: {
      budgetUs: budget,
      gateBudgetUs: 1e6 / (ctx.target.architectureGateTpsPerUser * TT.MARGIN),
      ratios: RATIOS.map(({ratio, lane: name, field, note}) => ({ratio, lane: name, requiredUs: time[field],
        availableUs: budget, value: time[field] / budget, note}))
    },
    collectives: {
      collectivesPerToken: model.collectivesPerToken,
      perLayer: model.layers > 0 ? model.collectivesPerToken / model.layers : null,
      bytesPerCollectivePerRank: collectiveBytes / model.collectivesPerToken,
      networkBytesPerSecond: RES.networkBandwidth,
      tauUs: TT.TAU_US,
      bases: bases.map(b => ({...b, bytesPerCollectivePerRank: collectiveBytes / b.count,
        perCollectiveTimeUs: perCollectiveUs(b.count), commUs: b.count * perCollectiveUs(b.count),
        tauFloorBinds: perCollectiveUs(b.count) === TT.TAU_US})),
      note: 'the per-token collective count is the model\'s own basis; it does not vary with TP in the planning model (the K3 count is the detailed TP32 count)'
    },
    topOperators: {byComputeUs: top('computeUs'), byMemoryUs: top('memoryUs'), byBytes: top('bytes')}
  };
}

// ---- build -------------------------------------------------------------------------------------

function build(options = {}) {
  const ctx = options.context || context(options);
  const models = ctx.active.map(modelId => {
    const p = ctx.workload.provenance[modelId];
    // Shape-ambiguity alternatives are reported as a TPS range, exactly as the scorecard does.
    const variants = Object.keys(ctx.workload.variants[modelId] || {}).map(name => {
      const v = TT.planningModel(ctx.workload, modelId, name);
      const t = TT.slotTime(v, slot(32), ctx.workload.calibration);
      return {variant: name, tpsPerUserAtTP32: t.tpsPerUser, bound: t.bound};
    });
    return {
      model: modelId,
      status: p.status,
      shapeSource: p.shapeSource,
      dtypePolicy: ctx.workload.dtypePolicy[modelId],
      collectivesPerToken: ctx.workload.collectivesPerToken[modelId],
      layers: ctx.workload.layers[modelId],
      variants,
      slots: TPS_LIST.map(tp => slotSummary(ctx, modelId, tp))
    };
  });
  return {
    schemaVersion: SCHEMA_VERSION,
    status: 'MODEL (planning operator rows + planning token time); not a measurement',
    question: 'per token, how much FLOP and how many bytes each model moves per operator class, and which operators need compute versus bandwidth',
    generatedBy: KERNEL_FILE,
    kernel: {rows: 'integration/pipelines/generate_planning_operator_workload.js', timing: 'integration/planning/token_time.js'},
    inputs: {sourceArtifacts: ctx.sourceArtifacts,
      slot: {physicalProfile: PROFILE, mcProfile: MC_REFERENCE, calibration: `${WORKLOAD_FILE}#/calibration`}},
    target: ctx.target,
    blockedModels: ctx.blocked,
    definitions: {
      perTokenPerRank: 'global rows are divided by TP, as laneTimes does; the arithmetic intensity is TP-invariant',
      bound: 'compute when the row\'s FLOP/byte is at or above the core class\'s machine balance (peak x utilization x duty cycle / MC effective bytes per second); collective rows are classified by the network against tau',
      ratios: 'each ratio is one domain\'s own lane time as a fraction of the raw budget; they do not add up (raw = max(memory lane, serial lane))',
      intensityHistogram: 'buckets over FLOP/byte, with the operators in each bucket'
    },
    models,
    caveats: [
      'every number is MODEL: the operator rows are derived from the repository engineering preset and the public configs, the token-time factors are fitted on K3 only (ADR-0006)',
      'the collective count is stated on both bases the repository carries for K3 (reference-393, repo-510, ADR-0004); the other two models state only their ADR-0024 per-layer ASSUMPTION count',
      'software switches stay at the published OPT; no re-tuning happens here',
      'this file changes no baseline, contract, gate or published number'
    ]
  };
}

module.exports = {build, context, slotSummary, collectiveBases, histogram, row, RATIOS, INTENSITY_BUCKETS,
  BASELINE_FILE, WORKLOAD_FILE, PROFILES_FILE, OUT_FILE, SCHEMA_VERSION, TPS_LIST, PROFILE, MC_REFERENCE, BASELINE_MODEL};
