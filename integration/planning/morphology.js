'use strict';
/* L2 arch.direction: the morphology macro-parameters.
 *
 * A morphology is the published hardware point with its COARSE shape moved:
 *   * L/H 算力配比        -- (nL, nH) cores per die at the spec's engine shapes;
 *   * 片上 SRAM 总量与切分 -- (lMiB, hMiB) per-core local + sharedMiB per die;
 *   * MC 档位             -- the per-cube payload tier;
 *   * die 数              -- the package's compute dies;
 *   * TP                  -- the serving split.
 * Everything else (tensor shapes, banks, lane counts, tile sizes, prefetch depth)
 * stays at the published point: those are L3 degrees of freedom, and letting them
 * move here would make an L2 comparison a re-derivation of the whole design space.
 *
 * Two numbers per morphology, from two authorities that already exist:
 *   * area / power   -- integration/detailed/k3_architecture_search.js#physical(x, dies)
 *                       rescaled by k3_physical_basis.js#resize() to the SF4 liquid basis
 *                       the L1 contract's B-AREA is written on, plus the shared-port charge
 *                       (k3_rdma_final_tuning_model.js#chargeSharedPortCost) the contract carries;
 *   * TPS/usr        -- integration/planning/token_time.js#slotTime() with the morphology's
 *                       peaks and MC bandwidth CARRIED on the slot (ADR-0021: there is one
 *                       hardware spec, so a shape the spec does not enumerate is never given
 *                       a coreProfiles entry -- it travels on the slot for one evaluation).
 *
 * This module computes numbers only. It decides nothing: the D-Gate is
 * integration/governance/evaluate_gates.js, and the selection is stage_a.js's policy.
 */
const fs = require('fs');
const path = require('path');
const A = require('../detailed/k3_architecture_search');
const P = require('../detailed/k3_physical_basis');
const O = require('../detailed/k3_rdma_final_tuning_model');
const RES = require('../../teams/hardware/src/resource_profiles');
const TT = require('./token_time');

const root = path.resolve(__dirname, '../..');
const PUBLISHED_POINT_FILE = 'out/rdma/k3_rdma_final_tuning_results.json';
const PUBLISHED_POINT = '#/search/best/x';
const read = relativePath => JSON.parse(fs.readFileSync(path.join(root, relativePath), 'utf8').replace(/^﻿/, ''));

// The published point is the shape every axis is measured from. It is a generator
// artifact (search:final), and it is also what token_time.js's calibration cites --
// reading it here keeps one published point in the project instead of a second copy.
const PUBLISHED_X = (() => {
  const doc = read(PUBLISHED_POINT_FILE);
  const x = doc.search && doc.search.best && doc.search.best.x;
  if (!x) throw new Error(`${PUBLISHED_POINT_FILE}${PUBLISHED_POINT} is missing; run npm run search:final`);
  return x;
})();

// --- the axes ---------------------------------------------------------------------------

const MC_TIERS = Object.keys(RES.mcProfiles);
const TIER_GBS = Object.fromEntries(Object.entries(RES.mcProfiles).map(([id, mc]) => [id, mc.payloadGBsPerCube]));
const DIES = [4, 6, 8];
const TPS = [8, 16, 32];
// (nL, nH) at the spec's engine shapes. P1's own ratio is the reference.
const LH_RATIOS = [[8, 4], [4, 4], [12, 4], [16, 4], [8, 8], [8, 12], [8, 16]];
// (lMiB per L core, hMiB per H core).
const LOCAL_SRAM = [[1, 4], [2, 4], [4, 4], [1, 2], [1, 8]];
const SHARED_MIB = [8, 12, 16, 20, 24, 32];

const BASELINE_X = PUBLISHED_X;

// --- the published point must still be P1, or every number below is measured from
// --- the wrong origin. The spec is the authority; this is the guard that says so.
(() => {
  const peaks = diePeaks(BASELINE_X, A.LIMITS.dies);
  for (const coreClass of ['L', 'H', 'V', 'INDEXER', 'REDUCE']) {
    const spec = RES.coreProfiles.P1.peakByCore[coreClass];
    if (Math.abs(peaks.peakByCore[coreClass] - spec) > 1e-6 * spec) {
      throw new Error(`the published point's ${coreClass} peak (${peaks.peakByCore[coreClass]}) is not P1's (${spec}): ${PUBLISHED_POINT_FILE}${PUBLISHED_POINT} is not the shape teams/hardware/src/resource_profiles.js describes. Rerun npm run search:final (ADR-0021: one hardware spec)`);
    }
  }
  const mc640 = RES.mcProfiles.MC640.effectiveBytesPerSecond;
  if (Math.abs(peaks.memoryBytesPerSecond - mc640) > 1e-9 * mc640) {
    throw new Error(`the published point at MC640 carries ${peaks.memoryBytesPerSecond} B/s, not the spec's ${mc640}: the MC derivation has drifted from teams/hardware/inputs/k3_mc_baseline.json`);
  }
})();

// --- hardware point of a shape ----------------------------------------------------------

// physical() gives PER-DIE peaks; the planning slot wants the package's. Sixteen
// MC cubes per 8-die package is the spec's own count (card.memoryCubesPerComputeDie),
// so the tier scales with the die count rather than being pinned at the published 8.
// `mcTier` names which bandwidth tier is being costed: both tiers share the spec's
// sustainedEfficiency, but the tier is read rather than assumed so a future tier with
// its own efficiency does not silently inherit MC640's.
function diePeaks(x, dies, mcTier = 'MC640') {
  const physical = A.physical(x, dies);
  // The detailed model's own area: the SF4/liquid resize plus the shared-port charge
  // O.mapped() adds (MODEL, O-007). The L1 contract's B-AREA is written on the
  // port-charged figure, so a shape scored without it would sit ~8 mm2 under its own contract.
  const ports = O.sharedPortScaling(dies * physical.sharedRead, dies * physical.sharedWrite);
  const resized = O.OPT.chargeSharedPortCost
    ? O.chargeSharedPortCost(P.resize(physical, P.BASIS, dies), x, ports.extraCardTBs, dies)
    : P.resize(physical, P.BASIS, dies);
  const peak = {L: physical.lTF, H: physical.hTF, V: physical.vectorTOP};
  const byCore = {
    L: peak.L * dies * 1e12,
    H: peak.H * dies * 1e12,
    V: peak.V * dies * 1e12,
    // Same mapping as teams/hardware/src/resource_profiles.js: the lightning indexer
    // scores on the H tensor engines; REDUCE has no dedicated unit and rides the lanes.
    INDEXER: peak.H * dies * 1e12,
    REDUCE: peak.V * dies * 1e12
  };
  const sustained = RES.mcProfiles[mcTier].sustainedAssumption;
  const cubes = dies * A.LIMITS.mcCountPerDie;
  return {
    physical,
    resized,
    peakByCore: byCore,
    cubes,
    rawPayloadTBs: cubes * x.mcGBs / 1000,
    sustainedFraction: sustained,
    memoryBytesPerSecond: cubes * x.mcGBs / 1000 * 1e12 * sustained
  };
}

function shape(overrides = {}) {
  return {
    lhRatio: [BASELINE_X.nL, BASELINE_X.nH],
    localSram: [BASELINE_X.lMiB, BASELINE_X.hMiB],
    sharedMiB: BASELINE_X.sharedMiB,
    mcTier: 'MC640',
    tp: 32,
    dies: A.LIMITS.dies,
    ...overrides
  };
}

function xOf(shape) {
  const [nL, nH] = shape.lhRatio;
  const [lMiB, hMiB] = shape.localSram;
  return {...BASELINE_X, nL, nH, lMiB, hMiB, sharedMiB: shape.sharedMiB, mcGBs: TIER_GBS[shape.mcTier]};
}

// Axes that are NOT at the published point. The id carries exactly these, so the
// published shape keeps its published id and only a deviation gets a tag.
function deviations(shape) {
  const out = [];
  const [nL, nH] = shape.lhRatio;
  const [lMiB, hMiB] = shape.localSram;
  if (nL !== BASELINE_X.nL || nH !== BASELINE_X.nH) out.push(`N${nL}x${nH}`);
  if (lMiB !== BASELINE_X.lMiB || hMiB !== BASELINE_X.hMiB || shape.sharedMiB !== BASELINE_X.sharedMiB) out.push(`L${lMiB}H${hMiB}S${shape.sharedMiB}`);
  if (shape.dies !== A.LIMITS.dies) out.push(`D${shape.dies}`);
  return out;
}

// The tag sits between the profile id and the MC tier, which is what keeps all three
// parsers in teams/hardware/src/resource_profiles.js working on a tagged id:
// physicalProfileOf (startsWith 'P1-compact'), mcProfileOf (includes 'MC640') and
// tpOf (/TP(\d+)$/). stage_b.js reads all three.
function morphologyId(shape) {
  const tag = deviations(shape);
  return [RES.coreProfiles.P1.id, ...tag, shape.mcTier, `TP${shape.tp}`].join('-');
}

// --- the enumerated space ---------------------------------------------------------------

// The grid: the published shape at every MC tier and TP. These are the ids that existed
// before the morphology axis, and they keep their meaning -- "the published P1 shape at
// this tier and TP" -- so nothing downstream that names one starts naming something else.
function grid() {
  const out = [];
  for (const mcTier of MC_TIERS) {
    for (const tp of TPS) out.push(shape({mcTier, tp}));
  }
  return out;
}

// One axis moved at a time off the published shape, at the contract's own scope
// (TP32, MC640 unless the tier IS the axis). A star, not a cartesian: the L2 question
// is which shape can hold the contract and where each one falls short, and a star
// answers that per axis with a bounded number of candidates. The one coupling the L1
// contract names by hand -- SRAM window against MC bandwidth -- gets its two off-diagonal
// points so the substitution rate is visible instead of assumed.
function deviationsFromPublished() {
  const out = [];
  for (const lhRatio of LH_RATIOS) {
    if (lhRatio[0] === BASELINE_X.nL && lhRatio[1] === BASELINE_X.nH) continue;
    out.push(shape({lhRatio}));
  }
  for (const sharedMiB of SHARED_MIB) {
    if (sharedMiB === BASELINE_X.sharedMiB) continue;
    out.push(shape({sharedMiB}));
  }
  for (const localSram of LOCAL_SRAM) {
    if (localSram[0] === BASELINE_X.lMiB && localSram[1] === BASELINE_X.hMiB) continue;
    out.push(shape({localSram}));
  }
  for (const dies of DIES) {
    if (dies === A.LIMITS.dies) continue;
    out.push(shape({dies}));
  }
  for (const mcTier of MC_TIERS) {
    if (mcTier === 'MC640') continue;
    for (const sharedMiB of [8, 24]) out.push(shape({mcTier, sharedMiB}));
  }
  return out;
}

function enumerate() {
  return [...grid(), ...deviationsFromPublished()].map(s => ({...s, morphologyId: morphologyId(s)}));
}

// --- scoring ----------------------------------------------------------------------------

// The contract entry a morphology is checked against, and the shortfall when it misses.
// `requirement` is copied from the contract so a reader never has to hold two numbers.
function check(entry, value, shortfall, note) {
  const bound = entry.min !== undefined ? entry.min : entry.max;
  const satisfied = entry.min !== undefined ? value >= bound : value <= bound;
  return {
    id: entry.id,
    quantity: entry.quantity,
    requirement: entry.min !== undefined ? {min: entry.min} : {max: entry.max},
    value,
    satisfied,
    shortfall: satisfied ? 0 : shortfall,
    note
  };
}

// One morphology, scored: hardware point, per-model TPS, and the L1 contract entry by entry.
// `models` is {modelId: planningModel}; `baselineComputeUs` is that model's compute lane at
// the published peaks (the contract's computeScale is measured against P1).
function evaluate(item, {models, calibration, contract}) {
  const x = xOf(item);
  const hw = diePeaks(x, item.dies, item.mcTier);
  const slot = {
    tp: item.tp,
    physicalProfile: 'P1',
    peakByCore: hw.peakByCore,
    memoryBytesPerSecond: hw.memoryBytesPerSecond
  };
  // The baseline is the published P1 point by profile id -- exactly how stage_a's grid names it --
  // so this ratio is "this shape's compute vs the shape the contract's reference is written on".
  const baselineSlot = {tp: item.tp, physicalProfile: 'P1', mcProfile: 'MC640'};

  const perModel = {};
  for (const [modelId, model] of Object.entries(models)) {
    const t = TT.slotTime(model, slot, calibration);
    const baselineComputeUs = TT.laneTimes(model, baselineSlot).computeUs;
    const computeUs = TT.laneTimes(model, slot).computeUs;
    perModel[modelId] = {
      tpsPerUser: t.tpsPerUser,
      bound: t.bound,
      memoryLaneUs: t.memoryLaneUs,
      serialLaneUs: t.serialLaneUs,
      computeUs,
      baselineComputeUs,
      // B-SERIAL-CMP's quantity is a scaling factor against P1's own compute: the contract's point
      // is 0.7445 and its reference is "P1 peaks ... = 1". So this is new/baseline, and the entry's
      // min is a FLOOR on how far a shape is allowed to trade compute away.
      computeScale: baselineComputeUs / computeUs
    };
  }
  const comparable = Object.values(perModel);
  const minTpsPerUser = Math.min(...comparable.map(r => r.tpsPerUser));
  const worstModel = Object.entries(perModel).find(([, r]) => r.tpsPerUser === minTpsPerUser)[0];
  // The contract states one floor, so the binding case is the model whose shape-relative compute is
  // weakest -- a shape that clears the floor for K3 but not for DeepSeek-V4-Pro does not clear it.
  const computeScale = Math.min(...comparable.map(r => r.computeScale));

  const entry = id => contract.split.find(e => e.id === id);
  const r = hw.resized;
  const limits = entry('B-AREA').limits;
  const localMiBPerDie = item.lhRatio[0] * item.localSram[0] + item.lhRatio[1] * item.localSram[1];
  const checks = [
    check(entry('B-MEM-BW'), x.mcGBs, entry('B-MEM-BW').min - x.mcGBs,
      `${hw.cubes} cubes x ${x.mcGBs} GB/s/cube = ${hw.rawPayloadTBs} TB/s raw, ${hw.sustainedFraction} sustained = ${hw.memoryBytesPerSecond} B/s`),
    check(entry('B-SERIAL-CMP'), computeScale, entry('B-SERIAL-CMP').min - computeScale,
      `vs P1 peaks, worst model ${worstModel}; the shape may compute ${computeScale}x faster`),
    check(entry('B-TAU'), TT.TAU_US, TT.TAU_US - entry('B-TAU').max,
      'not a morphology axis: tau is the spec basis (tauBasis.tauUs), carried unchanged'),
    // L2 refines B-SRAM-CAP into the two things it always was: local per-die and shared per-die.
    // The contract's own minimum is on the SHARED half; local is reported so the refinement has both.
    check(entry('B-SRAM-CAP'), item.sharedMiB, entry('B-SRAM-CAP').min - item.sharedMiB,
      `depth ${entry('B-SRAM-CAP').depth} window; ${item.sharedMiB} MiB shared per die against the contract's ${entry('B-SRAM-CAP').min}`),
    check(entry('B-AREA'), r.dieArea, r.dieArea - limits.dieAreaMm2,
      `SF4/liquid basis; die power ${r.diePower} W, card power ${r.cardPower} W, package ${r.packageArea} mm2`)
  ];
  const areaLimits = {
    dieAreaMm2: {value: r.dieArea, max: limits.dieAreaMm2, satisfied: r.dieArea <= limits.dieAreaMm2},
    diePowerW: {value: r.diePower, max: limits.diePowerW, satisfied: r.diePower <= limits.diePowerW},
    cardPowerW: {value: r.cardPower, max: limits.cardPowerW, satisfied: r.cardPower <= limits.cardPowerW},
    packageAreaMm2: {value: r.packageArea, max: P.BASIS.limits.packageArea, satisfied: r.packageArea <= P.BASIS.limits.packageArea}
  };

  return {
    morphologyId: item.morphologyId,
    axes: {
      lhRatio: item.lhRatio,
      lCoresPerDie: item.lhRatio[0],
      hCoresPerDie: item.lhRatio[1],
      localMiBPerDie: item.localSram,
      localMiBPerDieTotal: localMiBPerDie,
      sharedMiBPerDie: item.sharedMiB,
      totalSramMiBPerDie: localMiBPerDie + item.sharedMiB,
      mcTier: item.mcTier,
      mcGBsPerCube: x.mcGBs,
      dies: item.dies,
      tp: item.tp
    },
    hardware: {
      peakByCore: hw.peakByCore,
      tfPerDie: hw.physical.lTF + hw.physical.hTF,
      vectorTopPerDie: hw.physical.vectorTOP,
      cubes: hw.cubes,
      memoryBytesPerSecond: hw.memoryBytesPerSecond
    },
    physical: {
      dieAreaMm2: r.dieArea,
      diePowerW: r.diePower,
      cardPowerW: r.cardPower,
      packageAreaMm2: r.packageArea,
      basis: P.BASIS.process,
      cooling: P.BASIS.cooling,
      feasible: r.feasible,
      reasons: r.reasons,
      limits: areaLimits
    },
    tpsPerModel: perModel,
    minTpsPerUser,
    worstModel,
    meetsTarget: minTpsPerUser >= contract.target.tpsPerUser,
    meetsArchitectureGate: minTpsPerUser >= contract.target.architectureGate,
    checks,
    misses: checks.filter(c => !c.satisfied).map(c => ({id: c.id, shortfall: c.shortfall}))
  };
}

module.exports = {
  PUBLISHED_POINT_FILE, PUBLISHED_POINT, MC_TIERS, TIER_GBS, DIES, TPS, LH_RATIOS, LOCAL_SRAM, SHARED_MIB,
  BASELINE_X, shape, xOf, morphologyId, deviations, enumerate, diePeaks, evaluate
};
