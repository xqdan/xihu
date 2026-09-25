'use strict';
/* Generate data/workload/planning_operator_workload.json.
 *
 * K3 rows are DERIVED from the single K3 shape source, src/core/design_engine.js
 * (MODEL_PRESETS.kimiK3), with the attention and KV layout of the detailed
 * model (absorbed MLA, FP8 KV cache). The derived totals are reconciled against
 * the detailed plan of the published point (src/rdma/k3_rdma_final_tuning_model.js).
 *
 * DeepSeek-V4-Pro rows are DERIVED from the manifest shape block: reported
 * fields from model_profiles.json plus explicit ASSUMPTION fields. Nothing is
 * ratio-scaled from K3.
 *
 * GLM-5.2 rows are DERIVED from the manifest shape block: fields of the public
 * HF config.json plus explicit ASSUMPTION fields for the deployment layout.
 *
 * The planning token-time calibration (models/planning/token_time.js) is fitted
 * once here on the K3 detailed published point and stored with the workload.
 *
 * Run: node scripts/generate_planning_operator_workload.js
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const E = require('../src/core/design_engine.js');
const O = require('../src/rdma/k3_rdma_final_tuning_model.js');
const TT = require('../models/planning/token_time.js');

const root = path.resolve(__dirname, '..');
const read = p => JSON.parse(fs.readFileSync(path.join(root, p), 'utf8').replace(/^﻿/, ''));
const hashFile = p => crypto.createHash('sha256').update(fs.readFileSync(path.join(root, p))).digest('hex');
const TP_REFERENCE = 32;
const CONTEXT = 1048576;
const CALIBRATION_SLOT = {tp: TP_REFERENCE, physicalProfile: 'P1', mcProfile: 'MC640'};
const sum = (rows, i) => rows.filter(r => r[4] !== 'collective').reduce((s, r) => s + r[i], 0);

// ---------------------------------------------------------------- K3 (derived)
const spec = E.MODEL_PRESETS.kimiK3;
const m = E.deriveModel(spec);
const a = spec.attention;
const la = spec.linearAttention;
const p = m.params;
const b = m.bytes;
const finalTuning = read('data/rdma/k3_rdma_final_tuning_results.json');
const best = finalTuning.search.best;
const detailedPlan = O.mapped(best.x).plan;
// Absorbed MLA decode (as in the detailed model): QK over latent + RoPE, PV over the latent.
const absorbedQk = a.kvLatent + a.ropeDim;
const absorbedPv = a.kvLatent;
const softmaxAttentionFlops = m.softmaxLayers * 2 * CONTEXT * a.heads * (absorbedQk + absorbedPv);
const kdaFlops = la.layers * a.heads * la.stateDim * la.stateDim * 7;
const kvBytesPerToken = detailedPlan.kvBytesPerToken; // FP8 FlashMLA layout, 656 B
const kvBytes = m.softmaxLayers * CONTEXT * kvBytesPerToken;

// Collective bytes/FLOP per token from the detailed model (per rank at TP32, scaled to global).
const collectiveWireBytesGlobal = best.wireBytes * TP_REFERENCE;
const collectiveFlopsGlobal = collectiveWireBytesGlobal / spec.dtype.dense; // one accumulate per transported BF16 element (planning estimate)

const k3Rows = [
  ['dense_projection', 'L', 2 * (p.attn + p.wdown + p.wup + p.shared + p.router + p.denseFfn + p.lmHead),
    b.attn + b.wdown + b.wup + b.shared + b.router + b.denseFfn + b.lmHead, 'weight'],
  ['routed_moe', 'L', 2 * p.routedActive, b.routedActive, 'expert'],
  ['attention', 'H', softmaxAttentionFlops, kvBytes, 'kv_state'],
  ['kda_state', 'V', kdaFlops, 2 * m.kdaStateStore, 'kv_state'],
  ['collective_reduce', 'REDUCE', collectiveFlopsGlobal, collectiveWireBytesGlobal, 'collective']
];
const k3Flops = sum(k3Rows, 2);
const k3Bytes = sum(k3Rows, 3);

// ------------------------------------------- reconciliation with detailed plan
const detailedFlops = detailedPlan.ops.reduce((s, o) => s + (o.flops || 0), 0) * TP_REFERENCE;
const detailedReadBytes = best.readBytes * TP_REFERENCE;
const reconciliation = {
  source: 'src/rdma/k3_rdma_final_tuning_model.js mapped(best.x).plan (per rank x TP32)',
  detailedGlobalFlopsPerToken: detailedFlops,
  derivedGlobalFlopsPerToken: k3Flops,
  flopsRatioDerivedOverCalibrated: k3Flops / detailedFlops,
  detailedGlobalReadBytesPerToken: detailedReadBytes,
  derivedGlobalMemoryBytesPerToken: k3Bytes,
  bytesRatioDerivedOverCalibrated: k3Bytes / detailedReadBytes,
  note: 'Derived bytes count each weight/KV/state byte once. The detailed read traffic also carries expert prefetch mis-prediction re-reads, so it is somewhat larger; the calibrated kMemory absorbs the gap together with the DMA efficiency.'
};

// ------------------------------------------------ DeepSeek-V4-Pro (derived)
const manifest = read('data/workload/formal_model_manifests.json');
const dsManifest = manifest.models.find(x => x.modelId === 'DeepSeek-V4-Pro');
const glmManifest = manifest.models.find(x => x.modelId === 'GLM-5.2');

function deriveDeepSeek(shape) {
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
  const expertHidden = (r.activeParamsB * 1e9 - fixedActive) / (moeLayers * activeExpertsPerLayer * perExpertPerI);
  const expertParams = perExpertPerI * expertHidden;
  const impliedTotal = fixedActive + moeLayers * (r.routedExperts + r.sharedExperts) * expertParams;

  const denseMatmulParams = r.layers * (attnParams + indexerParams) + v.denseLayers * denseFfnParams
    + moeLayers * (routerParams + r.sharedExperts * expertParams) + lmHeadParams; // embedding is a row lookup, not a matmul
  const routedActiveParams = moeLayers * r.activeExperts * expertParams;
  const indexerFlops = r.layers * CONTEXT * idx.heads * idx.headDim * 2;
  const indexerBytes = r.layers * CONTEXT * idx.keyBytesPerToken;
  const sparseFlops = r.layers * 2 * r.indexerTopK * r.heads * ((mla.kvLatent + mla.ropeDim) + mla.kvLatent);
  const sparseBytes = r.layers * r.indexerTopK * v.kvBytesPerTokenPerLayer;
  const collectivesPerToken = r.layers * v.collectivesPerLayer;
  const collectiveBytes = collectivesPerToken * 2 * H * 2 * TP_REFERENCE; // per-rank ring message x TP ranks
  const rows = [
    ['dense_projection', 'L', 2 * denseMatmulParams, denseMatmulParams * bpp.dense, 'weight'],
    ['routed_moe', 'L', 2 * routedActiveParams, routedActiveParams * bpp.routedExpert, 'expert'],
    ['indexer', 'INDEXER', indexerFlops, indexerBytes, 'index'],
    ['sparse_attention', 'H', sparseFlops, sparseBytes, 'kv_state'],
    ['collective_reduce', 'REDUCE', collectiveBytes / 2, collectiveBytes, 'collective']
  ];
  return {
    rows,
    collectivesPerToken,
    derivation: {
      attentionParamsPerLayer: attnParams,
      indexerParamsPerLayer: indexerParams,
      denseFfnParamsPerLayer: denseFfnParams,
      moeLayers,
      expertHidden,
      expertHiddenBasis: 'solved from reportedActiveParams = 49B (embedding included)',
      activeParams: fixedActive + moeLayers * activeExpertsPerLayer * expertParams,
      impliedTotalParams: impliedTotal,
      impliedTotalOverReported: impliedTotal / (r.totalParamsB * 1e9),
      mtpApplied: false
    }
  };
}
const ds = deriveDeepSeek(dsManifest.shape);

// ------------------------------------------------------ GLM-5.2 (from config)
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
const glm = deriveGlm(glmManifest.shape);

// ----------------------------------------------------------- calibration
const k3Model = {rows: k3Rows, collectivesPerToken: best.collectiveCount};
const calibration = TT.calibrate(k3Model, CALIBRATION_SLOT, best);
// Out-of-fit check: the same factors at MC320 against a fresh detailed replay.
const mc320 = O.evaluate({...best.x, mcGBs: 320});
const planningMc320 = TT.slotTime(k3Model, {...CALIBRATION_SLOT, mcProfile: 'MC320'}, calibration);
calibration.validation = {
  slot: {...CALIBRATION_SLOT, mcProfile: 'MC320'},
  detailedTpsPerUser: mc320.tps,
  planningTpsPerUser: planningMc320.tpsPerUser,
  planningOverDetailed: planningMc320.tpsPerUser / mc320.tps,
  note: 'Not fitted: same kMemory/kCompute replayed against the detailed model with mcGBs = 320.'
};

const out = {
  schemaVersion: 'planning-operator-workload-v0.4',
  status: 'K3_SHAPE_DERIVED; GLM-5.2 SHAPE_DERIVED_FROM_CONFIG; DEEPSEEK-V4-PRO SHAPE_DERIVED_WITH_ASSUMPTIONS',
  generatedBy: 'scripts/generate_planning_operator_workload.js',
  units: {
    flops: 'global FLOP/token',
    bytes: 'global byte/token before TP',
    rate: 'SI per package rank'
  },
  sourceHashes: {
    designEngine: hashFile('src/core/design_engine.js'),
    finalTuningModel: hashFile('src/rdma/k3_rdma_final_tuning_model.js'),
    finalTuningResults: hashFile('data/rdma/k3_rdma_final_tuning_results.json'),
    formalModelManifests: hashFile('data/workload/formal_model_manifests.json'),
    tokenTime: hashFile('models/planning/token_time.js'),
    resourceProfiles: hashFile('models/planning/resource_profiles.js')
  },
  provenance: {
    K3: {
      status: 'SHAPE_DERIVED_FROM_ENGINEERING_PRESET',
      shapeSource: 'src/core/design_engine.js#MODEL_PRESETS.kimiK3',
      attentionParameterSource: m.attnSource,
      attentionFlopBasis: `absorbed MLA: ${m.softmaxLayers} layers x 2 x context x ${a.heads} heads x (${absorbedQk} + ${absorbedPv})`,
      kvBytesPerTokenPerLayer: kvBytesPerToken,
      kvBytesSource: 'src/rdma/k3_rdma_final_tuning_model.js mapped(best.x).plan.kvBytesPerToken (OPT.kvCache = fp8)',
      context: CONTEXT,
      collectiveSource: `data/rdma/k3_rdma_final_tuning_results.json#/search/best/wireBytes x TP${TP_REFERENCE}; collectiveCount on the reference-393 basis`,
      reconciliation
    },
    'GLM-5.2': {
      status: 'SHAPE_DERIVED_FROM_CONFIG',
      shapeSource: 'data/workload/formal_model_manifests.json#/models/1/shape',
      configSource: glmManifest.shape.config.source,
      assumptions: Object.keys(glmManifest.shape.assumptions),
      derivation: glm.derivation,
      note: 'Shape fields come from the public config.json; the FP8 KV layout, index-key bytes, TP mapping and collectives per layer are ASSUMPTION. Shared indexer layers reuse the previous full layer top-k. MTP is excluded from TPS/usr.'
    },
    'DeepSeek-V4-Pro': {
      status: 'SHAPE_DERIVED_WITH_ASSUMPTIONS',
      shapeSource: 'data/workload/formal_model_manifests.json#/models/2/shape',
      assumptions: Object.keys(dsManifest.shape.assumptions),
      derivation: ds.derivation,
      note: 'Every field outside shape.reported is an ASSUMPTION (DeepSeek-V3/V3.2 dimensions). MTP is excluded from TPS/usr.'
    }
  },
  collectivesPerToken: {
    K3: best.collectiveCount,
    'GLM-5.2': glm.collectivesPerToken,
    'DeepSeek-V4-Pro': ds.collectivesPerToken
  },
  calibration,
  limitations: [
    'K3 rows are derived from the repository engineering preset, which is itself not vendor-confirmed.',
    'DeepSeek-V4-Pro rows rest on ASSUMPTION fields (DeepSeek-V3/V3.2 dimensions); the expert hidden size is solved from the reported 49B active parameters.',
    'GLM-5.2 rows follow the public config.json; its KV/index-key byte layout, TP mapping and collectives per layer are ASSUMPTION fields.',
    'kMemory/kCompute are fitted on K3 only; applying them to GLM-5.2 and DeepSeek-V4-Pro is a planning ASSUMPTION.',
    'Collective FLOP is a planning estimate (one accumulate per transported element).'
  ],
  operators: {
    K3: k3Rows,
    'GLM-5.2': glm.rows,
    'DeepSeek-V4-Pro': ds.rows
  }
};
fs.writeFileSync(path.join(root, 'data/workload/planning_operator_workload.json'), `${JSON.stringify(out, null, 2)}\n`);
console.log(JSON.stringify({
  k3GlobalFlopsPerToken: k3Flops,
  k3GlobalBytesPerToken: k3Bytes,
  reconciliation: {flops: reconciliation.flopsRatioDerivedOverCalibrated, bytes: reconciliation.bytesRatioDerivedOverCalibrated},
  calibration: {kMemory: calibration.kMemory, kCompute: calibration.kCompute, calibratedTps: calibration.calibratedTpsPerUser, detailedTps: calibration.detailedTpsPerUser, residualUs: calibration.rawResidualUs, mc320: calibration.validation},
  glm: {activeParams: glm.derivation.activeParams, totalWithMtpOverReported: glm.derivation.totalWithMtpOverReported, collectivesPerToken: glm.collectivesPerToken},
  deepseek: {expertHidden: ds.derivation.expertHidden, impliedTotalOverReported: ds.derivation.impliedTotalOverReported, collectivesPerToken: ds.collectivesPerToken}
}, null, 2));
