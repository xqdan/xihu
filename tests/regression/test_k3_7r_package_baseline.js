'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const specPath = path.resolve(__dirname, '../../teams/hardware/inputs/k3_7r_package_baseline.json');
const spec = JSON.parse(fs.readFileSync(specPath, 'utf8'));
const close = (actual, expected, tolerance, label) => {
  assert(Math.abs(actual - expected) <= tolerance,
    `${label}: ${actual} != ${expected} within ${tolerance}`);
};

assert.equal(spec.scope, 'single-chip-package');
assert.equal(spec.softwareVisibility.packageIsTpRank, true);
assert.equal(spec.softwareVisibility.packagesPerTpReplica, 32);

close(spec.reticle.widthMm * spec.reticle.heightMm, spec.reticle.areaMm2, 1e-12,
  'reticle area');
close(spec.reticle.areaMm2 * spec.reticle.count, spec.reticle.theoreticalAreaMm2, 1e-12,
  '7-reticle theoretical area');
close(spec.placementWindow.widthMm * spec.placementWindow.heightMm,
  spec.placementWindow.areaMm2, 1e-12, 'placement window area');

const c = spec.compute;
const m = spec.memory;
const p = spec.packageTotals;
close(c.dieWidthMm * c.dieHeightMm, c.dieAreaMm2, 1e-12, 'compute die area');
close(Object.values(c.areaBudgetMm2PerDie).reduce((a, b) => a + b, 0),
  c.dieAreaMm2, 1e-12, 'compute die area budget');
close(Object.values(c.sramBreakdownMiBPerDie).reduce((a, b) => a + b, 0),
  c.dataSramMiBPerDie, 1e-12, 'compute die SRAM budget');

close(c.dieCount * c.dieAreaMm2, p.computeAreaMm2, 1e-12, 'package compute area');
close(m.cubeCount * m.cubeAreaMm2Planning, p.memoryAreaMm2, 1e-12,
  'package memory area');
close(p.computeAreaMm2 + p.memoryAreaMm2, p.bareDieAreaMm2, 1e-12,
  'package bare-die area');
close(spec.placementWindow.areaMm2 - p.bareDieAreaMm2,
  p.placementRoutingReserveMm2, 1e-12, 'placement/routing reserve');
assert(p.bareDieAreaMm2 < spec.placementWindow.areaMm2);
assert(spec.placementWindow.areaMm2 < spec.reticle.theoreticalAreaMm2);

close(c.dieCount * c.dataSramMiBPerDie, p.dataSramMiB, 1e-12,
  'package SRAM capacity');
close(m.cubeCount * m.capacityGBPerCubePrimary, p.memoryCapacityGBPrimary, 1e-12,
  'package primary memory capacity');
close(m.cubeCount * m.capacityGBPerCubePrototype, p.memoryCapacityGBPrototype, 1e-12,
  'package prototype memory capacity');
close(m.cubeCount * m.payloadGBsPerCubeBaseline / 1000,
  p.memoryPayloadTBsBaseline, 1e-12, 'package baseline MC payload');
close(m.cubeCount * m.payloadGBsPerCubeStretch / 1000,
  p.memoryPayloadTBsStretch, 1e-12, 'package stretch MC payload');
close(c.dieCount * c.powerWPerDieBudget, p.computePowerWBudget, 1e-12,
  'package compute power budget');

assert.equal(c.lCoresPerDie, 8);
assert.equal(c.hCoresPerDie, 8);
assert.equal(c.dataSramMiBPerDie, 96);
assert.equal(m.cubesPerComputeDie, 2);
assert.equal(spec.acceptance.targetTpsPerUser, 1000);
assert.equal(spec.acceptance.architectureGateTpsPerUser, 1050);

console.log(
  `PASS 7R package baseline: ${p.bareDieAreaMm2}/${spec.placementWindow.areaMm2} mm2, ` +
  `${p.dataSramMiB} MiB SRAM, ${p.memoryCapacityGBPrimary} GB MC, ` +
  `${p.memoryPayloadTBsBaseline.toFixed(2)} TB/s baseline payload`
);
