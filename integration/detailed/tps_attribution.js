'use strict';
/* TPS/usr attribution cards, one per design dimension (MODEL).
 *
 * Question (teams/council/docs/23_DESIGN_QUESTION_WORKFLOW_PROPOSAL.md, L4): at one design point,
 * how does each parameter of a dimension (on-die SRAM, collectives, ...) move the final TPS/usr,
 * what does it cost in area and power, where does it break the raw budget, and which parameters
 * the budget actually rests on.
 *
 * Method (all through the production model, O.evaluate and the replay helpers of
 * k3_tps_design_baseline.js; nothing is re-implemented):
 *   1. every parameter is moved alone: hardware and mapping fields one step on a neighbour list,
 *      software mechanisms switched back, unmeasured assumptions over their sweep values;
 *   2. each move is replayed nominally and under the joint pessimistic point (allUnmeasured), and
 *      reported as dTps, dRawUs, d area / power and dTps per mm2 / per W;
 *   3. break-even by bisection where the parameter is continuous (B.breakEven), and what stops the
 *      point just past it: the raw budget, or a hard constraint (breakEvenBy);
 *   4. the critical-path lines the dimension owns, as a share of raw;
 *   5. the dimension's own pessimistic values replayed together;
 *   6. a mechanical classification of every parameter from its adverse moves (CLASSES below);
 *   7. couplings: named pairs of moves replayed alone and together, where one row alone cannot say
 *      which parameter carries a cost (two rows on the same wall, a mechanism held at its published
 *      value while another moves). Reported, not classified.
 * The `joint` card instead takes the joint pessimistic point apart: each unmeasured value alone,
 * left out, and grouped by the dimension that owns it.
 *
 * A card is input to design.attribution; agents read it and may not change a number in it.
 * It changes no baseline, gate or published number. Its design point is the one
 * integration/pipelines/design_point.js resolves (the joint point once design.coupling has landed
 * one, the published point before), recorded in inputs.point.
 */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const A = require('./k3_architecture_search.js');
const O = require('./k3_rdma_final_tuning_model.js');
const B = require('./k3_tps_design_baseline.js');
const C = require('./coupling_search.js');
const BP = require('./baseline_point.js');

const root = path.resolve(__dirname, '../..');
const BASELINE_FILE = 'teams/hardware/inputs/k3_mc_baseline.json';
const OUT_DIR = 'out/attribution';
const SCHEMA_VERSION = 'attribution-card-v0.1';
const DEFAULT_DIMENSIONS = ['sram', 'comm', 'joint'];
// A move that changes TPS by less than this is "no effect" for the classification.
const SLACK_TPS = 1;
const EPS = 1e-9;
const STRESS = B.JOINT_PESSIMISTIC.allUnmeasured;

// Mechanical, from the adverse moves only (less hardware, a mechanism switched back, an
// assumption on its pessimistic side). Whether a break-even is physically plausible is NOT
// decided here; that is the domain expert's call in design.attribution.
const CLASSES = {
  loadBearing: 'an adverse move breaks the raw budget or makes the point infeasible (bearsBy says which); infeasible mappings and model errors are not counted',
  slack: 'every adverse move costs < 1 TPS/usr and at least one frees die area or power',
  insensitive: 'every adverse move costs < 1 TPS/usr and none frees area or power',
  graded: 'adverse moves cost TPS but the budget holds',
  basis: 'a counting basis (ADR-0004), not a design choice; reported, not classified',
  untested: 'no adverse move on the list (the published value is the lowest step)'
};

// Which dimension owns each unmeasured value of the joint pessimistic point, and who answers for it.
const KEY_DIMENSION = {matrixUtil: 'compute', vectorUtil: 'compute', unpackParamsPerLaneCycle: 'compute',
  layoutImbalance: 'sram', kvTile: 'sram', mcUtil: 'mc', prediction: 'mc', launchScale: 'software'};
const DIMENSION_OWNER = {compute: 'compute-expert', sram: 'memory-expert', mc: 'memory-expert', comm: 'comm-expert', software: 'software-expert'};

// Evidence and the measurement that would replace the model, per parameter.
const INFO = {
  // Tile use is not written here: it is computed into criticalPath.occupancy.localTile.
  lMiB: ['MODEL (A.TECH SRAM density; L local tile use in criticalPath.occupancy.localTile.lCore)', 'SRAM macro density and energy for the target process; L-core tile footprint from the kernel mapping'],
  hMiB: ['MODEL (A.TECH SRAM density; H local tile use in criticalPath.occupancy.localTile.hCore)', 'SRAM macro density; H-core tile footprint from the kernel mapping'],
  sharedMiB: ['MODEL (A.TECH SRAM density)', 'shared-SRAM occupancy trace (prefetch window, RDMA workspace) from an event-level replay'],
  lBanks: ['MODEL (A.TECH.bankArea)', 'bank-conflict counts from Palladium cycles of the L-core kernels'],
  hBanks: ['MODEL (A.TECH.bankArea)', 'bank-conflict counts from Palladium cycles of the H-core kernels'],
  bankBytes: ['MODEL', 'bank width vs access granularity from the kernel mapping'],
  sharedSlices: ['MODEL', 'shared-slice contention trace (NoC + port) from an event-level replay'],
  tmaEngines: ['MODEL (A.TECH.tmaArea)', 'TMA descriptor throughput on RTL'],
  tmaBytes: ['MODEL', 'TMA burst size vs SRAM port width on RTL'],
  kvTile: ['MODEL (mapping choice)', 'FlashMLA tile sweep on the target kernel'],
  headTile: ['MODEL (mapping choice)', 'H-core tile footprint per head tile from the kernel mapping (score and accumulator bytes scale with it)'],
  depth: ['MODEL (prefetch lookahead in layers)', 'DMA prefetch trace: lookahead actually reached before eviction'],
  // The model uses one factor for two things (the A.mappedPlan tile check and every kernel time), so
  // it needs both measurements; teams/vv/docs/VV_MEASUREMENT_PLAN.md item 6 names only the capacity one.
  layoutImbalance: ['ASSUMPTION', 'two roles, one factor: capacity (it scales the local tile bytes of the H/L tile check) needs the memory-compiler macro shape imbalance over every SRAM instance (VV_MEASUREMENT_PLAN.md item 6); time (it scales every kernel time) needs the per-bank access histogram from Palladium'],
  rdmaLanes: ['MODEL (A.TECH.rdmaLaneArea)', 'RDMA PHY lane rate and sustained payload per lane'],
  ucieLanes: ['MODEL (A.TECH.ucieLaneArea)', 'UCIe PHY characterisation (lanes, shoreline)'],
  ucieGbps: ['MODEL', 'UCIe PHY characterisation (rate, BER at rate)'],
  nocLanes: ['MODEL', 'NoC link utilisation from an event-level replay'],
  nocBytes: ['MODEL', 'NoC flit width vs payload from the RTL'],
  reduceLanes: ['MODEL', 'Reduce-unit throughput on RTL'],
  tauUs: ['SPEC basis (ADR-0004); physical floor open (B-008)', 'end-to-end per-collective latency on the RDMA path (PHY + switch + NIC + notify)'],
  countBasis: ['ADR-0004 counting basis; shared-expert fold legality open (B-007)', 'legality of the shared-expert fold (B-007)'],
  mcUtil: ['ASSUMPTION', 'sustained MC payload bandwidth on silicon or a vendor model'],
  matrixUtil: ['ASSUMPTION', 'kernel cycle counts on RTL / Palladium'],
  vectorUtil: ['ASSUMPTION', 'vector kernel cycle counts on RTL / Palladium'],
  prediction: ['ASSUMPTION (B-003)', 'expert-router trace: prefetch hit rate'],
  unpackParamsPerLaneCycle: ['ASSUMPTION (no RTL or microbenchmark)', 'unpack microbenchmark on RTL'],
  launchScale: ['ASSUMPTION (B-003)', 'runtime launch trace with batching']
};
const MECHANISM_MEASUREMENT = 'event-level trace showing the mechanism engages at the published point';

const MODEL_ERROR = 'model error: ';
const isModelError = reason => reason.startsWith(MODEL_ERROR);
const safe = fn => {
  try { return fn(); } catch (e) { return {feasible: false, reasons: [`${MODEL_ERROR}${e.message}`]}; }
};
const snap = r => {
  if (r && r.feasible !== false) return {feasible: true, tpsPerUser: r.tps, rawUs: r.rawUs, dieAreaMm2: r.p.dieArea, diePowerW: r.p.diePower, cardPowerW: r.p.cardPower};
  const reasons = ((r && (r.reasons || [r.reason])) || []).filter(Boolean);
  return {feasible: false, reasons: reasons.length ? reasons : ['infeasible']};
};
const pick = (o, keys) => Object.fromEntries(Object.entries(o).filter(([k]) => keys.includes(k)));
const omit = (o, keys) => Object.fromEntries(Object.entries(o).filter(([k]) => !keys.includes(k)));
const per = (d, by) => (Math.abs(by) > EPS ? d / by : null);

// One replayed move against the published point (and against the stress point, when replayed).
function compare(base, s, budgetUs, stressBase, stress) {
  const out = s.feasible
    ? {feasible: true, tpsPerUser: s.tpsPerUser, rawUs: s.rawUs, withinBudget: s.rawUs <= budgetUs,
      dTps: s.tpsPerUser - base.tpsPerUser, dRawUs: s.rawUs - base.rawUs,
      dDieAreaMm2: s.dieAreaMm2 - base.dieAreaMm2, dDiePowerW: s.diePowerW - base.diePowerW, dCardPowerW: s.cardPowerW - base.cardPowerW}
    : {feasible: false, reasons: s.reasons, withinBudget: false, ...(s.reasons.some(isModelError) ? {modelError: true} : {})};
  if (s.feasible) {
    out.dTpsPerMm2 = per(out.dTps, out.dDieAreaMm2);
    out.dTpsPerW = per(out.dTps, out.dDiePowerW);
  }
  if (stress === null) out.stress = null;
  else if (!stress.feasible) out.stress = {feasible: false, reasons: stress.reasons};
  else out.stress = {tpsPerUser: stress.tpsPerUser, dTps: stressBase.feasible ? stress.tpsPerUser - stressBase.tpsPerUser : null, withinBudget: stress.rawUs <= budgetUs};
  return out;
}

// ---- parameter kinds -------------------------------------------------------------------------
// Each returns {name, kind, where, published, owner, role?, moves: [{to, adverse, run(x), stress(x)|null}], breakEven?(x, ctx)}.

// Hardware: the adverse move is the smaller neighbour (less silicon). Mapping (kvTile, depth): a
// mapping is a choice, so both neighbours count as adverse ("does the budget rest on this choice").
// A design point whose value is not on the list (the joint point's tmaEngines 1) gets it inserted,
// so its neighbours are still list steps; at the bottom of the list it has no adverse move.
function field(name, list, {kind = 'hardware', owner}) {
  return {name, kind, where: `x.${name}`, owner,
    published: x => x[name],
    moves: x => {
      const values = list.includes(x[name]) ? list : [...list, x[name]].sort((a, b) => a - b);
      const i = values.indexOf(x[name]);
      return [i - 1, i + 1].filter(j => j >= 0 && j < values.length).map(j => ({
        to: values[j], adverse: kind === 'mapping' || values[j] < x[name],
        run: y => O.evaluate({...y, [name]: values[j]}),
        // The stress point sets kvTile itself; a kvTile move under it would be overwritten.
        stress: name in STRESS ? null : y => B.replayJoint(STRESS, {...y, [name]: values[j]})
      }));
    }};
}

// `alsoReads`: OPT keys the mechanism depends on but does not switch (reported with the published
// value so a reader does not go looking for them elsewhere).
function mechanism(key, owner, {note, alsoReads = []} = {}) {
  const m = B.MECHANISMS.find(d => d.key === key);
  if (!m) throw new Error(`unknown mechanism ${key}`);
  const off = m.patch || {[key]: m.off};
  return {name: key, kind: 'mechanism', where: m.patch ? `OPT.{${Object.keys(m.patch).join(', ')}}` : `OPT.${key}`, owner, role: m.role, note,
    evidence: m.evidence, measurementNeeded: MECHANISM_MEASUREMENT,
    published: () => (m.patch ? pick(O.OPT, [...Object.keys(m.patch), ...alsoReads]) : O.OPT[key]),
    moves: () => [{to: m.patch ? m.patch : m.off, adverse: true,
      run: y => B.withOpt(off, y),
      stress: y => B.withOpt(off, y, z => B.replayJoint(STRESS, z))}]};
}

function assumption(key, owner) {
  const sw = B.ASSUMPTION_SWEEPS.find(s => s.key === key);
  if (!sw) throw new Error(`unknown assumption ${key}`);
  return sweepParam(sw, owner, v => ({...STRESS, [key]: v}));
}

// A sweep in the B.ASSUMPTION_SWEEPS shape. `stressValues(v)` gives the joint values to replay with
// v in place, or null when the sweep is not part of the stress point (then `stressRun` is used).
// What stops the point just past a break-even: the raw budget, or a hard constraint (B.breakEven counts
// an infeasible point as missing the budget, so the bisection alone does not say which).
function breakEvenBy(sw, x, be) {
  if (!be || typeof be.valueAtBudget !== 'number') return null;
  const past = be.valueAtBudget + (sw.lowerIsWorse ? -1 : 1) * 1e-6 * Math.max(1, Math.abs(be.valueAtBudget));
  const s = snap(safe(() => sw.run(past, x)));
  return s.feasible ? {by: 'budget', past, rawUs: s.rawUs} : {by: 'feasibility', past, reasons: s.reasons};
}

// A share written into a published note ("H local 81% used") points at the computed occupancy instead.
const occupancyNote = note => note && note.replace(/\(H local \d+(?:\.\d+)?% used\)/, '(H local tile use in criticalPath.occupancy.localTile.hCore)');
function sweepParam(sw, owner, stressValues, stressRun) {
  return {name: sw.key, kind: 'assumption', where: sw.where, owner, note: occupancyNote(sw.note),
    published: () => sw.baseline(),
    moves: () => {
      const base = sw.baseline();
      return sw.values.map(v => ({to: v, adverse: sw.lowerIsWorse ? v < base : v > base,
        run: y => sw.run(v, y),
        stress: stressRun ? y => stressRun(v, y) : y => B.replayJoint(stressValues(v), y)}));
    },
    breakEven: (x, ctx) => (sw.lowerIsWorse || sw.ceiling ? B.breakEven(sw, x, ctx.budgetUs) : null),
    breakEvenBy: (x, be) => breakEvenBy(sw, x, be)};
}

// tau: the spec per-collective floor (ADR-0004). The analytic break-even (doc 21) assumes every
// collective sits on the floor; the replayed one does not, so both are reported.
const TAU_SWEEP = {key: 'tauUs', where: 'OPT.tauUs', baseline: () => O.OPT.tauUs, values: [1.0, 1.3, 1.5, 2.0], ceiling: 3, lowerIsWorse: false,
  run: (v, x) => B.withOpt({tauUs: v}, x), note: 'per-collective latency floor; every collective costs at least tau'};
function tau(owner) {
  const p = sweepParam(TAU_SWEEP, owner, null, (v, y) => B.withOpt({tauUs: v}, y, z => B.replayJoint(STRESS, z)));
  p.kind = 'protocol';
  p.breakEvenBy = (x, be) => breakEvenBy(TAU_SWEEP, x, be.replayed);
  p.breakEven = (x, ctx) => ({
    replayed: B.breakEven(TAU_SWEEP, x, ctx.budgetUs),
    analytic: {valueAtBudget: O.OPT.tauUs + (ctx.budgetUs - ctx.base.rawUs) / ctx.collectiveCount,
      note: 'tau + raw margin / collective count: assumes every collective is on the tau floor (doc 21, tpsDesign.sensitivity.tauBreakEvenUs)'}
  });
  return p;
}

function countBasis(owner) {
  return {name: 'countBasis', kind: 'basis', where: 'OPT.countBasis', owner,
    published: () => O.OPT.countBasis,
    moves: () => [{to: 'repo-510', adverse: true,
      run: y => B.withOpt({countBasis: 'repo-510'}, y),
      stress: y => B.withOpt({countBasis: 'repo-510'}, y, z => B.replayJoint(STRESS, z))}]};
}

// ---- coupling factors ----------------------------------------------------------------------------
// One move of a coupling, as a wrapper around the evaluation, so that two factors compose.
const switchOff = key => {
  const m = B.MECHANISMS.find(d => d.key === key);
  if (!m) throw new Error(`unknown mechanism ${key}`);
  const patch = m.patch || {[key]: m.off};
  return {name: key, label: `${key} off`, to: m.patch ? m.patch : m.off, apply: (y, fn) => B.withOpt(patch, y, fn)};
};
const techAt = (key, v) => ({name: key, label: `${key}=${v}`, to: v, apply: (y, fn) => B.withTech({[key]: v}, () => fn(y))});
const xAt = (key, v) => ({name: key, label: `${key}=${v}`, to: v, apply: (y, fn) => fn({...y, [key]: v})});
const pair = (a, b, why, at = []) => ({a, b, why, at});

// ---- dimensions --------------------------------------------------------------------------------

const MEM = DIMENSION_OWNER.sram, COMM = DIMENSION_OWNER.comm, SW = DIMENSION_OWNER.software;
const KV_TILES = [16384, 32768, 65536];
// headTile follows the tuning search's list (k3_rdma_final_tuning_search.js EXT.headTile), where 96 is the top.
const HEAD_TILES = [48, 96];
const HMIB = [2, 4, 8], BANKS = [32, 64], SLICES = [8, 16, 32];
// The steps next to the published value on a list.
const neighbours = (values, v) => {
  const i = values.indexOf(v);
  return i < 0 ? [] : [i - 1, i + 1].filter(j => j >= 0 && j < values.length).map(j => values[j]);
};
// Tile use against the local capacity check of A.mappedPlan ('H local tile' / 'L local tile'): a tile
// is infeasible when used > capacity x LIMITS.usable; used already includes TECH.layoutImbalance.
const tileUse = (usedMiB, capacityMiB) => ({usedMiB, capacityMiB, usableMiB: capacityMiB * A.LIMITS.usable,
  shareOfUsable: usedMiB / (capacityMiB * A.LIMITS.usable), shareOfCapacity: usedMiB / capacityMiB});
const DIMENSIONS = {
  sram: {
    question: 'How do on-die SRAM capacity, banking, TMA and the SRAM-side mapping move TPS/usr, and at what area and power?',
    params: [
      // Neighbour lists follow A.SPACE; a step outside it (lMiB 0.5, sharedMiB 12) is taken only
      // where the published value is the lowest SPACE value, so that an adverse move exists.
      field('lMiB', [0.5, 1, 2], {owner: MEM}),
      field('hMiB', HMIB, {owner: MEM}),
      field('sharedMiB', [12, 16, 24], {owner: MEM}),
      field('lBanks', BANKS, {owner: MEM}),
      field('hBanks', BANKS, {owner: MEM}),
      field('bankBytes', [32, 64], {owner: MEM}),
      field('sharedSlices', SLICES, {owner: MEM}),
      field('tmaEngines', [2, 4], {owner: MEM}),
      field('tmaBytes', [256, 512], {owner: MEM}),
      field('kvTile', KV_TILES, {kind: 'mapping', owner: MEM}),
      // The SRAM simulator only maps depth 0..4 (k3_operator_sram_sim.js), so 4 is the top step.
      field('depth', [2, 3, 4], {kind: 'mapping', owner: MEM}),
      // headTile sizes the score and accumulator bytes of the H local tile (A.mappedPlan).
      field('headTile', HEAD_TILES, {kind: 'mapping', owner: MEM}),
      assumption('layoutImbalance', MEM),
      mechanism('sharedPortScaling', MEM, {alsoReads: ['tmaPortWriteScale'],
        note: 'tmaPortWriteScale multiplies the shared write port only while tmaDedicatedPort is on (O.mapped); the switch-back turns the port off, so the scale goes inert and is not patched'}),
      mechanism('kvPrefetch', SW, {note: 'replayed with dmaPreempt held on: the demand fetch parks an in-flight KV prefetch; the coupling kvPrefetch off x dmaPreempt off separates the two'}),
      mechanism('tmaLane', SW),
      mechanism('kvCache', SW, {note: 'shares the H local tile check with kvTile and the H vector lanes with softmaxFusion; see the couplings with both'})
    ],
    couplings: x => {
      const layout = B.ASSUMPTION_SWEEPS.find(s => s.key === 'layoutImbalance').values;
      // bf16 KV does not fit the H local tile at the published kvTile, so a kvCache pair there says
      // nothing; those pairs are replayed at the smallest tile on the list instead.
      const smallTile = [xAt('kvTile', KV_TILES[0])];
      return [
        // bf16 KV raises the H local tile bytes per token; a smaller tile may give that back.
        ...KV_TILES.filter(v => v !== x.kvTile).map(v => pair(xAt('kvTile', v), switchOff('kvCache'),
          'both act on the H local tile check; the kvCache row alone cannot say whether bf16 costs time or only needs a smaller tile')),
        // layoutImbalance scales kernel time and the local tile check; a mechanism that hides SRAM time
        // may be what keeps a pessimistic imbalance inside the budget.
        ...['sharedPortScaling', 'kvPrefetch', 'tmaLane', 'kvCache'].flatMap(k => layout.map(v => pair(switchOff(k), techAt('layoutImbalance', v),
          'the layoutImbalance row holds every mechanism on; this replays the imbalance with the mechanism switched back', k === 'kvCache' ? smallTile : []))),
        pair(switchOff('kvPrefetch'), switchOff('dmaPreempt'), 'the KV prefetch and the demand fetch share the DMA lane; dmaPreempt decides which waits'),
        pair(switchOff('kvCache'), switchOff('softmaxFusion'), 'the fp8 dequant runs on the H vector lanes and is charged against the softmax hiding budget (B.MECHANISMS role)', smallTile),
        // The H local tile wall (bindingConstraints): hMiB is the capacity; kvTile, headTile and kvCache
        // set the bytes; layoutImbalance multiplies them. Less capacity with a smaller tile, more with a larger one.
        ...neighbours(HMIB, x.hMiB).flatMap(h => neighbours(KV_TILES, x.kvTile).filter(v => (h > x.hMiB) === (v > x.kvTile))
          .map(v => pair(xAt('hMiB', h), xAt('kvTile', v), 'both sides of the H local tile check: capacity against the KV slab bytes'))),
        ...neighbours(HMIB, x.hMiB).filter(h => h > x.hMiB).flatMap(h => [
          ...layout.map(v => pair(xAt('hMiB', h), techAt('layoutImbalance', v), 'layoutImbalance scales the tile bytes; more H capacity may move the point where the tile stops fitting')),
          pair(xAt('hMiB', h), switchOff('kvCache'), 'bf16 KV doubles the KV slab bytes of the H tile; more H capacity may let the fallback fit at the published kvTile')]),
        // SW-05 claimed a smaller head tile lets bf16 fit at the published kvTile
        // (teams/council/docs/reviews/2026-09-26_K3_P1_FREEZE_GAP_REVIEW.md); this replays it.
        ...neighbours(HEAD_TILES, x.headTile).map(v => pair(xAt('headTile', v), switchOff('kvCache'), 'a smaller head tile frees the score / accumulator bytes that bf16 KV needs')),
        // Fewer H banks and a worse slowest-bank factor both slow the H-side SRAM reads.
        ...neighbours(BANKS, x.hBanks).filter(v => v < x.hBanks).flatMap(v => layout.map(l => pair(xAt('hBanks', v), techAt('layoutImbalance', l),
          'fewer H banks and a worse slowest-bank factor both act on the H-side SRAM read time'))),
        pair(switchOff('tmaLane'), switchOff('kvPrefetch'), 'the dedicated TMA lane and the KV prefetch both take shared->local traffic off the critical path'),
        pair(switchOff('tmaLane'), switchOff('commOverlap'), 'collectives overlap the TMA traffic; without the lane the overlap may have less to hide behind'),
        // The sharedPortScaling row alone is replayed at the published slice count.
        ...neighbours(SLICES, x.sharedSlices).filter(v => v < x.sharedSlices).map(v => pair(xAt('sharedSlices', v), switchOff('sharedPortScaling'),
          'fewer shared slices and no port scaling both cut the shared-SRAM write bandwidth'))
      ];
    },
    // Lines of the time ledger this dimension owns. localTma + tmaFill + tmaHidden is the exposed
    // shared->local traffic; dmaWait is the memory lane showing through.
    criticalPath: (r, x) => ({lines: [['localTma', r.services.localTma], ['tmaFill', r.services.tmaFill], ['tmaHidden', r.services.tmaHidden], ['dmaWait', r.waitUs]],
      context: {memoryLane: {dmaBusyUs: r.dmaBusyUs, rawUs: r.rawUs, busyShareOfRaw: r.dmaBusyUs / r.rawUs,
        note: 'the DMA/MC lane runs in parallel with the serial chain; busy close to raw means bandwidth, not SRAM, sets the floor'},
      occupancy: {sharedWindowMiBPerCard: r.sramMiB, sharedPeakReservedMiBPerCard: r.peakReservedMiB,
        localTile: {check: 'A.mappedPlan: infeasible when usedMiB > usableMiB = capacityMiB x LIMITS.usable; usedMiB includes TECH.layoutImbalance',
          usable: A.LIMITS.usable, lCore: tileUse(r.localL, x.lMiB), hCore: tileUse(r.localH, x.hMiB)}}}})
  },
  comm: {
    question: 'How do the collective latency floor, the counting basis, the links and the collective mechanisms move TPS/usr, and at what area and power?',
    params: [
      tau(COMM),
      countBasis(COMM),
      field('rdmaLanes', [8, 16], {owner: COMM}),
      field('ucieLanes', [64, 128, 256], {owner: COMM}),
      field('ucieGbps', [32, 64], {owner: COMM}),
      field('nocLanes', [2, 4], {owner: COMM}),
      field('nocBytes', [128, 256, 512], {owner: COMM}),
      field('reduceLanes', [2048, 4096, 8192], {owner: COMM}),
      mechanism('commOverlap', SW),
      mechanism('pvMerge', SW)
    ],
    // memoryTransport + tpReduce + cardLocal + portTail + tauFloor = commUs; commOverlap is negative.
    criticalPath: r => ({lines: ['memoryTransport', 'tpReduce', 'cardLocal', 'portTail', 'tauFloor', 'commOverlap'].map(k => [k, r.services[k]]),
      context: {commUs: r.commUs, collectives: r.protocol.map(a => ({name: a.name, count: a.count, timeUs: a.timeUs, avgUs: a.timeUs / a.count})),
        collectiveCount: r.protocol.reduce((s, a) => s + a.count, 0)}})
  }
};

// ---- builders ----------------------------------------------------------------------------------

// Every replay of a card runs at its design point. The published point needs no scope; a joint
// point (integration/pipelines/design_point.js) brings its OPT patch, the compute winner's model
// patch and the comm winner's control path, replayed exactly as coupling_search.js replayed its row.
const atPoint = (point, fn) => (point && point.model ? C.withPoint({opt: point.opt || {}, model: point.model}, fn) : fn());

// options.point: a resolved design point (design_point.resolve); without one, options.x or the
// published point. The record of it (inputs.point) is what run_workflow.js checks a card against.
function context(options = {}) {
  const text = options.text || fs.readFileSync(path.join(root, BASELINE_FILE), 'utf8');
  const spec = JSON.parse(text);
  const point = options.point || null;
  const x = point ? point.x : options.x || BP.publishedX(spec, 'generate_tps_attribution.js');
  return atPoint(point, () => {
    const r = O.evaluate(x);
    if (!r.feasible) throw new Error(`design point is infeasible: ${(r.reasons || []).join(', ')}`);
    const base = snap(r);
    return {text, spec, x, r, base, point,
      stressBase: snap(B.replayJoint(STRESS, x)),
      budgetUs: spec.goal.rawLatencyBudgetUs,
      collectiveCount: r.protocol.reduce((s, a) => s + a.count, 0),
      inputs: {baseline: BASELINE_FILE, baselineSha256: crypto.createHash('sha256').update(text).digest('hex'),
        pointSource: point ? point.source : options.pointSource || `${BASELINE_FILE}#tpsDesign.hardware.x`, x: {...x},
        ...(point ? {point: {kind: point.kind, source: point.source, optionId: point.optionId, sha256: point.sha256,
          opt: point.opt, model: point.model, departsFromPublished: point.departsFromPublished}} : {}),
        goalTpsPerUser: spec.goal.target, rawBudgetUs: spec.goal.rawLatencyBudgetUs, engineeringMargin: spec.goal.engineeringMargin,
        software: {tauUs: O.OPT.tauUs, countBasis: O.OPT.countBasis, launchScale: O.OPT.launchScale, kvCache: O.OPT.kvCache, kvPrefetch: O.OPT.kvPrefetch, pvMerge: O.OPT.pvMerge},
        stressPoint: {name: 'JOINT_PESSIMISTIC.allUnmeasured', values: STRESS}, slackTps: SLACK_TPS}};
  });
}

// A move the model could not evaluate says nothing about the design and is never counted. A mapping
// is chosen by the search among feasible points, so an infeasible mapping is a choice not taken, not
// a risk the design carries.
const counted = (kind, moves) => moves.filter(m => m.adverse && !m.modelError && (kind !== 'mapping' || m.feasible));

function classify(kind, moves) {
  if (kind === 'basis') return 'basis';
  const adverse = counted(kind, moves);
  if (!adverse.length) return 'untested';
  if (adverse.some(m => !m.feasible || !m.withinBudget)) return 'loadBearing';
  if (adverse.every(m => Math.abs(m.dTps) < SLACK_TPS)) {
    return adverse.some(m => m.dDieAreaMm2 < -EPS || m.dDiePowerW < -EPS) ? 'slack' : 'insensitive';
  }
  return 'graded';
}

function parameterRow(p, ctx) {
  const info = INFO[p.name] || [];
  const moves = p.moves(ctx.x).map(m => ({to: m.to, adverse: m.adverse,
    ...compare(ctx.base, snap(safe(() => m.run(ctx.x))), ctx.budgetUs, ctx.stressBase, m.stress ? snap(safe(() => m.stress(ctx.x))) : null)}));
  const row = {name: p.name, kind: p.kind, where: p.where, published: p.published(ctx.x), owner: p.owner,
    evidence: p.evidence || info[0] || 'UNVERIFIED', measurementNeeded: p.measurementNeeded || info[1] || 'UNVERIFIED'};
  if (p.role) row.role = p.role;
  if (p.note) row.note = p.note;
  row.moves = moves;
  if (p.breakEven) row.breakEven = p.breakEven(ctx.x, ctx);
  const by = p.breakEvenBy && row.breakEven ? p.breakEvenBy(ctx.x, row.breakEven) : null;
  if (by) row.breakEvenBy = by;
  row.classification = classify(p.kind, moves);
  // budget: a feasible adverse move misses the raw budget. feasibility: only a hard constraint is hit,
  // the budget holds on every feasible adverse move.
  if (row.classification === 'loadBearing') {
    row.bearsBy = counted(p.kind, moves).some(m => m.feasible && !m.withinBudget) ? 'budget' : 'feasibility';
  }
  return row;
}

const lineShares = (lines, rawUs) => {
  const rows = lines.map(([name, us]) => ({name, us, shareOfRaw: us / rawUs}));
  const netUs = rows.reduce((s, l) => s + l.us, 0);
  return {lines: rows, netUs, netShareOfRaw: netUs / rawUs};
};

// The dimension's own values of the stress point, replayed together and left out of it.
function dimensionJoint(dimension, ctx) {
  const keys = Object.keys(STRESS).filter(k => KEY_DIMENSION[k] === dimension);
  if (!keys.length) return {values: {}, replay: null, note: `JOINT_PESSIMISTIC declares no pessimistic value for ${dimension}`};
  const alone = snap(safe(() => B.replayJoint(pick(STRESS, keys), ctx.x)));
  const rest = snap(safe(() => B.replayJoint(omit(STRESS, keys), ctx.x)));
  return {values: pick(STRESS, keys),
    alone: alone.feasible ? {tpsPerUser: alone.tpsPerUser, rawUs: alone.rawUs, dTps: alone.tpsPerUser - ctx.base.tpsPerUser, withinBudget: alone.rawUs <= ctx.budgetUs} : alone,
    allUnmeasured: ctx.stressBase.feasible ? {tpsPerUser: ctx.stressBase.tpsPerUser, withinBudget: ctx.stressBase.rawUs <= ctx.budgetUs} : ctx.stressBase,
    leaveOut: rest.feasible ? {tpsPerUser: rest.tpsPerUser, recoveryTps: ctx.stressBase.feasible ? rest.tpsPerUser - ctx.stressBase.tpsPerUser : null, withinBudget: rest.rawUs <= ctx.budgetUs} : rest};
}

const CAVEATS = [
  'software configuration is held at the design point\'s OPT for every move (the published OPT, patched by inputs.point.opt at a joint point); a hardware move that re-tuning would rescue is charged in full to the hardware',
  'die area / power are the detailed model\'s; at a joint point they leave out the Comm Core area (inputs.point.model.commCoreAreaMm2), which the coupling row\'s die area includes',
  'moves are one step on a neighbour list (or the sweep values), not gradients; interactions appear only in jointPessimistic, the stress replays and couplings',
  'couplings are reported, not classified: a pair that breaks the budget only together is flagged breaksOnlyTogether, the rows keep their one-at-a-time class',
  'the stress point (JOINT_PESSIMISTIC.allUnmeasured) is an invented scenario, not a forecast',
  'K3 / TP32 / 1M context / Batch=1 on the detailed model only; GLM-5.2 and DeepSeek-V4-Pro have no attribution here (UNCORROBORATED)',
  'dTpsPerMm2 / dTpsPerW are null where the move does not change die area / power',
  'the classification is mechanical; whether a break-even lies inside the physically plausible range is decided in design.attribution, not here'
];
const STATUS = 'MODEL: one-at-a-time replays of the detailed model at one design point. Changes no baseline, gate or published number';
const REGENERATE = 'npm run attribution:cards (node integration/pipelines/generate_tps_attribution.js); checked by tests/regression/test_tps_attribution.js';

// Which hard constraint each infeasible move hits, grouped by constraint. One constraint behind many
// rows is the wall the point sits against; model errors are listed apart, they are not constraints.
function bindingConstraints(parameters) {
  const hits = {}, errors = [];
  for (const p of parameters) {
    for (const m of p.moves.filter(mv => !mv.feasible)) {
      if (m.modelError) { errors.push({name: p.name, to: m.to, reasons: m.reasons}); continue; }
      for (const reason of m.reasons) (hits[reason] = hits[reason] || []).push({name: p.name, to: m.to, adverse: m.adverse});
    }
  }
  return {byConstraint: Object.entries(hits).map(([constraint, moves]) => ({constraint, moves})).sort((a, b) => b.moves.length - a.moves.length),
    modelErrors: errors};
}

// A coupling: each move alone and both together, on the nominal point (the stress point is not
// replayed: it fixes kvTile and layoutImbalance itself), optionally on a shifted reference point `at`.
// Every dTps is against the published point. interactionTps = both - a - b (+ at, when shifted) when
// all cells are feasible; negative means the pair costs more than its moves add up to.
// breaksOnlyTogether: each move alone stays inside the budget, the pair does not.
function couplingRow(c, ctx) {
  const cell = factors => {
    const run = factors.reduceRight((fn, f) => y => f.apply(y, fn), y => O.evaluate(y));
    const {stress, ...rest} = compare(ctx.base, snap(safe(() => run(ctx.x))), ctx.budgetUs, ctx.stressBase, null);
    return rest;
  };
  const ref = c.at.length ? cell(c.at) : null;
  const a = cell([...c.at, c.a]), b = cell([...c.at, c.b]), both = cell([...c.at, c.a, c.b]);
  const all = [a, b, both, ...(ref ? [ref] : [])].every(m => m.feasible);
  const shifted = ref ? ` @ ${c.at.map(f => f.label).join(', ')}` : '';
  return {name: `${c.a.label} x ${c.b.label}${shifted}`, between: [c.a.name, c.b.name], why: c.why,
    ...(ref ? {at: {moves: c.at.map(f => ({name: f.name, to: f.to})), ...ref}} : {}),
    a: {to: c.a.to, ...a}, b: {to: c.b.to, ...b}, both,
    interactionTps: all ? both.dTps - a.dTps - b.dTps + (ref ? ref.dTps : 0) : null,
    breaksOnlyTogether: a.withinBudget && b.withinBudget && !both.withinBudget};
}

function dimensionCard(dimension, ctx) {
  const d = DIMENSIONS[dimension];
  const parameters = d.params.map(p => parameterRow(p, ctx));
  const cp = d.criticalPath(ctx.r, ctx.x);
  const by = c => parameters.filter(p => p.classification === c).map(p => p.name);
  return {
    schemaVersion: SCHEMA_VERSION, dimension, question: d.question, status: STATUS,
    inputs: ctx.inputs,
    published: {nominal: ctx.base, stress: ctx.stressBase, rawMarginUs: ctx.budgetUs - ctx.base.rawUs},
    criticalPath: {...lineShares(cp.lines, ctx.r.rawUs), ...cp.context},
    classes: CLASSES,
    parameters,
    jointPessimistic: dimensionJoint(dimension, ctx),
    bindingConstraints: bindingConstraints(parameters),
    couplings: (d.couplings ? d.couplings(ctx.x) : []).map(c => couplingRow(c, ctx)),
    loadBearing: by('loadBearing'), graded: by('graded'), slack: by('slack'), insensitive: by('insensitive'), untested: by('untested'), basis: by('basis'),
    owners: [...new Set(parameters.map(p => p.owner))],
    caveats: CAVEATS,
    regenerate: REGENERATE
  };
}

// The joint pessimistic point taken apart: which unmeasured values carry the gap to the goal.
function jointCard(ctx) {
  const all = ctx.stressBase;
  const compute = snap(safe(() => B.replayJoint(B.JOINT_PESSIMISTIC.compute, ctx.x)));
  const recovery = s => (s.feasible && all.feasible ? s.tpsPerUser - all.tpsPerUser : null);
  const parameters = Object.keys(STRESS).map(key => {
    const sw = B.ASSUMPTION_SWEEPS.find(s => s.key === key);
    const info = INFO[key] || [];
    const alone = snap(safe(() => B.replayJoint({[key]: STRESS[key]}, ctx.x)));
    const leaveOut = snap(safe(() => B.replayJoint(omit(STRESS, [key]), ctx.x)));
    const aloneRow = alone.feasible
      ? {tpsPerUser: alone.tpsPerUser, rawUs: alone.rawUs, dTps: alone.tpsPerUser - ctx.base.tpsPerUser, withinBudget: alone.rawUs <= ctx.budgetUs}
      : {feasible: false, reasons: alone.reasons, withinBudget: false};
    const leaveRow = leaveOut.feasible
      ? {tpsPerUser: leaveOut.tpsPerUser, recoveryTps: recovery(leaveOut), withinBudget: leaveOut.rawUs <= ctx.budgetUs}
      : {feasible: false, reasons: leaveOut.reasons, withinBudget: false};
    const closesGap = all.feasible && all.rawUs > ctx.budgetUs && leaveRow.withinBudget;
    const be = sw && (sw.lowerIsWorse || sw.ceiling) ? B.breakEven(sw, ctx.x, ctx.budgetUs) : null;
    const beBy = sw ? breakEvenBy(sw, ctx.x, be) : null;
    return {name: key, kind: 'assumption', where: sw ? sw.where : `x.${key}`, dimension: KEY_DIMENSION[key], owner: DIMENSION_OWNER[KEY_DIMENSION[key]],
      published: sw ? sw.baseline() : ctx.x[key], pessimistic: STRESS[key],
      evidence: info[0] || 'UNVERIFIED', measurementNeeded: info[1] || 'UNVERIFIED',
      alone: aloneRow, leaveOut: leaveRow, closesGapAlone: closesGap,
      breakEven: be, ...(beBy ? {breakEvenBy: beBy} : {}),
      classification: !aloneRow.withinBudget || closesGap ? 'loadBearing' : Math.abs(aloneRow.dTps) >= SLACK_TPS ? 'graded' : 'insensitive'};
  });
  const dims = [...new Set(Object.values(KEY_DIMENSION))];
  const byDimension = dims.map(dim => {
    const keys = Object.keys(STRESS).filter(k => KEY_DIMENSION[k] === dim);
    const alone = snap(safe(() => B.replayJoint(pick(STRESS, keys), ctx.x)));
    const leaveOut = snap(safe(() => B.replayJoint(omit(STRESS, keys), ctx.x)));
    return {dimension: dim, owner: DIMENSION_OWNER[dim], keys,
      aloneTpsPerUser: alone.feasible ? alone.tpsPerUser : null, aloneDTps: alone.feasible ? alone.tpsPerUser - ctx.base.tpsPerUser : null,
      leaveOutTpsPerUser: leaveOut.feasible ? leaveOut.tpsPerUser : null, recoveryTps: recovery(leaveOut),
      leaveOutWithinBudget: leaveOut.feasible && leaveOut.rawUs <= ctx.budgetUs};
  });
  const ranked = byDimension.filter(d => d.recoveryTps !== null).sort((a, b) => b.recoveryTps - a.recoveryTps);
  const holds = all.feasible && all.rawUs <= ctx.budgetUs;
  const by = c => parameters.filter(p => p.classification === c).map(p => p.name);
  return {
    schemaVersion: SCHEMA_VERSION, dimension: 'joint',
    question: 'Does the raw budget hold when the unmeasured values are wrong together, and which dimension carries the gap?',
    status: STATUS, inputs: ctx.inputs,
    published: {nominal: ctx.base, stress: all, rawMarginUs: ctx.budgetUs - ctx.base.rawUs},
    criticalPath: null,
    classes: {loadBearing: 'the pessimistic value alone breaks the budget, or leaving it out of the joint point alone closes the gap',
      graded: 'the pessimistic value alone costs >= 1 TPS/usr but the budget holds', insensitive: 'the pessimistic value alone costs < 1 TPS/usr'},
    parameters,
    jointPessimistic: {
      compute: {values: B.JOINT_PESSIMISTIC.compute, ...(compute.feasible ? {tpsPerUser: compute.tpsPerUser, withinBudget: compute.rawUs <= ctx.budgetUs} : compute)},
      allUnmeasured: {values: STRESS, ...(all.feasible ? {tpsPerUser: all.tpsPerUser, withinBudget: holds, gapToGoalTps: all.tpsPerUser - ctx.inputs.goalTpsPerUser} : all)},
      byDimension,
      // Doc 23 section 6: a joint point below the goal goes back to the dimension whose values carry most of the gap.
      routing: holds ? {routeTo: null, note: 'the budget holds at the joint pessimistic point'}
        : ranked.length ? {routeTo: ranked[0].dimension, owner: ranked[0].owner, recoveryTps: ranked[0].recoveryTps, closesGap: ranked[0].leaveOutWithinBudget,
          note: 'the dimension whose pessimistic values, if they were wrong, recover the most TPS/usr'} : {routeTo: null, note: 'no dimension replay is feasible'}
    },
    loadBearing: by('loadBearing'), graded: by('graded'), insensitive: by('insensitive'),
    owners: [...new Set(parameters.map(p => p.owner))],
    caveats: CAVEATS,
    regenerate: REGENERATE
  };
}

function build(dimension, options = {}) {
  if (dimension !== 'joint' && !Object.keys(DIMENSIONS).includes(dimension)) {
    throw new Error(`unknown dimension "${dimension}"; expected one of ${[...Object.keys(DIMENSIONS), 'joint'].join(', ')}`);
  }
  const ctx = options.context || context(options);
  return atPoint(ctx.point, () => (dimension === 'joint' ? jointCard(ctx) : dimensionCard(dimension, ctx)));
}

module.exports = {build, context, classify, DIMENSIONS, DEFAULT_DIMENSIONS, KEY_DIMENSION, DIMENSION_OWNER, CLASSES, SLACK_TPS, TAU_SWEEP,
  BASELINE_FILE, OUT_DIR, SCHEMA_VERSION};
