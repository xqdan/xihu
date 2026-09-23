'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const Final = require('../src/rdma/k3_rdma_final_tuning_model.js');

const specPath = path.resolve(__dirname, '../docs/design/spec/k3_mc_baseline.json');
const baseline = JSON.parse(fs.readFileSync(
  specPath,
  'utf8'
));
const finalResult = JSON.parse(fs.readFileSync(
  path.resolve(__dirname, '../data/rdma/k3_rdma_final_tuning_results.json'),
  'utf8'
));
const candidate = finalResult.search.best.x;

function close(actual, expected, tolerance, label) {
  assert(Math.abs(actual - expected) <= tolerance,
    `${label}: ${actual} != ${expected} within ${tolerance}`);
}

assert.equal(baseline.goal.target, 1000);
assert.equal(baseline.goal.tpCards, 32);
assert.equal(baseline.referenceMemoryCube.maxUnidirectionalBandwidthGBsPerCube, 320);
assert(fs.existsSync(path.resolve(path.dirname(specPath), baseline.referenceMemoryCube.source)),
  'Reference provenance file must exist');
// Whether the stretch point clears the target is a model outcome, not a fixed expectation:
// the spec must state it consistently, and the 1050 architecture gate is never closed by a P1 model.
assert.equal(baseline.acceptance.currentStatus,
  baseline.modelResults.stretchMc640GBs.tpsPerUser >= baseline.goal.target ? 'target-met-in-model-only' : 'not-met');
assert(baseline.modelResults.stretchMc640GBs.tpsPerUser < baseline.acceptance.architectureGateTpsPerUser || baseline.acceptance.architectureGateTpsPerUser === undefined,
  'architecture gate cannot be closed by the P1 model');

const reference = Final.evaluate({...candidate, mcGBs: 320});
const stretch = Final.evaluate({...candidate, mcGBs: 640});

assert(reference.feasible);
assert(stretch.feasible);
close(reference.tps, baseline.modelResults.referenceMc320GBs.tpsPerUser, 1e-9,
  'reference MC TPS');
close(reference.rawUs, baseline.modelResults.referenceMc320GBs.rawLatencyUs, 1e-9,
  'reference MC raw latency');
close(stretch.tps, baseline.modelResults.stretchMc640GBs.tpsPerUser, 1e-9,
  'stretch MC TPS');
close(stretch.rawUs, baseline.modelResults.stretchMc640GBs.rawLatencyUs, 1e-9,
  'stretch MC raw latency');

close(stretch.p.totalMiB, baseline.sramAccounting.physicalMiBPerDie, 1e-12,
  'physical SRAM per die');
close(candidate.sharedMiB * 8, baseline.sramAccounting.sharedPhysicalMiBPerCard, 1e-12,
  'shared SRAM per card');
close(stretch.sramMiB, baseline.sramAccounting.sharedUsableWindowMiBPerCard, 1e-12,
  'shared SRAM working window per card');
close(stretch.peakReservedMiB,
  baseline.sramAccounting.simulatedPeakReservedMiBPerCard, 1e-9,
  'shared SRAM simulated peak per card');

// The reference-compatible MC point must remain a visible blocker (below target),
// and the stretch point must be materially faster than the reference point.
assert(reference.tps < baseline.goal.target, 'Reference-compatible MC point must remain a visible blocker');
assert(stretch.tps > reference.tps * 1.5, 'MC bandwidth sensitivity unexpectedly changed');
// Charged shared-port scaling cost must be reflected in the spec and stay within limits.
assert(baseline.computeDieCandidate.sharedPortScalingCost && baseline.computeDieCandidate.sharedPortScalingCost.powerWPerDie > 0,
  'spec must carry the charged shared-port cost; run npm run baseline:sync');
close(stretch.p.dieArea, baseline.computeDieCandidate.estimatedAreaMm2, 1e-9, 'die area');
close(stretch.p.diePower, baseline.computeDieCandidate.estimatedPowerW, 1e-9, 'die power');
close(stretch.p.cardPower, baseline.computeDieCandidate.estimatedCardPowerW, 1e-9, 'card power');
assert(stretch.p.cardPower <= baseline.card.powerLimitW, 'card power must respect the card limit after charged costs');

console.log(
  `PASS design baseline: MC320 ${reference.tps.toFixed(2)} TPS, ` +
  `MC640 ${stretch.tps.toFixed(2)} TPS; SRAM peak is card aggregate`
);

