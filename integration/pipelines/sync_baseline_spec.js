'use strict';
/* Sync the machine-readable P1 baseline from the Final Tuning results.
 *
 * Hand-copied performance numbers drift. This script rewrites ONLY the
 * model-derived fields of teams/hardware/inputs/k3_mc_baseline.json
 * (computeDieCandidate, modelResults, collectiveCount, tauBasis, sramAccounting,
 * acceptance.reason, tpsDesign, designPoint) and
 * the K3 calibration block of out/direction/directional_workload_baseline.json
 * from out/rdma/k3_rdma_final_tuning_results.json. Human-authored fields
 * (goal, architectureRoute, referenceMemoryCube, bandwidthTiers, tilePlan,
 * card) are preserved.
 *
 * The point (doc 23 §7.3, "设计点接线"). `--point published` (the default) syncs from the search
 * best at the model's own OPT and model and writes no designPoint block, as before. `--point joint
 * --adr <ADR file>` syncs from the landed joint point (out/coupling/joint_point.json, resolved and
 * verified by design_point.js): every field below is replayed inside coupling_search.withPoint with
 * the point's OPT patch and model patch, the die area counts the option overheads and the Comm Core
 * as the joint replay does, and the baseline records the point in `designPoint` -- after which
 * design_point.js finds no departures and design.converge no longer stops on it. The ADR must name
 * the point's optionId and sha256: moving the baseline is a decision, not a side effect of a landed
 * file. Modules that replay tpsDesign.hardware.x without the patch stop on a patched baseline
 * (integration/detailed/baseline_point.js) until they are wired to it.
 *
 * Run after `npm run search:final`: node integration/pipelines/sync_baseline_spec.js [--point published|joint --adr <file>]
 */
const fs = require('fs');
const path = require('path');
const root = path.resolve(__dirname, '../..');
const read = p => JSON.parse(fs.readFileSync(path.join(root, p), 'utf8').replace(/^﻿/, ''));
const write = (p, v) => fs.writeFileSync(path.join(root, p), `${JSON.stringify(v, null, 2)}\n`, 'utf8');
const O = require('../detailed/k3_rdma_final_tuning_model.js');
const A = require('../detailed/k3_architecture_search.js');
const P = require('../detailed/k3_physical_basis.js');
const T = require('../detailed/k3_tps_design_baseline.js');
const C = require('../detailed/coupling_search.js');

const BASELINE_FILE = 'teams/hardware/inputs/k3_mc_baseline.json';
const DIRECTIONAL_FILE = 'out/direction/directional_workload_baseline.json';
const RESULTS_FILE = 'out/rdma/k3_rdma_final_tuning_results.json';
const ADR_DIR = 'teams/council/adr/';

// The joint point to sync from: a resolved joint point (design_point.js) and the ADR that moves
// the baseline onto it, which must cite the point's optionId and sha256.
function jointPoint(joint, adr) {
  if (!joint || joint.kind !== 'joint') throw new Error('--point joint needs a resolved joint point (design_point.js)');
  if (!adr || !adr.file || !adr.file.startsWith(ADR_DIR)) throw new Error(`--point joint needs --adr <file under ${ADR_DIR}>`);
  const missing = [joint.optionId, joint.sha256].filter(s => !adr.text.includes(s));
  if (missing.length) throw new Error(`${adr.file} does not name the joint point (${missing.join(', ')}); the ADR must cite its optionId and sha256`);
  return {kind: 'joint', source: joint.source, optionId: joint.optionId, sha256: joint.sha256, adr: adr.file,
    x: joint.x, opt: joint.opt, model: joint.model};
}

// Die area as the joint replay counts it (coupling_search.replay): the detailed model's die plus
// the option overheads and the Comm Core, none of which A.physical() sizes. At the published point
// there is no model patch and the area is the model's own.
const extraArea = (p, model) => (model ? model.matrixAreaOverhead * p.area.matrix + model.vectorAreaOverhead * p.area.vector + model.commCoreAreaMm2 : 0);

// The baseline and the directional workload baseline at `point`, derived from the parsed inputs
// without writing anything (the test runs it at an injected joint point).
function build({spec, baseline, results, point = {kind: 'published'}}) {
  spec = JSON.parse(JSON.stringify(spec));
  baseline = JSON.parse(JSON.stringify(baseline));
  const best = results.search.best;
  // The results file must replay at its own point whichever point the baseline is synced from:
  // a stale results file is stale either way.
  const replayBest = O.evaluate(best.x);
  if (!replayBest.feasible || Math.abs(replayBest.tps - best.tps) > 1e-7) throw new Error('stored best does not replay from the current model; rerun npm run search:final');
  const joint = point.kind === 'joint';
  const derive = () => fields({spec, baseline, results, x: joint ? point.x : best.x, model: joint ? point.model : null,
    source: joint ? `${point.source} (${point.optionId}, ${point.adr})` : RESULTS_FILE});
  if (joint) {
    C.withPoint({opt: point.opt, model: point.model}, derive);
    spec.designPoint = {kind: 'joint', source: point.source, optionId: point.optionId, sha256: point.sha256, adr: point.adr,
      opt: point.opt, model: point.model,
      note: 'The baseline is this joint point, moved by the ADR. tpsDesign.hardware.x is its x, and every model-derived field was replayed with this OPT patch and model patch (coupling_search.withPoint); estimatedAreaMm2 includes optionAreaMm2. Modules that replay tpsDesign.hardware.x without the patch stop on it (integration/detailed/baseline_point.js).'};
  } else {
    derive();
    delete spec.designPoint;
  }
  return {spec, baseline};
}

// Every model-derived field, replayed at x under whatever OPT and model are in force.
function fields({spec, baseline, results, x, model, source}) {
  const reference = O.evaluate({...x, mcGBs: 320});
  const stretch = O.evaluate({...x, mcGBs: 640});
  const replay = O.evaluate(x);
  if (!reference.feasible || !stretch.feasible) throw new Error('the synced point must be feasible at MC320 and MC640');
  if (!replay.feasible) throw new Error('the synced point does not replay from the current model');
  if (x.mcGBs !== 640) console.warn(`warning: the synced point uses mcGBs=${x.mcGBs}; the MC640 point below is a replay, not the searched optimum`);

  const D = A.LIMITS.dies;
  const optionArea = extraArea(stretch.p, model);
  spec.version = results.version;
  spec.status = 'planning-baseline (P1 compact executable profile; generated by integration/pipelines/sync_baseline_spec.js)';
  spec.computeDieCandidate = {
    profile: 'P1-compact-executable',
    frequencyGHz: x.ghz,
    lCores: x.nL,
    hCores: x.nH,
    lCore: {tensorEngines: x.lEngines, tensorShape: [x.lRows, x.lCols], vectorLanes: x.vectorLanes, localSramMiB: x.lMiB, tmaEngines: x.tmaEngines, tmaBytesPerCyclePerEngine: x.tmaBytes},
    hCore: {tensorEngines: x.hEngines, tensorShape: [x.hRows, x.hCols], vectorLanes: x.vectorLanes, localSramMiB: x.hMiB, tmaEngines: x.tmaEngines, tmaBytesPerCyclePerEngine: x.tmaBytes},
    sharedSramMiB: x.sharedMiB,
    sharedSramSlices: x.sharedSlices,
    physicalDataSramMiB: stretch.p.totalMiB,
    dataNocBytesPerCyclePerDirection: x.nocBytes,
    abstractNocMesh: [stretch.p.meshSide, stretch.p.meshSide],
    reduceLanes: x.reduceLanes,
    bf16DenseTflops: stretch.p.lTF + stretch.p.hTF,
    vectorTops: stretch.p.vectorTOP,
    estimatedAreaMm2: stretch.p.dieArea + optionArea,
    ...(model ? {optionAreaMm2: {matrixOverhead: model.matrixAreaOverhead * stretch.p.area.matrix, vectorOverhead: model.vectorAreaOverhead * stretch.p.area.vector, commCore: model.commCoreAreaMm2,
      note: 'counted in estimatedAreaMm2 as the joint replay counts it; not sized by A.physical(), so not in the detailed model die check'}} : {}),
    estimatedPowerW: stretch.p.diePower,
    estimatedCardPowerW: stretch.p.cardPower,
    sharedPortScalingCost: stretch.p.sharedPortCost || null,
    physicalBasis: {process: P.BASIS.process, areaScale: {...P.PROCESS[P.BASIS.process]}, matrixTFPerMm2: P.BASIS.matrixTFPerMm2, cooling: P.BASIS.cooling, limits: {...P.BASIS.limits}, source: 'integration/detailed/k3_physical_basis.js', note: 'area scaled from the N4-ref TECH coefficients; power, frequency and bandwidth coefficients unchanged; all ASSUMPTION (B-006)'},
    note: 'Area is estimated on the physical basis above. Area and power include the charged shared-SRAM port scaling cost (Final Tuning OPT.chargeSharedPortCost). All coefficients are analytical assumptions pending synthesis/floorplan/IP back-annotation.'
  };
  // prefetchDepth (1) was a hand-authored leftover; the searched lookahead is optimizedOverlapDepth.
  const {prefetchDepth: _staleDepth, ...tilePlanRest} = spec.tilePlan || {};
  spec.tilePlan = {
    ...tilePlanRest,
    weightTileMiB: x.weightTileMiB,
    kvTileTokens: x.kvTile,
    kvCacheFormat: O.OPT.kvCache,
    headTile: x.headTile,
    optimizedOverlapDepth: x.depth,
    rdmaStripeKiB: O.OPT.stripeKiB,
    partialReadyThresholds: {attention: O.OPT.partialThresholdAttention, lse: O.OPT.partialThresholdLSE, router: O.OPT.partialThresholdRouter}
  };
  const point = r => ({
    tpsPerUser: r.tps,
    rawLatencyUs: r.rawUs,
    e2eLatencyUs: r.e2eUs,
    computeUs: r.computeUs,
    commUs: r.commUs,
    dmaWaitUs: r.waitUs,
    commOverlapUs: r.overlapUs,
    tmaFillUs: r.tmaFillUs,
    tmaHiddenUs: r.tmaHiddenUs,
    readBytesPerRankPerToken: r.readBytes,
    effectiveDmaTBsPerCard: r.dmaTBs
  });
  spec.modelResults = {
    profile: 'P1-compact-executable',
    source,
    referenceMc320GBs: point(reference),
    stretchMc640GBs: point(stretch)
  };

  // Collective counting basis. This is a COUNTING choice, not a physical
  // optimization: under 'reference-393' the Q/new-KV all-gather and the sampling
  // broadcast stay in the DAG as local ops instead of network traffic. Reporting
  // a higher TPS on this basis must not be read as a gain.
  const byPhase = {};
  for (const a of replay.protocol) byPhase[a.name] = a.count;
  const collectiveTotal = replay.protocol.reduce((s, a) => s + a.count, 0);
  spec.collectiveCount = {
    total: collectiveTotal,
    byPhase,
    countBasis: O.OPT.countBasis,
    referencePageTotal: 393,
    repoBaselineTotal: 510,
    referencePageSource: 'references/k3_1000tps_chip_designs.html:1720',
    reconciliation: 'teams/software/docs/COLLECTIVE_SCHEDULE.md#11-与-repo-510-的差额',
    status: 'accepted 2026-09-25 (B-007); the folded reduction follows the shared-expert compute',
    note: 'The 510->393 difference is 92 folded shared-output reductions plus 24 Q/new-KV all-gathers and 1 sampling broadcast that the reference page does not count; it is not a measured speedup.'
  };

  // tau basis. This path once carried several inconsistent per-collective
  // latency defaults. Since 2026-09-25 the published point floors
  // every collective at OPT.tauUs (the spec 1.15 us). The ceiling is analytic
  // because the simulator asserts raw = compute - tmaHidden + comm + wait - overlap and COMM shares
  // the compute slot, except for the data-independent shared experts that run
  // under a collective (OPT.commOverlap) and the shared->local fills on the TMA
  // lanes (OPT.tmaLane); both are subtracted at their observed values.
  const observedNsPerCollective = collectiveTotal ? (replay.commUs * 1000) / collectiveTotal : null;
  const specTauUs = 1.15;
  if (O.OPT.tauUs !== specTauUs) throw new Error(`OPT.tauUs ${O.OPT.tauUs} differs from the spec tau ${specTauUs}`);
  const ceiling = N => 1e6 / ((replay.computeUs - replay.tmaHiddenUs + N * specTauUs - replay.overlapUs) * spec.goal.engineeringMargin);
  spec.tauBasis = {
    publishedBasis: 'floor at OPT.tauUs (decision 2026-09-25)',
    tauUs: O.OPT.tauUs,
    oneWayUs: O.OPT.oneWayUs,
    observedNsPerCollective,
    specNsPerCollective: specTauUs * 1000,
    ratioToSpec: observedNsPerCollective ? (specTauUs * 1000) / observedNsPerCollective : null,
    sourcesInRepo: {
      'integration/detailed/k3_operator_sram_sim.js#tauUs': 1.15,
      'integration/detailed/k3_sram_memory_rdma_model.js#MEM.oneWayUs': 0.10,
      'integration/detailed/k3_rdma_final_tuning_model.js#OPT.tauUs (published floor)': O.OPT.tauUs,
      'integration/detailed/k3_rdma_final_tuning_model.js#OPT.oneWayUs': O.OPT.oneWayUs
    },
    ceilingTpsByCount: Object.fromEntries([510, 485, 393, 301, 209].map(n => [n, ceiling(n)])),
    overlapUs: replay.overlapUs,
    tmaHiddenUs: replay.tmaHiddenUs,
    note: 'ceiling(N) = 1e6 / ((computeUs - tmaHiddenUs + N x 1.15us - overlapUs) x 1.17), analytic given the simulator conservation identity raw = compute - tmaHidden + comm + wait - overlap, with DMA wait taken as zero; overlapUs is the shared-expert compute hidden under collectives and tmaHiddenUs the shared->local fills hidden on the TMA lanes, both held at their observed values (fewer collectives leave less time to hide fills under, so the ceiling is optimistic). The published point uses the spec tau as a per-collective floor; after the 2026-09-25 attention/small-op mapping (layer PV merge, softmax and epilogue fusion) the 393 ceiling is above 1000 TPS, so the remaining margin is DMA wait, not the collective count.',
    blocker: 'B-008 (tau basis unified at 1.15 us on 2026-09-25; physical derivation still depends on B-004/B-005)',
    adr: 'teams/council/adr/ADR-0004-collective-tau-basis-and-count-basis.md'
  };
  spec.sramAccounting = {
    physicalMiBPerDie: stretch.p.totalMiB,
    physicalMiBPerCard: stretch.p.totalMiB * D,
    sharedPhysicalMiBPerCard: x.sharedMiB * D,
    sharedUsableWindowMiBPerCard: stretch.sramMiB,
    simulatedPeakReservedMiBPerCard: stretch.peakReservedMiB,
    note: 'The simulator peak and window are card-aggregate shared-SRAM values, not per-die values. Per-core local SRAM is accounted separately by tile-fit constraints.'
  };
  spec.acceptance = {
    ...spec.acceptance,
    architectureGateTpsPerUser: 1050,
    currentStatus: stretch.tps >= spec.goal.target ? 'target-met-in-model-only' : 'not-met',
    architectureGateStatus: 'not-met (engineering model; gate requires the selected manufacturable MC route in the detailed tile model)',
    reason: `The best stretch-MC candidate is ${stretch.tps.toFixed(2)} TPS/usr and the reference-compatible 320 GB/s MC point is about ${reference.tps.toFixed(2)} TPS/usr (single hardware spec P1, engineering model).`
  };
  // TPS/usr design baseline (docs/architecture/21_TPS_DESIGN_BASELINE.md, ADR-0005).
  spec.tpsDesign = T.build(x, spec.goal.rawLatencyBudgetUs);

  // Directional workload baseline: the K3 calibration block mirrors the MC320 point.
  const k3 = baseline.models.find(m => m.modelId === 'K3');
  // FLOP/token is the detailed plan's own operator FLOP (absorbed MLA attention,
  // the same count the tile simulator times), summed over the TP ranks.
  const planOps = O.mapped(x).plan.ops;
  const opFlops = unit => planOps.filter(o => unit ? o.unit === unit : true).reduce((a, o) => a + (o.flops || 0), 0) * spec.goal.tpCards;
  k3.globalFlopsPerToken = opFlops();
  k3.globalMemoryBytesPerToken = reference.readBytes * spec.goal.tpCards;
  k3.collectiveReference = {...k3.collectiveReference, tp: spec.goal.tpCards, latencyUsPerToken: reference.commUs};
  k3.calibration = {
    observedTp: spec.goal.tpCards,
    observedReadBytesPerRank: reference.readBytes,
    observedRawLatencyUs: reference.rawUs,
    observedE2eLatencyUs: reference.e2eUs,
    observedTpsPerUser: reference.tps,
    source: model ? `${source}, MC320 replay` : `${RESULTS_FILE} (MC320 replay of search.best)`,
    flopDerivation: `sum of operator FLOP in O.mapped(${model ? 'the synced point x' : 'search.best.x'}).plan x TP${spec.goal.tpCards}: L ${(opFlops('L') / 1e12).toFixed(6)}T, H ${(opFlops('H') / 1e12).toFixed(6)}T (absorbed-MLA QK/PV over the full context), V ${(opFlops('V') / 1e12).toFixed(6)}T`
  };
  k3.limitations = [
    'TP8 and TP16 byte scaling is directional, not observed.',
    'Operator-level byte reuse and overlap are deferred to Stage B.'
  ];
  baseline.asOf = results.version.slice(0, 10);
  return {reference, stretch};
}

function parseArgs(argv) {
  const flags = {point: 'published', adr: null};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--point') flags.point = argv[++i];
    else if (argv[i] === '--adr') flags.adr = argv[++i];
    else throw new Error(`unknown argument ${argv[i]}`);
  }
  if (!['published', 'joint'].includes(flags.point)) throw new Error(`--point must be published or joint, not ${flags.point}`);
  if (flags.point === 'published' && flags.adr) throw new Error('--adr only applies to --point joint');
  return flags;
}

function main(argv) {
  const flags = parseArgs(argv);
  let point = {kind: 'published'};
  if (flags.point === 'joint') {
    // Loaded here, not at the top: design_point.js loads the domain searches, which read the
    // baseline this script is about to rewrite.
    const DP = require('./design_point.js');
    const adr = flags.adr && {file: flags.adr.replace(/\\/g, '/'), text: fs.existsSync(path.join(root, flags.adr)) ? fs.readFileSync(path.join(root, flags.adr), 'utf8') : ''};
    if (adr && !adr.text) throw new Error(`${flags.adr} is missing or empty`);
    point = jointPoint(DP.resolve({point: 'joint'}), adr);
  }
  const {spec, baseline} = build({spec: read(BASELINE_FILE), baseline: read(DIRECTIONAL_FILE), results: read(RESULTS_FILE), point});
  write(BASELINE_FILE, spec);
  write(DIRECTIONAL_FILE, baseline);
  const k3 = baseline.models.find(m => m.modelId === 'K3');
  const mr = spec.modelResults, cd = spec.computeDieCandidate;
  console.log(JSON.stringify({
    version: spec.version,
    point: spec.designPoint ? {kind: 'joint', optionId: spec.designPoint.optionId, adr: spec.designPoint.adr} : {kind: 'published'},
    mc320: {tps: mr.referenceMc320GBs.tpsPerUser, rawUs: mr.referenceMc320GBs.rawLatencyUs},
    mc640: {tps: mr.stretchMc640GBs.tpsPerUser, rawUs: mr.stretchMc640GBs.rawLatencyUs},
    dieAreaMm2: cd.estimatedAreaMm2, diePowerW: cd.estimatedPowerW, cardPowerW: cd.estimatedCardPowerW,
    globalMemoryBytesPerToken: k3.globalMemoryBytesPerToken
  }, null, 2));
}

if (require.main === module) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}

module.exports = {BASELINE_FILE, DIRECTIONAL_FILE, RESULTS_FILE, ADR_DIR, build, jointPoint, parseArgs};
