'use strict';
/* K3 TPS/usr design baseline (docs/design/21_TPS_DESIGN_BASELINE.md, ADR-0005).
 *
 * Collects, for the published Final Tuning point, everything the TPS/usr claim
 * rests on: the time ledger, the hardware sizing, and every software mechanism
 * with the value it would fall back to and the replayed TPS when only that one
 * is switched back. Ablations are recomputed from the model, never hand-copied.
 *
 * Written into docs/design/spec/k3_mc_baseline.json#tpsDesign by
 * scripts/sync_baseline_spec.js; tests/test_tps_design_baseline.js rebuilds it
 * and compares.
 */
const A = require('../search/k3_architecture_search.js');
const O = require('./k3_rdma_final_tuning_model.js');
const P = require('../search/k3_physical_basis.js');

const pick = r => r.feasible === false
  ? {feasible: false, reasons: r.reasons || [r.reason]}
  : {feasible: true, tpsPerUser: r.tps, rawLatencyUs: r.rawUs};

// Evaluate with a temporary OPT patch; OPT is always restored.
function withOpt(patch, x, fn = O.evaluate) {
  const saved = {...O.OPT};
  Object.assign(O.OPT, patch);
  try { return fn(x); } finally { Object.assign(O.OPT, saved); }
}

const SHARED_PORT_UNSCALED = {localWriteRatio: 1, tmaDedicatedPort: false, sharedReadScale: 1, sharedReadPerWrite: 0};
// Mechanisms the published point relies on. `off` is the value the mechanism
// falls back to (a `patch` of several OPT keys for composite mechanisms); each
// one must lower TPS (or make the point infeasible) when switched back alone.
const MECHANISMS = [
  {key: 'tmaLane', off: false, layer: 'scheduler/TMA', evidence: 'MODEL', role: 'shared->local fills issued ahead on per-domain (L/H) TMA lanes'},
  {key: 'kvPrefetch', off: 'layer', layer: 'scheduler/DMA', evidence: 'MODEL', role: 'KV context tiles of the next x.depth layers prefetched into shared SRAM'},
  {key: 'dmaPreempt', off: false, layer: 'scheduler/DMA', evidence: 'MODEL', role: 'demand fetches (routed-expert misses) park in-flight prefetches'},
  {key: 'commOverlap', off: false, layer: 'scheduler/collective', evidence: 'MODEL', role: 'shared experts run under the Wdown + Router all-gather'},
  {key: 'softmaxFusion', off: false, layer: 'kernel mapping', evidence: 'MODEL', role: 'online softmax pipelined on H vector lanes under QK'},
  {key: 'launchBatching', off: false, layer: 'runtime', evidence: 'ASSUMPTION', role: 'launch cost scaled once by OPT.launchScale'},
  {key: 'epilogueFusion', off: false, layer: 'kernel mapping', evidence: 'MODEL', role: 'elementwise ops folded into the adjacent kernel'},
  {key: 'pvMerge', off: 'tile', layer: 'kernel mapping', evidence: 'MODEL', role: 'PV m/l/O merged once per layer, cross-die ring reduce-scatter by heads'},
  {key: 'kvCache', off: 'bf16', layer: 'model format', evidence: 'MODEL (precision open, B-001)', role: 'FlashMLA FP8 KV layout, BF16 compute with in-kernel dequant'},
  {key: 'sharedPortScaling', patch: SHARED_PORT_UNSCALED, layer: 'hardware/SRAM ports', evidence: 'MODEL (O-007)', role: 'shared-SRAM write/read port scaling and dedicated TMA port, charged in area/power'}
];
// Switches that are on but do not move TPS at the published point; listed so
// nobody reads them as contributors.
const NO_EFFECT = [
  {key: 'tilePartialReady', patch: {tilePartialReady: false}, note: 'acts on duration only through GAIN, which is 1'}
];

const category = o => o.unit === 'COMM' ? 'collective'
  : /^QK|softmax|^PV|RoPE|KV append|MLA Q|Q \/ new-KV/.test(o.name) ? 'mlaAttention'
  : /Linear recurrent|Linear projections/.test(o.name) ? 'linearAttention'
  : /Attention output projection|Attention RMSNorm|Attention residual/.test(o.name) ? 'attentionCommon'
  : /Expert|Routed|Router|Dispatch|Wup|Wdown|SiLU|Shared|MoE|Top-k/.test(o.name) ? 'moe'
  : 'headAndSampling';

function build(x, budgetUs) {
  const r = O.evaluate(x);
  if (!r.feasible) throw new Error('published point is infeasible');
  const m = O.mapped(x), p = r.p;
  const unscaled = withOpt(SHARED_PORT_UNSCALED, x).p;
  const collectiveTotal = r.protocol.reduce((s, a) => s + a.count, 0);
  const opTimeUsByCategory = {};
  for (const o of m.plan.ops) opTimeUsByCategory[category(o)] = (opTimeUsByCategory[category(o)] || 0) + o.duration;
  return {
    status: 'BASELINE (model-derived, not FROZEN; ADR-0003, ADR-0005)',
    document: 'docs/design/21_TPS_DESIGN_BASELINE.md',
    adr: 'docs/design/decisions/ADR-0005-tps-design-baseline.md',
    point: {tpsPerUser: r.tps, rawLatencyUs: r.rawUs, e2eLatencyUs: r.e2eUs, rawBudgetUs: budgetUs, rawMarginUs: budgetUs - r.rawUs},
    ledger: {
      identity: 'raw = compute - tmaHidden + comm + wait - overlap; TPS = 1e6 / (raw x engineeringMargin)',
      computeUs: r.computeUs, tmaHiddenUs: r.tmaHiddenUs, commUs: r.commUs, dmaWaitUs: r.waitUs, overlapUs: r.overlapUs,
      tmaFillUs: r.tmaFillUs, tmaExposedUs: r.tmaExposedUs,
      services: r.services,
      opTimeUsByCategory,
      collectives: r.protocol.map(a => ({name: a.name, count: a.count, timeUs: a.timeUs, avgProtocolUs: a.timeUs / a.count, workspaceBytes: a.workspace}))
    },
    dataMovement: {
      readBytesPerRankPerToken: r.readBytes, predictedExpertBytes: r.predBytes, mispredictedBytes: r.wrongBytes,
      dmaBusyUs: r.dmaBusyUs, effectiveDmaTBsPerCard: r.dmaTBs, dmaPreemptions: r.dmaPreemptions, tmaCancels: r.tmaCancels,
      kvBytesPerTokenPerLayer: m.plan.kvBytesPerToken, backingGBPerRank: r.backingGB,
      sharedWindowMiBPerCard: r.sramMiB, sharedPeakReservedMiBPerCard: r.peakReservedMiB,
      localTileMiB: {lCore: r.localL, hCore: r.localH}, rdmaWorkspaceMiB: r.rdmaReserveMiB
    },
    hardware: {
      x: {...x},
      perDie: {
        lTensorTflops: p.lTF, hTensorTflops: p.hTF, vectorTops: p.vectorTOP, reduceTops: p.reduceTOP,
        localSramMiB: p.localMiB, dataSramMiB: p.totalMiB,
        localReadTBs: {lCore: p.lRead, hCore: p.hRead}, sharedReadTBs: p.sharedRead, sharedWriteTBs: p.sharedWrite,
        nocMesh: [p.meshSide, p.meshSide], nocTBs: p.nocTB, coreTmaTBs: p.coreTma,
        uciePortGBs: p.uciePortGB, mcGBsPerDie: p.mcDieGB, dieCutGBs: p.dieCutGB, rdmaGBsPerDie: p.rdmaDieGB
      },
      perCard: {rdmaGBs: p.rdmaCardGB, powerW: p.cardPower, mcPowerW: p.mcPower, packageAreaMm2: p.packageArea, shorelineMm: p.shoreline, shorelineBudgetMm: p.edgeBudget},
      areaMm2: p.area, powerW: p.power, dieAreaMm2: p.dieArea, diePowerW: p.diePower,
      limits: {dieAreaMm2: P.BASIS.limits.dieArea, diePowerW: P.BASIS.limits.diePower, cardPowerW: P.BASIS.limits.cardPower, packageAreaMm2: P.BASIS.limits.packageArea},
      sharedPortScalingCost: {dieAreaMm2: p.dieArea - unscaled.dieArea, diePowerW: p.diePower - unscaled.diePower, cardPowerW: p.cardPower - unscaled.cardPower},
      // Physical basis (P.BASIS); dieAreaMm2AtN4Ref is physical() on the historical
      // N4 reference coefficients, before the charged shared-port area.
      basis: {process: P.BASIS.process, areaScale: {...P.PROCESS[P.BASIS.process]}, matrixTFPerMm2: P.BASIS.matrixTFPerMm2,
        matrixTFPerMm2N4Ref: A.TECH.matrixTFPerMm2, cooling: P.BASIS.cooling, dieAreaMm2AtN4Ref: A.physical(x).dieArea},
      tech: {matrixUtil: A.TECH.matrixUtil, vectorUtil: A.TECH.vectorUtil, launchUs: A.TECH.launchUs, unpackParamsPerLaneCycle: A.TECH.unpackParamsPerLaneCycle}
    },
    software: {
      opt: {...O.OPT},
      gainAllNeutral: Object.values(O.GAIN).every(v => v === 1),
      mechanisms: MECHANISMS.map(d => {
        const off = d.patch || {[d.key]: d.off};
        const on = d.patch ? Object.fromEntries(Object.keys(d.patch).map(k => [k, O.OPT[k]])) : O.OPT[d.key];
        return {key: d.key, on, off: d.patch || d.off, layer: d.layer, evidence: d.evidence, role: d.role, ablation: pick(withOpt(off, x))};
      }),
      noEffectAtPublishedPoint: NO_EFFECT.map(n => ({key: n.key, note: n.note, ablation: pick(withOpt(n.patch, x))})),
      countBasis: {on: O.OPT.countBasis, off: 'repo-510', ablation: pick(withOpt({countBasis: 'repo-510'}, x)), note: 'counting basis, not an optimization (ADR-0004)'}
    },
    sensitivity: {
      tauBreakEvenUs: O.OPT.tauUs + (budgetUs - r.rawUs) / collectiveTotal,
      tauHeadroomUsPerCollective: (budgetUs - r.rawUs) / collectiveTotal,
      depth: Object.fromEntries([1, 2, 3, 4].map(d => [d, pick(O.evaluate({...x, depth: d}))])),
      mcGBs: Object.fromEntries([320, 400, 480, 560, 640].map(g => [g, pick(O.evaluate({...x, mcGBs: g}))])),
      kvTile16384: {fp8: pick(O.evaluate({...x, kvTile: 16384})), bf16: pick(withOpt({kvCache: 'bf16'}, {...x, kvTile: 16384}))}
    },
    regenerate: 'npm run search:final && npm run baseline:sync && npm run model:planning; enforced by tests/test_tps_design_baseline.js'
  };
}

module.exports = {build, MECHANISMS, NO_EFFECT, SHARED_PORT_UNSCALED};
