'use strict';
/* HW-ARCH exploratory scenario: Batch=1 decode with MTP / speculative verify.
 *
 * Status: EXPLORATORY. This is NOT the baseline and it does not change any gate, the published
 * 1101.77 TPS/usr, or the Batch=1 definition used by the planning model (SCENARIO_MATRIX.md: "MTP
 * 接受率场景（当前均未纳入）"). It prices one question: if a verify step may process k tokens of the
 * same sequence, how much memory bandwidth does the 1000 TPS/usr goal stop needing?
 *
 * Step model (k = verify tokens per step, one sequence):
 *   - the detailed simulator runs ONE step with batch = k tokens and seqs = 1 sequence: activations,
 *     routing, collectives, expert unions scale with k; KV and linear-state traffic scale with the one
 *     sequence (the k tokens share one KV read, which is the whole point of verifying together);
 *   - routed-expert union: 'worst' = k*K distinct experts (no overlap between consecutive tokens),
 *     'expected' = independent routing, N(1-(1-K/N)^k). Real routing is correlated between adjacent
 *     tokens, so the truth lies at or below 'expected'; neither is measured (UNVERIFIED_PLANNING_MANIFEST);
 *   - hardware is the published point; the software knobs are re-tuned per (dtype, tier, k, union).
 * Acceptance and draft cost are ASSUMPTIONS, swept, not measured:
 *   - E[tokens/step] = (1 - a^k) / (1 - a) for a chain of k-1 drafted tokens with per-token acceptance a
 *     (k = 1 gives 1);
 *   - each drafted token costs `d` average layer times of the k = 1 step of the same configuration
 *     (the MTP head is one MoE layer; d = 2 also covers its LM head / sampling / launch);
 *   - the 1.17 timing margin applies to everything.
 * TPS/usr = E[tokens/step] / ((verifyRaw + (k-1) * d * layerUs) * margin).
 * Rollback, KV invalidation of rejected tokens and the draft's own SRAM footprint are not modelled.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const O = require('./k3_rdma_final_tuning_model.js');
const E = require('../../teams/model/src/design_engine.js');

const root = path.resolve(__dirname, '../..');
const BASELINE_FILE = 'teams/hardware/inputs/k3_mc_baseline.json';
const SPACE_FILE = 'teams/hardware/inputs/memory_design_space.json';
const MARGIN = 1.17;
const LAYERS = 93;
const SCENARIO = {
  mcGBs: [320, 400, 480, 560, 640],
  verifyTokens: [1, 2, 3, 4],
  unions: ['worst', 'expected'],
  dtypes: {bf16Dense: 2, fp8Dense: 1},
  acceptance: [0.2, 0.4, 0.6, 0.8],
  draftLayerEquiv: [1, 2],
  alphaStep: 0.05,
  retune: {depth: [1, 2, 4], weightTileMiB: [4, 8], windowFraction: [0.5, 0.75, 1], kvTile: [16384, 32768]}
};

const readBaseline = () => {
  const file = path.join(root, BASELINE_FILE), text = fs.readFileSync(file, 'utf8');
  const spec = JSON.parse(text);
  const goal = JSON.parse(fs.readFileSync(path.join(root, SPACE_FILE), 'utf8')).requirements.minTpsPerUser;
  return {x: spec.tpsDesign.hardware.x, point: spec.tpsDesign.point, goal,
    sha256: crypto.createHash('sha256').update(text).digest('hex')};
};

// One verify step of the detailed model; the model preset is patched for the call and always restored.
function step(x, {dtype, mcGBs, tokens, union, knobs}) {
  const preset = E.MODEL_PRESETS.kimiK3, saved = preset.dtype.dense;
  preset.dtype.dense = SCENARIO.dtypes[dtype];
  try {
    return O.evaluate({...x, mcGBs, ...knobs}, {tokens, seqs: 1, union});
  } finally { preset.dtype.dense = saved; }
}

function bestStep(x, spec) {
  const R = SCENARIO.retune;
  let top = null;
  for (const depth of R.depth) for (const weightTileMiB of R.weightTileMiB)
    for (const windowFraction of R.windowFraction) for (const kvTile of R.kvTile) {
      const knobs = {depth, weightTileMiB, windowFraction, kvTile};
      const r = step(x, {...spec, knobs});
      if (r.feasible && (!top || r.rawUs < top.rawUs)) top = {rawUs: r.rawUs, knobs};
    }
  return top;
}

const expectedTokens = (a, k) => (a === 1 ? k : (1 - a ** k) / (1 - a));
const tpsPerUser = (verifyRawUs, k, a, layerUs, d) => 1e6 * expectedTokens(a, k) / ((verifyRawUs + (k - 1) * d * layerUs) * MARGIN);

function build() {
  const base = readBaseline();
  const rows = [];
  for (const dtype of Object.keys(SCENARIO.dtypes)) for (const mcGBs of SCENARIO.mcGBs) for (const union of SCENARIO.unions)
    for (const tokens of SCENARIO.verifyTokens) {
      // With one token the union is irrelevant: compute it once under 'worst' and share it.
      if (tokens === 1 && union !== 'worst') continue;
      const best = bestStep(base.x, {dtype, mcGBs, tokens, union});
      rows.push({dtype, mcGBs, union: tokens === 1 ? 'n/a' : union, verifyTokens: tokens,
        feasible: !!best, verifyRawUs: best ? best.rawUs : null, tunedKnobs: best ? best.knobs : null});
    }
  const find = (dtype, mcGBs, union, k) => rows.find(r => r.dtype === dtype && r.mcGBs === mcGBs && r.verifyTokens === k && r.union === (k === 1 ? 'n/a' : union));
  const goal = base.goal;

  // TPS/usr per row and (acceptance, draft cost): the matrix a reader can check by hand.
  const perf = [];
  for (const dtype of Object.keys(SCENARIO.dtypes)) for (const mcGBs of SCENARIO.mcGBs) for (const union of SCENARIO.unions)
    for (const d of SCENARIO.draftLayerEquiv) for (const a of SCENARIO.acceptance) {
      const one = find(dtype, mcGBs, union, 1);
      let bestK = null;
      for (const k of SCENARIO.verifyTokens) {
        const r = find(dtype, mcGBs, union, k);
        if (!r || !r.feasible || !one || !one.feasible) continue;
        const tps = tpsPerUser(r.verifyRawUs, k, a, one.verifyRawUs / LAYERS, d);
        if (!bestK || tps > bestK.tpsPerUser) bestK = {verifyTokens: k, tpsPerUser: tps};
      }
      perf.push({dtype, mcGBs, union, draftLayerEquiv: d, acceptance: a, bestVerifyTokens: bestK && bestK.verifyTokens,
        tpsPerUser: bestK && bestK.tpsPerUser, meetsGoal: !!bestK && bestK.tpsPerUser >= goal});
    }

  // Smallest per-token acceptance that reaches the goal at each configuration (0 means k = 1 already does).
  const alphaForGoal = [];
  const steps = Math.round(1 / SCENARIO.alphaStep);
  for (const dtype of Object.keys(SCENARIO.dtypes)) for (const mcGBs of SCENARIO.mcGBs) for (const union of SCENARIO.unions)
    for (const d of SCENARIO.draftLayerEquiv) {
      const one = find(dtype, mcGBs, union, 1);
      let found = null;
      if (one && one.feasible) for (let i = 0; i <= steps && found === null; i++) {
        const a = i * SCENARIO.alphaStep;
        for (const k of SCENARIO.verifyTokens) {
          const r = find(dtype, mcGBs, union, k);
          if (r && r.feasible && tpsPerUser(r.verifyRawUs, k, a, one.verifyRawUs / LAYERS, d) >= goal) { found = Number(a.toFixed(4)); break; }
        }
      }
      alphaForGoal.push({dtype, mcGBs, union, draftLayerEquiv: d, minAcceptance: found});
    }

  const published = find('bf16Dense', 640, 'worst', 1);
  return {
    status: 'EXPLORATORY: Batch=1 + MTP/speculative verify scenario. Not the baseline; no gate or published number depends on it',
    unit: {tpsPerUser: 'tokens/s per user', rawUs: 'microseconds per verify step (before the timing margin)'},
    model: {name: 'K3', tp: 32, context: 1048576, preset: 'UNVERIFIED_PLANNING_MANIFEST'},
    inputs: {baseline: BASELINE_FILE, baselineSha256: base.sha256, goalTpsPerUser: goal, margin: MARGIN, publishedTpsPerUser: base.point.tpsPerUser},
    assumptions: {
      acceptance: 'per-token acceptance of a drafted chain, swept; unmeasured (model_profiles.json: mtpAcceptanceRateMustBeMeasured)',
      draftCost: 'd average layer times of the k = 1 step per drafted token; d is swept, the MTP head is not designed',
      expertUnion: "'worst' (no overlap between the k tokens) and 'expected' (independent routing); correlated routing would be lower",
      notModelled: 'rollback / KV invalidation of rejected tokens, the draft head SRAM footprint, scheduler overhead of a data-dependent step length',
      hardware: 'published point; software knobs re-tuned per row over ' + JSON.stringify(SCENARIO.retune),
      seed: 'deterministic (no random inputs)'
    },
    scenario: SCENARIO,
    checkRow: {description: 'k = 1, BF16 dense, MC640 must reproduce the published Batch=1 step', verifyRawUs: published.verifyRawUs},
    rows, perf, alphaForGoal,
    regenerate: 'node integration/pipelines/generate_mtp_exploration.js (npm run mtp:explore); checked by tests/regression/test_mtp_exploration.js'
  };
}

module.exports = {SCENARIO, MARGIN, LAYERS, step, bestStep, expectedTokens, tpsPerUser, build, readBaseline};
