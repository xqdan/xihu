'use strict';
/* Generate out/workload/planning_operator_workload.json.
 *
 * K3 rows are DERIVED from the single K3 shape source, teams/model/src/design_engine.js
 * (MODEL_PRESETS.kimiK3), with the attention and KV layout of the detailed
 * model (absorbed MLA, FP8 KV cache). The derived totals are reconciled against
 * the detailed plan of the published point (integration/detailed/k3_rdma_final_tuning_model.js).
 *
 * DeepSeek-V4-Pro rows are DERIVED from the manifest shape block: reported
 * fields from model_profiles.json plus explicit ASSUMPTION fields. Nothing is
 * ratio-scaled from K3. The reported 49B active and 1.6T total do not agree
 * under the ASSUMPTION fields, so the expert hidden size is solved both ways:
 * the point estimate from 49B active, the variant expertHiddenFromTotal from
 * 1.6T total (ADR-0008).
 *
 * GLM-5.2 rows are DERIVED from the manifest shape block: fields of the public
 * HF config.json plus explicit ASSUMPTION fields for the deployment layout.
 * Both derivations are owned by the Model team (teams/model/src/workload_derivation.js).
 *
 * The planning token-time calibration (integration/planning/token_time.js) is fitted
 * once here on the timing breakdown of the K3 detailed published point and
 * stored with the workload. The dtype policy of each model is recorded
 * explicitly, and a K3 FP8-dense comparison model is stored (not ranked).
 *
 * Run: node integration/pipelines/generate_planning_operator_workload.js
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const E = require('../../teams/model/src/design_engine.js');
const O = require('../detailed/k3_rdma_final_tuning_model.js');
const TT = require('../planning/token_time.js');
const {CONTEXT, TP_REFERENCE, deriveDeepSeek, deriveGlm} = require('../../teams/model/src/workload_derivation.js');

const root = path.resolve(__dirname, '../..');
const read = p => JSON.parse(fs.readFileSync(path.join(root, p), 'utf8').replace(/^﻿/, ''));
const hashFile = p => crypto.createHash('sha256').update(fs.readFileSync(path.join(root, p))).digest('hex');
const CALIBRATION_SLOT = {tp: TP_REFERENCE, physicalProfile: 'P1', mcProfile: 'MC640'};
const sum = (rows, i) => rows.filter(r => r[4] !== 'collective').reduce((s, r) => s + r[i], 0);

// ---------------------------------------------------------------- K3 (derived)
const spec = E.MODEL_PRESETS.kimiK3;
const m = E.deriveModel(spec);
const a = spec.attention;
const la = spec.linearAttention;
const p = m.params;
const b = m.bytes;
const finalTuning = read('out/rdma/k3_rdma_final_tuning_results.json');
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
// Comparison only (fix of the dtype asymmetry, ADR-0008): K3 with FP8 attention/shared/latent
// projections and BF16 router + LM head, i.e. the GLM-5.2 / DeepSeek-V4-Pro dense policy.
const k3Fp8DenseRows = k3Rows.map(r => r[0] === 'dense_projection'
  ? [r[0], r[1], r[2], (p.attn + p.wdown + p.wup + p.shared + p.denseFfn) * 1 + (p.router + p.lmHead) * 2, r[4]]
  : r);
const k3Flops = sum(k3Rows, 2);
const k3Bytes = sum(k3Rows, 3);

// ------------------------------------------- reconciliation with detailed plan
const detailedFlops = detailedPlan.ops.reduce((s, o) => s + (o.flops || 0), 0) * TP_REFERENCE;
const detailedReadBytes = best.readBytes * TP_REFERENCE;
const reconciliation = {
  source: 'integration/detailed/k3_rdma_final_tuning_model.js mapped(best.x).plan (per rank x TP32)',
  detailedGlobalFlopsPerToken: detailedFlops,
  derivedGlobalFlopsPerToken: k3Flops,
  flopsRatioDerivedOverCalibrated: k3Flops / detailedFlops,
  detailedGlobalReadBytesPerToken: detailedReadBytes,
  derivedGlobalMemoryBytesPerToken: k3Bytes,
  bytesRatioDerivedOverCalibrated: k3Bytes / detailedReadBytes,
  expertRereadBytesPerToken: best.wrongBytes * TP_REFERENCE,
  derivedPlusRereadOverDetailed: (k3Bytes + best.wrongBytes * TP_REFERENCE) / detailedReadBytes,
  note: 'Derived bytes count each weight/KV/state byte once. The detailed read traffic also carries expert prefetch mis-prediction re-reads (wrongBytes); the token time charges them with the separate expertReread factor on routed-expert bytes, and kMemory carries only the DMA efficiency.'
};

// ------------------------------- GLM-5.2 and DeepSeek-V4-Pro (Model team derivation)
const manifest = read('teams/model/inputs/formal_model_manifests.json');
const dsManifest = manifest.models.find(x => x.modelId === 'DeepSeek-V4-Pro');
const glmManifest = manifest.models.find(x => x.modelId === 'GLM-5.2');
const ds = deriveDeepSeek(dsManifest.shape, 'active');
const dsFromTotal = deriveDeepSeek(dsManifest.shape, 'total');
const glm = deriveGlm(glmManifest.shape);

// ----------------------------------------------------------- calibration
const k3Model = {rows: k3Rows, collectivesPerToken: best.collectiveCount, layers: spec.layers};
const calibration = TT.calibrate(k3Model, CALIBRATION_SLOT, best, TT.detailedBreakdown(detailedPlan.ops));
// Out-of-fit check: the same factors at MC320 against a fresh detailed replay.
const mc320 = O.evaluate({...best.x, mcGBs: 320});
const planningMc320 = TT.slotTime(k3Model, {...CALIBRATION_SLOT, mcProfile: 'MC320'}, calibration);
calibration.validation = {
  slot: {...CALIBRATION_SLOT, mcProfile: 'MC320'},
  detailedTpsPerUser: mc320.tps,
  planningTpsPerUser: planningMc320.tpsPerUser,
  planningOverDetailed: planningMc320.tpsPerUser / mc320.tps,
  note: 'Not fitted: same factors replayed against the detailed model with mcGBs = 320.'
};

const out = {
  schemaVersion: 'planning-operator-workload-v0.5',
  status: 'K3_SHAPE_DERIVED; GLM-5.2 SHAPE_DERIVED_FROM_CONFIG; DEEPSEEK-V4-PRO SHAPE_DERIVED_WITH_ASSUMPTIONS',
  generatedBy: 'integration/pipelines/generate_planning_operator_workload.js',
  units: {
    flops: 'global FLOP/token',
    bytes: 'global byte/token before TP',
    rate: 'SI per package rank'
  },
  sourceHashes: {
    designEngine: hashFile('teams/model/src/design_engine.js'),
    finalTuningModel: hashFile('integration/detailed/k3_rdma_final_tuning_model.js'),
    finalTuningResults: hashFile('out/rdma/k3_rdma_final_tuning_results.json'),
    formalModelManifests: hashFile('teams/model/inputs/formal_model_manifests.json'),
    workloadDerivation: hashFile('teams/model/src/workload_derivation.js'),
    tokenTime: hashFile('integration/planning/token_time.js'),
    resourceProfiles: hashFile('teams/hardware/src/resource_profiles.js')
  },
  provenance: {
    K3: {
      status: 'SHAPE_DERIVED_FROM_ENGINEERING_PRESET',
      shapeSource: 'teams/model/src/design_engine.js#MODEL_PRESETS.kimiK3',
      attentionParameterSource: m.attnSource,
      attentionFlopBasis: `absorbed MLA: ${m.softmaxLayers} layers x 2 x context x ${a.heads} heads x (${absorbedQk} + ${absorbedPv})`,
      kvBytesPerTokenPerLayer: kvBytesPerToken,
      kvBytesSource: 'integration/detailed/k3_rdma_final_tuning_model.js mapped(best.x).plan.kvBytesPerToken (OPT.kvCache = fp8)',
      context: CONTEXT,
      collectiveSource: `out/rdma/k3_rdma_final_tuning_results.json#/search/best/wireBytes x TP${TP_REFERENCE}; collectiveCount on the reference-393 basis`,
      reconciliation
    },
    'GLM-5.2': {
      status: 'SHAPE_DERIVED_FROM_CONFIG',
      shapeSource: 'teams/model/inputs/formal_model_manifests.json#/models/1/shape',
      configSource: glmManifest.shape.config.source,
      assumptions: Object.keys(glmManifest.shape.assumptions),
      derivation: glm.derivation,
      note: 'Shape fields come from the public config.json; the FP8 KV layout, index-key bytes and collectives per layer are ASSUMPTION; the TP-only FFN/MoE mapping is a deployment decision. Shared indexer layers reuse the previous full layer top-k. MTP is excluded from TPS/usr.'
    },
    'DeepSeek-V4-Pro': {
      status: 'SHAPE_DERIVED_WITH_ASSUMPTIONS',
      shapeSource: 'teams/model/inputs/formal_model_manifests.json#/models/2/shape',
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
  layers: {
    K3: spec.layers,
    'GLM-5.2': glm.layers,
    'DeepSeek-V4-Pro': ds.layers
  },
  // Weight dtype per model. The policies differ; the scorecard shows them next to TPS/usr.
  dtypePolicy: {
    K3: {
      attentionAndDenseProjections: 'BF16', sharedExpert: 'BF16', routerAndLmHead: 'BF16', routedExpert: 'MXFP4 (0.53125 B)',
      kvCache: 'FP8 FlashMLA (656 B/token/layer)',
      source: 'teams/model/src/design_engine.js#MODEL_PRESETS.kimiK3.dtype (dense 2 B); the K3 detailed published point is BF16 dense'
    },
    'GLM-5.2': {
      attentionAndDenseProjections: 'FP8', sharedExpert: 'FP8', routerAndLmHead: 'BF16', routedExpert: 'FP8',
      kvCache: 'FP8 FlashMLA (656 B/token/layer, ASSUMPTION)',
      source: 'zai-org/GLM-5.2-FP8 quantization_config'
    },
    'DeepSeek-V4-Pro': {
      attentionAndDenseProjections: 'FP8', sharedExpert: 'FP8', routerAndLmHead: 'BF16 (aligned with GLM-5.2)', routedExpert: 'FP4 (0.53125 B)',
      kvCache: 'FP8 FlashMLA (656 B/token/layer, ASSUMPTION)',
      source: 'teams/model/inputs/formal_model_manifests.json#/models/2/shape/assumptions/bytesPerParam (ASSUMPTION)'
    }
  },
  // Shape-ambiguity alternatives: same slot formula, reported as a TPS/usr range.
  variants: {
    'DeepSeek-V4-Pro': {
      expertHiddenFromTotal: {
        rows: dsFromTotal.rows,
        collectivesPerToken: dsFromTotal.collectivesPerToken,
        layers: dsFromTotal.layers,
        derivation: dsFromTotal.derivation
      }
    }
  },
  // Comparison models: recomputed in the scorecard, never ranked or used for selection.
  comparisons: {
    'K3-FP8-dense': {
      baseModelId: 'K3',
      rows: k3Fp8DenseRows,
      collectivesPerToken: best.collectiveCount,
      layers: spec.layers,
      note: 'K3 with the GLM-5.2 / DeepSeek-V4-Pro dense dtype policy (FP8 attention/shared/latent projections, BF16 router and LM head); routed experts and KV unchanged. Not a K3 configuration of record.'
    }
  },
  calibration,
  limitations: [
    'K3 rows are derived from the repository engineering preset, which is itself not vendor-confirmed.',
    'DeepSeek-V4-Pro rows rest on ASSUMPTION fields (DeepSeek-V3/V3.2 dimensions); the expert hidden size is solved from the reported 49B active parameters.',
    'GLM-5.2 rows follow the public config.json; its KV/index-key byte layout and collectives per layer are ASSUMPTION fields.',
    'FFN/MoE is TP-only for all three models (deployment decision): no expert parallelism, no all-to-all dispatch row.',
    'The token-time factors (expertReread, kMemory, kFlop, fixedPerLayerUs, kTmaExposedUsPerGB) are fitted on K3 only; applying them to GLM-5.2 and DeepSeek-V4-Pro is a planning ASSUMPTION.',
    'DeepSeek-V4-Pro: the reported 49B active and 1.6T total disagree under the ASSUMPTION fields; the point estimate uses 49B active, the variant expertHiddenFromTotal uses 1.6T total.',
    'Dense weight dtype differs by model (K3 BF16; GLM-5.2 and DeepSeek-V4-Pro FP8 with BF16 router and LM head); see dtypePolicy and the K3-FP8-dense comparison.',
    'Collective FLOP is a planning estimate (one accumulate per transported element).'
  ],
  operators: {
    K3: k3Rows,
    'GLM-5.2': glm.rows,
    'DeepSeek-V4-Pro': ds.rows
  }
};
fs.writeFileSync(path.join(root, 'out/workload/planning_operator_workload.json'), `${JSON.stringify(out, null, 2)}\n`);
console.log(JSON.stringify({
  k3GlobalFlopsPerToken: k3Flops,
  k3GlobalBytesPerToken: k3Bytes,
  reconciliation: {flops: reconciliation.flopsRatioDerivedOverCalibrated, bytes: reconciliation.bytesRatioDerivedOverCalibrated},
  calibration: {expertReread: calibration.expertReread, kMemory: calibration.kMemory, kFlop: calibration.kFlop, fixedPerLayerUs: calibration.fixedPerLayerUs, kTmaExposedUsPerGB: calibration.kTmaExposedUsPerGB, calibratedTps: calibration.calibratedTpsPerUser, detailedTps: calibration.detailedTpsPerUser, residualUs: calibration.rawResidualUs, mc320: calibration.validation},
  glm: {activeParams: glm.derivation.activeParams, totalWithMtpOverReported: glm.derivation.totalWithMtpOverReported, collectivesPerToken: glm.collectivesPerToken},
  deepseek: {expertHidden: ds.derivation.expertHidden, impliedTotalOverReported: ds.derivation.impliedTotalOverReported, expertHiddenFromTotal: dsFromTotal.derivation.expertHidden, activeFromTotal: dsFromTotal.derivation.activeParams, collectivesPerToken: ds.collectivesPerToken}
}, null, 2));
