'use strict';

/* Model-owned collective ledgers.  This kernel turns the model's logical
 * messages into the protocol quantities consumed by the cross-team network
 * planner.  It deliberately does not derive model shape or claim runtime
 * latency; those remain separate evidence classes. */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '../..', '..');
const LEDGER_FILES = {
  'GLM-5.2': 'teams/model/inputs/glm_5_2_collective_ledger.json',
  'DeepSeek-V4-Pro': 'teams/model/inputs/deepseek_v4_pro_collective_ledger.json'
};
const hash = data => crypto.createHash('sha256').update(data).digest('hex');
const readText = file => fs.readFileSync(path.join(ROOT, file), 'utf8');
const read = file => JSON.parse(readText(file));
const align = (n, a) => Math.ceil(n / a) * a;

function assertFinite(value, name, positive = false) {
  if (!Number.isFinite(value) || (positive ? value <= 0 : value < 0)) throw new Error(`${name} must be ${positive ? 'positive' : 'non-negative'}`);
}

function validateLedger(ledger) {
  if (!ledger || ledger.schemaVersion !== 'model-collective-ledger-v0.1') throw new Error('invalid collective ledger schema');
  if (!LEDGER_FILES[ledger.modelId]) throw new Error(`unsupported collective ledger model ${ledger.modelId}`);
  for (const key of ['hiddenSize', 'attentionHeads', 'indexerHeads', 'layers']) assertFinite(ledger[key], `${ledger.modelId}.${key}`, true);
  const d = ledger.defaults;
  for (const key of ['payloadBytesPerRank', 'headerBytes', 'flagBytes', 'packetAlignBytes', 'stripeBytes',
    'outstandingPerNic', 'qpContextBytes', 'wqeCqeBytes', 'epochs', 'ackBytesPerRequest', 'dieCount']) {
    assertFinite(d[key], `${ledger.modelId}.defaults.${key}`, true);
  }
  if (!Array.isArray(ledger.collectives) || !ledger.collectives.length) throw new Error(`${ledger.modelId}: empty collective ledger`);
  let total = 0;
  for (const c of ledger.collectives) {
    for (const key of ['collectiveId', 'layerClass', 'operation', 'activeNicPolicy', 'payloadBasis', 'algorithm', 'precision', 'evidence']) {
      if (typeof c[key] !== 'string' || !c[key]) throw new Error(`${ledger.modelId}: ${key} missing`);
    }
    for (const key of ['layerCount', 'countPerLayer', 'countPerToken', 'payloadBytesPerRank']) assertFinite(c[key], `${ledger.modelId}.${c.collectiveId}.${key}`, true);
    if (c.countPerToken !== c.layerCount * c.countPerLayer) throw new Error(`${ledger.modelId}.${c.collectiveId}: count mismatch`);
    total += c.countPerToken;
  }
  if (ledger.countByLayerClass && ledger.countByLayerClass.total !== total) throw new Error(`${ledger.modelId}: countByLayerClass.total mismatch`);
  return ledger;
}

function load(modelId) {
  if (!LEDGER_FILES[modelId]) return null;
  const file = LEDGER_FILES[modelId];
  const text = readText(file);
  const ledger = validateLedger(JSON.parse(text));
  return {...ledger, source: {path: file, sha256: hash(text)}};
}

function activeNics(c, tp, defaults) {
  if (c.activeNicPolicy === 'indexerHeads') return Math.min(defaults.dieCount, Math.max(1, Math.ceil(c.indexerHeads / tp)));
  return Math.min(defaults.dieCount, Math.max(1, Math.ceil(c.payloadBytesPerRank / defaults.stripeBytes)));
}

function variantFor(ledger, variantId) {
  if (!ledger.variants) return null;
  const variant = ledger.variants.find(v => v.variantId === variantId);
  if (!variant) throw new Error(`${ledger.modelId}: unknown variant ${variantId}`);
  return variant;
}

function protocol(modelId, tp, variantId = null) {
  if (!Number.isInteger(tp) || tp < 2) throw new Error(`invalid TP${tp}`);
  const ledger = load(modelId);
  if (!ledger) return null;
  const variant = variantFor(ledger, variantId || (ledger.variants && ledger.variants[0].variantId));
  const d = ledger.defaults;
  const indexerHeads = ledger.indexerHeads || 1;
  const rows = ledger.collectives.map(c => {
    const n = activeNics({...c, indexerHeads}, tp, d);
    const peers = tp - 1;
    const transportBytes = c.operation === 'allReduce' || c.operation === 'reduceScatterAllGather' ? 2 * c.payloadBytesPerRank : c.payloadBytesPerRank;
    const passPayloads = c.operation === 'allGather' ? [c.payloadBytesPerRank]
      : c.operation === 'lse' ? [c.payloadBytesPerRank]
        : c.operation === 'reduceScatterAllGather' || c.operation === 'allReduce'
          ? [transportBytes, c.payloadBytesPerRank] : [c.payloadBytesPerRank];
    const packetBytes = passPayloads.map(bytes => align(bytes / tp / n + d.headerBytes + d.flagBytes, d.packetAlignBytes));
    const requestsPerCollectivePerRank = packetBytes.length * peers * n;
    const wireBytes = packetBytes.reduce((sum, packet) => sum + packet * peers * n, 0);
    const logicalBytesPerRank = c.payloadBytesPerRank;
    const ackControlBytesPerRank = requestsPerCollectivePerRank * d.ackBytesPerRequest;
    const queueBytes = d.dieCount * (peers * d.qpContextBytes + d.outstandingPerNic * d.wqeCqeBytes);
    const mailboxBytes = d.epochs * (transportBytes * 2 + c.payloadBytesPerRank + tp * n * d.mailboxSlotBytes);
    for (const [key, value] of Object.entries({wireBytes, requestsPerCollectivePerRank, queueBytes, mailboxBytes, ackControlBytesPerRank})) assertFinite(value, `${ledger.modelId}.${c.collectiveId}.${key}`);
    return {
      ...c,
      countPerToken: c.countPerToken,
      payloadBytesPerCollective: c.payloadBytesPerRank,
      logicalBytesPerRank,
      peersPerRank: peers,
      activeNICs: n,
      transportBytes,
      protocolWireBytesPerCollectivePerRank: wireBytes,
      protocolRequestsPerCollectivePerRank: requestsPerCollectivePerRank,
      protocolWorkspaceBytesPerRank: queueBytes + mailboxBytes,
      ackControlBytesPerCollectivePerRank: ackControlBytesPerRank,
      packetBytesPerPass: packetBytes,
      routedLogicalBytesPerCollectivePerRank: logicalBytesPerRank * peers,
      nocBytesPerCollectivePerRank: 2 * transportBytes + d.flagBytes * requestsPerCollectivePerRank,
      indexerHeads,
      variantId: variant ? variant.variantId : null
    };
  });
  const logicalPayload = rows.reduce((s, r) => s + r.countPerToken * r.logicalBytesPerRank, 0);
  const wireBytes = rows.reduce((s, r) => s + r.countPerToken * r.protocolWireBytesPerCollectivePerRank, 0);
  const requests = rows.reduce((s, r) => s + r.countPerToken * r.protocolRequestsPerCollectivePerRank, 0);
  const routedBytes = rows.reduce((s, r) => s + r.countPerToken * r.routedLogicalBytesPerCollectivePerRank, 0);
  return {
    modelId,
    variantId: variant ? variant.variantId : null,
    tp,
    layers: ledger.layers,
    attentionHeads: ledger.attentionHeads,
    indexerHeads: ledger.indexerHeads,
    countPerToken: rows.reduce((s, r) => s + r.countPerToken, 0),
    rows,
    variants: ledger.variants ? ledger.variants.map(v => ({...v,
      collectivePayloadBasis: 'shared protocol ledger; parameter variant changes compute/weight rows, not collective payload'})) : null,
    totals: {logicalPayloadBytesPerRank: logicalPayload, protocolWireBytesPerRank: wireBytes,
      routedLogicalBytesPerRank: routedBytes, requestsPerRank: requests,
      ackControlBytesPerRank: rows.reduce((s, r) => s + r.countPerToken * r.ackControlBytesPerCollectivePerRank, 0),
      maxWorkspaceBytesPerRank: Math.max(...rows.map(r => r.protocolWorkspaceBytesPerRank))},
    source: ledger.source,
    evidenceClass: ledger.evidenceClass,
    status: ledger.status
  };
}

function modelProtocolContexts(modelId) {
  return [8, 16, 32].map(tp => protocol(modelId, tp));
}

module.exports = {LEDGER_FILES, load, validateLedger, protocol, modelProtocolContexts};
