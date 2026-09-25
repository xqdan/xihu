'use strict';
/* Planning token time for one slot (model x physical profile x MC profile x TP).
 *
 * The slot has the same two-lane structure as the K3 detailed model
 * (src/simulation/k3_operator_sram_sim.js, raw = compute - tmaHidden + comm + wait - overlap,
 * with DMA prefetch running under the single compute/collective slot):
 *
 *   memory lane  = sum over non-collective operators of bytes / TP / effective MC bandwidth
 *   serial lane  = sum over operators of FLOP / TP / (core-class peak x utilization x duty cycle)
 *                + collectives per token x max(tau, bytes per collective / network bandwidth)
 *   raw          = max(memory lane x kMemory, compute x kCompute + collectives)
 *   e2e          = raw x engineering margin (1.17);  TPS/usr = 1e6 / e2e
 *
 * kMemory and kCompute are calibrated once on the K3 detailed published point
 * (calibrate() below; the result is stored in data/workload/planning_operator_workload.json).
 * Collective time is not calibrated: the detailed model charges the same tau floor.
 * Applying the K3 factors to other models is a planning ASSUMPTION.
 */
const fs = require('fs');
const path = require('path');
const RES = require('./resource_profiles');

const root = path.resolve(__dirname, '../..');
const spec = JSON.parse(fs.readFileSync(path.join(root, 'docs/design/spec/k3_mc_baseline.json'), 'utf8'));
const TAU_US = spec.tauBasis.tauUs;
const MARGIN = spec.goal.engineeringMargin;
const NOMINAL = {bandwidth: 1, computeCapacity: 1, compute: 1, bytes: 1, network: 1};

// Uncalibrated lane times. model = {rows: [[operatorId, coreClass, globalFlops, globalBytes, bytesClass]], collectivesPerToken}.
function laneTimes(model, {tp, physicalProfile, mcProfile}, variation = NOMINAL) {
  const peak = RES.coreProfiles[physicalProfile].peakByCore;
  const mcBytesPerSecond = RES.mcProfiles[mcProfile].effectiveBytesPerSecond * variation.bandwidth;
  const computeUsByCore = {};
  let memoryUs = 0, collectiveBytes = 0;
  for (const [, coreClass, globalFlops, globalBytes, bytesClass] of model.rows) {
    const flops = globalFlops * variation.compute / tp;
    const bytes = globalBytes * variation.bytes / tp;
    const us = flops / (peak[coreClass] * variation.computeCapacity * RES.utilization * RES.dutyCycle) * 1e6;
    computeUsByCore[coreClass] = (computeUsByCore[coreClass] || 0) + us;
    if (bytesClass === 'collective') collectiveBytes += bytes;
    else memoryUs += bytes / mcBytesPerSecond * 1e6;
  }
  const count = model.collectivesPerToken;
  const perCollectiveUs = count > 0
    ? Math.max(TAU_US, collectiveBytes / count / RES.networkBandwidth * 1e6) / variation.network
    : 0;
  return {
    memoryUs,
    computeUs: Object.values(computeUsByCore).reduce((a, b) => a + b, 0),
    computeUsByCore,
    collectivesPerToken: count,
    perCollectiveUs,
    commUs: count * perCollectiveUs
  };
}

function slotTime(model, slot, calibration, variation = NOMINAL) {
  const t = laneTimes(model, slot, variation);
  const memoryLaneUs = t.memoryUs * calibration.kMemory;
  const serialLaneUs = t.computeUs * calibration.kCompute + t.commUs;
  const rawUs = Math.max(memoryLaneUs, serialLaneUs);
  const uncalibratedRawUs = Math.max(t.memoryUs, t.computeUs + t.commUs);
  return {
    ...t,
    memoryLaneUs,
    serialLaneUs,
    rawUs,
    e2eUs: rawUs * MARGIN,
    tpsPerUser: 1e6 / (rawUs * MARGIN),
    bound: memoryLaneUs >= serialLaneUs ? 'memory' : (t.commUs >= t.computeUs * calibration.kCompute ? 'collective' : 'compute'),
    uncalibratedRawUs,
    uncalibratedTpsPerUser: 1e6 / (uncalibratedRawUs * MARGIN)
  };
}

// Lane factors from the K3 detailed published point. detailed is the stored
// search.best of data/rdma/k3_rdma_final_tuning_results.json.
function calibrate(k3Model, slot, detailed) {
  const t = laneTimes(k3Model, slot);
  const detailedSerialComputeUs = detailed.computeUs - detailed.tmaHiddenUs - detailed.overlapUs;
  const calibration = {
    slot,
    source: 'data/rdma/k3_rdma_final_tuning_results.json#/search/best',
    detailedTpsPerUser: detailed.tps,
    detailedRawUs: detailed.rawUs,
    detailedDmaBusyUs: detailed.dmaBusyUs,
    detailedSerialComputeUs,
    detailedCommUs: detailed.commUs,
    planningMemoryUs: t.memoryUs,
    planningComputeUs: t.computeUs,
    planningCommUs: t.commUs,
    kMemory: detailed.dmaBusyUs / t.memoryUs,
    kCompute: detailedSerialComputeUs / t.computeUs,
    margin: MARGIN,
    tauUs: TAU_US,
    definition: 'kMemory = detailed DMA busy / planning memory lane; kCompute = (detailed compute - hidden TMA - comm overlap) / planning compute; collectives are charged at the same tau in both models and are not scaled'
  };
  const replay = slotTime(k3Model, slot, calibration);
  calibration.calibratedRawUs = replay.rawUs;
  calibration.calibratedTpsPerUser = replay.tpsPerUser;
  calibration.rawResidualUs = replay.rawUs - detailed.rawUs;
  calibration.uncalibratedTpsPerUser = replay.uncalibratedTpsPerUser;
  return calibration;
}

// Planning model of one workload entry, or null when the model is BLOCKED_CONFIG (no rows, no TPS).
function planningModel(workload, modelId) {
  if (workload.provenance[modelId].status === 'BLOCKED_CONFIG') return null;
  return {rows: workload.operators[modelId], collectivesPerToken: workload.collectivesPerToken[modelId]};
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

module.exports = {TAU_US, MARGIN, NOMINAL, laneTimes, slotTime, calibrate, planningModel, boundingOperator};
