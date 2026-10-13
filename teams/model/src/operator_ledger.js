'use strict';

/* Manifest-derived operator ledger for the two non-K3 model lanes.
 * This is intentionally separate from traced_ledger.js: GLM has a reference
 * trace, while DeepSeek currently only has reported fields plus assumptions.
 * The rows are planning evidence, not a validated kernel trace. */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const {deriveDeepSeek, deriveGlm} = require('./workload_derivation');

const ROOT = path.resolve(__dirname, '../..', '..');
const MANIFEST_FILE = 'teams/model/inputs/formal_model_manifests.json';
const FORMAT = 'model-operator-ledger-v0.1';
const EVIDENCE = 'UNVERIFIED_PLANNING_MANIFEST';
const CONTEXT = 1048576;

const read = file => JSON.parse(fs.readFileSync(path.join(ROOT, file), 'utf8'));
const sha256 = data => crypto.createHash('sha256').update(data).digest('hex');
const manifestText = () => fs.readFileSync(path.join(ROOT, MANIFEST_FILE), 'utf8');
const manifest = () => read(MANIFEST_FILE);
const round = value => Number(value);

function row({operatorId, layerClass, layerCount, coreClass, dtype, parameterCount,
  parameterStorageBytes, flopsPerLayer, bytesPerLayer, bytesClass, state = false,
  basis, source, invocationsPerToken = null}) {
  return {
    operatorId, layerClass, layerCount, coreClass, dtype,
    parameterCountPerLayer: round(parameterCount),
    parameterStorageBytesPerLayer: round(parameterStorageBytes),
    flopsPerLayer: round(flopsPerLayer),
    bytesPerLayer: round(bytesPerLayer),
    globalFlopsPerToken: round(flopsPerLayer * layerCount),
    globalBytesPerToken: round(bytesPerLayer * layerCount),
    bytesClass, state, basis, source,
    ...(invocationsPerToken === null ? {} : {invocationsPerToken: round(invocationsPerToken)})
  };
}

function addAttentionRows(rows, shape, layerClass, layerCount, bpp) {
  const c = shape.config || shape.reported;
  const H = c.hidden, heads = c.heads, mla = c.mla || shape.assumptions.mla.value;
  const bytes = (params, dtype) => params * bpp[dtype];
  const components = [
    ['q_a_projection', H * mla.qLoraRank, 'fp8'],
    ['q_b_projection', mla.qLoraRank * heads * (mla.qkNopeDim + mla.ropeDim), 'fp8'],
    ['kv_a_projection', H * (mla.kvLatent + mla.ropeDim), 'fp8'],
    ['kv_b_projection_absorbed', mla.kvLatent * heads * (mla.qkNopeDim + mla.vHeadDim), 'fp8'],
    ['attention_output_projection', heads * mla.vHeadDim * H, 'fp8']
  ];
  for (const [operatorId, parameterCount, dtype] of components) rows.push(row({
    operatorId, layerClass, layerCount, coreClass: 'H', dtype,
    parameterCount, parameterStorageBytes: bytes(parameterCount, dtype),
    flopsPerLayer: 2 * parameterCount, bytesPerLayer: bytes(parameterCount, dtype),
    bytesClass: 'weight', basis: 'absorbed MLA decode projection; 2 FLOP per parameter', source: MANIFEST_FILE
  }));
}

function addIndexerRows(rows, shape, layerClass, layerCount, bpp) {
  const c = shape.config || shape.reported;
  const H = c.hidden, mla = c.mla || shape.assumptions.mla.value;
  const idx = c.indexer || shape.assumptions.indexer.value;
  const params = [
    ['indexer_query_projection', mla.qLoraRank * idx.heads * idx.headDim],
    ['indexer_key_projection', H * idx.headDim],
    ['indexer_weight_projection', H * idx.heads]
  ];
  for (const [operatorId, parameterCount] of params) {
    const dtype = operatorId === 'indexer_weight_projection' && c.fp8 ? 'bf16' : 'fp8';
    rows.push(row({operatorId, layerClass, layerCount, coreClass: 'INDEXER', dtype,
      parameterCount, parameterStorageBytes: parameterCount * bpp[dtype],
      flopsPerLayer: 2 * parameterCount, bytesPerLayer: parameterCount * bpp[dtype],
      bytesClass: 'weight', basis: 'indexer projection; full/shared layer ownership is a model assumption', source: MANIFEST_FILE}));
  }
  const contextBytes = shape.assumptions.indexKeyBytesPerToken?.value || idx.keyBytesPerToken;
  const indexFlops = CONTEXT * idx.heads * (idx.headDim * 2 + 2);
  rows.push(row({operatorId: 'indexer_context_score', layerClass, layerCount, coreClass: 'INDEXER', dtype: 'FP16',
    parameterCount: 0, parameterStorageBytes: 0, flopsPerLayer: indexFlops,
    bytesPerLayer: CONTEXT * contextBytes, bytesClass: 'index', state: true,
    basis: `decode indexer scores over ${CONTEXT} cached tokens; index key layout is an assumption`, source: MANIFEST_FILE}));
}

function addCollectiveRow(rows, shape, layerCount, collectivesPerLayer) {
  const c = shape.config || shape.reported;
  const hidden = c.hidden;
  const count = Math.round(layerCount * collectivesPerLayer);
  const payload = 2 * hidden * 2;
  rows.push(row({operatorId: 'collective_reduce', layerClass: 'global', layerCount: 1, coreClass: 'REDUCE', dtype: 'BF16',
    parameterCount: 0, parameterStorageBytes: 0, flopsPerLayer: count * payload / 2,
    bytesPerLayer: count * payload * 32, bytesClass: 'collective',
    basis: `TP32 planning collective envelope: ${count} collectives x BF16 hidden payload x TP32`,
    source: MANIFEST_FILE, invocationsPerToken: count}));
}

function addSparseRows(rows, shape, layerClass, layerCount) {
  const c = shape.config || shape.reported;
  const v = Object.fromEntries(Object.entries(shape.assumptions).map(([k, x]) => [k, x.value]));
  const mla = c.mla || v.mla, idx = c.indexer || v.indexer;
  const topK = c.indexer?.topK || c.indexerTopK;
  const kvBytes = v.kvBytesPerTokenPerLayer;
  const sparseFlops = 2 * topK * c.heads * ((mla.kvLatent + mla.ropeDim) + mla.kvLatent);
  rows.push(row({operatorId: 'sparse_attention_topk', layerClass, layerCount, coreClass: 'H', dtype: 'BF16',
    parameterCount: 0, parameterStorageBytes: 0, flopsPerLayer: sparseFlops,
    bytesPerLayer: topK * kvBytes, bytesClass: 'kv_state', state: true,
    basis: `sparse attention reads topK=${topK} latent KV entries; KV layout is an assumption`, source: MANIFEST_FILE}));
}

function addFfnRows(rows, shape, layerClass, layerCount, bpp, routedActive, expertHiddenOverride = null) {
  const c = shape.config || shape.reported;
  const H = c.hidden, dense = c.denseFfnHidden || shape.assumptions.denseFfnHidden.value;
  if (layerClass.includes('dense')) {
    for (const [operatorId, parameterCount] of [['dense_gate_projection', H * dense], ['dense_up_projection', H * dense], ['dense_down_projection', H * dense]]) rows.push(row({
      operatorId, layerClass, layerCount, coreClass: 'L', dtype: 'fp8', parameterCount,
      parameterStorageBytes: parameterCount * bpp.dense, flopsPerLayer: 2 * parameterCount,
      bytesPerLayer: parameterCount * bpp.dense, bytesClass: 'weight', basis: 'dense FFN projection', source: MANIFEST_FILE
    }));
    return;
  }
  const routedExperts = c.routedExperts, sharedExperts = c.sharedExperts;
  const expertHidden = expertHiddenOverride || c.expertHidden || shape.assumptions.expertHidden.value;
  const routerParams = H * routedExperts;
  rows.push(row({operatorId: 'moe_router', layerClass, layerCount, coreClass: 'L', dtype: 'bf16',
    parameterCount: routerParams, parameterStorageBytes: routerParams * bpp.routerAndLmHead,
    flopsPerLayer: 2 * routerParams, bytesPerLayer: routerParams * bpp.routerAndLmHead,
    bytesClass: 'weight', basis: 'router selects active routed experts; overflow is not modeled', source: MANIFEST_FILE}));
  const expertParams = 3 * H * expertHidden;
  const expertDtype = bpp.routedExpert < 1 ? 'fp4' : 'fp8';
  rows.push(row({operatorId: 'routed_expert_active', layerClass, layerCount, coreClass: 'L', dtype: expertDtype,
    parameterCount: routedActive * expertParams, parameterStorageBytes: routedExperts * expertParams * bpp.routedExpert,
    flopsPerLayer: 2 * routedActive * expertParams, bytesPerLayer: routedActive * expertParams * bpp.routedExpert,
    bytesClass: 'expert', basis: `${routedActive} routed experts per token; expert storage retains all ${routedExperts}`, source: MANIFEST_FILE}));
  const sharedParams = sharedExperts * expertParams;
  rows.push(row({operatorId: 'shared_expert', layerClass, layerCount, coreClass: 'L', dtype: 'fp8',
    parameterCount: sharedParams, parameterStorageBytes: sharedParams * bpp.sharedExpert,
    flopsPerLayer: 2 * sharedParams, bytesPerLayer: sharedParams * bpp.sharedExpert,
    bytesClass: 'expert', basis: `${sharedExperts} shared expert(s) per MoE layer`, source: MANIFEST_FILE}));
}

function addStateRows(rows, shape, layerClass, layerCount, fullIndexer) {
  const v = Object.fromEntries(Object.entries(shape.assumptions).map(([k, x]) => [k, x.value]));
  const c = shape.config || shape.reported;
  const topK = c.indexer?.topK || c.indexerTopK;
  rows.push(row({operatorId: 'kv_state_read', layerClass, layerCount, coreClass: 'H', dtype: 'FP8',
    parameterCount: 0, parameterStorageBytes: 0, flopsPerLayer: 0,
    bytesPerLayer: v.kvBytesPerTokenPerLayer * topK,
    bytesClass: 'kv_state', state: true, basis: 'top-k KV state traffic per decode token', source: MANIFEST_FILE}));
  if (fullIndexer) rows.push(row({operatorId: 'index_cache_read', layerClass, layerCount, coreClass: 'INDEXER', dtype: 'FP8',
    parameterCount: 0, parameterStorageBytes: 0, flopsPerLayer: 0,
    bytesPerLayer: CONTEXT * (v.indexKeyBytesPerToken || v.indexer.keyBytesPerToken),
    bytesClass: 'index', state: true, basis: 'full indexer cache read over the context', source: MANIFEST_FILE}));
}

function buildGlm(shape) {
  const c = shape.config, v = Object.fromEntries(Object.entries(shape.assumptions).map(([k, x]) => [k, x.value]));
  const bpp = {fp8: v.bytesPerParam.fp8, bf16: v.bytesPerParam.bf16, dense: v.bytesPerParam.fp8,
    sharedExpert: v.bytesPerParam.fp8, routedExpert: v.bytesPerParam.fp8, routerAndLmHead: v.bytesPerParam.bf16};
  const fullSet = new Set(c.fullIndexerLayers);
  const rows = [];
  const classes = [
    {id: 'full_dense', count: c.fullIndexerLayers.filter(i => i < c.denseLayers).length, full: true, dense: true},
    {id: 'full_moe', count: c.fullIndexerLayers.filter(i => i >= c.denseLayers).length, full: true, dense: false},
    {id: 'shared_moe', count: c.layers - c.fullIndexerLayers.length, full: false, dense: false}
  ];
  for (const layer of classes.filter(x => x.count > 0)) {
    addAttentionRows(rows, shape, layer.id, layer.count, bpp);
    if (layer.full) addIndexerRows(rows, shape, layer.id, layer.count, bpp);
    addSparseRows(rows, shape, layer.id, layer.count);
    addFfnRows(rows, shape, layer.id, layer.count, bpp, c.activeExperts);
    addStateRows(rows, shape, layer.id, layer.count, layer.full);
  }
  addCollectiveRow(rows, shape, c.layers, (c.fullIndexerLayers.length * v.collectivesPerLayer.full + (c.layers - c.fullIndexerLayers.length) * v.collectivesPerLayer.shared) / c.layers);
  rows.push(row({operatorId: 'lm_head', layerClass: 'global', layerCount: 1, coreClass: 'L', dtype: 'bf16',
    parameterCount: c.vocab * c.hidden, parameterStorageBytes: c.vocab * c.hidden * bpp.bf16,
    flopsPerLayer: 2 * c.vocab * c.hidden, bytesPerLayer: c.vocab * c.hidden * bpp.bf16,
    bytesClass: 'weight', basis: 'untied BF16 LM head; embedding lookup excluded from matmul ledger', source: MANIFEST_FILE}));
  return makeLedger('GLM-5.2', 'config-derived deployment layout; full/shared indexer and FP8 checkpoint assumptions', rows,
    {variants: [{variantId: 'configDerived', parameterBasis: 'public config plus deployment assumptions'}], shape: {layers: c.layers, fullIndexerLayers: c.fullIndexerLayers, denseLayers: c.denseLayers, indexerHeads: c.indexer.heads, attentionHeads: c.heads}});
}

function buildDeepSeek(shape, variantId) {
  const d = deriveDeepSeek(shape, variantId === 'totalParams' ? 'total' : 'active');
  const a = shape.assumptions, b = Object.fromEntries(Object.entries(a).map(([k, x]) => [k, x.value]));
  const bpp = {fp8: b.bytesPerParam.dense, dense: b.bytesPerParam.dense, sharedExpert: b.bytesPerParam.sharedExpert,
    routedExpert: b.bytesPerParam.routedExpert, routerAndLmHead: b.bytesPerParam.routerAndLmHead};
  const classes = [{id: 'dense_full', count: b.denseLayers, dense: true}, {id: 'moe_full', count: shape.reported.layers - b.denseLayers, dense: false}];
  const rows = [];
  for (const layer of classes) {
    addAttentionRows(rows, shape, layer.id, layer.count, bpp);
    addIndexerRows(rows, shape, layer.id, layer.count, bpp);
    addSparseRows(rows, shape, layer.id, layer.count);
    addFfnRows(rows, shape, layer.id, layer.count, bpp, shape.reported.activeExperts, d.derivation.expertHidden);
    addStateRows(rows, shape, layer.id, layer.count, true);
  }
  addCollectiveRow(rows, shape, shape.reported.layers, b.collectivesPerLayer);
  rows.push(row({operatorId: 'lm_head', layerClass: 'global', layerCount: 1, coreClass: 'L', dtype: 'bf16',
    parameterCount: b.vocab * shape.reported.hidden, parameterStorageBytes: b.vocab * shape.reported.hidden * bpp.routerAndLmHead,
    flopsPerLayer: 2 * b.vocab * shape.reported.hidden, bytesPerLayer: b.vocab * shape.reported.hidden * bpp.routerAndLmHead,
    bytesClass: 'weight', basis: 'untied BF16 LM head; embedding lookup excluded', source: MANIFEST_FILE}));
  return makeLedger('DeepSeek-V4-Pro', `reported ${variantId} variant; all non-reported dimensions remain assumptions`, rows,
    {variants: [{variantId: 'activeParams', parameterBasis: 'reported activeParamsB = 49'}, {variantId: 'totalParams', parameterBasis: 'reported totalParamsB = 1600'}],
      selectedVariant: variantId, shape: {layers: shape.reported.layers, denseLayers: b.denseLayers, indexerHeads: b.indexer.heads, attentionHeads: shape.reported.heads}, derivation: d.derivation});
}

function makeLedger(modelId, note, rows, extra) {
  const totals = rows.reduce((a, r) => {
    a.globalFlopsPerToken += r.globalFlopsPerToken;
    a.globalBytesPerToken += r.globalBytesPerToken;
    a.parameterCount += r.parameterCountPerLayer * r.layerCount;
    a.parameterStorageBytes += r.parameterStorageBytesPerLayer * r.layerCount;
    a.byBytesClass[r.bytesClass] = (a.byBytesClass[r.bytesClass] || 0) + r.globalBytesPerToken;
    a.byCoreClass[r.coreClass] = (a.byCoreClass[r.coreClass] || 0) + r.globalFlopsPerToken;
    return a;
  }, {globalFlopsPerToken: 0, globalBytesPerToken: 0, parameterCount: 0, parameterStorageBytes: 0, byBytesClass: {}, byCoreClass: {}});
  return {schemaVersion: FORMAT, modelId, evidenceClass: EVIDENCE, status: 'PLANNING_DERIVED', note,
    provenance: {manifest: MANIFEST_FILE, manifestSha256: sha256(manifestText()), source: 'teams/model/src/operator_ledger.js'},
    scenario: {batch: 1, contextTokens: CONTEXT, decodeTokens: 1, phase: 'decode'}, rows, totals, ...extra};
}

function build(modelId, variantId) {
  const m = manifest();
  const shape = m.models.find(x => x.modelId === modelId)?.shape;
  if (!shape) throw new Error(`unknown model ${modelId}`);
  if (modelId === 'GLM-5.2') return buildGlm(shape);
  if (modelId === 'DeepSeek-V4-Pro') return buildDeepSeek(shape, variantId || 'activeParams');
  throw new Error(`operator ledger only covers GLM-5.2 and DeepSeek-V4-Pro, got ${modelId}`);
}

function buildAll() {
  return {
    schemaVersion: 'model-operator-ledgers-v0.1',
    generatedBy: 'teams/model/src/operator_ledger.js',
    models: {
      'GLM-5.2': build('GLM-5.2'),
      'DeepSeek-V4-Pro': {variants: {activeParams: build('DeepSeek-V4-Pro', 'activeParams'), totalParams: build('DeepSeek-V4-Pro', 'totalParams')}}
    }
  };
}

module.exports = {FORMAT, EVIDENCE, MANIFEST_FILE, CONTEXT, build, buildAll, buildGlm, buildDeepSeek, makeLedger};
