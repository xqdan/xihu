'use strict';
// Traced operator ledger reconciliation (MODEL-CH-01, ADR-0025; teams/council/docs/24_TRACE_AND_CHARON_ADOPTION_PLAN.md).
// 1. A synthetic GLM-5.2 ledger shaped like the tracer's output (built here from the manifest config and the reference
//    modeling code's shapes) reconciles: no MISMATCH, and the known differences get their status and exact size.
// 2. Perturbations of the ledger (a shape, a layer, the indexer layers, the expert count, the cache width, an
//    unmatched not-convert entry, a stray FLOP, a missing indexer head weighting) are each reported as MISMATCH;
//    provenance gaps are reported.
// 3. The tracer and the reconciler agree on the output path; the tracer header names its dependencies.
// 4. If the committed ledger exists: provenance complete, produced by the current tracer (else stale), no MISMATCH.
//    The tracer needs torch and transformers, which the test path does not install, so the ledger may be absent.
const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const TL = require('../../teams/model/src/traced_ledger.js');
const {CONTEXT} = require('../../teams/model/src/workload_derivation.js');

const root = path.resolve(__dirname, '../..');
const sha256 = data => crypto.createHash('sha256').update(data).digest('hex');
const manifests = JSON.parse(fs.readFileSync(path.join(root, 'teams/model/inputs/formal_model_manifests.json'), 'utf8'));
const shape = manifests.models.find(m => m.modelId === 'GLM-5.2').shape;
const c = shape.config, mla = c.mla, idx = c.indexer, H = c.hidden, T = CONTEXT;

// 1. Synthetic ledger.
function layerKind(layers, {dense, full}) {
  const parameters = [], ops = [], modules = {'': {class: 'GlmMoeDsaDecoderLayer', calls: 1}};
  const param = (name, shp, role = 'matmul', storage = role === 'matmul' ? 'fp8' : 'bf16') =>
    parameters.push({name, shape: shp, numel: shp.reduce((a, b) => a * b, 1), role, storage});
  const linear = (mod, out, inp, storage, tokens = 1) => {
    param(`${mod}.weight`, [out, inp], 'matmul', storage);
    ops.push({module: mod, op: 'aten.mm', shapes: [[tokens, inp], [inp, out]], count: 1, flops: 2 * tokens * inp * out});
    modules[mod] = {class: 'Linear', calls: 1};
  };
  param('input_layernorm.weight', [H], 'vector');
  param('post_attention_layernorm.weight', [H], 'vector');
  linear('self_attn.q_a_proj', mla.qLoraRank, H);
  param('self_attn.q_a_layernorm.weight', [mla.qLoraRank], 'vector');
  linear('self_attn.q_b_proj', c.heads * (mla.qkNopeDim + mla.ropeDim), mla.qLoraRank);
  linear('self_attn.kv_a_proj_with_mqa', mla.kvLatent + mla.ropeDim, H);
  param('self_attn.kv_a_layernorm.weight', [mla.kvLatent], 'vector');
  linear('self_attn.kv_b_proj', c.heads * (mla.qkNopeDim + mla.vHeadDim), mla.kvLatent, 'fp8', T);
  linear('self_attn.o_proj', H, c.heads * mla.vHeadDim);
  const qk = mla.qkNopeDim + mla.ropeDim;
  ops.push({module: 'self_attn', op: 'aten.bmm', shapes: [[64, 1, qk], [64, qk, T]], count: 1, flops: 2 * c.heads * qk * T});
  ops.push({module: 'self_attn', op: 'aten.bmm', shapes: [[64, 1, T], [64, T, mla.vHeadDim]], count: 1, flops: 2 * c.heads * T * mla.vHeadDim});
  modules.self_attn = {class: 'GlmMoeDsaAttention', calls: 1};
  const cache = {kv: {appendTokens: 1, readTokens: T, width: mla.kvLatent + mla.ropeDim, referenceDtype: 'bfloat16'}, index: null};
  if (full) {
    linear('self_attn.indexer.wq_b', idx.heads * idx.headDim, mla.qLoraRank);
    linear('self_attn.indexer.wk', idx.headDim, H);
    param('self_attn.indexer.k_norm.weight', [idx.headDim], 'vector');
    param('self_attn.indexer.k_norm.bias', [idx.headDim], 'vector');
    linear('self_attn.indexer.weights_proj', idx.heads, H, 'bf16'); // modules_to_not_convert: self_attn.indexers_proj
    ops.push({module: 'self_attn.indexer', op: 'aten.bmm', shapes: [[idx.heads, 1, idx.headDim], [1, idx.headDim, T]], count: 1, flops: 2 * idx.heads * idx.headDim * T});
    ops.push({module: 'self_attn.indexer', op: 'aten.bmm', shapes: [[1, 1, idx.heads], [1, idx.heads, T]], count: 1, flops: 2 * idx.heads * T});
    modules['self_attn.indexer'] = {class: 'GlmMoeDsaIndexer', calls: 1, outputShape: [1, 1, idx.topK]};
    cache.index = {appendTokens: 1, readTokens: T, width: idx.headDim, referenceDtype: 'bfloat16'};
  }
  if (dense) {
    linear('mlp.gate_proj', c.denseFfnHidden, H);
    linear('mlp.up_proj', c.denseFfnHidden, H);
    linear('mlp.down_proj', H, c.denseFfnHidden);
  } else {
    const E = c.routedExperts, I = c.expertHidden, k = c.activeExperts;
    linear('mlp.gate', E, H, 'bf16');
    param('mlp.experts.gate_up_proj', [E, 2 * I, H]);
    param('mlp.experts.down_proj', [E, H, I]);
    ops.push({module: 'mlp.experts', op: 'aten.bmm', shapes: [[k, 2 * I, H], [k, H, 1]], count: 1, flops: 2 * k * 2 * I * H});
    ops.push({module: 'mlp.experts', op: 'aten.bmm', shapes: [[k, H, I], [k, I, 1]], count: 1, flops: 2 * k * H * I});
    modules['mlp.experts'] = {class: 'GlmMoeDsaExperts', calls: 1, selected: k};
    linear('mlp.shared_experts.gate_proj', I * c.sharedExperts, H);
    linear('mlp.shared_experts.up_proj', I * c.sharedExperts, H);
    linear('mlp.shared_experts.down_proj', H, I * c.sharedExperts);
  }
  return {layers, parameters, ops, otherOps: {}, modules, cache};
}

function syntheticLedger() {
  const full = new Set(c.fullIndexerLayers);
  const groups = {};
  for (let i = 0; i < c.layers; i++) {
    const key = `${i < c.denseLayers ? 'dense' : 'moe'}/${full.has(i) ? 'full' : 'shared'}`;
    (groups[key] = groups[key] || []).push(i);
  }
  const layerKinds = Object.entries(groups).map(([key, layers]) =>
    layerKind(layers, {dense: key.startsWith('dense'), full: key.endsWith('full')}));
  const src = repo => ({repo, revision: '0'.repeat(40), url: 'synthetic', sha256: '0'.repeat(64), fetched: 'local file'});
  return {
    format: TL.FORMAT, modelId: 'GLM-5.2', evidenceClass: TL.EVIDENCE,
    provenance: {tool: TL.TOOL, toolSha256: '0'.repeat(64), python: 'synthetic', torch: 'synthetic', transformers: 'synthetic',
      modeling: 'synthetic', modelingSha256: '0'.repeat(64), config: src('zai-org/GLM-5.2'), quantConfig: src('zai-org/GLM-5.2-FP8'),
      device: 'meta', attnImplementation: 'eager', expertsImplementation: 'batched_mm'},
    scenario: {batch: 1, decodeTokens: 1, contextTokens: T, cachedTokens: T - 1},
    global: {
      parameters: [
        {name: 'model.embed_tokens.weight', shape: [c.vocab, H], numel: c.vocab * H, role: 'lookup', storage: 'bf16'},
        {name: 'model.norm.weight', shape: [H], numel: H, role: 'vector', storage: 'bf16'},
        {name: 'lm_head.weight', shape: [c.vocab, H], numel: c.vocab * H, role: 'matmul', storage: 'bf16'}],
      ops: [{module: 'lm_head', op: 'aten.mm', shapes: [[1, H], [H, c.vocab]], count: 1, flops: 2 * H * c.vocab}],
      otherOps: {}, modules: {lm_head: {class: 'Linear', calls: 1}, 'model.norm': {class: 'GlmMoeDsaRMSNorm', calls: 1}}},
    layerKinds,
    unmatchedNotConvert: []
  };
}

const clone = x => JSON.parse(JSON.stringify(x));
const base = syntheticLedger();
assert.deepStrictEqual(TL.provenanceProblems(base), []);
const report = TL.reconcileGlm(base, shape);
const check = id => report.checks.find(x => x.id === id);
assert.deepStrictEqual(TL.mismatches(report), [], JSON.stringify(TL.mismatches(report), null, 1));
for (const id of ['structure.layers', 'structure.fullIndexerLayers', 'structure.denseLayers', 'structure.indexerTopK',
  'structure.selectedExperts', 'structure.unmatchedNotConvert', 'params.attention', 'params.indexer', 'params.denseFfn',
  'params.sharedExperts', 'params.routedExperts', 'params.router', 'params.embedding', 'params.lmHead', 'params.total',
  'dense_projection.flops', 'dense_projection.bytes', 'routed_moe.flops', 'routed_moe.bytes', 'indexer.flops', 'indexer.keyElements']) {
  assert.strictEqual(check(id).status, 'MATCH', `${id}: ${JSON.stringify(check(id))}`);
}
const fullLayers = c.fullIndexerLayers.length;
// The plan prices the indexer head-weight projection at BF16 as the FP8 checkpoint stores it, and counts the
// per-head weighting of the indexer scores.
assert.deepStrictEqual(report.storageDifferences, []);
assert.strictEqual(TL.plannedStorage('self_attn.indexer.weights_proj.weight', 'indexer'), 'bf16');
assert.strictEqual(check('reference.kv_b_proj').status, 'REFERENCE_FORM');
assert.strictEqual(check('reference.kv_b_proj').traced, check('reference.kv_b_proj').planned * T);
assert.strictEqual(check('sparse_attention.flops').status, 'REFERENCE_FORM');
assert.strictEqual(check('sparse_attention.kvElements').status, 'REFERENCE_FORM');
assert.strictEqual(check('params.norm').status, 'NOT_IN_PLAN');
assert.strictEqual(check('collective_reduce').status, 'NOT_TRACED');
assert.strictEqual(Object.values(report.summary).reduce((a, b) => a + b, 0), report.checks.length);

// A checkpoint that stored the indexer projection at FP8 would differ from the plan by exactly its storage.
{
  const l = clone(base);
  for (const k of l.layerKinds) for (const p of k.parameters) if (p.name.endsWith('weights_proj.weight')) p.storage = 'fp8';
  const r = TL.reconcileGlm(l, shape);
  const bytes = r.checks.find(x => x.id === 'dense_projection.bytes');
  assert.strictEqual(bytes.status, 'STORAGE_DIFFERENCE');
  assert.strictEqual(bytes.delta, -fullLayers * H * idx.heads);
  assert.deepStrictEqual(r.storageDifferences.map(s => [s.name, s.storage, s.planned, s.numel]),
    [['self_attn.indexer.weights_proj.weight', 'fp8', 'bf16', fullLayers * H * idx.heads]]);
}

// 2. Perturbations.
const flagged = (mutate, ids) => {
  const l = clone(base);
  mutate(l);
  const got = TL.mismatches(TL.reconcileGlm(l, shape)).map(x => x.id);
  for (const id of ids) assert(got.includes(id), `expected MISMATCH ${id}, got ${JSON.stringify(got)}`);
};
const kindOf = (l, i) => l.layerKinds.find(k => k.layers.includes(i));
flagged(l => {
  const p = kindOf(l, 5).parameters.find(x => x.name === 'self_attn.q_b_proj.weight');
  p.shape[0] += 1; p.numel += p.shape[1];
}, ['params.attention', 'params.total']);
flagged(l => { kindOf(l, 77).layers.pop(); }, ['structure.layers']);
flagged(l => {
  const k = kindOf(l, 6);
  k.layers = k.layers.filter(i => i !== 6);
  kindOf(l, 5).layers.push(6);
}, ['structure.fullIndexerLayers', 'params.indexer', 'indexer.flops']);
flagged(l => { kindOf(l, 5).modules['mlp.experts'].selected = 7; }, ['structure.selectedExperts', 'ops.weightOps', 'routed_moe.bytes']);
flagged(l => { kindOf(l, 5).cache.kv.width = mla.kvLatent; }, ['sparse_attention.kvElements']);
flagged(l => { l.unmatchedNotConvert = ['model.layers.5.self_attn.unknown']; }, ['structure.unmatchedNotConvert']);
flagged(l => { kindOf(l, 5).ops.push({module: 'mlp', op: 'aten.mm', shapes: [], count: 1, flops: 2}); }, ['ops.unexpected']);
flagged(l => { kindOf(l, 5).ops.find(o => o.module === 'self_attn.o_proj').flops *= 2; }, ['ops.weightOps']);
flagged(l => {
  const k = kindOf(l, 6);
  k.ops = k.ops.filter(o => !(o.module === 'self_attn.indexer' && o.shapes[0][2] === idx.heads));
}, ['indexer.flops']);
flagged(l => { kindOf(l, 5).parameters.push({name: 'self_attn.extra.weight', shape: [1, 1], numel: 1, role: 'matmul', storage: 'fp8'}); },
  ['ops.weightOps']);
{
  const l = clone(base);
  delete l.provenance.toolSha256;
  l.provenance.config.revision = '';
  l.scenario.contextTokens = 8192;
  const problems = TL.provenanceProblems(l);
  for (const want of ['provenance.toolSha256 missing', 'provenance.config.revision missing', 'scenario']) {
    assert(problems.some(p => p.startsWith(want)), `expected provenance problem ${want}: ${JSON.stringify(problems)}`);
  }
}

// 3. Tracer and reconciler agree.
const toolText = fs.readFileSync(path.join(root, TL.TOOL), 'utf8');
for (const [modelId, file] of Object.entries(TL.LEDGERS)) {
  assert(toolText.includes(`"${modelId}": {`), `${TL.TOOL} has no entry for ${modelId}`);
  assert(toolText.includes(`"out": "${file}"`), `${TL.TOOL} does not write ${file}`);
}
assert(/torch 2\.\d+/.test(toolText) && /transformers \d+\.\d+/.test(toolText), 'tracer header must name its torch / transformers versions (ADR-0025)');
assert(toolText.includes(`FORMAT = "${TL.FORMAT}"`) && toolText.includes(`EVIDENCE = "${TL.EVIDENCE}"`));

// 4. The committed ledger.
for (const [modelId, file] of Object.entries(TL.LEDGERS)) {
  const full = path.join(root, file);
  if (!fs.existsSync(full)) {
    console.log(`SKIP ${modelId}: ${file} not generated (run python ${TL.TOOL} --model ${modelId}; needs torch and transformers)`);
    continue;
  }
  const ledger = JSON.parse(fs.readFileSync(full, 'utf8'));
  assert.deepStrictEqual(TL.provenanceProblems(ledger), [], `${file} provenance`);
  assert.strictEqual(ledger.provenance.toolSha256, sha256(fs.readFileSync(path.join(root, TL.TOOL))),
    `${file} is stale: ${TL.TOOL} changed since it was generated; rerun the tracer`);
  for (const s of ['config', 'quantConfig']) {
    assert(toolText.includes(`"revision": "${ledger.provenance[s].revision}"`), `${file} ${s} revision is not the one pinned in ${TL.TOOL}`);
  }
  const r = TL.reconcileGlm(ledger, manifests.models.find(m => m.modelId === modelId).shape);
  assert.deepStrictEqual(TL.mismatches(r), [], `${file} reconciliation:\n${JSON.stringify(TL.mismatches(r), null, 1)}`);
  console.log(`${modelId}: ${JSON.stringify(r.summary)}`);
}

console.log('traced operator ledger reconciliation ok');
