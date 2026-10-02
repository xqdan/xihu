'use strict';
// Assumption sensitivity of the planning token time (GLM-5.2, DeepSeek-V4-Pro, K3).
// The cases change one unmeasured input at a time; this test replays them independently of
// stage_b.js and pins the conclusions the review rests on: which lane binds, which cases flip
// the target, and that the sharding of attention weights is carried as an explicit input.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const TT = require('../../integration/planning/token_time.js');
const {deriveDeepSeek, deriveGlm} = require('../../teams/model/src/workload_derivation.js');

const root = path.resolve(__dirname, '../..');
const read = p => JSON.parse(fs.readFileSync(path.join(root, p), 'utf8').replace(/^﻿/, ''));
const workload = read('out/workload/planning_operator_workload.json');
const run = read('out/detailed/detailed_architecture_run.json');
const manifest = read('teams/model/inputs/formal_model_manifests.json');
const TARGET = 1000;
const MODELS = ['K3', 'GLM-5.2', 'DeepSeek-V4-Pro'];

// attentionWeightBytes: stored value equals the derivation, and the weights are a part of the dense row.
const glmShape = manifest.models.find(m => m.modelId === 'GLM-5.2').shape;
const dsShape = manifest.models.find(m => m.modelId === 'DeepSeek-V4-Pro').shape;
assert.strictEqual(workload.attentionWeightBytes['GLM-5.2'], deriveGlm(glmShape).derivation.attentionWeightBytes);
assert.strictEqual(workload.attentionWeightBytes['DeepSeek-V4-Pro'], deriveDeepSeek(dsShape, 'active').derivation.attentionWeightBytes);
for (const id of MODELS) {
  const dense = workload.operators[id].find(r => r[0] === 'dense_projection');
  const share = workload.attentionWeightBytes[id] / dense[3];
  assert(share > 0.3 && share < 1, `${id}: attention weights are ${(share * 100).toFixed(0)}% of dense bytes`);
}

// Artifact slots equal an independent replay of the cases.
const slots = run.tokenTime.slots;
assert.strictEqual(slots.length, 18);
for (const slot of slots) {
  assert.deepStrictEqual(slot.assumptionSensitivity.map(c => c.id), TT.ASSUMPTION_CASES.map(c => c.id));
  const model = TT.planningModel(workload, slot.modelId);
  const replay = TT.assumptionSensitivity(model, {tp: slot.tp, physicalProfile: slot.physicalProfile, mcProfile: slot.mcProfile}, workload.calibration, workload.attentionWeightBytes[slot.modelId]);
  slot.assumptionSensitivity.forEach((c, i) => {
    assert(Math.abs(c.tpsPerUser - replay[i].tpsPerUser) < 1e-9, `${slot.candidateId} ${slot.modelId} ${c.id}`);
    assert.strictEqual(c.meetsTarget, c.tpsPerUser >= TARGET);
  });
}

const slotOf = (modelId, tp, mc) => slots.find(s => s.modelId === modelId && s.tp === tp && s.mcProfile === mc && s.physicalProfile === 'P1');
const caseOf = (slot, id) => slot.assumptionSensitivity.find(c => c.id === id);

for (const slot of slots) {
  const at = id => caseOf(slot, id).tpsPerUser;
  const nominal = slot.tpsPerUser;
  // Direction: more collectives, more replication, lower prediction accuracy and larger kMemory never help.
  assert(at('collectivesPerLayerPlus1') <= nominal + 1e-9 && at('collectivesPerLayerMinus1') >= nominal - 1e-9, `${slot.candidateId} ${slot.modelId} collectives direction`);
  assert(at('attentionReplicated100pct') <= at('attentionReplicated10pct') && at('attentionReplicated10pct') <= nominal + 1e-9, `${slot.candidateId} ${slot.modelId} replication direction`);
  assert(at('expertPrediction0.3') <= at('expertPrediction0.5') + 1e-9 && at('expertPrediction0.5') <= nominal + 1e-9, `${slot.candidateId} ${slot.modelId} prediction direction`);
  assert(at('kMemory1.3') <= nominal + 1e-9 && at('kMemory1.0') >= nominal - 1e-9, `${slot.candidateId} ${slot.modelId} kMemory direction`);
}

// Review conclusions for GLM-5.2 and DeepSeek-V4-Pro at TP32 (change them only with the review text).
for (const id of ['GLM-5.2', 'DeepSeek-V4-Pro']) {
  const mc640 = slotOf(id, 32, 'MC640'), mc320 = slotOf(id, 32, 'MC320');
  assert.strictEqual(mc640.bound, 'collective', `${id} MC640 is bound by collectives (count x tau)`);
  assert.strictEqual(mc320.bound, 'memory', `${id} MC320 is bound by the memory lane`);
  assert(mc640.tpsPerUser >= TARGET && mc320.tpsPerUser >= TARGET, `${id} nominal meets the target`);
  // At MC640 the memory-side factors do not move the value; the collective count does.
  for (const idc of ['expertPrediction0.5', 'expertPrediction0.3', 'kMemory1.0', 'kMemory1.3']) assert(Math.abs(caseOf(mc640, idc).deltaPct) < 1e-9, `${id} MC640 ${idc}`);
  assert(caseOf(mc640, 'collectivesPerLayerPlus1').deltaPct < -15, `${id} +1 collective/layer costs more than 15%`);
  assert(caseOf(mc640, 'collectivesPerLayerPlus1').meetsTarget, `${id} still meets the target with +1 collective/layer at MC640`);
  // At MC320 the collective count does not move the value; the memory-side factors do.
  assert(Math.abs(caseOf(mc320, 'collectivesPerLayerPlus1').deltaPct) < 1e-9);
  assert(caseOf(mc320, 'kMemory1.3').deltaPct < -10);
  // Full replication of the attention weights fails the target everywhere: the sharding decision matters.
  assert(!caseOf(mc640, 'attentionReplicated100pct').meetsTarget && !caseOf(mc320, 'attentionReplicated100pct').meetsTarget, `${id} full replication`);
}

// The assumption that carries these cases is declared in the manifests.
for (const shape of [glmShape, dsShape]) assert(shape.assumptions.collectivesPerLayer, 'collectivesPerLayer must stay a declared ASSUMPTION');
assert(!MODELS.some(id => workload.provenance[id].status === 'BLOCKED_CONFIG'));

console.log('PASS planning assumption sensitivity: cases replay, directions hold, GLM-5.2 and DeepSeek-V4-Pro lanes and target flips pinned');
