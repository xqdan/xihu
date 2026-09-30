'use strict';
/* AI Core matrix:vector design search (HW-02, teams/hardware/docs/02_AI_CORE.md section 2.5).
 *
 * The design space is HW-02's input, teams/hardware/inputs/matrix_vector_design_space.json:
 * vector lanes per core, where low-precision operands are turned into tensor
 * operands (vector unpack or native FP8/MXFP4 tensor input) and how the softmax
 * exp is computed (SFU or polynomial), with the vector op counts and area
 * ASSUMPTIONs. search() enumerates the product and scores every candidate on
 *
 *  1. kernel bounds -- per fused kernel, the largest core MACs:lanes ratio at
 *     which its vector work still hides under its matrix work:
 *       MACs/lanes <= matrix FLOPs / (2 x matrixUtil x fill x vector lane-cycles)
 *     generic ops cost ops / (2 x vectorUtil) lane-cycles and dequant elements
 *     1 / unpackParamsPerLaneCycle, as in A.mappedPlan; bounds do not depend on
 *     the lane count, so each kernel sets a minimum lanes = MACs / bound;
 *  2. the K3 detailed replay (O.evaluate) at the published point with only the
 *     lanes, the unpack (native input) and the softmax op count changed.
 *
 * A candidate is feasible if every required H-core kernel hides, the K3 replay
 * keeps the published TPS/usr within the tolerance and the die (with the option
 * area overheads) stays within its limits. Feasible candidates are ranked by die
 * area including the overheads, then die power.
 *
 * build() writes only the winner (out/detailed/matrix_vector_design.json);
 * candidates() writes the whole scored candidate set with a fingerprint over it
 * (out/detailed/matrix_vector_candidates.json), so that a downstream consumer
 * which merges or excludes candidates can be checked against a persisted set
 * instead of against a console log. A winner-only artifact cannot do that:
 * "every exclusion is traceable" is not verifiable if the excluded entries were
 * never written down.
 * alternatives() gives the best candidate of every option and analysis() the
 * lanes sweep, the kernel bound table, the unpack attribution, the native-input
 * break-even overhead and the K3-only variant, which the document quotes.
 * Evidence class MODEL: op counts, TECH.vectorUtil, unpackParamsPerLaneCycle
 * and the overheads are ASSUMPTIONs (B-006, O-006, O-012).
 */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const A = require('./k3_architecture_search.js');
const O = require('./k3_rdma_final_tuning_model.js');
const P = require('./k3_physical_basis.js');
const E = require('../../teams/model/src/design_engine.js');
const W = require('../../teams/model/src/workload_derivation.js');

const root = path.resolve(__dirname, '../..');
const SPACE_FILE = 'teams/hardware/inputs/matrix_vector_design_space.json';
const read = p => JSON.parse(fs.readFileSync(path.join(root, p), 'utf8'));
const BATCHES = [1, 2, 4, 8, 16];
const NATIVE_TECH = {unpackParamsPerLaneCycle: Infinity};
const EPS = 1e-9;

// Fingerprint of a candidate set. Stable across runs and across machines:
// the fields are sorted, the numbers rounded to their reported precision, and
// the digest is taken over JSON with an explicit key order. A fingerprint that
// depends on enumeration order or on float formatting noise is worse than none --
// it would disagree between two identical searches.
function fingerprint(candidates) {
  const canon = candidates.map(c => ({
    pick: Object.fromEntries(Object.entries(c.pick).sort(([a], [b]) => (a < b ? -1 : 1))),
    feasible: c.feasible,
    violations: [...c.violations].sort(),
    lanes: c.lanes,
    areaMm2: Number(c.areaMm2.toFixed(9)),
    diePowerW: Number(c.diePowerW.toFixed(9)),
    tpsPerUser: c.tpsPerUser === null ? null : Number(c.tpsPerUser.toFixed(9)),
  }));
  canon.sort((a, b) => (JSON.stringify(a.pick) < JSON.stringify(b.pick) ? -1 : 1));
  return crypto.createHash('sha256').update(JSON.stringify(canon)).digest('hex');
}

function hardware(x) {
  const lMacs = x.lEngines * x.lRows * x.lCols, hMacs = x.hEngines * x.hRows * x.hCols;
  return {lMacsPerCore: lMacs, hMacsPerCore: hMacs, dieMacs: x.nL * lMacs + x.nH * hMacs, cores: x.nL + x.nH, dies: A.LIMITS.dies};
}
const ratios = (hw, lanes) => ({die: hw.dieMacs / (hw.cores * lanes), lCore: hw.lMacsPerCore / lanes, hCore: hw.hMacsPerCore / lanes});

function shapes() {
  const man = read('teams/model/inputs/formal_model_manifests.json').models;
  const glm = man.find(m => m.modelId === 'GLM-5.2').shape, ds = man.find(m => m.modelId === 'DeepSeek-V4-Pro').shape;
  const k3 = E.MODEL_PRESETS.kimiK3;
  const dsA = Object.fromEntries(Object.entries(ds.assumptions).map(([k, v]) => [k, v.value]));
  return {
    'Kimi K3': {heads: k3.attention.heads, kvLatent: k3.attention.kvLatent, rope: k3.attention.ropeDim, contextSharded: false,
      linearStateDim: k3.linearAttention.stateDim},
    'GLM-5.2': {heads: glm.config.heads, kvLatent: glm.config.mla.kvLatent, rope: glm.config.mla.ropeDim, contextSharded: true,
      topK: glm.config.indexer.topK, indexer: {heads: glm.config.indexer.heads, headDim: glm.config.indexer.headDim}},
    'DeepSeek-V4-Pro': {heads: ds.reported.heads, kvLatent: dsA.mla.kvLatent, rope: dsA.mla.ropeDim, contextSharded: true,
      topK: ds.reported.indexerTopK, indexer: {heads: dsA.indexer.heads, headDim: dsA.indexer.headDim}}
  };
}

// Per-kernel bounds under one low-precision premise and softmax op count.
function kernelBounds(ctx, native, softmaxOps) {
  const {x, tp, hw, shapes: S} = ctx, V = ctx.space.vectorOps;
  const um = A.TECH.matrixUtil, uv = A.TECH.vectorUtil, rate = native ? Infinity : A.TECH.unpackParamsPerLaneCycle;
  const opLC = ops => ops / (2 * uv), dqLC = n => n / rate;
  const tileFill = (n, tile) => n / (Math.ceil(n / tile) * tile);
  const NHcard = hw.dies * x.nH, rows = [];
  const kernel = (model, name, core, flops, laneCycles, fill, basis) => {
    const bound = laneCycles > 0 ? flops / (2 * um * fill * laneCycles) : Infinity;
    const macs = core === 'L' ? hw.lMacsPerCore : hw.hMacsPerCore;
    rows.push({model, kernel: name, core, matrixFlopsPerUnit: flops, vectorLaneCyclesPerUnit: laneCycles, fill,
      maxCoreRatio: bound, minLanesPerCore: macs / bound, basis});
  };
  // Weight GEMV: 2B matrix FLOPs against one unpacked element per parameter;
  // no vector work with native input. L-core fill is 1 for B >= lRows.
  if (!native) for (const B of BATCHES) kernel('all', `GEMV B=${B}`, 'L', 2 * B, dqLC(1), Math.min(1, B / x.lRows), 'per parameter');
  for (const [model, s] of Object.entries(S)) {
    // Absorbed MLA, fused QK + online softmax + PV, per (head, token). FP8 KV is
    // dequantized in QK and PV (kvLatent elements per token), shared by the heads
    // of the core; heads stay together (token-parallel split).
    const tokensPerCore = s.contextSharded ? s.topK / (tp * NHcard) : x.kvTile / NHcard;
    kernel(model, 'MLA', 'H', 2 * (s.kvLatent + s.rope) + 2 * s.kvLatent, opLC(softmaxOps) + dqLC(2 * s.kvLatent / s.heads),
      tileFill(s.heads, x.hRows) * Math.min(1, tokensPerCore / x.hCols), `per (head, token); ${s.heads} heads, ${tokensPerCore} tokens per core`);
    if (s.indexer) {
      // DSA lightning indexer per (index head, token): q.k over headDim, ReLU and
      // head weighting; per token the top-k select and the FP8 key scale (native)
      // or a full key dequant (vector unpack).
      const tokens = W.CONTEXT / (tp * NHcard), h = s.indexer.heads;
      const perToken = opLC(V.topkOpsPerToken) + (native ? opLC(1) : dqLC(s.indexer.headDim));
      kernel(model, 'DSA indexer', 'H', 2 * s.indexer.headDim, opLC(V.indexerOpsPerScore) + perToken / h,
        tileFill(h, x.hRows) * Math.min(1, tokens / x.hCols), `per (index head, token); ${h} index heads, ${tokens} tokens per core`);
    }
    if (s.linearStateDim) {
      // KDA state update per head at B=1: one row, so the matrix fill is 1/hRows.
      const d2 = s.linearStateDim ** 2;
      kernel(model, 'KDA state update', 'H', V.kdaMatrixFlopsPerStateElement * d2, opLC(V.kdaOpsPerStateElement * d2), 1 / x.hRows,
        'per head; B=1 fill 1/hRows');
    }
  }
  return rows;
}

// Run fn with A.TECH patched and the softmax op count forwarded to the
// simulator through A.mappedPlan; both are always restored.
function withModel({tech = {}, softmaxOpsPerScore}, fn) {
  const saved = {...A.TECH}, orig = A.mappedPlan;
  Object.assign(A.TECH, tech);
  A.mappedPlan = (x, batch, p, basis) => orig(x, batch, p, {...(typeof basis === 'string' ? {countBasis: basis} : basis), softmaxOpsPerScore});
  try { return fn(); } finally { Object.assign(A.TECH, saved); A.mappedPlan = orig; }
}

// K3 detailed replay at the published point with the lanes, the unpack and the
// softmax op count of a candidate (cached per combination).
function replay(ctx, lanes, native, softmaxOps) {
  const key = `${lanes}|${native}|${softmaxOps}`;
  if (ctx.replays[key]) return ctx.replays[key];
  const x = {...ctx.x, vectorLanes: lanes};
  return (ctx.replays[key] = withModel({tech: native ? NATIVE_TECH : {}, softmaxOpsPerScore: softmaxOps}, () => {
    const p = P.resize(A.physical(x)), r = O.evaluate(x);
    const base = {dieAreaMm2: p.dieArea, diePowerW: p.diePower, matrixAreaMm2: p.area.matrix, vectorAreaMm2: p.area.vector};
    if (!r.feasible) return {...base, feasible: false, reasons: r.reasons || [r.reason]};
    return {...base, feasible: true, tpsPerUser: r.tps, rawLatencyUs: r.rawUs};
  }));
}

function context() {
  const space = read(SPACE_FILE);
  const spec = read('teams/hardware/inputs/k3_mc_baseline.json');
  const x = spec.tpsDesign.hardware.x, tp = read('out/rdma/k3_rdma_final_tuning_results.json').tp;
  const ctx = {space, x, tp, point: spec.tpsDesign.point, hw: hardware(x), shapes: shapes(), replays: {}, bounds: {},
    sha256: crypto.createHash('sha256').update(fs.readFileSync(path.join(root, SPACE_FILE))).digest('hex')};
  ctx.kernels = (native, softmaxOps) => ctx.bounds[`${native}|${softmaxOps}`] || (ctx.bounds[`${native}|${softmaxOps}`] = kernelBounds(ctx, native, softmaxOps));
  return ctx;
}

// Score one candidate (an option name per dimension) against the requirements.
function evaluate(ctx, pick, req = ctx.space.requirements) {
  const D = ctx.space.dimensions, hw = ctx.hw;
  const o = Object.fromEntries(Object.entries(pick).map(([d, n]) => [d, D[d].options[n]]));
  const lanes = o.vectorLanes.lanes, native = o.lowPrecisionInput.native, softmaxOps = o.expUnit.softmaxOpsPerScore;
  const r = ratios(hw, lanes);
  const kernels = ctx.kernels(native, softmaxOps).map(k => ({...k, coreRatio: k.core === 'L' ? r.lCore : r.hCore,
    hidden: (k.core === 'L' ? r.lCore : r.hCore) <= k.maxCoreRatio + EPS,
    required: req.hiddenCoreClasses.includes(k.core) && req.models.includes(k.model)}));
  const required = kernels.filter(k => k.required);
  const binding = required.reduce((a, k) => (k.minLanesPerCore > a.minLanesPerCore ? k : a));
  const sys = replay(ctx, lanes, native, softmaxOps);
  const area = {die: sys.dieAreaMm2, matrixOverhead: o.lowPrecisionInput.matrixAreaOverhead * sys.matrixAreaMm2,
    vectorOverhead: o.expUnit.vectorAreaOverhead * sys.vectorAreaMm2};
  const areaMm2 = area.die + area.matrixOverhead + area.vectorOverhead;
  const violations = [];
  if (required.some(k => !k.hidden)) violations.push('hKernelExposed');
  if (!sys.feasible) violations.push('systemInfeasible');
  else if (sys.tpsPerUser < ctx.point.tpsPerUser * (1 - req.tpsTolerance)) violations.push('k3Tps');
  if (areaMm2 > P.BASIS.limits.dieArea) violations.push('dieArea');
  return {pick, feasible: !violations.length, violations, lanes, ratio: r, kernels,
    binding: {model: binding.model, kernel: binding.kernel, maxCoreRatio: binding.maxCoreRatio, minLanesPerCore: binding.minLanesPerCore},
    system: sys, areaMm2, area, diePowerW: sys.diePowerW};
}

// Ranking: feasible, least area (with overheads), least power, name.
function better(a, b) {
  if (a.feasible !== b.feasible) return a.feasible;
  if (Math.abs(a.areaMm2 - b.areaMm2) > EPS) return a.areaMm2 < b.areaMm2;
  if (Math.abs(a.diePowerW - b.diePowerW) > EPS) return a.diePowerW < b.diePowerW;
  return JSON.stringify(a.pick) < JSON.stringify(b.pick);
}

function lostOn(a, w) {
  if (!a.feasible) return `infeasible: ${a.violations.join(', ')}`;
  if (Math.abs(a.areaMm2 - w.areaMm2) > EPS) return 'area';
  if (Math.abs(a.diePowerW - w.diePowerW) > EPS) return 'power';
  return 'tie';
}

function search(ctx = context(), req = ctx.space.requirements) {
  const D = ctx.space.dimensions, dims = Object.keys(D);
  let best = null, candidates = 0, feasible = 0;
  const all = [];
  const perOption = Object.fromEntries(dims.map(d => [d, {}]));
  const walk = (i, pick) => {
    if (i === dims.length) {
      candidates++;
      const e = evaluate(ctx, {...pick}, req);
      if (e.feasible) feasible++;
      all.push(e);
      if (!best || better(e, best)) best = e;
      for (const d of dims) { const cur = perOption[d][pick[d]]; if (!cur || better(e, cur)) perOption[d][pick[d]] = e; }
      return;
    }
    for (const n of Object.keys(D[dims[i]].options)) { pick[dims[i]] = n; walk(i + 1, pick); }
  };
  walk(0, {});
  return {ctx, req, best, perOption, all, counts: {candidates, feasible}};
}

const summary = e => ({pick: e.pick, feasible: e.feasible, violations: e.violations, lanes: e.lanes, dieRatio: e.ratio.die, hCoreRatio: e.ratio.hCore,
  binding: e.binding, tpsPerUser: e.system.feasible ? e.system.tpsPerUser : null, areaMm2: e.areaMm2, diePowerW: e.diePowerW});

// Best candidate of every option of every dimension.
function alternatives(result = search()) {
  const {best, perOption} = result, out = {};
  for (const [d, opts] of Object.entries(perOption)) {
    out[d] = {};
    for (const [n, e] of Object.entries(opts)) out[d][n] = {chosen: n === best.pick[d], lostOn: n === best.pick[d] ? null : lostOn(e, best), ...summary(e)};
  }
  return out;
}

// The whole scored candidate set, with a fingerprint over it.
// Written next to the winner so that any downstream consumer which merges,
// ranks or excludes candidates can be checked against a persisted set:
// given this file, "candidate X was excluded because Y" is reproducible;
// given only the winner it is not, because the excluded entries were never
// written down anywhere that survives the run.
// Ordering is by the search's own ranking (feasible first, then area, power,
// name) so the consumer does not have to re-derive it.
function candidates(result = search()) {
  const {best, req, all, counts, ctx} = result;
  const ranked = [...all].sort((a, b) => (better(a, b) ? -1 : better(b, a) ? 1 : 0));
  const entries = ranked.map(e => ({
    optionId: Object.entries(e.pick).map(([d, n]) => `${d}=${n}`).join('|'),
    pick: e.pick,
    feasible: e.feasible,
    violations: e.violations,
    chosen: e === best,
    lostOn: e === best ? null : lostOn(e, best),
    lanes: e.lanes,
    ratio: e.ratio,
    binding: e.binding,
    areaMm2: e.areaMm2,
    area: e.area,
    diePowerW: e.diePowerW,
    tpsPerUser: e.system.feasible ? e.system.tpsPerUser : null,
    rawLatencyUs: e.system.feasible ? e.system.rawLatencyUs : null,
  }));
  return {
    status: 'MODEL (search over the HW-02 design space; the candidate set behind out/detailed/matrix_vector_design.json, not FROZEN)',
    designSpace: {file: SPACE_FILE, sha256: ctx.sha256, dimensions: Object.keys(ctx.space.dimensions)},
    requirements: {models: req.models, hiddenCoreClasses: req.hiddenCoreClasses, tpsTolerance: req.tpsTolerance},
    ranking: 'feasible first, then die area including the option overheads, then die power, then pick',
    totalCandidates: counts.candidates,
    feasibleCandidates: counts.feasible,
    // The fingerprint is over the scored set, not over the file: recomputing it
    // from a fresh search must reproduce this value. It is what makes
    // "these are the candidates that were searched" checkable rather than asserted.
    candidateSetSha256: fingerprint(entries),
    candidates: entries,
    regenerate: 'node integration/pipelines/generate_matrix_vector_design.js (npm run aicore:search); enforced by tests/regression/test_matrix_vector_design.js',
  };
}

// Where the published point's unpack time sits: per-op kernel time above the
// native-input time, split by weight format.
function unpackAttribution(x) {
  const on = O.mapped(x), off = withModel({tech: NATIVE_TECH, softmaxOpsPerScore: 8}, () => O.mapped(x));
  const out = {routedMxfp4Us: 0, denseBf16Us: 0, kvDequantUs: 0};
  on.plan.ops.forEach((o, i) => {
    if (o.unit === 'COMM') return;
    const d = o.timing.kernel - off.plan.ops[i].timing.kernel;
    if (d <= 1e-12) return;
    if (o.unit === 'H') out.kvDequantUs += d;
    else if (o.name.startsWith('Expert ')) out.routedMxfp4Us += d;
    else out.denseBf16Us += d;
  });
  return out;
}

// Document tables: lanes sweep, kernel bounds per premise, unpack attribution,
// native-input break-even overhead and the K3-only requirement variant.
function analysis(result = search()) {
  const {ctx, perOption} = result, D = ctx.space.dimensions;
  const premises = Object.keys(D.lowPrecisionInput.options), exps = Object.keys(D.expUnit.options);
  const combos = premises.flatMap(p => exps.map(e => ({premise: p, exp: e, native: D.lowPrecisionInput.options[p].native,
    softmaxOps: D.expUnit.options[e].softmaxOpsPerScore})));
  const sweep = Object.values(D.vectorLanes.options).map(({lanes}) => {
    const r = ratios(ctx.hw, lanes), row = {vectorLanes: lanes, dieRatio: r.die, hCoreRatio: r.hCore};
    for (const c of combos) {
      const s = replay(ctx, lanes, c.native, c.softmaxOps);
      row[`${c.premise}/${c.exp}`] = s.feasible ? s.tpsPerUser : null;
    }
    const base = replay(ctx, lanes, false, combos[0].softmaxOps);
    row.dieAreaMm2 = base.dieAreaMm2;
    if (!base.feasible) row.reasons = base.reasons;
    return row;
  });
  const keys = [];
  for (const c of combos) for (const k of ctx.kernels(c.native, c.softmaxOps)) if (!keys.some(q => q.model === k.model && q.kernel === k.kernel)) keys.push(k);
  const kernels = keys.map(k => ({model: k.model, kernel: k.kernel, core: k.core,
    maxCoreRatio: Object.fromEntries(combos.map(c => {
      const q = ctx.kernels(c.native, c.softmaxOps).find(v => v.model === k.model && v.kernel === k.kernel);
      return [`${c.premise}/${c.exp}`, q ? q.maxCoreRatio : null];
    }))}));
  // Largest matrix-area overhead at which the best native candidate still ties
  // the best vector-unpack candidate on area (the matrix area does not depend
  // on the lanes, so the native ranking does not change with the overhead).
  const nat = perOption.lowPrecisionInput.nativeTensor, vec = perOption.lowPrecisionInput.vectorUnpack;
  const breakEven = (vec.areaMm2 - (nat.areaMm2 - nat.area.matrixOverhead)) / nat.system.matrixAreaMm2;
  const k3 = search(ctx, {...ctx.space.requirements, models: ['Kimi K3']});
  return {sweep, kernels, unpackAttribution: unpackAttribution(ctx.x),
    nativeBreakEvenMatrixOverhead: breakEven,
    k3Only: {...summary(k3.best), counts: k3.counts,
      bestPerPremise: Object.fromEntries(Object.entries(k3.perOption.lowPrecisionInput).map(([n, e]) => [n, summary(e)]))}};
}

function build(result = search()) {
  const {ctx, req, best, counts} = result, {space, x, point} = ctx, D = space.dimensions;
  const design = Object.fromEntries(Object.entries(best.pick).map(([d, n]) => [d, {option: n, ...D[d].options[n]}]));
  const V = D.expUnit.options[best.pick.expUnit];
  return {
    status: 'MODEL (search over the HW-02 design space: analytical kernel bounds + K3 detailed replay; not FROZEN, does not change the published point)',
    owner: space.owner,
    document: space.document,
    designSpace: {file: SPACE_FILE, sha256: ctx.sha256, dimensions: Object.keys(D), candidates: counts.candidates, feasible: counts.feasible,
      constraints: space.constraints, objective: space.objective,
      note: 'only the winning design is written here; the alternatives stay in the design space and in the document, section 2.5'},
    requirements: {models: req.models, hiddenCoreClasses: req.hiddenCoreClasses, tpsTolerance: req.tpsTolerance},
    assumptions: {matrixUtil: A.TECH.matrixUtil, vectorUtil: A.TECH.vectorUtil, unpackParamsPerLaneCycle: A.TECH.unpackParamsPerLaneCycle,
      vectorOps: {...space.vectorOps, softmaxOpsPerScore: V.softmaxOpsPerScore}, tp: ctx.tp, context: W.CONTEXT},
    hardware: {publishedX: {...x}, lMacsPerCore: ctx.hw.lMacsPerCore, hMacsPerCore: ctx.hw.hMacsPerCore, publishedLanesPerCore: x.vectorLanes,
      publishedRatio: ratios(ctx.hw, x.vectorLanes)},
    design,
    ratio: best.ratio,
    ruled: Object.fromEntries(Object.entries(space.ruled).map(([k, v]) => [k, {chosen: v.chosen, reason: v.reason}])),
    kernels: best.kernels.map(k => ({model: k.model, kernel: k.kernel, core: k.core, maxCoreRatio: k.maxCoreRatio, minLanesPerCore: k.minLanesPerCore,
      coreRatio: k.coreRatio, hidden: k.hidden, required: k.required, basis: k.basis})),
    binding: best.binding,
    evaluation: {
      k3System: {publishedTpsPerUser: point.tpsPerUser, tpsPerUser: best.system.tpsPerUser, rawLatencyUs: best.system.rawLatencyUs},
      areaMm2: best.areaMm2, area: best.area, diePowerW: best.diePowerW, dieAreaLimitMm2: P.BASIS.limits.dieArea
    },
    regenerate: 'node integration/pipelines/generate_matrix_vector_design.js (npm run aicore:search); enforced by tests/regression/test_matrix_vector_design.js'
  };
}

module.exports = {SPACE_FILE, context, evaluate, search, candidates, alternatives, analysis, build, replay};
