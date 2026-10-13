'use strict';

/* Planning-only single-die replay for the model-owned operator ledgers.
 * This is deliberately a resource service model, not a runtime simulator:
 * it has no queue trace, scheduler trace, or validated token-time fit. */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const R = require('../../teams/hardware/src/resource_profiles');

const ROOT = path.resolve(__dirname, '../..');
const LEDGER_FILE = 'out/workload/model_operator_ledgers.json';
const DIES = R.DIES_PER_PACKAGE;
const TP_VALUES = [16, 32];
const MC_VALUES = ['MC320', 'MC640'];
const EVIDENCE = 'UNVERIFIED_PLANNING_MANIFEST';

const read = file => JSON.parse(fs.readFileSync(path.join(ROOT, file), 'utf8'));
const hashFile = file => crypto.createHash('sha256').update(fs.readFileSync(path.join(ROOT, file))).digest('hex');
const finite = (value, label) => {
  if (!Number.isFinite(value) || value < 0) throw new Error(`${label} must be finite and non-negative`);
  return value;
};

function loadLedgerArtifact() {
  const artifact = read(LEDGER_FILE);
  if (artifact.schemaVersion !== 'model-operator-ledgers-v0.1') throw new Error(`${LEDGER_FILE}: unsupported schema`);
  if (artifact.provenance?.evidenceClass !== EVIDENCE) throw new Error(`${LEDGER_FILE}: evidence class mismatch`);
  return artifact;
}

function variantEntries(artifact) {
  const glm = [['GLM-5.2', null, artifact.models['GLM-5.2']]];
  const ds = Object.entries(artifact.models['DeepSeek-V4-Pro'].variants)
    .map(([variantId, ledger]) => ['DeepSeek-V4-Pro', variantId, ledger]);
  return [...glm, ...ds];
}

function dtypeCosts(dtype, parameterCount) {
  const normalized = String(dtype).toLowerCase();
  if (normalized === 'fp4' || normalized === 'mxfp4') {
    return {dequantOps: parameterCount, scaleBytes: parameterCount / 32};
  }
  if (normalized === 'fp8') {
    return {dequantOps: parameterCount, scaleBytes: parameterCount / 128 * 4};
  }
  return {dequantOps: 0, scaleBytes: 0};
}

function coreResource(coreClass) {
  if (coreClass === 'INDEXER') return 'H';
  if (coreClass === 'REDUCE') return 'V';
  return coreClass;
}

function replayLedger(ledger, modelId, variantId, tp, mcProfile) {
  const profile = R.coreProfiles.P1;
  const mc = R.mcProfiles[mcProfile];
  if (!mc) throw new Error(`unknown MC profile ${mcProfile}`);
  const networkPerDie = R.networkBandwidth / DIES;
  const memoryPerDie = mc.effectiveBytesPerSecond / DIES;
  const corePeakPerDie = Object.fromEntries(Object.entries(profile.peakByCore).map(([key, value]) => [key, value / DIES]));
  const sustainedPeakPerDie = Object.fromEntries(Object.entries(corePeakPerDie).map(([key, value]) => [key, value * R.utilization * R.dutyCycle]));
  const rows = ledger.rows.map(sourceRow => {
    const resource = coreResource(sourceRow.coreClass);
    const flops = finite(sourceRow.globalFlopsPerToken / tp / DIES, `${modelId}.${sourceRow.operatorId}.flopsPerDie`);
    const bytes = finite(sourceRow.globalBytesPerToken / tp / DIES, `${modelId}.${sourceRow.operatorId}.bytesPerDie`);
    const parameterCount = finite(sourceRow.parameterCountPerLayer * sourceRow.layerCount / tp / DIES, `${modelId}.${sourceRow.operatorId}.parametersPerDie`);
    const costs = dtypeCosts(sourceRow.dtype, parameterCount);
    const accumulationOps = flops / 2;
    const computeSeconds = sustainedPeakPerDie[resource] ? (flops + costs.dequantOps + accumulationOps) / sustainedPeakPerDie[resource] : 0;
    const memorySeconds = bytes / memoryPerDie;
    const networkBytes = sourceRow.bytesClass === 'collective' ? bytes : 0;
    const localBytes = bytes - networkBytes;
    const networkSeconds = networkBytes / networkPerDie;
    const computeUs = computeSeconds * 1e6;
    const memoryUs = memorySeconds * 1e6;
    const networkUs = networkSeconds * 1e6;
    const serviceUs = Math.max(computeUs, memoryUs, networkUs);
    const bottleneck = serviceUs === networkUs && networkUs >= computeUs && networkUs >= memoryUs ? 'network'
      : serviceUs === memoryUs && memoryUs >= computeUs ? 'memory' : 'compute';
    return {
      operatorId: sourceRow.operatorId,
      layerClass: sourceRow.layerClass,
      layerCount: sourceRow.layerCount,
      coreClass: sourceRow.coreClass,
      resourceClass: resource,
      dtype: sourceRow.dtype,
      bytesClass: sourceRow.bytesClass,
      flopsPerDie: flops,
      bytesPerDie: bytes,
      localBytesPerDie: localBytes,
      networkBytesPerDie: networkBytes,
      dequantOpsPerDie: finite(costs.dequantOps, `${modelId}.${sourceRow.operatorId}.dequantOpsPerDie`),
      scaleBytesPerDie: finite(costs.scaleBytes, `${modelId}.${sourceRow.operatorId}.scaleBytesPerDie`),
      accumulationOpsPerDie: finite(accumulationOps, `${modelId}.${sourceRow.operatorId}.accumulationOpsPerDie`),
      computeUs: finite(computeUs, `${modelId}.${sourceRow.operatorId}.computeUs`),
      memoryUs: finite(memoryUs, `${modelId}.${sourceRow.operatorId}.memoryUs`),
      networkUs: finite(networkUs, `${modelId}.${sourceRow.operatorId}.networkUs`),
      nominalCycles: finite(serviceUs * profile.ghz * 1e3, `${modelId}.${sourceRow.operatorId}.nominalCycles`),
      serviceUs: finite(serviceUs, `${modelId}.${sourceRow.operatorId}.serviceUs`),
      bottleneck,
      basis: sourceRow.basis,
      source: sourceRow.source
    };
  });

  const classes = ['L', 'H', 'INDEXER', 'REDUCE', 'V'].map(coreClass => {
    const resource = coreResource(coreClass);
    const own = rows.filter(row => row.coreClass === coreClass);
    const sum = field => own.reduce((total, row) => total + row[field], 0);
    const computeUs = sum('computeUs');
    const memoryUs = sum('memoryUs');
    const networkUs = sum('networkUs');
    const serviceUs = Math.max(computeUs, memoryUs, networkUs);
    return {
      coreClass,
      resourceClass: resource,
      operatorCount: own.length,
      flopsPerDie: sum('flopsPerDie'),
      bytesPerDie: sum('bytesPerDie'),
      localBytesPerDie: sum('localBytesPerDie'),
      networkBytesPerDie: sum('networkBytesPerDie'),
      dequantOpsPerDie: sum('dequantOpsPerDie'),
      scaleBytesPerDie: sum('scaleBytesPerDie'),
      accumulationOpsPerDie: sum('accumulationOpsPerDie'),
      computeUs, memoryUs, networkUs,
      nominalCycles: serviceUs * profile.ghz * 1e3,
      serviceUs,
      bottleneck: serviceUs === 0 ? 'unused' : serviceUs === networkUs && networkUs >= computeUs && networkUs >= memoryUs ? 'network'
        : serviceUs === memoryUs && memoryUs >= computeUs ? 'memory' : 'compute'
    };
  });
  const totalComputeUs = classes.reduce((sum, row) => sum + row.computeUs, 0);
  const totalMemoryUs = classes.reduce((sum, row) => sum + row.memoryUs, 0);
  const totalNetworkUs = classes.reduce((sum, row) => sum + row.networkUs, 0);
  const criticalUs = Math.max(totalComputeUs, totalMemoryUs, totalNetworkUs);
  return {
    modelId, variantId, tp, mcProfile, physicalProfile: 'P1', diesPerPackage: DIES,
    evidenceClass: EVIDENCE, status: 'PLANNING_DERIVED',
    assumptions: {
      tpShard: 'global FLOP/byte is divided by TP, then by 8 dies; TP-only placement, no EP/all-to-all',
      computePeak: 'P1 peakByCore derated by utilization x dutyCycle; INDEXER uses H, REDUCE uses V',
      memoryBandwidth: 'MC effective sustained bytes/s divided evenly across 8 dies',
      networkBandwidth: 'card network payload limit divided evenly across 8 dies for a lower-bound service estimate',
      quantization: 'FP8 dequant uses one operation and one FP32 scale per 128 weights; FP4 uses one operation and one byte scale per 32 weights',
      overlap: 'compute, memory and network service times are maxed per operator; no queueing or scheduler trace'
    },
    resourceProfile: {source: R.SPEC_PATH, profile: 'P1', ghz: profile.ghz, utilization: R.utilization, dutyCycle: R.dutyCycle,
      corePeakPerDie: corePeakPerDie, sustainedPeakPerDie, memoryBytesPerSecondPerDie: memoryPerDie, networkBytesPerSecondPerDie: networkPerDie},
    rows, resources: classes,
    criticalPath: {computeUs: totalComputeUs, memoryUs: totalMemoryUs, networkUs: totalNetworkUs,
      serviceUs: criticalUs, nominalCycles: criticalUs * profile.ghz * 1e3,
      bottleneck: criticalUs === totalNetworkUs && totalNetworkUs >= totalComputeUs && totalNetworkUs >= totalMemoryUs ? 'network'
        : criticalUs === totalMemoryUs && totalMemoryUs >= totalComputeUs ? 'memory' : 'compute',
      tps: null, p95Us: null, p99Us: null}
  };
}

function build() {
  const artifact = loadLedgerArtifact();
  const runs = [];
  for (const [modelId, variantId, ledger] of variantEntries(artifact)) {
    for (const tp of TP_VALUES) for (const mc of MC_VALUES) runs.push(replayLedger(ledger, modelId, variantId, tp, mc));
  }
  return {
    schemaVersion: 'model-core-replay-v0.1',
    generatedBy: 'integration/planning/model_core_replay.js',
    evidenceClass: EVIDENCE,
    status: 'PLANNING_DERIVED',
    scenario: {batch: 1, contextTokens: 1048576, decodeTokens: 1, phase: 'decode'},
    provenance: {operatorLedger: LEDGER_FILE, operatorLedgerSha256: hashFile(LEDGER_FILE),
      resourceProfile: R.SPEC_PATH, resourceProfileSha256: hashFile(R.SPEC_PATH),
      replaySource: 'integration/planning/model_core_replay.js', replaySourceSha256: hashFile('integration/planning/model_core_replay.js')},
    units: {flops: 'per die FLOP/token', bytes: 'per die byte/token', time: 'nominal service microseconds/token', cycles: 'nominal 1 GHz-equivalent cycles'},
    runs
  };
}

module.exports = {LEDGER_FILE, EVIDENCE, DIES, TP_VALUES, MC_VALUES, dtypeCosts, replayLedger, build};
