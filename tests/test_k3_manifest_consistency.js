'use strict';
// K3 has exactly one shape source: src/core/design_engine.js MODEL_PRESETS.kimiK3.
// The formal planning manifest, the model profile and the planning operator
// workload must agree with it. GLM-5.2 layer count must agree between the
// manifest and the profile.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const E = require('../src/core/design_engine.js');
const root = path.resolve(__dirname, '..');
const read = p => JSON.parse(fs.readFileSync(path.join(root, p), 'utf8').replace(/^﻿/, ''));

const preset = E.MODEL_PRESETS.kimiK3;
const manifest = read('data/workload/formal_model_manifests.json');
const profiles = read('data/workload/model_profiles.json');
const workload = read('data/workload/planning_operator_workload.json');
const k3 = manifest.models.find(m => m.modelId === 'K3');

assert.strictEqual(manifest.singleSourceOfTruth.K3, 'src/core/design_engine.js#MODEL_PRESETS.kimiK3');
assert.strictEqual(k3.layerCount, preset.layers);
assert.strictEqual(k3.moeLayerCount, preset.moeLayers);
assert.strictEqual(k3.hiddenSize, preset.hidden);
assert.strictEqual(k3.moeLatent, preset.moe.latent);
assert.strictEqual(k3.expertHidden, preset.moe.expertHidden);
assert.strictEqual(k3.expertConfig.experts, preset.moe.totalExperts);
assert.strictEqual(k3.expertConfig.activeExpertsPerToken, preset.moe.activeExperts);
assert.strictEqual(k3.expertConfig.sharedExperts, preset.moe.sharedExperts);
assert.strictEqual(k3.expertConfig.expertInput, preset.moe.expertInput);
assert.strictEqual(k3.attention.heads, preset.attention.heads);
assert.strictEqual(k3.attention.qkHeadDim, preset.attention.qkHeadDim);
assert.strictEqual(k3.attention.vHeadDim, preset.attention.vHeadDim);
assert.strictEqual(k3.attention.kvLatent, preset.attention.kvLatent);
assert.strictEqual(k3.attention.ropeDim, preset.attention.ropeDim);
assert.strictEqual(k3.attention.linearAttentionLayers, preset.linearAttention.layers);
assert.strictEqual(k3.attention.linearStateDim, preset.linearAttention.stateDim);
assert.strictEqual(k3.attention.softmaxLayers, preset.layers - preset.linearAttention.layers);
assert.strictEqual(k3.dtype.routedBytesPerParam, preset.dtype.routed);
assert.strictEqual(k3.dtype.denseBytesPerParam, preset.dtype.dense);

const k3Profile = profiles.profiles.find(p => p.id === 'K3');
assert.strictEqual(k3Profile.layerCount, preset.layers);
assert.strictEqual(k3Profile.shapeSource, manifest.singleSourceOfTruth.K3);

// Planning operator workload: K3 rows regenerate from the preset.
assert.strictEqual(workload.provenance.K3.status, 'SHAPE_DERIVED_FROM_ENGINEERING_PRESET');
const m = E.deriveModel(preset);
const p = m.params, b = m.bytes;
const rows = Object.fromEntries(workload.operators.K3.map(r => [r[0], r]));
const close = (a, e, label) => assert(Math.abs(a - e) <= 1e-6 * Math.max(1, Math.abs(e)), `${label}: ${a} != ${e}`);
close(rows.dense_projection[2], 2 * (p.attn + p.wdown + p.wup + p.shared + p.router + p.denseFfn + p.lmHead), 'dense FLOP');
close(rows.dense_projection[3], b.attn + b.wdown + b.wup + b.shared + b.router + b.denseFfn + b.lmHead, 'dense bytes');
close(rows.routed_moe[2], 2 * p.routedActive, 'routed FLOP');
close(rows.routed_moe[3], b.routedActive, 'routed bytes');
close(rows.attention[3], m.softmaxLayers * 1048576 * m.kvPerTokenPerLayer, 'KV bytes');
close(rows.kda_state[3], 2 * m.kdaStateStore, 'KDA state bytes');
// Derived totals must reconcile with the calibrated RDMA baseline within 25%.
const rec = workload.provenance.K3.reconciliation;
assert(rec.flopsRatioDerivedOverCalibrated > 0.75 && rec.flopsRatioDerivedOverCalibrated < 1.25, `FLOP reconciliation ${rec.flopsRatioDerivedOverCalibrated}`);
assert(rec.bytesRatioDerivedOverCalibrated > 0.75 && rec.bytesRatioDerivedOverCalibrated < 1.25, `byte reconciliation ${rec.bytesRatioDerivedOverCalibrated}`);
const crypto = require('crypto');
const hash = f => crypto.createHash('sha256').update(fs.readFileSync(path.join(root, f))).digest('hex');
assert.strictEqual(workload.sourceHashes.designEngine, hash('src/core/design_engine.js'), 'planning workload is stale vs design_engine.js; run node scripts/generate_planning_operator_workload.js');
assert.strictEqual(workload.sourceHashes.finalTuningResults, hash('data/rdma/k3_rdma_final_tuning_results.json'), 'planning workload is stale vs final tuning results');

// GLM-5.2 layer count: one value across manifest and profile.
const glm = manifest.models.find(x => x.modelId === 'GLM-5.2');
const glmProfile = profiles.profiles.find(x => x.id === 'GLM-5.2');
assert.strictEqual(glmProfile.layerCount, glm.layerCount);
assert(glm.layerCountStatus && glm.layerCountStatus.includes('NOT_CONFIRMED'));
const ds = manifest.models.find(x => x.modelId === 'DeepSeek-V4-Pro');
const dsProfile = profiles.profiles.find(x => x.id === 'DeepSeek-V4-Pro');
assert.strictEqual(dsProfile.layerCount, ds.layerCount);
assert.strictEqual(dsProfile.reportedArchitectureSignals.routedExperts, ds.expertConfig.experts);
assert.strictEqual(dsProfile.reportedArchitectureSignals.activeExpertsPerToken, ds.expertConfig.activeExpertsPerToken);

console.log('PASS K3 manifest consistency: manifest, profile and planning workload match design_engine kimiK3; GLM/DeepSeek fields agree across files');
