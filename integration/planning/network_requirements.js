'use strict';
// Collective-only link demand at the published K3 mapping and its TP16 protocol projection. Routing, packets and timing use
// the existing protocol/topology kernel; no measurement, topology choice or Gate is inferred.
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const {execFileSync} = require('child_process');
const T = require('../detailed/collective_topology');
const O = require('../detailed/k3_rdma_final_tuning_model');
const R = require('../detailed/k3_sram_memory_rdma_model');
const A = require('../detailed/k3_architecture_search');
const BP = require('../detailed/baseline_point');
const E = require('../../teams/model/src/design_engine');
const CL = require('../../teams/model/src/collective_ledger');
const RW = require('./requirement_workload');
const IDS = require('./run_ids');

const root = path.resolve(__dirname, '../..');
const OUT_FILE = 'out/requirements/network_requirements.json';
const KERNEL_FILE = 'integration/planning/network_requirements.js';
const SCHEMA_VERSION = 'network-requirements-v0.2';
const SOURCE_FILES = [...new Set([T.BASELINE_FILE, T.CANDIDATES_FILE, T.COMM_CORE_FILE,
  RW.WORKLOAD_FILE, RW.SCENARIO_CATALOG_FILE, RW.SCENARIO_SCHEMA_FILE, RW.KERNEL_FILE,
  KERNEL_FILE, 'integration/planning/run_ids.js', 'integration/orchestration/runtime/schema.js',
  'teams/model/inputs/formal_model_manifests.json', 'integration/detailed/baseline_point.js',
  CL.LEDGER_FILES['GLM-5.2'], CL.LEDGER_FILES['DeepSeek-V4-Pro'],
  'teams/model/src/collective_ledger.js',
  'teams/hardware/src/resource_profiles.js', ...T.SOURCE_FILES])];
const read = file => JSON.parse(fs.readFileSync(path.join(root, file), 'utf8'));
const hash = data => crypto.createHash('sha256').update(data).digest('hex');

function percentiles(samples) {
  if (!samples.length) return {p50: null, p95: null, p99: null, min: null, max: null};
  const sorted = [...samples].sort((a, b) => a.value - b.value);
  const total = sorted.reduce((s, x) => s + x.count, 0);
  const at = q => {
    let cumulative = 0;
    for (const x of sorted) { cumulative += x.count; if (cumulative >= Math.ceil(q * total)) return x.value; }
    return sorted[sorted.length - 1].value;
  };
  return {p50: at(.50), p95: at(.95), p99: at(.99), min: sorted[0].value, max: sorted[sorted.length - 1].value};
}

function parameters(spec, topology, corner) {
  return {...Object.fromEntries(spec.parameters.map(p => [p.key, p[corner]])),
    cableM: topology.cableM ? topology.cableM[corner] : 0,
    spineCableM: topology.spineCableM ? topology.spineCableM[corner] : 0};
}

function routeTraffic(topologyDef, spec, classes, ctx) {
  const P = parameters(spec, topologyDef, 'nominal');
  const topo = T.topology(topologyDef, spec.card, P);
  const links = new Map(), samples = [];
  const order = T.ringOrder(topologyDef, spec.card.ranks);
  let injectedPacketBytes = 0, routedPacketBytes = 0;
  const classRows = classes.map(({name, payload, count, q}) => {
    let injected = 0, routed = 0;
    const ownSamples = [];
    for (const pass of q.protocolPasses || T.passes(name, payload, q)) for (const step of T.steps(pass, 'oneShot', q.activeNICs, order, spec.card.ranks)) {
      const packetBytes = Math.ceil((step.bytes + ctx.c.headerBytes + ctx.c.flagBytes) / ctx.c.packetAlign) * ctx.c.packetAlign;
      for (let src = 0; src < spec.card.ranks; src++) for (let nic = 0; nic < q.activeNICs; nic++) for (const dst of step.dsts(src)) {
        if (dst === src || dst < 0 || dst >= spec.card.ranks) throw new Error('invalid collective destination');
        const route = topo.route(src, dst, spec.card.nicDies[nic]);
        ownSamples.push({value: T.pathLatency(route, P, spec.propagationUsPerM), count});
        injected += packetBytes * count;
        for (const edge of route.links) {
          const entry = links.get(edge.id) || {linkId: edge.id, lanes: edge.lanes,
            capacityGBs: edge.lanes * ctx.p.rdmaDieGB / spec.card.lanesPerDie, packetBytesPerToken: 0};
          if (entry.lanes !== edge.lanes) throw new Error(`inconsistent lane count for ${edge.id}`);
          entry.packetBytesPerToken += packetBytes * count;
          links.set(edge.id, entry);
          routed += packetBytes * count;
        }
      }
    }
    const expected = q.wireBytes * count * spec.card.ranks;
    if (Math.abs(injected - expected) > 1e-6 * Math.max(1, expected)) throw new Error(`${name}: route bytes differ from protocol wire bytes`);
    samples.push(...ownSamples);
    injectedPacketBytes += injected; routedPacketBytes += routed;
    const latencyCornersUs = Object.fromEntries(['low', 'nominal', 'high'].map(corner => {
      const Pc = parameters(spec, topologyDef, corner);
      const cell = {topologyDef, algorithm: 'oneShot', ackDrain: 'phase', topo: T.topology(topologyDef, spec.card, Pc), P: Pc};
      return [corner, T.derive(name, payload, q, cell, {...ctx, P: Pc}).tauUs];
    }));
    return {name, countPerToken: count, payloadBytesPerCollective: payload, activeNICs: q.activeNICs,
      protocolWireBytesPerCollectivePerRank: q.wireBytes,
      protocolRequestsPerCollectivePerRank: T.passes(name, payload, q).length * (spec.card.ranks - 1) * q.activeNICs,
      protocolWorkspaceBytesPerRank: q.workspace,
      injectedPacketBytesPerTokenGroup: injected, routedPacketBytesPerTokenGroup: routed,
      nominalMessagePathLatencyUs: percentiles(ownSamples), collectiveLatencyCornersUs: latencyCornersUs};
  });
  return {topology: topologyDef.key, algorithm: 'oneShot', ackDrain: 'phase', evidence: 'MODEL_WITH_ASSUMPTIONS',
    classes: classRows, nominalMessagePathLatencyUs: percentiles(samples),
    runtimeLatencyUs: {p50: null, p95: null, p99: null, status: 'UNVERIFIABLE_NO_QUEUEING_TRACE'},
    injectedPacketBytesPerTokenGroup: injectedPacketBytes, routedPacketBytesPerTokenGroup: routedPacketBytes,
    links: [...links.values()].sort((a, b) => a.linkId.localeCompare(b.linkId))};
}

function modelContext(modelId, tp = 32) {
  const base = context(tp);
  const ledger = CL.protocol(modelId, tp);
  if (!ledger) throw new Error(`no model collective ledger for ${modelId}`);
  const classes = ledger.rows.map(row => {
    const name = row.operation === 'allGather' ? `${row.collectiveId} all-gather`
      : row.operation === 'lse' ? `${row.collectiveId} LSE` : `${row.collectiveId} all-reduce`;
    return {name, payload: row.payloadBytesPerCollective, count: row.countPerToken,
      q: {activeNICs: row.activeNICs, wireBytes: row.protocolWireBytesPerCollectivePerRank,
        workspace: row.protocolWorkspaceBytesPerRank, transportBytes: row.transportBytes,
        readBytes: row.transportBytes, writeBytes: row.transportBytes,
        nocBytes: row.nocBytesPerCollectivePerRank,
        timing: {cardLocal: 0, tpReduce: 0},
        protocolPasses: row.operation === 'allGather' ? [{op: 'gather', bytes: row.payloadBytesPerCollective}]
          : row.operation === 'lse' ? [{op: 'scatter', bytes: row.transportBytes}]
            : [{op: 'scatter', bytes: row.transportBytes}, {op: 'gather', bytes: row.payloadBytesPerCollective}]}};
  });
  const modelControls = new Map([
    ['all-gather', base.controlUs('Wdown + Router all-gather')],
    ['LSE', base.controlUs('LSE merge / output reduce-scatter')],
    ['all-reduce', base.controlUs('Attention output all-reduce')]
  ]);
  return {...base, modelId, modelLedger: ledger, classes,
    controlUs: name => {
      for (const [key, value] of modelControls) if (name.includes(key)) return value;
      return base.controlUs('Attention output all-reduce');
    },
    lseHeadsPerRank: ledger.attentionHeads / tp,
    wireBytesPerTokenPerRank: ledger.totals.protocolWireBytesPerRank,
    nocBytesPerTokenPerRank: ledger.rows.reduce((s, row) => s + row.countPerToken * row.nocBytesPerCollectivePerRank, 0),
    dieCutBytesPerTokenPerRank: ledger.totals.logicalPayloadBytesPerRank * 2};
}

function context(tp = 32) {
  const baseline = read(T.BASELINE_FILE), spec = read(T.CANDIDATES_FILE);
  if (spec.card.ranks !== 32 || spec.card.dies !== baseline.card.computeDies || spec.card.dies !== 8 ||
      spec.card.nicDies.length !== spec.card.dies) throw new Error('network ledger requires the existing 32-rank / 8-die protocol mapping');
  const x = BP.publishedX(baseline, KERNEL_FILE), mapped = O.mapped(x);
  if (!mapped.feasible) throw new Error(`network mapping infeasible: ${mapped.reasons}`);
  const c = R.config({...R.MEM, stripeKiB: O.OPT.stripeKiB, oneWayUs: O.OPT.oneWayUs,
    commitCycles: O.OPT.commitCycles, notifyCycles: O.OPT.notifyCycles, ackCycles: O.OPT.ackCycles,
    outstandingPerNIC: O.OPT.outstandingPerNIC, epochs: O.OPT.epochs});
  const grouped = new Map();
  for (const op of mapped.plan.ops.filter(o => o.unit === 'COMM')) {
    const key = `${op.name}|${op.mapping.payload}`;
    const entry = grouped.get(key) || {name: op.name, payload: op.mapping.payload, count: 0, q: op.memory};
    entry.count++; grouped.set(key, entry);
  }
  let classes = [...grouped.values()];
  if (![16, 32].includes(tp)) throw new Error(`no K3 protocol projection for TP${tp}`);
  const projectedSpec = {...spec, card: {...spec.card, ranks: tp}, topologies: spec.topologies.map(t => {
    if (tp === spec.card.ranks) return t;
    const variant = t.rankVariants && t.rankVariants[String(tp)];
    if (!variant) throw new Error(`${t.key}: no explicit TP${tp} topology variant`);
    const {rankVariants, ...base} = t;
    return {...base, ...variant};
  })};
  const protocolConfig = tp === 32 ? c : R.config({...c, tp});
  if (tp !== 32) classes = classes.map(k => ({...k, q: R.collective(k.name, k.payload, mapped.p, x, protocolConfig)}));
  const controls = new Map(read(T.COMM_CORE_FILE).controlPath.classes.map(k => [k.name, k.controlUs]));
  const controlUs = name => { if (!controls.has(name)) throw new Error(`missing Comm Core control cost for ${name}`); return controls.get(name); };
  return {baseline, spec: projectedSpec, x, p: mapped.p, c: protocolConfig, card: projectedSpec.card,
    prop: spec.propagationUsPerM, controlUs, classes,
    wireBytesPerTokenPerRank: classes.reduce((s, k) => s + k.count * k.q.wireBytes, 0),
    nocBytesPerTokenPerRank: classes.reduce((s, k) => s + k.count * k.q.nocBytes, 0),
    dieCutBytesPerTokenPerRank: classes.reduce((s, k) => s + k.count * 2 * k.payload, 0)};
}

function scenarioLedger(scenario, ctx, traffic, multiplier) {
  const reasons = [];
  if (scenario.model !== 'K3' && !ctx.modelLedger) reasons.push('no per-collective message ledger for this model');
  if (scenario.tp !== ctx.spec.card.ranks) reasons.push('no explicit protocol/topology projection for this TP');
  if (scenario.batch !== 1 || scenario.context !== ctx.baseline.goal.contextTokens || scenario.phase !== 'decode') reasons.push('not the published batch/context/decode mapping');
  const expectedPrecision = scenario.model === 'K3' ? 'BF16+FP8-KV' : 'FP8+FP8-KV';
  if (scenario.precision !== expectedPrecision) reasons.push(`precision differs from the ${scenario.model} collective mapping`);
  if (reasons.length) return {...scenario, status: 'BLOCKED_CONFIG', reasons, layers: null, topologies: []};
  const rate = scenario.targetTpsPerUser;
  const gb = bytes => bytes * rate / 1e9;
  return {...scenario, status: 'MODEL_WITH_ASSUMPTIONS', tokenRatePerRank: rate,
    mapping: {basis: scenario.tp === 32 ? 'PUBLISHED_TP32_PROTOCOL' : 'TP16_PROTOCOL_PROJECTION',
      detailedReplaySupported: scenario.tp === 32, endToEndTpsPerUser: null,
      payloadBasis: scenario.model === 'K3' ? 'full-group logical payload and reference-393 class counts from the published K3 operator ledger; payload is not scaled by TP' : `${scenario.model} model-owned per-collective ledger; payload is not scaled by TP`,
      peersPerRank: scenario.tp - 1, lseHeadsPerRank: ctx.lseHeadsPerRank || E.MODEL_PRESETS.kimiK3.attention.heads / scenario.tp,
      lseNICPlacement: 'one whole head per active NIC up to 8 dies; nicDies[k] from topology contract',
      controlPathBasis: 'TP32 Comm Core control cost held fixed for TP16 as a planning assumption; not a TP16 firmware replay',
      collectiveLedger: ctx.modelLedger ? {
      modelId: ctx.modelLedger.modelId,
      variantId: ctx.modelLedger.variantId,
      variants: ctx.modelLedger.variants,
      source: ctx.modelLedger.source,
      evidenceClass: ctx.modelLedger.evidenceClass,
      collectiveCountPerToken: ctx.modelLedger.countPerToken,
      logicalPayloadBytesPerRank: ctx.modelLedger.totals.logicalPayloadBytesPerRank,
      protocolWireBytesPerRank: ctx.modelLedger.totals.protocolWireBytesPerRank,
      routedLogicalBytesPerRank: ctx.modelLedger.totals.routedLogicalBytesPerRank,
      requestsPerRank: ctx.modelLedger.totals.requestsPerRank,
      ackControlBytesPerRank: ctx.modelLedger.totals.ackControlBytesPerRank,
      maxWorkspaceBytesPerRank: ctx.modelLedger.totals.maxWorkspaceBytesPerRank,
      conservation: {
        routedEqualsLogicalTimesPeers: ctx.modelLedger.totals.routedLogicalBytesPerRank === ctx.modelLedger.totals.logicalPayloadBytesPerRank * (scenario.tp - 1),
        wireAtLeastLogical: ctx.modelLedger.totals.protocolWireBytesPerRank >= ctx.modelLedger.totals.logicalPayloadBytesPerRank
      }
      } : null},
    layers: {
      dieLocal: {basis: 'collective NoC bytes, balanced across dies; not individual NoC link routing',
        bytesPerTokenPerRank: ctx.nocBytesPerTokenPerRank, requiredGBsPerRank: gb(ctx.nocBytesPerTokenPerRank),
        requiredGBsPerDieBalanced: gb(ctx.nocBytesPerTokenPerRank) / ctx.card.dies,
        availableGBsPerDie: ctx.p.nocTB * 1000, evidence: 'MODEL_BALANCED_PLACEMENT_ASSUMPTION'},
      dieToDie: {basis: '2 x collective payload crosses the ring cut per collective; not total hop bytes',
        topology: 'bidirectional die ring (ADR-0016 OPEN)', cutLinks: A.dieRing(ctx.card.dies).cutLinks,
        bytesPerTokenAcrossCut: ctx.dieCutBytesPerTokenPerRank, requiredGBsAcrossCut: gb(ctx.dieCutBytesPerTokenPerRank),
        availableGBsAcrossCut: ctx.p.dieCutGB, evidence: 'MODEL_CUT_LOWER_BOUND'},
      package: {basis: 'package die-to-die ring cut; same resource as dieToDie, NOT additive',
        aliasOf: 'dieToDie', requiredGBsAcrossCut: gb(ctx.dieCutBytesPerTokenPerRank)},
      scaleOut: {basis: 'protocol data packets with header, flag and alignment per rank; excludes ACK packets',
        requiredInjectionGBsPerRank: gb(ctx.wireBytesPerTokenPerRank), availableInjectionGBsPerRank: ctx.p.rdmaCardGB},
      collective: {basis: 'service class spanning the above resources, NOT an extra physical tier',
        wireBytesPerTokenPerRank: ctx.wireBytesPerTokenPerRank}
    },
    topologies: traffic.map(row => {
      const links = row.links.map(link => ({...link, requiredGBs: gb(link.packetBytesPerToken),
        p99PlanningRequiredGBs: gb(link.packetBytesPerToken) * multiplier,
        utilization: gb(link.packetBytesPerToken) / link.capacityGBs}));
      const busiest = [...links].sort((a, b) => b.utilization - a.utilization || a.linkId.localeCompare(b.linkId))[0];
      return {...row, links, busiestLink: busiest,
        injectedGBsGroup: gb(row.injectedPacketBytesPerTokenGroup), routedGBsGroup: gb(row.routedPacketBytesPerTokenGroup)};
    })};
}

function build() {
  const ctx = context(), catalog = RW.loadScenarioCatalog();
  const workload = RW.build();
  const planningScenarios = workload.models.flatMap(m => m.scenarios);
  const contexts = new Map([['K3|32', ctx], ['K3|16', context(16)]]), traffic = new Map();
  const ledgers = catalog.map(s => {
    const key = `${s.model}|${s.tp}`;
    if (!contexts.has(key) && s.model !== 'K3') contexts.set(key, modelContext(s.model, s.tp));
    const own = contexts.get(key) || ctx;
    const planning = planningScenarios.find(p => p.scenarioId === s.scenarioId);
    const supported = contexts.has(key) && s.batch === 1 && s.context === ctx.baseline.goal.contextTokens && s.phase === 'decode' && s.precision === (s.model === 'K3' ? 'BF16+FP8-KV' : 'FP8+FP8-KV');
    if (!supported) return scenarioLedger(s, own, [], null);
    if (!planning || !planning.network) throw new Error(`network planning tail multiplier requires matching workload scenario ${s.scenarioId}`);
    if (!traffic.has(key)) traffic.set(key, own.spec.topologies.map(t => routeTraffic(t, own.spec, own.classes, own)));
    return scenarioLedger(s, own, traffic.get(key), planning.network.p99Multiplier);
  });
  return {schemaVersion: SCHEMA_VERSION, generatedBy: KERNEL_FILE, workItem: 'HW-NETWORK-DEMAND-01',
    status: 'PARTIAL_MODEL_WITH_ASSUMPTIONS; no Gate or topology selection',
    provenance: {sourceCommit: process.env.K3_SOURCE_COMMIT || execFileSync('git', ['rev-parse', 'HEAD'], {cwd: root, encoding: 'utf8'}).trim(),
      manifestHash: hash(fs.readFileSync(path.join(root, 'teams/model/inputs/formal_model_manifests.json'))),
      runId: `network-demand-${hash(JSON.stringify(catalog)).slice(0, 12)}`, seed: IDS.seed,
      profile: 'P1 / MC640 published stretch mapping', modelVersion: ctx.baseline.version,
      evidenceLevel: 'MODEL_WITH_ASSUMPTIONS', units: 'decimal GB/s and us'},
    scope: {point: `${T.BASELINE_FILE}#/tpsDesign/hardware/x`, model: 'K3', tp: [16, 32], detailedReplayTp: [32], batch: 1,
      context: ctx.baseline.goal.contextTokens, phase: 'decode', physicalProfile: 'P1', mcProfile: 'MC640 (published stretch mapping)'},
    units: {bandwidth: 'decimal GB/s, directed links, full TP-group traffic on each link', latency: 'us'},
    inputs: {sourceArtifacts: SOURCE_FILES.map(file => ({path: file, sha256: hash(fs.readFileSync(path.join(root, file)))})),
      scenarioCatalogSha256: hash(JSON.stringify(catalog))},
    assumptions: {topologyStatus: ctx.spec.status, topologySource: T.CANDIDATES_FILE,
      bandwidthP99MultipliersByScenario: Object.fromEntries(ledgers.filter(s => s.status !== 'BLOCKED_CONFIG').map(s => [s.scenarioId, planningScenarios.find(p => p.scenarioId === s.scenarioId).network.p99Multiplier])),
      bandwidthP99Basis: 'each matching workload scenario planning multiplier, not a measured traffic quantile',
      latencyQuantiles: 'nearest-rank empirical quantiles across nominal message routes, weighted by collective count; not runtime queueing tails',
      latencyCorners: 'all parameters low/nominal/high from topology contract; NOT P50/P95/P99'},
    exclusions: ['ACK packet wire demand', 'packet retransmission and loss', 'MTU segmentation', 'background DMA and non-collective NoC traffic',
      'NoC per-router placement and routing', 'extra D2D forwarding to scale-out ports; ring-cut demand is a lower bound',
      'queueing distributions and runtime latency percentiles', 'TP16 compute, memory capacity, SRAM feasibility and end-to-end TPS replay', 'topology selection and Gate eligibility'],
    scenarios: ledgers};
}

module.exports = {build, context, percentiles, parameters, routeTraffic, scenarioLedger, SOURCE_FILES, OUT_FILE, KERNEL_FILE, SCHEMA_VERSION};
