'use strict';
/* Reconciliation of a traced operator ledger (MODEL-CH-01, ADR-0025) with the planning rows of
 * workload_derivation.js. The ledger is the JSON that tools/trace_operator_ledger.py writes from the
 * Hugging Face reference modeling code on the meta device; this module only reads it.
 *
 * Every check gets one status:
 *   MATCH               traced equals planned
 *   STORAGE_DIFFERENCE  the difference is exactly the checkpoint storage of parameters the plan prices otherwise
 *   REFERENCE_FORM      the reference code computes this differently from the deployment kernel; the traced
 *                       value is checked against the reference formula instead of the planning row
 *   NOT_IN_PLAN         traced work or parameters the planning rows leave out, sized exactly
 *   NOT_TRACED          planned work the trace cannot see
 *   MISMATCH            anything else
 *
 * Usage: node teams/model/src/traced_ledger.js   prints the reconciliation of the committed ledger.
 */
const fs = require('fs');
const path = require('path');
const {CONTEXT, deriveGlm} = require('./workload_derivation.js');

const FORMAT = 'traced-operator-ledger/1';
const EVIDENCE = 'UNVERIFIED_PLANNING_MANIFEST';
const TOOL = 'tools/trace_operator_ledger.py';
const LEDGERS = {'GLM-5.2': 'teams/model/inputs/glm_5_2_traced_operator_ledger.json'};
const PROVENANCE_KEYS = ['tool', 'toolSha256', 'python', 'torch', 'transformers', 'modeling', 'modelingSha256',
  'config', 'quantConfig', 'device', 'attnImplementation', 'expertsImplementation'];
const SOURCE_KEYS = ['repo', 'revision', 'sha256'];
const STATUSES = ['MATCH', 'STORAGE_DIFFERENCE', 'REFERENCE_FORM', 'NOT_IN_PLAN', 'NOT_TRACED', 'MISMATCH'];

// Storage the planning rows price each parameter class at (workload_derivation.js deriveGlm, bytesPerParam).
const PLANNED_STORAGE = {attention: 'fp8', indexer: 'fp8', denseFfn: 'fp8', sharedExperts: 'fp8', routedExperts: 'fp8',
  router: 'bf16', lmHead: 'bf16'};

function provenanceProblems(ledger) {
  const out = [];
  if (ledger.format !== FORMAT) out.push(`format ${ledger.format}, expected ${FORMAT}`);
  if (ledger.evidenceClass !== EVIDENCE) out.push(`evidenceClass ${ledger.evidenceClass}, expected ${EVIDENCE}`);
  const p = ledger.provenance || {};
  for (const k of PROVENANCE_KEYS) if (p[k] === undefined || p[k] === '') out.push(`provenance.${k} missing`);
  for (const s of ['config', 'quantConfig']) {
    for (const k of SOURCE_KEYS) if (!(p[s] || {})[k]) out.push(`provenance.${s}.${k} missing`);
  }
  if (p.tool !== undefined && p.tool !== TOOL) out.push(`provenance.tool ${p.tool}, expected ${TOOL}`);
  const sc = ledger.scenario || {};
  if (sc.batch !== 1 || sc.decodeTokens !== 1 || sc.contextTokens !== CONTEXT || sc.cachedTokens !== CONTEXT - 1) {
    out.push(`scenario ${JSON.stringify(sc)} is not one B=1 decode token at the planning context ${CONTEXT}`);
  }
  return out;
}

// Parameter class from the parameter name (relative to its layer, or global) and the tracer's role.
function categoryOf(name, role) {
  if (role === 'vector') return 'norm';
  if (role === 'lookup') return 'embedding';
  if (name.startsWith('lm_head.')) return 'lmHead';
  if (name.startsWith('self_attn.indexer.')) return 'indexer';
  if (name.startsWith('self_attn.')) return 'attention';
  if (name.startsWith('mlp.experts.')) return 'routedExperts';
  if (name.startsWith('mlp.shared_experts.')) return 'sharedExperts';
  if (name.startsWith('mlp.gate.')) return 'router';
  if (name.startsWith('mlp.')) return 'denseFfn';
  return 'unclassified';
}

function judge(traced, planned, alternatives = []) {
  if (traced === planned) return 'MATCH';
  const hit = alternatives.find(a => a.value === traced);
  return hit ? hit.status : 'MISMATCH';
}

function reconcileGlm(ledger, shape) {
  const c = shape.config;
  const bpp = shape.assumptions.bytesPerParam.value;
  const d = deriveGlm(shape);
  const D = d.derivation;
  const row = Object.fromEntries(d.rows.map(r => [r[0], {flops: r[2], bytes: r[3]}]));
  const H = c.hidden, mla = c.mla, idx = c.indexer;
  const fullLayers = c.fullIndexerLayers.length;
  const checks = [];
  const add = (id, traced, planned, status, note) => checks.push({id, traced, planned,
    delta: typeof traced === 'number' && typeof planned === 'number' ? traced - planned : null, status, note});
  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

  const units = ledger.layerKinds.map(k => ({...k, n: k.layers.length}));
  units.push({...ledger.global, layers: [], n: 1, cache: {}, global: true});
  const layerUnits = units.filter(u => !u.global);

  // Structure.
  const layers = layerUnits.flatMap(u => u.layers).sort((a, b) => a - b);
  const range = n => Array.from({length: n}, (_, i) => i);
  add('structure.layers', layers.length, c.layers, same(layers, range(c.layers)) ? 'MATCH' : 'MISMATCH',
    'each decoder layer traced exactly once (MTP layer excluded)');
  const withModule = m => layerUnits.filter(u => u.modules[m]).flatMap(u => u.layers).sort((a, b) => a - b);
  const full = withModule('self_attn.indexer');
  add('structure.fullIndexerLayers', full, c.fullIndexerLayers, same(full, c.fullIndexerLayers) ? 'MATCH' : 'MISMATCH',
    'layers that run their own indexer');
  const moe = withModule('mlp.experts');
  const dense = layers.filter(i => !moe.includes(i));
  add('structure.denseLayers', dense, range(c.denseLayers), same(dense, range(c.denseLayers)) ? 'MATCH' : 'MISMATCH',
    'layers with a dense FFN instead of the MoE');
  const topk = [...new Set(layerUnits.filter(u => u.modules['self_attn.indexer'])
    .map(u => (u.modules['self_attn.indexer'].outputShape || []).slice(-1)[0]))];
  add('structure.indexerTopK', topk, [idx.topK], same(topk, [idx.topK]) ? 'MATCH' : 'MISMATCH',
    'top-k selected per query by the indexer');
  const selected = [...new Set(layerUnits.filter(u => u.modules['mlp.experts']).map(u => u.modules['mlp.experts'].selected))];
  add('structure.selectedExperts', selected, [c.activeExperts], same(selected, [c.activeExperts]) ? 'MATCH' : 'MISMATCH',
    'token-expert pairs per MoE layer for one decode token');
  const unmatched = ledger.unmatchedNotConvert || [];
  add('structure.unmatchedNotConvert', unmatched, [], unmatched.length ? 'MISMATCH' : 'MATCH',
    'FP8 checkpoint modules_to_not_convert entries that name no traced module (MTP layer excluded)');

  // Parameters by class.
  const params = {};
  const storageDiffs = {};
  const unclassified = [];
  for (const u of units) {
    for (const p of u.parameters) {
      const cat = categoryOf(p.name, p.role);
      params[cat] = (params[cat] || 0) + p.numel * u.n;
      if (cat === 'unclassified') unclassified.push(p.name);
      const planned = PLANNED_STORAGE[cat];
      if (planned && p.storage !== planned) {
        const key = `${p.name}:${p.storage}`;
        const rec = storageDiffs[key] || (storageDiffs[key] = {name: p.name, category: cat, storage: p.storage, planned,
          numelPerLayer: p.numel, numel: 0, layers: []});
        rec.numel += p.numel * u.n;
        rec.layers.push(...u.layers);
      }
    }
  }
  const plannedParams = {
    attention: c.layers * D.attentionParamsPerLayer,
    indexer: fullLayers * D.indexerParamsPerFullLayer,
    denseFfn: c.denseLayers * D.denseFfnParamsPerLayer,
    sharedExperts: D.moeLayers * c.sharedExperts * D.expertParams,
    routedExperts: D.moeLayers * c.routedExperts * D.expertParams,
    router: D.moeLayers * H * c.routedExperts,
    embedding: c.vocab * H,
    lmHead: c.vocab * H
  };
  for (const [cat, planned] of Object.entries(plannedParams)) {
    add(`params.${cat}`, params[cat] || 0, planned, judge(params[cat] || 0, planned), 'parameter count');
  }
  const tracedTotal = Object.keys(plannedParams).reduce((s, k) => s + (params[k] || 0), 0);
  add('params.total', tracedTotal, D.totalParams, judge(tracedTotal, D.totalParams), 'matmul and embedding parameters, MTP excluded');
  add('params.norm', params.norm || 0, 0, 'NOT_IN_PLAN', 'RMSNorm / LayerNorm weights and biases; the planning rows count matmul weights only');
  if (unclassified.length) add('params.unclassified', unclassified, [], 'MISMATCH', 'parameters with no planning class');

  // Ops: those issued by a module that owns matmul weights are weight ops, the rest activation ops.
  let denseFlops = 0, denseBytes = 0, routedFlops = 0, routedBytes = 0;
  const decompress = {traced: 0};
  const weightProblems = [];
  const activation = {attention: {traced: 0}, indexer: {traced: 0}, other: []};
  for (const u of units) {
    const own = {};
    for (const p of u.parameters) {
      if (p.role !== 'matmul') continue;
      const mod = p.name.slice(0, p.name.lastIndexOf('.'));
      const rec = own[mod] || (own[mod] = {category: categoryOf(p.name, p.role), numel: 0, bytes: 0});
      rec.numel += p.numel;
      rec.bytes += p.numel * bpp[p.storage];
    }
    const flopsBy = {};
    for (const o of u.ops) flopsBy[o.module] = (flopsBy[o.module] || 0) + o.flops;
    const kvRead = u.cache.kv ? u.cache.kv.readTokens : null;
    const where = u.global ? 'global' : `layers ${u.layers.join(',')}`;
    for (const [mod, w] of Object.entries(own)) {
      const flops = flopsBy[mod] || 0;
      if (w.category === 'routedExperts') {
        const sel = (u.modules[mod] || {}).selected || 0;
        const expected = 2 * sel * w.numel / c.routedExperts;
        if (flops !== expected) weightProblems.push(`${where} ${mod}: ${flops} FLOPs for ${sel} selected experts, expected ${expected}`);
        routedFlops += flops * u.n;
        routedBytes += w.bytes * sel / c.routedExperts * u.n;
      } else {
        const perToken = 2 * w.numel;
        if (mod.endsWith('kv_b_proj')) {
          decompress.traced += flops * u.n;
          if (flops !== kvRead * perToken) weightProblems.push(`${where} ${mod}: ${flops} FLOPs, expected 2 x ${w.numel} params x ${kvRead} cached tokens`);
        } else if (flops !== perToken) {
          weightProblems.push(`${where} ${mod}: ${flops} FLOPs, expected 2 x ${w.numel} params = ${perToken}`);
        }
        denseFlops += perToken * u.n;
        denseBytes += w.bytes * u.n;
      }
    }
    for (const [mod, flops] of Object.entries(flopsBy)) {
      if (own[mod]) continue;
      if (!u.global && mod === 'self_attn') {
        activation.attention.traced += flops * u.n;
      } else if (!u.global && mod === 'self_attn.indexer') {
        activation.indexer.traced += flops * u.n;
      } else {
        activation.other.push(`${where} ${mod}: ${flops} FLOPs`);
      }
    }
  }
  if (weightProblems.length) add('ops.weightOps', weightProblems, [], 'MISMATCH', 'weight ops whose FLOPs are not 2 x params per token');
  if (activation.other.length) add('ops.unexpected', activation.other, [], 'MISMATCH', 'FLOPs outside weight ops, attention and indexer');

  // Planning rows.
  add('dense_projection.flops', denseFlops, row.dense_projection.flops, judge(denseFlops, row.dense_projection.flops),
    'weight FLOPs per token of every non-routed matmul (kv_b_proj counted once per token, as absorbed)');
  const storageExtra = Object.values(storageDiffs).filter(s => s.category !== 'routedExperts')
    .reduce((s, x) => s + x.numel * (bpp[x.storage] - bpp[x.planned]), 0);
  add('dense_projection.bytes', denseBytes, row.dense_projection.bytes,
    judge(denseBytes, row.dense_projection.bytes, storageExtra ? [{value: row.dense_projection.bytes + storageExtra, status: 'STORAGE_DIFFERENCE'}] : []),
    storageExtra ? `checkpoint storage differs from the plan for ${Object.values(storageDiffs).map(s => s.name).join(', ')}` : 'weight bytes at checkpoint storage');
  // Reference-form expectations come from the manifest config, not from the traced layers, so a missing or
  // misclassified layer cannot make them agree with itself.
  const kvbPerToken = 2 * mla.kvLatent * c.heads * (mla.qkNopeDim + mla.vHeadDim);
  add('reference.kv_b_proj', decompress.traced, c.layers * kvbPerToken,
    judge(decompress.traced, c.layers * kvbPerToken, [{value: c.layers * kvbPerToken * CONTEXT, status: 'REFERENCE_FORM'}]),
    'the reference decompresses the whole latent cache through kv_b_proj every token; deployment absorbs it into q and the output (planned: once per token)');
  add('routed_moe.flops', routedFlops, row.routed_moe.flops, judge(routedFlops, row.routed_moe.flops), 'selected routed experts');
  add('routed_moe.bytes', routedBytes, row.routed_moe.bytes, judge(routedBytes, row.routed_moe.bytes), 'selected routed expert weights at checkpoint storage');
  const headWeighting = fullLayers * 2 * idx.heads * CONTEXT;
  add('indexer.flops', activation.indexer.traced, row.indexer.flops,
    judge(activation.indexer.traced, row.indexer.flops, [{value: row.indexer.flops + headWeighting, status: 'NOT_IN_PLAN'}]),
    `q.k scores over the context; the reference also weights the ${idx.heads} heads per token (2 x heads x context per full layer = ${headWeighting} FLOPs in total), which the planning row leaves out`);
  const denseAttention = c.layers * 2 * c.heads * CONTEXT * (mla.qkNopeDim + mla.ropeDim + mla.vHeadDim);
  add('sparse_attention.flops', activation.attention.traced, row.sparse_attention.flops,
    judge(activation.attention.traced, row.sparse_attention.flops, [{value: denseAttention, status: 'REFERENCE_FORM'}]),
    `the reference attends densely over the whole context with decompressed K/V and a top-k mask (checked against layers x 2 x heads x context x (qkNope + rope + vHead) = ${denseAttention}); deployment reads the ${idx.topK} selected latent entries`);

  // Cache traffic (elements; the deployment bytes per element are manifest ASSUMPTIONs).
  const kvWidth = mla.kvLatent + mla.ropeDim;
  const kv = layerUnits.map(u => u.cache.kv);
  const kvOk = kv.every(k => k && k.width === kvWidth && k.readTokens === CONTEXT && k.appendTokens === 1);
  const kvRead = layerUnits.reduce((s, u) => s + (u.cache.kv ? u.cache.kv.readTokens * u.cache.kv.width * u.n : 0), 0);
  add('sparse_attention.kvElements', kvRead, c.layers * idx.topK * kvWidth, kvOk ? 'REFERENCE_FORM' : 'MISMATCH',
    `every layer appends one ${kvWidth}-wide latent entry and the reference reads all ${CONTEXT} (${(kv[0] || {}).referenceDtype || '?'}); deployment reads ${idx.topK} entries at ${shape.assumptions.kvBytesPerTokenPerLayer.value} B (ASSUMPTION)`);
  const ix = layerUnits.filter(u => u.cache.index);
  const ixOk = same(ix.flatMap(u => u.layers).sort((a, b) => a - b), c.fullIndexerLayers)
    && ix.every(u => u.cache.index.width === idx.headDim && u.cache.index.readTokens === CONTEXT && u.cache.index.appendTokens === 1);
  const ixRead = ix.reduce((s, u) => s + u.cache.index.readTokens * u.cache.index.width * u.n, 0);
  add('indexer.keyElements', ixRead, fullLayers * CONTEXT * idx.headDim, ixOk ? judge(ixRead, fullLayers * CONTEXT * idx.headDim) : 'MISMATCH',
    `index keys read by the full layers; the planning row prices them at ${shape.assumptions.indexKeyBytesPerToken.value} B per token (ASSUMPTION)`);
  add('collective_reduce', null, d.collectivesPerToken, 'NOT_TRACED', 'collectives come from the deployment (TP32), not from the single-device reference');

  const summary = Object.fromEntries(STATUSES.map(s => [s, checks.filter(x => x.status === s).length]));
  return {modelId: ledger.modelId, checks, storageDifferences: Object.values(storageDiffs), summary};
}

const mismatches = report => report.checks.filter(x => x.status === 'MISMATCH');

if (require.main === module) {
  const root = path.resolve(__dirname, '../../..');
  const manifests = JSON.parse(fs.readFileSync(path.join(root, 'teams/model/inputs/formal_model_manifests.json'), 'utf8'));
  for (const [modelId, file] of Object.entries(LEDGERS)) {
    if (!fs.existsSync(path.join(root, file))) {
      console.log(`${modelId}: ${file} not generated yet (python ${TOOL} --model ${modelId})`);
      continue;
    }
    const ledger = JSON.parse(fs.readFileSync(path.join(root, file), 'utf8'));
    for (const p of provenanceProblems(ledger)) console.log(`${modelId}: provenance: ${p}`);
    const report = reconcileGlm(ledger, manifests.models.find(m => m.modelId === modelId).shape);
    for (const x of report.checks) {
      const v = val => (typeof val === 'number' ? val.toLocaleString('en-US') : JSON.stringify(val));
      console.log(`${x.status.padEnd(18)} ${x.id.padEnd(32)} traced ${v(x.traced)}  planned ${v(x.planned)}${x.delta ? `  delta ${v(x.delta)}` : ''}`);
    }
    console.log(JSON.stringify(report.summary));
  }
}

module.exports = {FORMAT, EVIDENCE, TOOL, LEDGERS, STATUSES, PLANNED_STORAGE, provenanceProblems, categoryOf, reconcileGlm, mismatches};
