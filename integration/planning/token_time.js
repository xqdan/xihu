'use strict';
/* Planning token time for one slot (model x physical profile x MC profile x TP).
 *
 * The slot has the same two-lane structure as the K3 detailed model
 * (integration/detailed/k3_operator_sram_sim.js, raw = compute - tmaHidden + comm + wait - overlap,
 * with DMA prefetch running under the single compute/collective slot):
 *
 *   memory lane  = kMemory x (sum of non-collective bytes / TP / effective MC bandwidth
 *                             + expertReread x routed-expert bytes / TP / effective MC bandwidth)
 *   serial lane  = kFlop x sum of FLOP / TP / (core-class peak x utilization x duty cycle)
 *                + fixedPerLayerUs x layers
 *                + kTmaExposedUsPerGB x non-collective GB per rank (shared->local fill, on chip)
 *                + collectives per token x max(tau, bytes per collective / network bandwidth)
 *   raw          = max(memory lane, serial lane)
 *   e2e          = raw x engineering margin (1.17);  TPS/usr = 1e6 / e2e
 *
 * Every factor is taken from the timing breakdown of the K3 detailed published
 * point (calibrate() below; stored in out/workload/planning_operator_workload.json):
 *   expertReread    = mis-predicted expert bytes / predicted expert bytes
 *   kMemory         = DMA busy / (memory time incl. re-reads)
 *   kFlop           = (kernel + split-KV reduce + die link) / planning compute
 *   fixedPerLayerUs = (local TMA + launch - comm overlap) / layers
 *   kTmaExposedUsPerGB = (TMA fill - hidden TMA) / non-collective GB per rank
 * Collective time is not calibrated: the detailed model charges the same tau
 * floor. Applying the K3 factors to other models is a planning ASSUMPTION.
 */
const fs = require('fs');
const path = require('path');
const RES = require('../../teams/hardware/src/resource_profiles');

const root = path.resolve(__dirname, '../..');
const spec = JSON.parse(fs.readFileSync(path.join(root, 'teams/hardware/inputs/k3_mc_baseline.json'), 'utf8'));
const TAU_US = spec.tauBasis.tauUs;
const MARGIN = spec.goal.engineeringMargin;
const NOMINAL = {bandwidth: 1, computeCapacity: 1, compute: 1, bytes: 1, network: 1};
// tau sensitivity columns until B-008 derives tau physically (ADR-0008).
const TAU_SENSITIVITY_US = [TAU_US, 1.5, 2.0];

// Uncalibrated lane times. model = {rows: [[operatorId, coreClass, globalFlops, globalBytes, bytesClass]], collectivesPerToken, layers}.
// variation.tauUs overrides the collective floor (tau sensitivity); the other keys scale the lanes.
function laneTimes(model, {tp, physicalProfile, mcProfile}, variation = NOMINAL) {
  const peak = RES.coreProfiles[physicalProfile].peakByCore;
  const mcBytesPerSecond = RES.mcProfiles[mcProfile].effectiveBytesPerSecond * variation.bandwidth;
  const tauUs = variation.tauUs === undefined ? TAU_US : variation.tauUs;
  const computeUsByCore = {};
  let memoryUs = 0, expertMemoryUs = 0, memoryBytes = 0, collectiveBytes = 0;
  for (const [, coreClass, globalFlops, globalBytes, bytesClass] of model.rows) {
    const flops = globalFlops * variation.compute / tp;
    const bytes = globalBytes * variation.bytes / tp;
    const us = flops / (peak[coreClass] * variation.computeCapacity * RES.utilization * RES.dutyCycle) * 1e6;
    computeUsByCore[coreClass] = (computeUsByCore[coreClass] || 0) + us;
    if (bytesClass === 'collective') collectiveBytes += bytes;
    else {
      memoryBytes += bytes;
      memoryUs += bytes / mcBytesPerSecond * 1e6;
      if (bytesClass === 'expert') expertMemoryUs += bytes / mcBytesPerSecond * 1e6;
    }
  }
  const count = model.collectivesPerToken;
  const perCollectiveUs = count > 0
    ? Math.max(tauUs, collectiveBytes / count / RES.networkBandwidth * 1e6) / variation.network
    : 0;
  return {
    memoryBytes,
    memoryUs,
    expertMemoryUs,
    computeUs: Object.values(computeUsByCore).reduce((a, b) => a + b, 0),
    computeUsByCore,
    layers: model.layers,
    collectivesPerToken: count,
    tauUs,
    perCollectiveUs,
    commUs: count * perCollectiveUs
  };
}

function slotTime(model, slot, calibration, variation = NOMINAL) {
  const t = laneTimes(model, slot, variation);
  const memoryLaneUs = (t.memoryUs + calibration.expertReread * t.expertMemoryUs) * calibration.kMemory;
  const flopUs = t.computeUs * calibration.kFlop;
  const fixedUs = calibration.fixedPerLayerUs * t.layers;
  const tmaExposedUs = calibration.kTmaExposedUsPerGB * t.memoryBytes / 1e9;
  const serialComputeUs = flopUs + fixedUs + tmaExposedUs;
  const serialLaneUs = serialComputeUs + t.commUs;
  const rawUs = Math.max(memoryLaneUs, serialLaneUs);
  const uncalibratedRawUs = Math.max(t.memoryUs, t.computeUs + t.commUs);
  return {
    ...t,
    memoryLaneUs,
    flopUs,
    fixedUs,
    tmaExposedUs,
    serialComputeUs,
    serialLaneUs,
    rawUs,
    e2eUs: rawUs * MARGIN,
    tpsPerUser: 1e6 / (rawUs * MARGIN),
    bound: memoryLaneUs >= serialLaneUs ? 'memory' : (t.commUs >= serialComputeUs ? 'collective' : 'compute'),
    uncalibratedRawUs,
    uncalibratedTpsPerUser: 1e6 / (uncalibratedRawUs * MARGIN)
  };
}

// TPS/usr of one slot at each tau of TAU_SENSITIVITY_US.
function tauSensitivity(model, slot, calibration) {
  return TAU_SENSITIVITY_US.map(tauUs => {
    const t = slotTime(model, slot, calibration, {...NOMINAL, tauUs});
    return {tauUs, tpsPerUser: t.tpsPerUser, bound: t.bound};
  });
}

// Expert prediction accuracies for the re-read sensitivity. expertReread = 1 - accuracy;
// the K3 detailed model uses 0.8 (integration/detailed/k3_operator_sram_sim.js DEFAULT.prediction),
// so the calibrated 0.20 is that input, not a measurement. kMemory stays as fitted on K3.
const PREDICTION_SENSITIVITY = [0.7, 0.8, 0.9];
function rereadSensitivity(model, slot, calibration) {
  return PREDICTION_SENSITIVITY.map(prediction => {
    const t = slotTime(model, slot, {...calibration, expertReread: 1 - prediction});
    return {prediction, expertReread: 1 - prediction, tpsPerUser: t.tpsPerUser, bound: t.bound};
  });
}

// Largest tau (us) at which the slot still reaches targetTps (nominal variation).
// null: the slot misses at any tau (memory lane, serial compute or collective bandwidth
// alone exceeds the budget). Every TP slot has collectives, so tau is always defined.
function maxTauForTarget(model, slot, calibration, targetTps) {
  const t = slotTime(model, slot, calibration);
  const budgetUs = 1e6 / (targetTps * MARGIN);
  if (t.collectivesPerToken === 0) throw new Error('maxTauForTarget: no collectives, tau is undefined');
  if (t.memoryLaneUs > budgetUs) return null;
  const tauMax = (budgetUs - t.serialComputeUs) / t.collectivesPerToken;
  const bandwidthUs = laneTimes(model, slot, {...NOMINAL, tauUs: 0}).perCollectiveUs;
  return tauMax >= bandwidthUs ? tauMax : null;
}

// Timing breakdown of the detailed plan (non-collective ops of O.mapped(best.x).plan.ops).
function detailedBreakdown(ops) {
  const s = {kernelUs: 0, reduceUs: 0, dieLinkUs: 0, localTmaUs: 0, launchUs: 0, tmaFillUs: 0};
  for (const o of ops.filter(x => x.unit !== 'COMM')) {
    s.kernelUs += o.timing.kernel || 0;
    s.reduceUs += o.timing.reduce || 0;
    s.dieLinkUs += o.timing.dieLink || 0;
    s.localTmaUs += o.timing.localTma || 0;
    s.launchUs += o.timing.launch || 0;
    s.tmaFillUs += o.timing.tmaFill || 0;
  }
  return s;
}

// Lane factors from the K3 detailed published point. detailed is the stored
// search.best of out/rdma/k3_rdma_final_tuning_results.json; breakdown is
// detailedBreakdown() of the same point.
function calibrate(k3Model, slot, detailed, breakdown) {
  const t = laneTimes(k3Model, slot);
  const detailedSerialComputeUs = detailed.computeUs - detailed.tmaHiddenUs - detailed.overlapUs;
  const expertReread = detailed.wrongBytes / detailed.predBytes;
  const kMemory = detailed.dmaBusyUs / (t.memoryUs + expertReread * t.expertMemoryUs);
  const flopTimeUs = breakdown.kernelUs + breakdown.reduceUs + breakdown.dieLinkUs;
  const fixedTimeUs = breakdown.localTmaUs + breakdown.launchUs - detailed.overlapUs;
  const tmaExposedUs = detailed.tmaFillUs - detailed.tmaHiddenUs;
  const calibration = {
    slot,
    source: 'out/rdma/k3_rdma_final_tuning_results.json#/search/best; op timing from integration/detailed/k3_rdma_final_tuning_model.js mapped(best.x).plan.ops',
    detailedTpsPerUser: detailed.tps,
    detailedRawUs: detailed.rawUs,
    detailedDmaBusyUs: detailed.dmaBusyUs,
    detailedSerialComputeUs,
    detailedCommUs: detailed.commUs,
    detailedBreakdown: {...breakdown, tmaHiddenUs: detailed.tmaHiddenUs, overlapUs: detailed.overlapUs, predBytes: detailed.predBytes, wrongBytes: detailed.wrongBytes},
    layers: k3Model.layers,
    planningMemoryBytes: t.memoryBytes,
    planningMemoryUs: t.memoryUs,
    planningExpertMemoryUs: t.expertMemoryUs,
    planningComputeUs: t.computeUs,
    planningCommUs: t.commUs,
    expertReread,
    kMemory,
    kFlop: flopTimeUs / t.computeUs,
    fixedPerLayerUs: fixedTimeUs / k3Model.layers,
    kTmaExposedUsPerGB: tmaExposedUs / (t.memoryBytes / 1e9),
    serialSplitUs: {flop: flopTimeUs, fixed: fixedTimeUs, tmaExposed: tmaExposedUs},
    // The ADR-0006 single factor, kept for comparison only; slotTime() does not use it.
    legacyKCompute: detailedSerialComputeUs / t.computeUs,
    margin: MARGIN,
    tauUs: TAU_US,
    tauSensitivityUs: TAU_SENSITIVITY_US,
    definition: 'expertReread = wrongBytes / predBytes; kMemory = DMA busy / (memory + expertReread x expert memory); kFlop = (kernel + reduce + dieLink) / planning compute; fixedPerLayerUs = (localTma + launch - comm overlap) / layers; kTmaExposedUsPerGB = (tmaFill - tmaHidden) / non-collective GB per rank; collectives are charged at the same tau in both models and are not scaled'
  };
  const replay = slotTime(k3Model, slot, calibration);
  calibration.calibratedRawUs = replay.rawUs;
  calibration.calibratedTpsPerUser = replay.tpsPerUser;
  calibration.calibratedSerialComputeUs = replay.serialComputeUs;
  calibration.rawResidualUs = replay.rawUs - detailed.rawUs;
  calibration.uncalibratedTpsPerUser = replay.uncalibratedTpsPerUser;
  return calibration;
}

// Planning model of one workload entry, or null when the model is BLOCKED_CONFIG (no rows, no TPS).
// variant selects an entry of workload.variants[modelId] (a shape-ambiguity alternative).
function planningModel(workload, modelId, variant) {
  if (workload.provenance[modelId].status === 'BLOCKED_CONFIG') return null;
  const base = {rows: workload.operators[modelId], collectivesPerToken: workload.collectivesPerToken[modelId], layers: workload.layers[modelId]};
  if (!variant) return base;
  const v = workload.variants[modelId][variant];
  return {rows: v.rows, collectivesPerToken: v.collectivesPerToken, layers: v.layers};
}

// Operator that dominates the bounding lane of a slotTime() result.
function boundingOperator(model, {physicalProfile}, result) {
  const rows = model.rows.filter(r => (result.bound === 'collective') === (r[4] === 'collective'));
  if (result.bound === 'compute') {
    const peak = RES.coreProfiles[physicalProfile].peakByCore;
    return rows.reduce((a, b) => b[2] / peak[b[1]] > a[2] / peak[a[1]] ? b : a)[0];
  }
  return rows.reduce((a, b) => b[3] > a[3] ? b : a)[0];
}

module.exports = {TAU_US, MARGIN, NOMINAL, TAU_SENSITIVITY_US, laneTimes, slotTime, tauSensitivity, PREDICTION_SENSITIVITY, rereadSensitivity, maxTauForTarget, detailedBreakdown, calibrate, planningModel, boundingOperator};
