'use strict';

/* Planning-only SRAM/MC sensitivity for GLM-5.2 and DeepSeek-V4-Pro.
 * Full context state is backing storage; only the active decode tile is
 * considered resident in shared SRAM. No validated latency or TPS is emitted. */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const R = require('../../teams/hardware/src/resource_profiles');

const ROOT = path.resolve(__dirname, '../..');
const LEDGER_FILE = 'out/workload/model_operator_ledgers.json';
const CORE_FILE = 'out/workload/model_core_replay.json';
const MANIFEST_FILE = 'teams/model/inputs/formal_model_manifests.json';
const DIES = R.DIES_PER_PACKAGE;
const SRAM_MIB = [4, 8, 16, 24, 32];
const BANDWIDTH_SCALES = [0.5, 0.75, 1, 1.25, 1.5];
const TILE_TOKENS = 32768;
const EVIDENCE = 'UNVERIFIED_PLANNING_MANIFEST';

const read = file => JSON.parse(fs.readFileSync(path.join(ROOT, file), 'utf8'));
const hashFile = file => crypto.createHash('sha256').update(fs.readFileSync(path.join(ROOT, file))).digest('hex');
const MiB = value => value / (1024 * 1024);
const finite = (value, label) => {
  if (!Number.isFinite(value) || value < 0) throw new Error(`${label} must be finite and non-negative`);
  return value;
};

function modelShape(modelId) {
  const manifest = read(MANIFEST_FILE);
  return manifest.models.find(model => model.modelId === modelId).shape;
}

function variantLedger(artifact, modelId, variantId) {
  return modelId === 'GLM-5.2' ? artifact.models[modelId] : artifact.models[modelId].variants[variantId];
}

function stateInventory(modelId, variantId, ledger) {
  const shape = modelShape(modelId);
  const c = shape.config || shape.reported;
  const a = Object.fromEntries(Object.entries(shape.assumptions).map(([key, value]) => [key, value.value]));
  const layers = c.layers;
  const fullIndexerLayers = c.fullIndexerLayers ? c.fullIndexerLayers.length : layers;
  const topK = c.indexer?.topK || c.indexerTopK;
  const kvBytesPerToken = a.kvBytesPerTokenPerLayer;
  const indexKeyBytes = a.indexKeyBytesPerToken || a.indexer.keyBytesPerToken;
  const expertRow = ledger.rows.find(row => row.operatorId === 'routed_expert_active');
  const expertBytesPerLayer = expertRow ? expertRow.bytesPerLayer : 0;
  const indexTileBytes = TILE_TOKENS * indexKeyBytes * fullIndexerLayers;
  const kvTileBytes = topK * kvBytesPerToken;
  const expertTileBytes = Math.max(expertBytesPerLayer, 8 * 1024 * 1024);
  const backing = {
    KV_STATE: layers * 1048576 * kvBytesPerToken,
    SPARSE_INDEX_CACHE: fullIndexerLayers * 1048576 * indexKeyBytes,
    EXPERT_STAGING: expertBytesPerLayer,
    MTP_BRANCH_STATE: 0
  };
  const resident = {
    KV_STATE: kvTileBytes,
    SPARSE_INDEX_CACHE: indexTileBytes,
    EXPERT_STAGING: expertTileBytes,
    MTP_BRANCH_STATE: 0
  };
  const state = Object.fromEntries(Object.keys(backing).map(key => [key, {
      stateClass: key,
      backingBytesPerPackage: finite(backing[key], `${modelId}.${key}.backing`),
      backingBytesPerDie: finite(backing[key] / DIES, `${modelId}.${key}.backingPerDie`),
      residentBytesPerDie: finite(resident[key] / DIES, `${modelId}.${key}.residentPerDie`),
      lifetime: key === 'KV_STATE' ? 'one decode request; append per generated token' : key === 'SPARSE_INDEX_CACHE' ? 'one decode request; reused by shared/full indexer schedule' : key === 'EXPERT_STAGING' ? 'one active layer; evict between layers' : 'excluded from current decode scope',
      evictionPolicy: key === 'MTP_BRANCH_STATE' ? 'excluded' : 'spill to external memory when shared window is insufficient',
      basis: key === 'KV_STATE' ? `${layers} layers x 1M context x ${kvBytesPerToken} B/token/layer; ${variantId || 'native'} variant does not alter KV shape` : key === 'SPARSE_INDEX_CACHE' ? `${fullIndexerLayers} full indexer layers x 1M context x ${indexKeyBytes} B/key` : key === 'EXPERT_STAGING' ? `max(active routed expert bytes/layer, 8 MiB weight tile floor); active expert staging is a planning assumption` : 'MTP is excluded from TPS/usr and has no resident allocation'
    }]));
  return {modelId, variantId, contextTokens: 1048576, tileTokens: TILE_TOKENS, topK, layers, state};
}

function classify(capacityMiB, inventory) {
  const capacityBytes = capacityMiB * 1024 * 1024;
  const classes = Object.values(inventory.state);
  const totalResident = classes.reduce((sum, item) => sum + item.residentBytesPerDie, 0);
  const overflowBytes = Math.max(0, totalResident - capacityBytes);
  const pressure = totalResident === 0 ? 0 : overflowBytes / totalResident;
  const byClass = Object.fromEntries(classes.map(item => [item.stateClass, {
    residentMiBPerDie: MiB(item.residentBytesPerDie),
    backingGiBPerDie: item.backingBytesPerDie / 1e9,
    overflowMiBPerDie: MiB(Math.max(0, item.residentBytesPerDie - capacityBytes)),
    capacityBound: item.residentBytesPerDie > capacityBytes
  }]));
  return {capacityMiBPerDie: capacityMiB, totalResidentMiBPerDie: MiB(totalResident), overflowMiBPerDie: MiB(overflowBytes), pressure, byClass};
}

function runSensitivity(base, inventory, capacityMiB, bandwidthScale) {
  const capacity = classify(capacityMiB, inventory);
  const spillPenalty = 1 + capacity.pressure;
  const computeUs = base.criticalPath.computeUs;
  const networkUs = base.criticalPath.networkUs;
  const memoryUs = base.rows.reduce((sum, row) => sum + row.memoryUs, 0) * spillPenalty / bandwidthScale;
  const serviceUs = Math.max(computeUs, memoryUs, networkUs);
  const bottleneck = serviceUs === networkUs && networkUs >= computeUs && networkUs >= memoryUs ? 'network'
    : serviceUs === memoryUs && memoryUs >= computeUs ? 'memory' : 'compute';
  return {
    modelId: base.modelId, variantId: base.variantId, tp: base.tp, mcProfile: base.mcProfile,
    physicalProfile: base.physicalProfile, evidenceClass: EVIDENCE, status: 'PLANNING_DERIVED',
    capacityMiBPerDie: capacityMiB, bandwidthScale,
    state: capacity,
    service: {computeUs, memoryUs, networkUs, serviceUs, nominalCycles: serviceUs * 1e3, bottleneck, tps: null, p95Us: null, p99Us: null},
    assumptions: {
      capacity: 'shared SRAM capacity is a per-die resident window; full KV/index backing remains in external memory',
      spill: 'overflow pressure multiplies memory service by (1 + overflow/resident); this is a sensitivity proxy, not a queueing replay',
      bandwidth: 'MC effective sustained bandwidth is scaled uniformly; compute and network lanes are held fixed',
      overlap: 'compute/memory/network use max service time; no scheduler, eviction or queue trace'
    }
  };
}

function build() {
  const ledgers = read(LEDGER_FILE);
  const core = read(CORE_FILE);
  if (ledgers.provenance.evidenceClass !== EVIDENCE || core.evidenceClass !== EVIDENCE) throw new Error('planning evidence class mismatch');
  const runs = [];
  for (const base of core.runs) {
    const ledger = variantLedger(ledgers, base.modelId, base.variantId);
    const inventory = stateInventory(base.modelId, base.variantId, ledger);
    for (const capacity of SRAM_MIB) for (const bandwidth of BANDWIDTH_SCALES) runs.push(runSensitivity(base, inventory, capacity, bandwidth));
  }
  return {
    schemaVersion: 'model-sram-sensitivity-v0.1', generatedBy: 'integration/planning/model_sram_sensitivity.js',
    evidenceClass: EVIDENCE, status: 'PLANNING_DERIVED',
    scenario: {batch: 1, contextTokens: 1048576, decodeTokens: 1, phase: 'decode'},
    sweep: {sharedSramMiBPerDie: SRAM_MIB, effectiveBandwidthScale: BANDWIDTH_SCALES, seed: 'deterministic-grid-v0', noRuntimeTrace: true},
    provenance: {operatorLedgers: LEDGER_FILE, operatorLedgersSha256: hashFile(LEDGER_FILE), coreReplay: CORE_FILE, coreReplaySha256: hashFile(CORE_FILE), manifest: MANIFEST_FILE, manifestSha256: hashFile(MANIFEST_FILE), source: 'integration/planning/model_sram_sensitivity.js', sourceSha256: hashFile('integration/planning/model_sram_sensitivity.js')},
    units: {capacity: 'MiB per die', backing: 'decimal GB per die', bandwidth: 'scale against MC effective sustained bytes/s', service: 'nominal microseconds/token', cycles: 'nominal 1 GHz-equivalent cycles'},
    runs
  };
}

module.exports = {LEDGER_FILE, CORE_FILE, MANIFEST_FILE, EVIDENCE, SRAM_MIB, BANDWIDTH_SCALES, stateInventory, classify, runSensitivity, build};
