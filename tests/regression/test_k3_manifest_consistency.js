'use strict';
// K3 has exactly one shape source: teams/model/src/design_engine.js MODEL_PRESETS.kimiK3.
// The formal planning manifest, the model profile and the planning operator
// workload must agree with it. GLM-5.2 layer count must agree between the
// manifest and the profile.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const E = require('../../teams/model/src/design_engine.js');
const root = path.resolve(__dirname, '../..');
const read = p => JSON.parse(fs.readFileSync(path.join(root, p), 'utf8').replace(/^﻿/, ''));

const preset = E.MODEL_PRESETS.kimiK3;
const manifest = read('teams/model/inputs/formal_model_manifests.json');
const profiles = read('teams/model/inputs/model_profiles.json');
const workload = read('out/workload/planning_operator_workload.json');
const k3 = manifest.models.find(m => m.modelId === 'K3');

assert.strictEqual(manifest.singleSourceOfTruth.K3, 'teams/model/src/design_engine.js#MODEL_PRESETS.kimiK3');
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
// KV cache is FP8 in the FlashMLA layout of the detailed model (656 B/token/layer), not the BF16 preset value.
const O = require('../../integration/detailed/k3_rdma_final_tuning_model.js');
const finalTuning = read('out/rdma/k3_rdma_final_tuning_results.json');
const kvBytesPerToken = O.mapped(finalTuning.search.best.x).plan.kvBytesPerToken;
assert.strictEqual(kvBytesPerToken, 656);
assert.strictEqual(workload.provenance.K3.kvBytesPerTokenPerLayer, kvBytesPerToken);
assert.strictEqual(k3.stateConfig.kvBytesPerTokenPerLayer, kvBytesPerToken);
close(rows.attention[3], m.softmaxLayers * 1048576 * kvBytesPerToken, 'KV bytes');
close(rows.kda_state[3], 2 * m.kdaStateStore, 'KDA state bytes');
// Derived totals must reconcile with the calibrated RDMA baseline within 25%.
const rec = workload.provenance.K3.reconciliation;
assert(rec.flopsRatioDerivedOverCalibrated > 0.75 && rec.flopsRatioDerivedOverCalibrated < 1.25, `FLOP reconciliation ${rec.flopsRatioDerivedOverCalibrated}`);
assert(rec.bytesRatioDerivedOverCalibrated > 0.75 && rec.bytesRatioDerivedOverCalibrated < 1.25, `byte reconciliation ${rec.bytesRatioDerivedOverCalibrated}`);
const crypto = require('crypto');
const hash = f => crypto.createHash('sha256').update(fs.readFileSync(path.join(root, f))).digest('hex');
assert.strictEqual(workload.sourceHashes.designEngine, hash('teams/model/src/design_engine.js'), 'planning workload is stale vs design_engine.js; run node integration/pipelines/generate_planning_operator_workload.js');
assert.strictEqual(workload.sourceHashes.finalTuningResults, hash('out/rdma/k3_rdma_final_tuning_results.json'), 'planning workload is stale vs final tuning results');
for (const [key, file] of [['finalTuningModel', 'integration/detailed/k3_rdma_final_tuning_model.js'], ['formalModelManifests', 'teams/model/inputs/formal_model_manifests.json'], ['workloadDerivation', 'teams/model/src/workload_derivation.js'], ['tokenTime', 'integration/planning/token_time.js'], ['resourceProfiles', 'teams/hardware/src/resource_profiles.js']]) {
  assert.strictEqual(workload.sourceHashes[key], hash(file), `planning workload is stale vs ${file}; run node integration/pipelines/generate_planning_operator_workload.js`);
}

// Token-time calibration replays on the K3 detailed published point.
const TT = require('../../integration/planning/token_time.js');
const cal = workload.calibration;
const best = finalTuning.search.best;
const breakdown = TT.detailedBreakdown(O.mapped(best.x).plan.ops);
const replayed = TT.calibrate({rows: workload.operators.K3, collectivesPerToken: best.collectiveCount, layers: preset.layers}, cal.slot, best, breakdown);
for (const key of ['expertReread', 'kMemory', 'kFlop', 'fixedPerLayerUs', 'kTmaExposedUsPerGB', 'legacyKCompute']) close(cal[key], replayed[key], key);
// The split serial terms add up to the detailed serial compute (compute - hidden TMA - comm overlap).
close(cal.serialSplitUs.flop + cal.serialSplitUs.fixed + cal.serialSplitUs.tmaExposed, cal.detailedSerialComputeUs, 'serial split');
close(cal.calibratedSerialComputeUs, cal.detailedSerialComputeUs, 'serial compute replay');
// Expert re-reads close the byte gap between the derived rows and the detailed read traffic.
close(cal.expertReread, best.wrongBytes / best.predBytes, 'expert re-read ratio');
assert(Math.abs(rec.derivedPlusRereadOverDetailed - 1) < 0.01, `derived + re-read / detailed read ${rec.derivedPlusRereadOverDetailed}`);
close(cal.detailedTpsPerUser, best.tps, 'calibration target');
assert(Math.abs(cal.rawResidualUs) < 0.01 * best.rawUs, `calibrated raw residual ${cal.rawResidualUs} us`);
assert(cal.kMemory > 0.8 && cal.kMemory < 1.5, `kMemory ${cal.kMemory}`);
assert(cal.kFlop > 0.8 && cal.kFlop < 2, `kFlop ${cal.kFlop}`);
assert(cal.fixedPerLayerUs > 0 && cal.kTmaExposedUsPerGB > 0 && cal.expertReread > 0 && cal.expertReread < 1);
assert.strictEqual(workload.layers.K3, preset.layers);
// Out-of-fit check at MC320 must stay within 15% of a fresh detailed replay.
const mc320 = O.evaluate({...best.x, mcGBs: 320});
close(cal.validation.detailedTpsPerUser, mc320.tps, 'MC320 detailed replay');
assert(cal.validation.planningOverDetailed > 0.85 && cal.validation.planningOverDetailed < 1.15, `MC320 planning/detailed ${cal.validation.planningOverDetailed}`);

// GLM-5.2 layer count: one value across manifest, profile and config shape.
const glm = manifest.models.find(x => x.modelId === 'GLM-5.2');
const glmProfile = profiles.profiles.find(x => x.id === 'GLM-5.2');
assert.strictEqual(glmProfile.layerCount, glm.layerCount);
assert.strictEqual(glm.shape.config.layers, glm.layerCount);
const ds = manifest.models.find(x => x.modelId === 'DeepSeek-V4-Pro');
const dsProfile = profiles.profiles.find(x => x.id === 'DeepSeek-V4-Pro');
assert.strictEqual(dsProfile.layerCount, ds.layerCount);
assert.strictEqual(dsProfile.reportedArchitectureSignals.routedExperts, ds.expertConfig.experts);
assert.strictEqual(dsProfile.reportedArchitectureSignals.activeExpertsPerToken, ds.expertConfig.activeExpertsPerToken);

// GLM-5.2 rows are derived from the public config.json: the parameter count including the
// MTP layer reproduces the reported 753B, shared indexer layers carry no indexer, and every
// deployment-layout field is an explicit ASSUMPTION.
const gc = glm.shape.config;
assert.strictEqual(gc.hidden, glm.hiddenSize);
assert.strictEqual(gc.heads, glm.attention.heads);
assert.strictEqual(gc.routedExperts, glm.expertConfig.experts);
assert.strictEqual(gc.activeExperts, glm.expertConfig.activeExpertsPerToken);
assert.strictEqual(gc.reportedTotalParamsB, glmProfile.reportedParameterCountB);
assert.deepStrictEqual(gc.fullIndexerLayers.slice(0, 4), [0, 1, 2, 6]);
assert(gc.fullIndexerLayers.every((l, i, xs) => i < 3 || l - xs[i - 1] === 4), 'full indexer every 4th layer after the first 3');
for (const [key, a] of Object.entries(glm.shape.assumptions)) assert(a.basis && 'value' in a, `GLM assumption ${key} needs value and basis`);
const glmProv = workload.provenance['GLM-5.2'];
assert.strictEqual(glmProv.status, 'SHAPE_DERIVED_FROM_CONFIG');
assert.deepStrictEqual(glmProv.assumptions, Object.keys(glm.shape.assumptions));
assert(Math.abs(glmProv.derivation.totalWithMtpOverReported - 1) < 0.005, `GLM total with MTP / 753B = ${glmProv.derivation.totalWithMtpOverReported}`);
assert(glmProv.derivation.activeParams < glmProv.derivation.totalParams);
assert.strictEqual(glmProv.derivation.fullIndexerLayers, gc.fullIndexerLayers.length);
assert.strictEqual(glmProv.derivation.mtpApplied, false);
const cpl = glm.shape.assumptions.collectivesPerLayer.value;
assert.strictEqual(workload.collectivesPerToken['GLM-5.2'], gc.fullIndexerLayers.length * cpl.full + (gc.layers - gc.fullIndexerLayers.length) * cpl.shared);
const glmIndexer = workload.operators['GLM-5.2'].find(r => r[0] === 'indexer');
close(glmIndexer[3], gc.fullIndexerLayers.length * glm.stateConfig.contextTokens * glm.shape.assumptions.indexKeyBytesPerToken.value, 'GLM index-key bytes (full layers only)');
assert(!workload.operators['GLM-5.2'].some(r => /dispatch|mtp/i.test(r[0])), 'no EP dispatch or MTP rows in the TP planning workload');
assert(TT.planningModel(workload, 'GLM-5.2'));

// DeepSeek-V4-Pro rows are derived from the manifest shape: reported fields agree with the
// profile, every other field is an explicit ASSUMPTION, and the derived active count is 49B.
const reported = ds.shape.reported;
assert.strictEqual(reported.totalParamsB, dsProfile.reportedParameterCountB);
assert.strictEqual(reported.activeParamsB, dsProfile.reportedActiveParameterCountB);
assert.strictEqual(reported.layers, dsProfile.layerCount);
assert.strictEqual(reported.hidden, dsProfile.hiddenSize);
assert.strictEqual(reported.heads, dsProfile.attentionHeads);
assert.strictEqual(reported.routedExperts, dsProfile.reportedArchitectureSignals.routedExperts);
assert.strictEqual(reported.activeExperts, dsProfile.reportedArchitectureSignals.activeExpertsPerToken);
assert.strictEqual(reported.sharedExperts, dsProfile.reportedArchitectureSignals.sharedExperts);
assert.strictEqual(reported.indexerTopK, dsProfile.reportedArchitectureSignals.indexerTopK);
for (const [key, a] of Object.entries(ds.shape.assumptions)) assert(a.basis && 'value' in a, `assumption ${key} needs value and basis`);
const dsProv = workload.provenance['DeepSeek-V4-Pro'];
assert.strictEqual(dsProv.status, 'SHAPE_DERIVED_WITH_ASSUMPTIONS');
assert.deepStrictEqual(dsProv.assumptions, Object.keys(ds.shape.assumptions));
close(dsProv.derivation.activeParams, reported.activeParamsB * 1e9, 'DeepSeek active parameters');
// Shape ambiguity (ADR-0008): the variant solves the expert hidden from the reported total instead.
const dsVar = workload.variants['DeepSeek-V4-Pro'].expertHiddenFromTotal;
close(dsVar.derivation.impliedTotalParams, reported.totalParamsB * 1e9, 'DeepSeek total parameters (variant)');
assert(dsVar.derivation.expertHidden < dsProv.derivation.expertHidden);
assert.strictEqual(dsVar.collectivesPerToken, workload.collectivesPerToken['DeepSeek-V4-Pro']);
assert.strictEqual(workload.layers['DeepSeek-V4-Pro'], reported.layers);
// Router and LM head are BF16 for DeepSeek-V4-Pro, as for GLM-5.2.
assert.strictEqual(ds.shape.assumptions.bytesPerParam.value.routerAndLmHead, 2);
assert.strictEqual(glm.shape.assumptions.bytesPerParam.value.bf16, 2);
for (const id of ['K3', 'GLM-5.2', 'DeepSeek-V4-Pro']) assert(workload.dtypePolicy[id] && workload.dtypePolicy[id].routerAndLmHead, `dtype policy for ${id}`);
assert.strictEqual(workload.dtypePolicy['GLM-5.2'].routerAndLmHead, 'BF16');
assert(workload.dtypePolicy['DeepSeek-V4-Pro'].routerAndLmHead.startsWith('BF16'));
// K3 FP8-dense comparison: only the dense projection row differs, and it is smaller.
const k3Fp8 = workload.comparisons['K3-FP8-dense'].rows;
assert.deepStrictEqual(k3Fp8.filter(r => r[0] !== 'dense_projection'), workload.operators.K3.filter(r => r[0] !== 'dense_projection'));
assert(k3Fp8.find(r => r[0] === 'dense_projection')[3] < workload.operators.K3.find(r => r[0] === 'dense_projection')[3]);
assert.strictEqual(dsProv.derivation.mtpApplied, false);
assert(dsProv.derivation.impliedTotalOverReported > 0.8 && dsProv.derivation.impliedTotalOverReported < 1.25, `DeepSeek implied total ${dsProv.derivation.impliedTotalOverReported}`);
assert.strictEqual(workload.collectivesPerToken['DeepSeek-V4-Pro'], reported.layers * ds.shape.assumptions.collectivesPerLayer.value);
assert(!workload.operators['DeepSeek-V4-Pro'].some(r => /dispatch|mtp/i.test(r[0])), 'no EP dispatch or MTP rows in the TP planning workload');

console.log('PASS K3 manifest consistency: manifest, profile and planning workload match design_engine kimiK3; calibration replays; GLM derived from config.json (753B reproduced); DeepSeek derived from reported shape + ASSUMPTIONs');
