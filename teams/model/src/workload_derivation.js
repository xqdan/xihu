'use strict';
/* Planning workload rows of GLM-5.2 and DeepSeek-V4-Pro, derived from the
 * manifest shape blocks in teams/model/inputs/formal_model_manifests.json.
 * Row format: [operatorId, coreClass, globalFlops, globalBytes, bytesClass]
 * per token at 1M context, before TP. Collective bytes are the per-rank ring
 * message at the TP32 reference times TP ranks.
 */
const CONTEXT = 1048576;
const TP_REFERENCE = 32;

// solveFrom = 'active': expert hidden from the reported active parameters (point estimate);
// 'total': from the reported total parameters (variant expertHiddenFromTotal).
function deriveDeepSeek(shape, solveFrom = 'active') {
  const r = shape.reported;
  const v = Object.fromEntries(Object.entries(shape.assumptions).map(([k, x]) => [k, x.value]));
  const H = r.hidden, mla = v.mla, idx = v.indexer, bpp = v.bytesPerParam;
  const moeLayers = r.layers - v.denseLayers;
  const attnParams = H * mla.qLoraRank + mla.qLoraRank * r.heads * (mla.qkNopeDim + mla.ropeDim)
    + H * (mla.kvLatent + mla.ropeDim) + mla.kvLatent * r.heads * (mla.qkNopeDim + mla.vHeadDim)
    + r.heads * mla.vHeadDim * H;
  const indexerParams = mla.qLoraRank * idx.heads * idx.headDim + H * idx.headDim + H * idx.heads;
  const denseFfnParams = 3 * H * v.denseFfnHidden;
  const routerParams = H * r.routedExperts;
  const embedParams = v.vocab * H;
  const lmHeadParams = v.vocab * H;
  const fixedActive = r.layers * (attnParams + indexerParams) + v.denseLayers * denseFfnParams
    + moeLayers * routerParams + embedParams + lmHeadParams;
  const perExpertPerI = 3 * H;
  const activeExpertsPerLayer = r.activeExperts + r.sharedExperts;
  const expertHidden = solveFrom === 'active'
    ? (r.activeParamsB * 1e9 - fixedActive) / (moeLayers * activeExpertsPerLayer * perExpertPerI)
    : (r.totalParamsB * 1e9 - fixedActive) / (moeLayers * (r.routedExperts + r.sharedExperts) * perExpertPerI);
  const expertParams = perExpertPerI * expertHidden;
  const impliedTotal = fixedActive + moeLayers * (r.routedExperts + r.sharedExperts) * expertParams;

  const fp8MatmulParams = r.layers * (attnParams + indexerParams) + v.denseLayers * denseFfnParams
    + moeLayers * r.sharedExperts * expertParams;
  const bf16MatmulParams = moeLayers * routerParams + lmHeadParams; // embedding is a row lookup, not a matmul
  const routedActiveParams = moeLayers * r.activeExperts * expertParams;
  const indexerFlops = r.layers * CONTEXT * idx.heads * idx.headDim * 2;
  const indexerBytes = r.layers * CONTEXT * idx.keyBytesPerToken;
  const sparseFlops = r.layers * 2 * r.indexerTopK * r.heads * ((mla.kvLatent + mla.ropeDim) + mla.kvLatent);
  const sparseBytes = r.layers * r.indexerTopK * v.kvBytesPerTokenPerLayer;
  const collectivesPerToken = r.layers * v.collectivesPerLayer;
  const collectiveBytes = collectivesPerToken * 2 * H * 2 * TP_REFERENCE; // per-rank ring message x TP ranks
  const rows = [
    ['dense_projection', 'L', 2 * (fp8MatmulParams + bf16MatmulParams), fp8MatmulParams * bpp.dense + bf16MatmulParams * bpp.routerAndLmHead, 'weight'],
    ['routed_moe', 'L', 2 * routedActiveParams, routedActiveParams * bpp.routedExpert, 'expert'],
    ['indexer', 'INDEXER', indexerFlops, indexerBytes, 'index'],
    ['sparse_attention', 'H', sparseFlops, sparseBytes, 'kv_state'],
    ['collective_reduce', 'REDUCE', collectiveBytes / 2, collectiveBytes, 'collective']
  ];
  return {
    rows,
    collectivesPerToken,
    layers: r.layers,
    derivation: {
      attentionParamsPerLayer: attnParams,
      indexerParamsPerLayer: indexerParams,
      denseFfnParamsPerLayer: denseFfnParams,
      moeLayers,
      expertHidden,
      expertHiddenBasis: solveFrom === 'active'
        ? `solved from reportedActiveParams = ${r.activeParamsB}B (embedding included)`
        : `solved from reportedTotalParams = ${r.totalParamsB}B (embedding and LM head included, MTP excluded)`,
      activeParams: fixedActive + moeLayers * activeExpertsPerLayer * expertParams,
      activeOverReported: (fixedActive + moeLayers * activeExpertsPerLayer * expertParams) / (r.activeParamsB * 1e9),
      impliedTotalParams: impliedTotal,
      impliedTotalOverReported: impliedTotal / (r.totalParamsB * 1e9),
      routedExpertBytesPerToken: routedActiveParams * bpp.routedExpert,
      mtpApplied: false
    }
  };
}

function deriveGlm(shape) {
  const c = shape.config;
  const v = Object.fromEntries(Object.entries(shape.assumptions).map(([k, x]) => [k, x.value]));
  const H = c.hidden, mla = c.mla, idx = c.indexer, bpp = v.bytesPerParam;
  const moeLayers = c.layers - c.denseLayers;
  const fullLayers = c.fullIndexerLayers.length;
  const sharedLayers = c.layers - fullLayers;
  const attnParams = H * mla.qLoraRank + mla.qLoraRank * c.heads * (mla.qkNopeDim + mla.ropeDim)
    + H * (mla.kvLatent + mla.ropeDim) + mla.kvLatent * c.heads * (mla.qkNopeDim + mla.vHeadDim)
    + c.heads * mla.vHeadDim * H;
  const indexerParams = mla.qLoraRank * idx.heads * idx.headDim + H * idx.headDim + H * idx.heads; // full layers only
  const denseFfnParams = 3 * H * c.denseFfnHidden;
  const expertParams = 3 * H * c.expertHidden;
  const routerParams = H * c.routedExperts;
  const embedParams = c.vocab * H;
  const lmHeadParams = c.vocab * H;
  const fixed = c.layers * attnParams + fullLayers * indexerParams + c.denseLayers * denseFfnParams
    + moeLayers * routerParams + embedParams + lmHeadParams;
  const totalParams = fixed + moeLayers * (c.routedExperts + c.sharedExperts) * expertParams;
  const mtpParams = attnParams + indexerParams + routerParams + (c.routedExperts + c.sharedExperts) * expertParams + 2 * H * H;
  const activeParams = fixed + moeLayers * (c.activeExperts + c.sharedExperts) * expertParams;

  const fp8MatmulParams = c.layers * attnParams + fullLayers * indexerParams + c.denseLayers * denseFfnParams
    + moeLayers * c.sharedExperts * expertParams;
  const bf16MatmulParams = moeLayers * routerParams + lmHeadParams; // embedding is a row lookup, not a matmul
  const routedActiveParams = moeLayers * c.activeExperts * expertParams;
  const indexerFlops = fullLayers * CONTEXT * idx.heads * idx.headDim * 2;
  const indexerBytes = fullLayers * CONTEXT * v.indexKeyBytesPerToken;
  const sparseFlops = c.layers * 2 * idx.topK * c.heads * ((mla.kvLatent + mla.ropeDim) + mla.kvLatent);
  const sparseBytes = c.layers * idx.topK * v.kvBytesPerTokenPerLayer;
  const collectivesPerToken = fullLayers * v.collectivesPerLayer.full + sharedLayers * v.collectivesPerLayer.shared;
  const collectiveBytes = collectivesPerToken * 2 * H * 2 * TP_REFERENCE; // per-rank ring message x TP ranks
  const rows = [
    ['dense_projection', 'L', 2 * (fp8MatmulParams + bf16MatmulParams), fp8MatmulParams * bpp.fp8 + bf16MatmulParams * bpp.bf16, 'weight'],
    ['routed_moe', 'L', 2 * routedActiveParams, routedActiveParams * bpp.fp8, 'expert'],
    ['indexer', 'INDEXER', indexerFlops, indexerBytes, 'index'],
    ['sparse_attention', 'H', sparseFlops, sparseBytes, 'kv_state'],
    ['collective_reduce', 'REDUCE', collectiveBytes / 2, collectiveBytes, 'collective']
  ];
  return {
    rows,
    collectivesPerToken,
    layers: c.layers,
    derivation: {
      attentionParamsPerLayer: attnParams,
      indexerParamsPerFullLayer: indexerParams,
      denseFfnParamsPerLayer: denseFfnParams,
      expertParams,
      moeLayers,
      fullIndexerLayers: fullLayers,
      sharedIndexerLayers: sharedLayers,
      totalParams,
      mtpParams,
      totalParamsWithMtp: totalParams + mtpParams,
      totalWithMtpOverReported: (totalParams + mtpParams) / (c.reportedTotalParamsB * 1e9),
      activeParams,
      activeParamsExcludingEmbedding: activeParams - embedParams,
      mtpApplied: false
    }
  };
}

module.exports = {CONTEXT, TP_REFERENCE, deriveDeepSeek, deriveGlm};
