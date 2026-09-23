'use strict';
/* Generate data/workload/planning_operator_workload.json.
 *
 * K3 rows are DERIVED from the single K3 shape source, src/core/design_engine.js
 * (MODEL_PRESETS.kimiK3), so the planning pipeline and the RDMA tile simulator
 * describe the same model. The derived totals are reconciled against the
 * calibrated directional baseline (data/direction/directional_workload_baseline.json).
 *
 * GLM-5.2 and DeepSeek-V4-Pro have no verified shapes. Their rows keep the
 * previously hand-authored operator mix but are rescaled so that the ratio of
 * each model to K3 is preserved against the derived K3 totals. They remain
 * UNVERIFIED planning inputs.
 *
 * Run: node scripts/generate_planning_operator_workload.js
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const E = require('../src/core/design_engine.js');

const root = path.resolve(__dirname, '..');
const read = p => JSON.parse(fs.readFileSync(path.join(root, p), 'utf8').replace(/^﻿/, ''));
const hashFile = p => crypto.createHash('sha256').update(fs.readFileSync(path.join(root, p))).digest('hex');
const TP_REFERENCE = 32;
const CONTEXT = 1048576;

// ---------------------------------------------------------------- K3 (derived)
const spec = E.MODEL_PRESETS.kimiK3;
const m = E.deriveModel(spec);
const a = spec.attention;
const la = spec.linearAttention;
const p = m.params;
const b = m.bytes;
const softmaxAttentionFlops = m.softmaxLayers * 2 * CONTEXT * a.heads * (a.qkHeadDim + a.vHeadDim);
const kdaFlops = la.layers * a.heads * la.stateDim * la.stateDim * 7;
const kvBytes = m.softmaxLayers * CONTEXT * m.kvPerTokenPerLayer;

// Collective bytes/FLOP per token from the calibrated RDMA tile model (per rank at TP32, scaled to global).
const finalTuning = read('data/rdma/k3_rdma_final_tuning_results.json');
const best = finalTuning.search.best;
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
const k3Flops = k3Rows.filter(r => r[4] !== 'collective').reduce((s, r) => s + r[2], 0);
const k3Bytes = k3Rows.filter(r => r[4] !== 'collective').reduce((s, r) => s + r[3], 0);

// ------------------------------------------------ reconciliation with baseline
const baseline = read('data/direction/directional_workload_baseline.json').models.find(x => x.modelId === 'K3');
const reconciliation = {
  calibratedGlobalFlopsPerToken: baseline.globalFlopsPerToken,
  derivedGlobalFlopsPerToken: k3Flops,
  flopsRatioDerivedOverCalibrated: k3Flops / baseline.globalFlopsPerToken,
  calibratedGlobalMemoryBytesPerToken: baseline.globalMemoryBytesPerToken,
  derivedGlobalMemoryBytesPerToken: k3Bytes,
  bytesRatioDerivedOverCalibrated: k3Bytes / baseline.globalMemoryBytesPerToken,
  note: 'Derived bytes count each weight/KV byte once. The calibrated baseline is the RDMA tile simulator read traffic, which includes expert prefetch mis-prediction (2-p) re-reads and tile re-loads, so it is expected to be somewhat larger.'
};

// -------------------------------------------- GLM / DeepSeek (ratio-preserved)
const previous = {
  // hand-authored 2026-09-22 planning rows, kept only for their model-to-K3 ratios
  K3: {flops: 28.8e12, bytes: 8.11e12},
  'GLM-5.2': [
    ['dense_projection', 'L', 4.5e12, 1.2e12, 'weight'],
    ['routed_moe', 'L', 22e12, 5.86e12, 'expert'],
    ['indexer', 'INDEXER', 2e12, 0.6e12, 'index'],
    ['sparse_attention', 'H', 5e12, 1.65e12, 'kv_state'],
    ['collective_dispatch', 'REDUCE', 0.3e12, 0.12e12, 'collective']
  ],
  'DeepSeek-V4-Pro': [
    ['dense_projection', 'L', 5.2e12, 1.39e12, 'weight'],
    ['routed_moe', 'L', 25e12, 6.83e12, 'expert'],
    ['indexer', 'INDEXER', 3e12, 0.85e12, 'index'],
    ['sparse_attention', 'H', 7e12, 2.3e12, 'kv_state'],
    ['expert_dispatch', 'REDUCE', 0.5e12, 0.2e12, 'collective']
  ]
};
const flopsScale = k3Flops / previous.K3.flops;
const bytesScale = k3Bytes / previous.K3.bytes;
const rescale = rows => rows.map(([id, core, flops, bytes, cls]) => [id, core, flops * flopsScale, bytes * bytesScale, cls]);

const out = {
  schemaVersion: 'planning-operator-workload-v0.2',
  status: 'K3_SHAPE_DERIVED; GLM-5.2 AND DEEPSEEK-V4-PRO UNVERIFIED',
  generatedBy: 'scripts/generate_planning_operator_workload.js',
  units: {
    flops: 'global FLOP/token',
    bytes: 'global byte/token before TP',
    rate: 'SI per package rank'
  },
  sourceHashes: {
    designEngine: hashFile('src/core/design_engine.js'),
    finalTuningResults: hashFile('data/rdma/k3_rdma_final_tuning_results.json'),
    directionalWorkloadBaseline: hashFile('data/direction/directional_workload_baseline.json')
  },
  provenance: {
    K3: {
      status: 'SHAPE_DERIVED_FROM_ENGINEERING_PRESET',
      shapeSource: 'src/core/design_engine.js#MODEL_PRESETS.kimiK3',
      attentionParameterSource: m.attnSource,
      context: CONTEXT,
      collectiveSource: `data/rdma/k3_rdma_final_tuning_results.json#/search/best/wireBytes x TP${TP_REFERENCE}`,
      reconciliation
    },
    'GLM-5.2': {status: 'UNVERIFIED_RATIO_SCALED_FROM_K3', flopsScale, bytesScale, note: 'Hand-authored operator mix rescaled to the derived K3 totals; replace with shape-derived rows once the manifest is confirmed.'},
    'DeepSeek-V4-Pro': {status: 'UNVERIFIED_RATIO_SCALED_FROM_K3', flopsScale, bytesScale, note: 'Hand-authored operator mix rescaled to the derived K3 totals; replace with shape-derived rows once the manifest is confirmed.'}
  },
  limitations: [
    'K3 rows are derived from the repository engineering preset, which is itself not vendor-confirmed.',
    'GLM-5.2 and DeepSeek-V4-Pro rows are not derived from verified model shapes.',
    'Collective FLOP is a planning estimate (one accumulate per transported element).'
  ],
  operators: {
    K3: k3Rows,
    'GLM-5.2': rescale(previous['GLM-5.2']),
    'DeepSeek-V4-Pro': rescale(previous['DeepSeek-V4-Pro'])
  }
};
fs.writeFileSync(path.join(root, 'data/workload/planning_operator_workload.json'), `${JSON.stringify(out, null, 2)}\n`);
console.log(JSON.stringify({k3GlobalFlopsPerToken: k3Flops, k3GlobalBytesPerToken: k3Bytes, reconciliation: {flops: reconciliation.flopsRatioDerivedOverCalibrated, bytes: reconciliation.bytesRatioDerivedOverCalibrated}}, null, 2));
