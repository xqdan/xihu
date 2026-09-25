'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const root = path.resolve(__dirname, '../..');
const detail = JSON.parse(fs.readFileSync(path.join(root, 'out/detailed/detailed_architecture_run.json'), 'utf8').replace(/^\uFEFF/, ''));
for (const row of detail.operatorLedger) {
  assert(Math.abs(row.requiredPeakFlops - row.requiredEffectiveFlops / (detail.sizing.utilizationAssumption * detail.sizing.dutyCycleAssumption)) < 1e-3);
  assert(Math.abs(row.requiredToAvailableRatio - row.requiredPeakFlops / row.availablePeakFlops) < 1e-12);
  assert(Math.abs(row.requiredToAvailableBandwidthRatio - row.requiredMemoryBandwidth / row.availableMemoryBandwidth) < 1e-12);
  assert(Math.abs(row.arithmeticIntensity - row.flops / row.bytes.total) < 1e-12);
  assert(Math.abs(row.ridgePoint - row.availablePeakFlops / row.availableMemoryBandwidth) < 1e-9);
}
assert(detail.operatorLedger.every(row => row.requiredNetworkBandwidth === 0 || row.availableNetworkBandwidth > 0));
console.log('PASS detailed sizing conservation: Roofline, compute sizing and bandwidth sizing ratios recompute from ledger fields');
