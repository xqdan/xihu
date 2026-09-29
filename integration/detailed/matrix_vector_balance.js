'use strict';
/* AI Core matrix:vector balance (HW-02 decision input, teams/hardware/docs/02_AI_CORE.md section 2.5).
 *
 * Question: how many vector lanes per core so that the vector work of every
 * fused kernel (weight unpack, KV/index-key dequant, softmax, indexer
 * ReLU/weighting/top-k, KDA state update) runs under the matrix time of the
 * same kernel, for K3, GLM-5.2 and DeepSeek-V4-Pro.
 *
 * Two views, kept separate:
 *  1. kernel bounds -- per kernel, the largest core matrix:vector ratio
 *     (MAC/cycle : lanes) at which the vector part still hides under the
 *     matrix part. Analytical, uses the model's own TECH conventions.
 *  2. K3 system sweep -- the detailed model (O.evaluate) replayed at the
 *     published point with only x.vectorLanes changed, with vector unpack and
 *     with native low-precision tensor input (unpack/dequant off).
 * Ratios are quoted as the repo quotes them: BF16 dense matrix peak : vector
 * peak (lanes x 2 ops x f), i.e. MACs : lanes.
 *
 * Evidence class MODEL: the vector op counts below and TECH.vectorUtil /
 * unpackParamsPerLaneCycle are ASSUMPTIONs (B-006, O-006, O-012).
 */
const fs = require('fs');
const path = require('path');
const A = require('./k3_architecture_search.js');
const O = require('./k3_rdma_final_tuning_model.js');
const P = require('./k3_physical_basis.js');
const E = require('../../teams/model/src/design_engine.js');
const W = require('../../teams/model/src/workload_derivation.js');

const root = path.resolve(__dirname, '../..');
const read = p => JSON.parse(fs.readFileSync(path.join(root, p), 'utf8'));

// Vector work per unit, generic ops counted as the model counts vector FLOPs
// (lanes x 2 ops per cycle, derated by TECH.vectorUtil); dequant elements run
// at TECH.unpackParamsPerLaneCycle with no derate, as in A.mappedPlan.
const VECTOR = {
  softmaxOpsPerScore: 8,          // max, sub, exp, sum, rescale (k3_operator_sram_sim: 8*B*nh*len)
  softmaxOpsPerScorePolyExp: 18,  // sensitivity: exp as a polynomial instead of an SFU op
  indexerOpsPerScore: 3,          // ReLU + weighted FMA across index heads
  topkOpsPerToken: 8,             // threshold/radix select over the scored context
  kdaOpsPerStateElement: 2,       // per-channel decay + delta update
  kdaMatrixFlopsPerStateElement: 7 // k3_operator_sram_sim: 7*B*heads*128*128
};
const BATCHES = [1, 2, 4, 8, 16];
const CANDIDATE_RATIOS = [48, 32, 16];
const TPS_TOLERANCE = 1e-3; // relative; a candidate "keeps TPS" within 0.1% of the scenario best

function hardware(x) {
  const lMacs = x.lEngines * x.lRows * x.lCols, hMacs = x.hEngines * x.hRows * x.hCols;
  const dieMacs = x.nL * lMacs + x.nH * hMacs, cores = x.nL + x.nH;
  return {
    lMacsPerCore: lMacs, hMacsPerCore: hMacs, lanesPerCore: x.vectorLanes, cores, dies: A.LIMITS.dies,
    ratio: {die: dieMacs / (cores * x.vectorLanes), lCore: lMacs / x.vectorLanes, hCore: hMacs / x.vectorLanes},
    lanesForDieRatio: r => dieMacs / (cores * r)
  };
}

// Largest core MACs:lanes ratio at which vector lane-cycles <= matrix cycles:
// F / (2 * MACs * um * fill) >= LC / lanes  <=>  MACs/lanes <= F / (2 * um * fill * LC)
const um = A.TECH.matrixUtil, uv = A.TECH.vectorUtil, unpackRate = A.TECH.unpackParamsPerLaneCycle;
const opLC = ops => ops / (2 * uv);
const dqLC = elements => elements / unpackRate;
const maxRatio = (flops, laneCycles, fill) => laneCycles > 0 ? flops / (2 * um * fill * laneCycles) : Infinity;
const tileFill = (n, tile) => n / (Math.ceil(n / tile) * tile);

function kernel(model, name, core, flops, laneCycles, fill, hw, basis) {
  const bound = maxRatio(flops, laneCycles, fill);
  const coreRatio = core === 'L' ? hw.ratio.lCore : hw.ratio.hCore;
  const macs = core === 'L' ? hw.lMacsPerCore : hw.hMacsPerCore;
  return {model, kernel: name, core, matrixFlopsPerUnit: flops, vectorLaneCyclesPerUnit: laneCycles, fill,
    maxCoreRatio: bound, minLanesPerCore: macs / bound, currentCoreRatio: coreRatio, hiddenAtCurrent: coreRatio <= bound + 1e-9, basis};
}

function shapes() {
  const man = read('teams/model/inputs/formal_model_manifests.json').models;
  const glm = man.find(m => m.modelId === 'GLM-5.2').shape, ds = man.find(m => m.modelId === 'DeepSeek-V4-Pro').shape;
  const k3 = E.MODEL_PRESETS.kimiK3;
  const dsA = Object.fromEntries(Object.entries(ds.assumptions).map(([k, v]) => [k, v.value]));
  return {
    'Kimi K3': {heads: k3.attention.heads, kvLatent: k3.attention.kvLatent, rope: k3.attention.ropeDim, contextSharded: false,
      linearStateDim: k3.linearAttention.stateDim, weightsNeedingUnpack: 'routed experts (MXFP4); dense/attention/shared are BF16'},
    'GLM-5.2': {heads: glm.config.heads, kvLatent: glm.config.mla.kvLatent, rope: glm.config.mla.ropeDim, contextSharded: true,
      topK: glm.config.indexer.topK, indexer: {heads: glm.config.indexer.heads, headDim: glm.config.indexer.headDim},
      indexerFlops: W.deriveGlm(glm).rows.find(r => r[0] === 'indexer')[2],
      weightsNeedingUnpack: 'all FP8 weights (attention, indexer, dense FFN, shared and routed experts); router and LM head BF16'},
    'DeepSeek-V4-Pro': {heads: ds.reported.heads, kvLatent: dsA.mla.kvLatent, rope: dsA.mla.ropeDim, contextSharded: true,
      topK: ds.reported.indexerTopK, indexer: {heads: dsA.indexer.heads, headDim: dsA.indexer.headDim},
      indexerFlops: W.deriveDeepSeek(ds).rows.find(r => r[0] === 'indexer')[2],
      weightsNeedingUnpack: 'FP8 attention/indexer/dense/shared and FP4 routed experts; router and LM head BF16'}
  };
}

function kernelBounds(x, tp, hw) {
  const S = shapes(), out = [];
  const NHcard = hw.dies * x.nH;
  // 1. Weight GEMV with vector unpack: 2B matrix FLOPs vs one unpacked element per parameter.
  //    L-core fill is 1 for B >= lRows (P1: lRows = 1).
  const gemv = BATCHES.map(B => kernel('all', `GEMV, sub-BF16 weights unpacked on vector, B=${B}`, 'L', 2 * B, dqLC(1),
    Math.min(1, B / x.lRows), hw, 'per parameter; vanishes with native FP8/FP4 tensor input'));
  for (const [model, s] of Object.entries(S)) {
    // 2. Absorbed MLA, fused QK + online softmax + PV, per (head, token). FP8 KV is
    //    dequantized in both QK and PV (kvLatent elements per token), shared by
    //    every head on the core; heads stay together (token-parallel split).
    const tokensPerCore = s.contextSharded ? s.topK / (tp * NHcard) : x.kvTile / NHcard;
    const mlaFill = tileFill(s.heads, x.hRows) * Math.min(1, tokensPerCore / x.hCols);
    const mlaFlops = 2 * (s.kvLatent + s.rope) + 2 * s.kvLatent;
    const kvDq = dqLC(2 * s.kvLatent / s.heads);
    out.push(kernel(model, 'MLA QK+softmax+PV, FP8 KV', 'H', mlaFlops, opLC(VECTOR.softmaxOpsPerScore) + kvDq, mlaFill, hw,
      `per (head, token); ${s.heads} heads per core, ${tokensPerCore} tokens per core`));
    out.push(kernel(model, 'MLA QK+softmax+PV, FP8 KV, polynomial exp', 'H', mlaFlops, opLC(VECTOR.softmaxOpsPerScorePolyExp) + kvDq, mlaFill, hw,
      'sensitivity: no exp SFU'));
    if (s.indexer) {
      // 3. DSA lightning indexer, per (index head, token): q.k over headDim, then
      //    ReLU and head weighting; per token: top-k select and the FP8 key scale
      //    (native) or a full key dequant (vector).
      const tokens = W.CONTEXT / (tp * NHcard), h = s.indexer.heads;
      const fill = tileFill(h, x.hRows) * Math.min(1, tokens / x.hCols);
      const flops = 2 * s.indexer.headDim;
      for (const native of [true, false]) {
        const perToken = opLC(VECTOR.topkOpsPerToken) + (native ? opLC(1) : dqLC(s.indexer.headDim));
        const k = kernel(model, `DSA indexer, FP8 key ${native ? 'native' : 'dequant on vector'}`, 'H', flops, opLC(VECTOR.indexerOpsPerScore) + perToken / h, fill, hw,
          `per (index head, token); ${h} index heads, ${tokens} tokens per core`);
        // Exposure per token per rank at the current ratio: matrix time from the
        // workload row, vector time = matrix time x coreRatio / bound.
        const matrixUs = s.indexerFlops / tp / (NHcard * 2 * hw.hMacsPerCore * x.ghz * 1e3 * um * fill);
        k.matrixUsPerTokenPerRank = matrixUs;
        k.exposedUsPerTokenPerRank = Math.max(0, matrixUs * (k.currentCoreRatio / k.maxCoreRatio - 1));
        out.push(k);
      }
    }
    if (s.linearStateDim) {
      // 4. KDA state update per head: GEMV-like at B=1 (one row), so the matrix fill is 1/hRows.
      const d2 = s.linearStateDim ** 2;
      out.push(kernel(model, 'KDA state update, B=1', 'H', VECTOR.kdaMatrixFlopsPerStateElement * d2, opLC(VECTOR.kdaOpsPerStateElement * d2),
        1 / x.hRows, hw, 'per head; hidden only because the matrix side runs at 1/hRows fill'));
    }
  }
  return {gemv, kernels: out};
}

// K3 detailed replay at the published point with only vectorLanes changed.
function withTech(patch, fn) {
  const saved = {...A.TECH};
  Object.assign(A.TECH, patch);
  try { return fn(); } finally { Object.assign(A.TECH, saved); }
}
const NATIVE = {unpackParamsPerLaneCycle: Infinity};

function sweepPoint(x, lanes, native) {
  const xx = {...x, vectorLanes: lanes};
  return withTech(native ? NATIVE : {}, () => {
    const p = P.resize(A.physical(xx));
    const r = O.evaluate(xx);
    const base = {vectorLanes: lanes, dieRatio: hardware(xx).ratio.die, vectorTopsPerDie: p.vectorTOP, dieAreaMm2: p.dieArea, diePowerW: p.diePower};
    if (!r.feasible) return {...base, feasible: false, reasons: r.reasons || [r.reason]};
    return {...base, feasible: true, tpsPerUser: r.tps, rawLatencyUs: r.rawUs, computeUs: r.computeUs};
  });
}

// Where the K3 published point's unpack time sits: the per-op kernel time above
// what it would be with native low-precision input, split by weight format.
function unpackAttribution(x) {
  const on = O.mapped(x), off = withTech(NATIVE, () => O.mapped(x));
  const out = {routedMxfp4Us: 0, denseBf16Us: 0, kvDequantUs: 0};
  on.plan.ops.forEach((o, i) => {
    if (o.unit === 'COMM') return;
    const d = o.timing.kernel - off.plan.ops[i].timing.kernel;
    if (d <= 1e-12) return;
    if (o.unit === 'H') out.kvDequantUs += d;
    else if (o.name.startsWith('Expert ')) out.routedMxfp4Us += d;
    else out.denseBf16Us += d;
  });
  out.note = 'denseBf16Us is a model artifact: mappedPlan charges vector unpack on every weight parameter, including BF16 weights that need none';
  return out;
}

function build() {
  const spec = read('teams/hardware/inputs/k3_mc_baseline.json');
  const res = read('out/rdma/k3_rdma_final_tuning_results.json');
  const x = spec.tpsDesign.hardware.x, tp = res.tp, hw = hardware(x);
  const {gemv, kernels} = kernelBounds(x, tp, hw);

  const lanesList = [...new Set([...CANDIDATE_RATIOS.map(r => Math.round(hw.lanesForDieRatio(r))), x.vectorLanes])].sort((a, b) => a - b);
  const sweep = {};
  for (const [key, native] of [['vectorUnpack', false], ['nativeLowPrecision', true]]) sweep[key] = lanesList.map(l => sweepPoint(x, l, native));

  // Decision: fewest lanes (largest die ratio) that (a) keeps the K3 system TPS
  // within tolerance of the scenario best and (b) hides the H-side kernels of the
  // models to be supported. L-side GEMV hiding is reported, not required: at B=1
  // the GEMV bound is below any practical ratio and only native input removes it.
  const hRequired = (models, native) => Math.max(...kernels.filter(k => k.core === 'H' && models.includes(k.model)
    && !/polynomial|KDA/.test(k.kernel) && (!/indexer/.test(k.kernel) || /native/.test(k.kernel) === native)).map(k => k.minLanesPerCore));
  const decide = (models, key) => {
    const native = key === 'nativeLowPrecision', rows = sweep[key].filter(r => r.feasible);
    const best = Math.max(...rows.map(r => r.tpsPerUser));
    const k3Lanes = Math.min(...rows.filter(r => r.tpsPerUser >= best * (1 - TPS_TOLERANCE)).map(r => r.vectorLanes));
    const hLanes = hRequired(models, native);
    const lanes = Math.max(k3Lanes, hLanes);
    return {models, premise: key, k3SystemMinLanes: k3Lanes, hKernelMinLanes: hLanes, lanesPerCore: lanes, dieRatio: hw.ratio.die * x.vectorLanes / lanes,
      hCoreRatio: hw.hMacsPerCore / lanes, lCoreRatio: hw.lMacsPerCore / lanes};
  };
  const all = Object.keys(shapes());
  return {
    status: 'MODEL (analytical kernel bounds + K3 detailed replay; not FROZEN)',
    owner: 'HW-02 AI-Core (co-sign SW-03 Kernel Optimization)',
    document: 'teams/hardware/docs/02_AI_CORE.md#25-matrixvector-配比hw-02-决策输入',
    ratioConvention: 'BF16 dense matrix peak : vector peak (lanes x 2 ops x f) = MACs : lanes, per die or per core class',
    hiddenCriterion: 'per kernel: vector lane-cycles / lanes <= matrix FLOPs / (2 x MACs x matrixUtil x fill)',
    assumptions: {matrixUtil: um, vectorUtil: uv, unpackParamsPerLaneCycle: unpackRate, vector: {...VECTOR}, tp, context: W.CONTEXT,
      evidence: 'ASSUMPTION (B-006 coefficients, O-006 vector op set, O-012 native FP8 MAC)'},
    hardware: {x: {...x}, lMacsPerCore: hw.lMacsPerCore, hMacsPerCore: hw.hMacsPerCore, lanesPerCore: x.vectorLanes, ratio: hw.ratio},
    gemv,
    kernels,
    k3: {publishedTpsPerUser: spec.tpsDesign.point.tpsPerUser, unpackAttribution: unpackAttribution(x), sweep, tpsTolerance: TPS_TOLERANCE},
    decision: {
      k3Only: {vectorUnpack: decide(['Kimi K3'], 'vectorUnpack'), nativeLowPrecision: decide(['Kimi K3'], 'nativeLowPrecision')},
      allModels: {vectorUnpack: decide(all, 'vectorUnpack'), nativeLowPrecision: decide(all, 'nativeLowPrecision')},
      gemvB1MaxLCoreRatio: gemv[0].maxCoreRatio,
      notes: [
        'At B=1 a sub-BF16 GEMV needs about one vector op per parameter against two matrix FLOPs; no practical ratio hides it. Native FP8/MXFP4 tensor input (O-012) or a decoder in the TMA path removes it; otherwise it is bounded by the memory lane, not hidden.',
        'The die ratio averages two core classes with very different needs (L core ~4:1, H core ~60:1 at P1); size lanes per core class.',
        'GLM-5.2 and DeepSeek-V4-Pro set the H-core requirement through the DSA indexer; K3 alone is set by the system replay.'
      ]
    },
    regenerate: 'node integration/pipelines/generate_matrix_vector_balance.js (npm run aicore:balance); enforced by tests/regression/test_matrix_vector_balance.js'
  };
}

module.exports = {build, VECTOR, maxRatio};
