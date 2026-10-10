'use strict';
/* Workload shape (ARCH-CH-03, teams/council/docs/24_TRACE_AND_CHARON_ADOPTION_PLAN.md). A supplementary
 * view of the published hardware under other decode shapes; it changes no target (ADR-0009) and feeds
 * no gate.
 *
 *  - batchSweep: B independent sequences per decode step (tokens = seqs = B) at a few contexts. The
 *    hardware is the published x; the mapping knobs (MAPPING_GRID: kvTile, headTile, weightTileMiB,
 *    depth) are re-chosen per point, since the published mapping is sized for B = 1 and does not fit
 *    the H local tile or the shared window at B >= 2. Per (context, B) the best TPS/usr mapping; per
 *    context the Pareto front of TPS/usr against TPS/card over every feasible (B, mapping).
 *    TPS/card = B x TPS/usr / TP: one card is one TP rank (06_MULTIDIE_AND_SCALEOUT.md). Both expert
 *    unions (UNIONS): the routed expert bytes a step reads grow with the distinct experts of its B tokens.
 *  - contextScan: B = 1 at the published mapping over shorter contexts, with the 24 LSE merges and
 *    the attention service split out, and a head-parallel bound (evidence PLANNING_ESTIMATE, not
 *    simulated): split the 96 heads over the 32 ranks instead of the context, so no LSE merge, but
 *    every rank reads and stores the whole context's KV. It saves the LSE merge time and costs
 *    between 0 (the extra KV read hidden behind compute) and the extra bytes at the effective DMA
 *    rate (fully exposed). Charon's dynamic-SP case.
 *
 * Evidence class MODEL (the head-parallel columns PLANNING_ESTIMATE). Speculative steps (seqs < tokens)
 * are mtp_exploration.js's, not here.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const O = require('./k3_rdma_final_tuning_model.js');
const A = require('./k3_architecture_search.js');
const BP = require('./baseline_point.js');
const {simulate} = require('./k3_operator_sram_sim.js');
const {createPool} = require('./eval_pool.js');

const root = path.resolve(__dirname, '../..');
const BASELINE_FILE = 'teams/hardware/inputs/k3_mc_baseline.json';
const SOURCE_FILES = [
  'integration/detailed/workload_shape.js',
  'integration/detailed/k3_operator_sram_sim.js',
  'integration/detailed/k3_architecture_search.js',
  'integration/detailed/cost_provider.js',
  'teams/vv/inputs/operator_cost_observations.json',
  'integration/detailed/k3_physical_basis.js',
  'integration/detailed/k3_sram_memory_rdma_model.js',
  'integration/detailed/k3_rdma_final_tuning_model.js'
];
const FORMAT = 'k3-workload-shape/1';
const EVIDENCE = 'MODEL';
const TP = A.LIMITS.tp;
const BATCHES = [1, 2, 4, 8, 16, 32];
const BATCH_CONTEXTS = [1048576, 131072, 8192];
// Distinct routed experts a step reads: 'worst' min(E, B x K), the simulator default; 'expected' E x (1 - (1 - K/E)^B).
const UNIONS = ['worst', 'expected'];
const SCAN_CONTEXTS = [2048, 4096, 8192, 16384, 32768, 131072, 524288, 1048576];
const MAPPING_GRID = {kvTile: [1024, 2048, 4096, 8192, 16384, 32768], headTile: [8, 16, 32, 48, 96], weightTileMiB: [4, 8], depth: [2, 4]};
const MAPPING_KEYS = Object.keys(MAPPING_GRID);
const TOL = 1e-6;

const sha256 = data => crypto.createHash('sha256').update(data).digest('hex');
const hashFile = relativePath => sha256(fs.readFileSync(path.join(root, relativePath)));
const readJson = relativePath => JSON.parse(fs.readFileSync(path.join(root, relativePath), 'utf8'));
const pick = (o, keys) => Object.fromEntries(keys.map(k => [k, o[k]]));
const sum = (ops, test) => ops.filter(test).reduce((s, o) => s + o.duration, 0);

// One decode step of x: O.evaluate's mapped() + simulate(), with the plan details the report needs.
// Exported for the evaluation pool, so it takes and returns plain data.
function evalPoint({x, tokens, context, union}) {
  const m = O.mapped(x, {tokens, context, union});
  if (!m.feasible) return {feasible: false, reasons: m.reasons};
  const r = simulate(m.plan, m.window);
  if (!r.feasible) return {feasible: false, reasons: [r.reason]};
  const ops = m.plan.ops;
  return {
    feasible: true,
    tpsPerUser: r.tps, tpsPerCard: r.tokensPerSecond / TP,
    rawUs: r.rawUs, computeUs: r.computeUs, commUs: r.commUs, waitUs: r.waitUs, overlapUs: r.overlapUs, tmaHiddenUs: r.tmaHiddenUs,
    lse: {count: ops.filter(o => o.name.startsWith('LSE merge')).length, us: sum(ops, o => o.name.startsWith('LSE merge'))},
    attentionUs: sum(ops, o => /^(QK|Online softmax|PV)/.test(o.name)),
    kvBytesPerRank: m.plan.jobs.filter(j => j.kind === 'kv').reduce((s, j) => s + j.bytes, 0),
    dmaTBs: m.plan.c.memTBs, margin: m.plan.c.margin,
    softmaxLayers: m.plan.model.softmaxLayers, kvBytesPerToken: m.plan.kvBytesPerToken,
    backingGB: m.plan.backingBytes / 1e9, stateStoreGB: m.plan.stateStore / 1e9
  };
}

function mappings(x) {
  const out = [pick(x, MAPPING_KEYS)];
  const rec = (i, acc) => {
    if (i === MAPPING_KEYS.length) {
      if (!MAPPING_KEYS.every(k => acc[k] === out[0][k])) out.push(acc);
      return;
    }
    for (const v of MAPPING_GRID[MAPPING_KEYS[i]]) rec(i + 1, {...acc, [MAPPING_KEYS[i]]: v});
  };
  rec(0, {});
  return out;
}

// Points not dominated in (tpsPerUser, tpsPerCard), by falling TPS/usr. Equal points keep the first.
function paretoFront(points) {
  const front = points.filter((p, i) => !points.some((q, j) =>
    (q.tpsPerUser >= p.tpsPerUser && q.tpsPerCard >= p.tpsPerCard && (q.tpsPerUser > p.tpsPerUser || q.tpsPerCard > p.tpsPerCard))
    || (j < i && q.tpsPerUser === p.tpsPerUser && q.tpsPerCard === p.tpsPerCard)));
  return front.sort((a, b) => b.tpsPerUser - a.tpsPerUser);
}

const row = (B, mapping, r) => ({batch: B, mapping, tpsPerUser: r.tpsPerUser, tpsPerCard: r.tpsPerCard,
  rawUs: r.rawUs, computeUs: r.computeUs, commUs: r.commUs, waitUs: r.waitUs, attentionUs: r.attentionUs,
  kvGBPerRank: r.kvBytesPerRank / 1e9, backingGB: r.backingGB});

function batchSweep(results, items) {
  const out = [];
  for (const context of BATCH_CONTEXTS) for (const union of UNIONS) {
    const rows = [], all = [];
    for (const B of BATCHES) {
      let best = null, feasible = 0;
      const reasons = {};
      items.forEach((it, i) => {
        if (it.scan || it.context !== context || it.union !== union || it.tokens !== B) return;
        const r = results[i];
        if (!r.feasible) { const k = r.reasons.join(' + '); reasons[k] = (reasons[k] || 0) + 1; return; }
        feasible++;
        const p = row(B, it.mapping, r);
        all.push(p);
        if (!best || p.tpsPerUser > best.tpsPerUser) best = p;
      });
      rows.push({batch: B, mappings: feasible + Object.values(reasons).reduce((a, b) => a + b, 0), feasible, infeasible: reasons, best});
    }
    const ok = rows.filter(r => r.best);
    const one = ok.find(r => r.batch === 1).best;
    const card = ok.reduce((a, r) => (r.best.tpsPerCard > a.tpsPerCard ? r.best : a), one);
    out.push({
      context, union, rows,
      paretoFront: paretoFront(all).map(p => pick(p, ['batch', 'mapping', 'tpsPerUser', 'tpsPerCard'])),
      summary: {
        batch1: pick(one, ['tpsPerUser', 'tpsPerCard', 'mapping']),
        maxTpsPerCard: pick(card, ['batch', 'tpsPerUser', 'tpsPerCard', 'mapping']),
        cardGainOverBatch1: card.tpsPerCard / one.tpsPerCard,
        userRatioAtMaxCard: card.tpsPerUser / one.tpsPerUser,
        // What one more sequence costs a decode step, from B = 1 to each larger feasible B.
        marginalUsPerSequence: ok.filter(r => r.batch > 1).map(r => ({batch: r.batch, us: (r.best.rawUs - one.rawUs) / (r.batch - 1)})),
        largestFeasibleBatch: Math.max(...ok.map(r => r.batch))
      }
    });
  }
  return out;
}

function contextScan(results, items) {
  return SCAN_CONTEXTS.map(context => {
    const r = results[items.findIndex(it => it.scan && it.context === context)];
    if (!r.feasible) return {context, feasible: false, reasons: r.reasons};
    // Head-parallel: each rank reads the whole context's KV instead of 1 / TP of it.
    const extraKvBytes = (TP - 1) * r.kvBytesPerRank;
    const exposedUs = extraKvBytes / (r.dmaTBs * 1e6);
    const tps = us => 1e6 / (us * r.margin);
    return {
      context, feasible: true,
      tpsPerUser: r.tpsPerUser, rawUs: r.rawUs, computeUs: r.computeUs, commUs: r.commUs, waitUs: r.waitUs,
      lse: {...r.lse, shareOfRaw: r.lse.us / r.rawUs},
      attentionUs: r.attentionUs, attentionShareOfRaw: r.attentionUs / r.rawUs,
      kvGBPerRank: r.kvBytesPerRank / 1e9,
      headParallel: {
        evidenceClass: 'PLANNING_ESTIMATE',
        savedUs: r.lse.us,
        extraKvGBPerRank: extraKvBytes / 1e9,
        extraKvExposedUs: exposedUs,
        tpsPerUser: {kvHidden: tps(r.rawUs - r.lse.us), kvExposed: tps(r.rawUs - r.lse.us + exposedUs)},
        extraKvStoreGBPerRank: (TP - 1) / TP * r.softmaxLayers * context * r.kvBytesPerToken / 1e9,
        // Context at which the fully exposed extra KV read equals the LSE time saved (it scales with context).
        breakEvenContext: context * r.lse.us / exposedUs
      }
    };
  });
}

async function build({jobs} = {}) {
  const spec = readJson(BASELINE_FILE);
  const x = BP.publishedX(spec, 'workload_shape.js');
  const items = [];
  for (const context of BATCH_CONTEXTS) for (const union of UNIONS) for (const tokens of BATCHES) for (const mapping of mappings(x)) {
    items.push({x: {...x, ...mapping}, tokens, context, union, mapping});
  }
  for (const context of SCAN_CONTEXTS) items.push({x, tokens: 1, context, scan: true});
  const pool = createPool({module: __filename, fn: 'evalPoint', ...(jobs ? {jobs} : {})});
  let results;
  try {
    results = await pool.map(items.map(({x: px, tokens, context, union}) => ({x: px, tokens, context, union})));
  } finally {
    await pool.close();
  }
  const scan = contextScan(results, items);
  const published = scan.find(s => s.context === A.LIMITS.context);
  if (Math.abs(published.rawUs - spec.tpsDesign.point.rawLatencyUs) > TOL) {
    throw new Error(`replay rawUs ${published.rawUs} is not the published ${spec.tpsDesign.point.rawLatencyUs}`);
  }
  const sweep = batchSweep(results, items);
  return {
    format: FORMAT,
    status: 'MODEL: supplementary view of the published hardware under batch and shorter contexts. Changes no target (ADR-0009) and feeds no gate or baseline',
    evidenceClass: EVIDENCE,
    workItem: 'ARCH-CH-03',
    plan: 'teams/council/docs/24_TRACE_AND_CHARON_ADOPTION_PLAN.md',
    method: {
      batchSweep: 'tokens = seqs = B independent sequences at each context and expert union (worst: min(E, B x K) distinct experts, the simulator default; expected: E x (1 - (1 - K/E)^B)); hardware fixed at tpsDesign.hardware.x, mapping knobs re-chosen from mappingGrid (the published mapping first; a later mapping replaces it only if strictly better). TPS/card = B x TPS/usr / TP (one card is one TP rank).',
      contextScan: 'B = 1, published mapping, context as given (the KV tiles of one rank cover context / TP). LSE and attention times are op service times from the mapped plan.',
      headParallel: 'PLANNING_ESTIMATE, not simulated. Heads split over the TP ranks instead of the context: the 24 LSE merges go away (saved = their service time, all on the serial path), every rank reads (TP - 1) x more KV, costed between 0 (hidden) and its bytes at the plan\'s effective DMA rate (exposed). Same attention FLOPs; the head-sharded H-core shape and the replicated KV append are not modelled.'
    },
    mappingGrid: MAPPING_GRID,
    provenance: {
      baseline: BASELINE_FILE, baselineSha256: hashFile(BASELINE_FILE),
      publishedX: x,
      sources: Object.fromEntries(SOURCE_FILES.map(f => [f, hashFile(f)]))
    },
    batchSweep: sweep,
    contextScan: scan
  };
}

module.exports = {FORMAT, EVIDENCE, TP, BATCHES, BATCH_CONTEXTS, UNIONS, SCAN_CONTEXTS, MAPPING_GRID, SOURCE_FILES, BASELINE_FILE, TOL,
  evalPoint, mappings, paretoFront, build};
