const E = require("../src/core/design_engine.js");
const MXFP4 = 17 / 32;
const EXTRA = {
  deepseekV4pro: {
    name: "DeepSeek-V4-Pro（1.6T-A49B）",
    totalParams: 1.6e12, activeParams: 49e9, layers: 61, moeLayers: 61,
    hidden: 7168, vocab: 129280, denseFfnHidden: 0,
    moe: { totalExperts: 384, activeExperts: 6, sharedExperts: 1, expertHidden: 3072, expertInput: "hidden", latent: 0 },
    attention: { kind: "mla", heads: 128, qkHeadDim: 512, vHeadDim: 512, kvLatent: 512, ropeDim: 64, qLoraRank: 1536, paramsPerLayer: "residual" },
    linearAttention: { layers: 0, stateDim: 0 },
    dtype: { routed: MXFP4, dense: 2 }
  },
  glm52: {
    name: "GLM-5.2 / 5.3（744B-A40B · MLA+DSA）",
    totalParams: 744e9, activeParams: 40e9, layers: 78, moeLayers: 75,
    hidden: 6144, vocab: 154880, denseFfnHidden: 12288,
    moe: { totalExperts: 256, activeExperts: 8, sharedExperts: 1, expertHidden: 2048, expertInput: "hidden", latent: 0 },
    attention: { kind: "mla", heads: 64, qkHeadDim: 256, vHeadDim: 256, kvLatent: 512, ropeDim: 64, qLoraRank: 2048, paramsPerLayer: "derive" },
    linearAttention: { layers: 0, stateDim: 0 },
    dtype: { routed: MXFP4, dense: 2 }
  }
};
const V4_ATTN = {
  heads: 128, headDim: 512, indexHeads: 64, indexHeadDim: 128, topk: 1024,
  window: 128, mCsa: 4, mHca: 128, nCsa: 29, nHca: 31, nSlide: 1, dtype: 2
};
const GLM_DSA = { topk: 2048, indexHeads: 32, indexHeadDim: 128, indexShare: 4 };

function v4KvBytes(ctx) {
  const a = V4_ATTN, n = ctx, d = a.dtype;
  const csa = a.nCsa * ((n / a.mCsa) * a.headDim * d + (n / a.mCsa) * a.indexHeadDim * d + a.window * a.headDim * d);
  const hca = a.nHca * ((n / a.mHca) * a.headDim * d + a.window * a.headDim * d);
  const slide = a.nSlide * a.window * a.headDim * d;
  return csa + hca + slide;
}
function v4AttnFlops(ctx) {
  const a = V4_ATTN;
  const qkv = (heads, dim, keys) => 2 * heads * (dim + dim) * keys;
  const csaKeys = Math.min(a.topk, Math.floor(ctx / a.mCsa)) + a.window;
  const hcaKeys = Math.floor(ctx / a.mHca) + a.window;
  const indexer = a.nCsa * 2 * (ctx / a.mCsa) * a.indexHeads * a.indexHeadDim;
  const csa = a.nCsa * qkv(a.heads, a.headDim, csaKeys);
  const hca = a.nHca * qkv(a.heads, a.headDim, hcaKeys);
  const slide = a.nSlide * qkv(a.heads, a.headDim, a.window);
  return indexer + csa + hca + slide;
}
function glmAttnFlops(model, ctx, dsa) {
  const a = model.spec.attention;
  const share = dsa.indexShare || 1;
  const indexer = (model.softmaxLayers / share) * 2 * ctx * dsa.indexHeads * dsa.indexHeadDim;
  const sparse = model.softmaxLayers * 2 * Math.min(ctx, dsa.topk) * a.heads * (a.qkHeadDim + a.vHeadDim);
  return indexer + sparse;
}
function k3AttnFlopsAbsorbed(m, ctx) {
  const a = m.spec.attention;
  return m.softmaxLayers * 2 * ctx * a.heads * (2 * (a.kvLatent || 0) + (a.ropeDim || 0));
}
function kdaFlopsPerToken(m) {
  const a = m.spec.attention;
  const la = m.spec.linearAttention || { layers: 0, stateDim: 0 };
  return la.layers * a.heads * (la.stateDim || 0) * (la.stateDim || 0) * 7;
}
function decorate(m, id) {
  m.id = id;
  if (id === "deepseekV4pro") {
    m.hybrid = "csa-hca";
    m.kvBytesFn = v4KvBytes;
    m.attnFlopsPerToken = v4AttnFlops;
  } else if (id === "glm52") {
    m.dsa = GLM_DSA;
    m.baseKvPerTok = m.kvPerTokenPerLayer;
    m.kvBytesFn = ctx => m.softmaxLayers * ctx * m.baseKvPerTok;
    m.attnFlopsPerToken = ctx => glmAttnFlops(m, ctx, GLM_DSA);
  } else {
    m.baseKvPerTok = m.kvPerTokenPerLayer;
    m.kvBytesFn = ctx => m.softmaxLayers * ctx * m.baseKvPerTok;
    m.attnFlopsPerToken = ctx => k3AttnFlopsAbsorbed(m, ctx);
  }
  return m;
}
function loadModel(id) {
  const spec = EXTRA[id] || E.MODEL_PRESETS[id];
  return decorate(E.deriveModel(spec), id);
}
function uniqueExperts(total, k, u) {
  const miss = Math.max(0, (total - k) / total);
  return total * (1 - Math.pow(miss, u));
}
function routedScale(m, B) {
  const k = m.spec.moe.activeExperts;
  const tot = m.spec.moe.totalExperts;
  return uniqueExperts(tot, k, B) / k;
}
function partIntensities(m, ctx, pred) {
  const p = m.params, b = m.bytes;
  const L = Math.max(1, ctx);
  const rows = [];
  const add = (name, flop, bytes, core, note, pf, bat) => {
    if (!(flop > 0) || !(bytes > 0)) return;
    rows.push({ name, flop, bytes, I: flop / bytes, core, note, pf: pf || "S", bat: bat || "B" });
  };
  add("Routed 专家（读 1 份）", 2 * p.routedActive, b.routedActive, "L", "", "S", "uniq");
  add("Routed ×(2−p) 预取", 2 * p.routedActive, b.routedActive * (2 - pred), "L", "", "skip", "uniq");
  add("Shared experts", 2 * p.shared, b.shared, "L", "", "S", "B");
  add("Wdown / Wup", 2 * (p.wdown + p.wup), b.wdown + b.wup, "L", "", "S", "B");
  add("Router", 2 * p.router, b.router, "L", "", "S", "B");
  add("Attn 投影 Wq/Wkv/Wo", 2 * p.attn, b.attn, "L", "", "S", "B");
  add("稠密 FFN", 2 * p.denseFfn, b.denseFfn, "L", "", "S", "B");
  add("LM Head", 2 * p.lmHead, b.lmHead, "L", "", "S", "B");
  const a = m.spec.attention;
  const dense = m.spec.dtype.dense;
  if (m.hybrid === "csa-hca") {
    const v = V4_ATTN;
    const csaKeys = Math.min(v.topk, Math.floor(L / v.mCsa)) + v.window;
    const hcaKeys = Math.floor(L / v.mHca) + v.window;
    add("CSA indexer", v.nCsa * 2 * (L / v.mCsa) * v.indexHeads * v.indexHeadDim,
      v.nCsa * (L / v.mCsa) * v.indexHeadDim * v.dtype, "H", "", "S2", "hold");
    add("CSA topk / 窗", v.nCsa * 2 * v.heads * (v.headDim + v.headDim) * csaKeys,
      v.nCsa * csaKeys * v.headDim * v.dtype, "H", "", "hold", "hold");
    add("HCA 压缩序列", v.nHca * 2 * v.heads * (v.headDim + v.headDim) * hcaKeys,
      v.nHca * hcaKeys * v.headDim * v.dtype, "H", "", "S2", "hold");
    add("Sliding window", v.nSlide * 2 * v.heads * (v.headDim + v.headDim) * v.window,
      v.nSlide * v.window * v.headDim * v.dtype, "H", "", "hold", "hold");
  } else if (m.dsa) {
    const share = m.dsa.indexShare || 1;
    const topk = Math.min(L, m.dsa.topk);
    const kvTok = (a.kvLatent + (a.ropeDim || 0)) * dense;
    add("DSA indexer", (m.softmaxLayers / share) * 2 * L * m.dsa.indexHeads * m.dsa.indexHeadDim,
      (m.softmaxLayers / share) * L * m.dsa.indexHeadDim * dense, "H", "", "S2", "hold");
    add("DSA topk 核", m.softmaxLayers * 2 * topk * a.heads * (a.qkHeadDim + a.vHeadDim),
      m.softmaxLayers * topk * kvTok, "H", "", "hold", "hold");
  } else {
    add("MLA（吸收后）", m.softmaxLayers * 2 * L * a.heads * (2 * (a.kvLatent || 0) + (a.ropeDim || 0)),
      m.softmaxLayers * L * (a.kvLatent + (a.ropeDim || 0)) * dense, "H", "", "S2", "hold");
  }
  const h = m.spec.hidden;
  const moe = m.spec.moe;
  add("RMSNorm", m.spec.layers * 2 * 5 * h, m.spec.layers * 2 * 2 * h * dense, "V", "", "hold", "hold");
  add("残差 Add", m.spec.layers * 2 * h, m.spec.layers * 2 * 3 * h * dense, "V", "", "hold", "hold");
  const siluE = m.spec.moeLayers * ((moe.activeExperts || 0) + (moe.sharedExperts || 0)) * (moe.expertHidden || 0)
    + (m.denseLayers || 0) * (m.spec.denseFfnHidden || 0);
  if (siluE > 0) add("SiLU / 门控", 4 * siluE, 2 * siluE * dense, "V", "", "hold", "hold");
  const rope = a.ropeDim || 0;
  if (rope > 0 && m.softmaxLayers > 0) {
    add("RoPE", m.softmaxLayers * a.heads * rope * 6, m.softmaxLayers * a.heads * rope * 2 * dense, "V", "", "hold", "hold");
  }
  let scores = 0;
  if (m.hybrid === "csa-hca") {
    const v = V4_ATTN;
    const csaKeys = Math.min(v.topk, Math.floor(L / v.mCsa)) + v.window;
    const hcaKeys = Math.floor(L / v.mHca) + v.window;
    scores = v.nCsa * v.heads * csaKeys + v.nHca * v.heads * hcaKeys + v.nSlide * v.heads * v.window;
  } else if (m.dsa) scores = m.softmaxLayers * a.heads * Math.min(L, m.dsa.topk);
  else scores = m.softmaxLayers * a.heads * L;
  if (scores > 0) add("Softmax / LSE", scores * 5, scores * 4, "V", "", "hold", "hold");
  const kdaF = kdaFlopsPerToken(m);
  if (kdaF > 0) add("KDA 状态", kdaF, 2 * m.kdaStateStore, "V", "", "hold", "hold");
  return rows;
}
function decodeIOf(p, B, m) {
  if (!(B > 1) || p.bat === "hold") return p.I;
  if (p.bat === "uniq") {
    const s = routedScale(m, B);
    return s > 0 ? p.I * B / s : p.I;
  }
  return p.I * B;
}
function prefillIOf(p, S) {
  if (!(S > 1) || p.pf === "hold" || p.pf === "skip") return p.I;
  if (p.pf === "S2") return p.I * S / 2;
  return p.I * S;
}
function linearFlops(m) {
  const p = m.params;
  return 2 * (p.routedActive + p.shared + p.wdown + p.wup + p.router + p.denseFfn + p.attn + p.lmHead);
}
function prefillAttnFlops(m, L) {
  const n = 10;
  let acc = 0;
  for (let i = 1; i <= n; i++) acc += m.attnFlopsPerToken(Math.max(1, Math.round(L * i / n)));
  return acc / n * L;
}
function shardPolicy(tp) {
  return { expertGroup: tp, attn: "shard", wdown: "shard", wup: "shard", shared: "shard", router: "shard", denseFfn: "shard" };
}
function payloadElems(m, r) {
  let elems = 0;
  const moe = r.moeCollectives || [];
  for (let i = 0; i < moe.length; i++) elems += moe[i].elems;
  elems *= m.spec.moeLayers;
  if (r.tp > 1) elems += (m.denseLayers || 0) * m.spec.hidden;
  const a = m.spec.attention;
  const mergeE = a.heads * ((a.kvLatent || 0) + 2);
  elems += m.softmaxLayers * (r.mlaMergeCollectives || 0) * mergeE;
  return elems;
}

const chip = E.clone(E.CHIP_DEFAULT);
chip.vectorTflops = chip.attnTflops / 32 + chip.linearTflops / 64;
const bwTBs = chip.mcCount * chip.mcBandwidthGBs * 1e9 * chip.mcEfficiency / 1e12;
const util = chip.utilization;
const matchTf = I => I * bwTBs / util;
const LGRID = [32.768, 65.536, 98.304, 131.072, 196.608, 262.144, 393.216, 524.288];
const HGRID = [262.144, 524.288, 786.432, 1048.576, 1572.864, 2097.152, 3145.728, 4194.304];
const VGRID = [4.096, 8.192, 16.384, 32.768, 65.536, 131.072];
function snapUp(x, grid) {
  for (let i = 0; i < grid.length; i++) if (grid[i] + 1e-6 >= x) return grid[i];
  return grid[grid.length - 1];
}
const f = (x, d) => Number(x).toLocaleString("en-US", { maximumFractionDigits: d, minimumFractionDigits: d });

const ctx = 1048576, S = 32768, pred = 0.8;
const ids = ["deepseekV4pro", "kimiK3", "glm52"];
const names = { deepseekV4pro: "V4-Pro", kimiK3: "K3", glm52: "GLM-5.2" };
const DECODE_B = [1, 16, 32];
const PREFILL_TP = [1, 8, 16, 32];

console.log("BW", bwTBs.toFixed(3), "TB/s  util", util);
console.log("current L/H/V", chip.linearTflops, chip.attnTflops, chip.vectorTflops);
console.log("ridges L/H/V", (chip.linearTflops * util / bwTBs).toFixed(1), (chip.attnTflops * util / bwTBs).toFixed(1), (chip.vectorTflops * util / bwTBs).toFixed(1));
console.log("");

let maxL_B = { 1: 0, 16: 0, 32: 0 };
let maxH = 0, maxV = 0;
let maxHname = "", maxLname = {};
const per = [];

ids.forEach(id => {
  const m = loadModel(id);
  if (m.hybrid === "csa-hca") {
    const total = m.kvBytesFn(ctx);
    m.kvPerTokenPerLayer = total / Math.max(1, m.softmaxLayers * ctx);
  }
  const parts = partIntensities(m, ctx, pred);
  const row = { id, short: names[id], L: [], H: [], V: [] };
  parts.forEach(p => {
    if (p.pf === "skip") return;
    if (p.core === "L") {
      DECODE_B.forEach(B => {
        const I = decodeIOf(p, B, m);
        row.L.push({ name: p.name, B, I, tf: matchTf(I) });
        if (I > maxL_B[B]) { maxL_B[B] = I; maxLname[B] = names[id] + " " + p.name; }
      });
    } else if (p.core === "H") {
      row.H.push({ name: p.name, I: p.I, tf: matchTf(p.I), pf: prefillIOf(p, S) });
      if (p.I > maxH) { maxH = p.I; maxHname = names[id] + " " + p.name; }
    } else {
      row.V.push({ name: p.name, I: p.I, tf: matchTf(p.I) });
      if (p.I > maxV) maxV = p.I;
    }
  });
  const lin = linearFlops(m);
  const wOnce = m.bytes.attn + m.bytes.wdown + m.bytes.wup + m.bytes.shared + m.bytes.router + m.bytes.denseFfn + m.bytes.routedActive + m.bytes.lmHead;
  const kvW = m.kvBytesFn(S);
  const linP = lin * S;
  const atP = prefillAttnFlops(m, S);
  const moeIpf = linP / wOnce;
  const attnIpf = atP / kvW;
  const modelIpf = (linP + atP) / (wOnce + kvW);
  const opts = { prediction: pred, context: ctx, collectiveFusion: true, mlaContextShardMerge: true, maxTp: 64, margin: 1.17, users: 1, imbalance: false };
  const pfTp = {};
  PREFILL_TP.forEach(tp => {
    let wire = 0;
    if (tp > 1) {
      const r = E.evaluate(m, chip, { pp: 1, tp, policy: shardPolicy(tp) }, opts);
      const pay = payloadElems(m, r) * m.spec.dtype.dense;
      wire = 2 * (tp - 1) * pay * S;
    }
    pfTp[tp] = { I: (linP + atP) / (wOnce + kvW + wire), wireGB: wire / 1e9 };
  });
  const decTp = {};
  [1, 8, 16].forEach(tp => {
    DECODE_B.forEach(B => {
      const scale = routedScale(m, B);
      const k = m.spec.moe.activeExperts;
      const routedB = m.bytes.routedActive * scale * (2 - pred);
      const det = m.bytes.attn + m.bytes.wdown + m.bytes.wup + m.bytes.shared + m.bytes.router + m.bytes.denseFfn;
      const attnK = (() => {
        const a = m.spec.attention;
        const dense = m.spec.dtype.dense;
        const L = ctx;
        if (m.hybrid === "csa-hca") {
          const v = V4_ATTN;
          const flop = v4AttnFlops(L);
          const csaKeys = Math.min(v.topk, Math.floor(L / v.mCsa)) + v.window;
          const hcaKeys = Math.floor(L / v.mHca) + v.window;
          const ixB = v.nCsa * (L / v.mCsa) * v.indexHeadDim * v.dtype;
          const csaB = v.nCsa * csaKeys * v.headDim * v.dtype;
          const hcaB = v.nHca * hcaKeys * v.headDim * v.dtype;
          const slB = v.nSlide * v.window * v.headDim * v.dtype;
          return { flop, traffic: ixB + csaB + hcaB + slB };
        }
        if (m.dsa) {
          const flop = glmAttnFlops(m, L, m.dsa);
          const share = m.dsa.indexShare || 1;
          const ixB = (m.softmaxLayers / share) * L * m.dsa.indexHeadDim * dense;
          const topk = Math.min(L, m.dsa.topk);
          const kvTok = (a.kvLatent + (a.ropeDim || 0)) * dense;
          return { flop, traffic: ixB + m.softmaxLayers * topk * kvTok };
        }
        return { flop: k3AttnFlopsAbsorbed(m, L), traffic: m.kvBytesFn(L) };
      })();
      const flop = lin * B + attnK.flop * B;
      let wire = 0;
      if (tp > 1) {
        const r = E.evaluate(m, chip, { pp: 1, tp, policy: shardPolicy(tp) }, opts);
        const pay = payloadElems(m, r) * m.spec.dtype.dense;
        wire = 2 * (tp - 1) * pay * B;
      }
      const hbm = det + m.bytes.lmHead + routedB + attnK.traffic * B;
      const I = flop / (hbm + wire);
      decTp[`${B}-${tp}`] = I;
    });
  });
  row.moeIpf = moeIpf;
  row.attnIpf = attnIpf;
  row.modelIpf = modelIpf;
  row.pfTp = pfTp;
  row.decTp = decTp;
  per.push(row);
});

console.log("=== Decode L operators (max I per B) ===");
DECODE_B.forEach(B => {
  console.log("B=" + B, "max I", maxL_B[B].toFixed(2), maxLname[B], "F_match", f(matchTf(maxL_B[B]), 1), "snap", snapUp(matchTf(maxL_B[B]), LGRID));
});
per.forEach(r => {
  const byB = {};
  r.L.forEach(x => {
    if (!byB[x.B] || x.I > byB[x.B].I) byB[x.B] = x;
  });
  console.log(r.short, DECODE_B.map(B => `B${B} ${byB[B].name} I=${byB[B].I.toFixed(2)} → ${f(byB[B].tf, 0)}TF`).join(" | "));
});

console.log("\n=== Decode H operators ===");
per.forEach(r => {
  r.H.sort((a, b) => b.I - a.I);
  console.log(r.short);
  r.H.forEach(x => console.log("  ", x.name, "I", x.I.toFixed(2), "F", f(x.tf, 0), "P I", f(x.pf, 0)));
});
console.log("max H", maxH.toFixed(2), maxHname, "F", f(matchTf(maxH), 1), "snap", snapUp(matchTf(maxH), HGRID));

console.log("\n=== Vector ===");
per.forEach(r => {
  r.V.sort((a, b) => b.I - a.I);
  console.log(r.short, r.V.map(x => x.name + " " + x.I.toFixed(2)).join(", "));
});
console.log("max V I", maxV.toFixed(2), "F", f(matchTf(maxV), 1), "snap", snapUp(matchTf(maxV), VGRID));

console.log("\n=== Prefill 32K whole-model I+wire ===");
per.forEach(r => {
  console.log(r.short, "I_MC", f(r.modelIpf, 0), "lin", f(r.moeIpf, 0), "attn", f(r.attnIpf, 0));
  PREFILL_TP.forEach(tp => console.log("  TP" + tp, "I", f(r.pfTp[tp].I, 1), "wire", f(r.pfTp[tp].wireGB, 1) + "GB", "F_if_match", f(matchTf(r.pfTp[tp].I), 0)));
});

console.log("\n=== Decode whole-model I+wire ===");
per.forEach(r => {
  console.log(r.short);
  [1, 16, 32].forEach(B => {
    console.log("  B" + B, [1, 8, 16].map(tp => "TP" + tp + "=" + f(r.decTp[`${B}-${tp}`], 2)).join(" "));
  });
});

console.log("\n=== Proposed ridges if we snap ===");
const lB1 = snapUp(matchTf(maxL_B[1]), LGRID);
const lB16 = snapUp(matchTf(maxL_B[16]), LGRID);
const lB32 = snapUp(matchTf(maxL_B[32]), LGRID);
const hDec = snapUp(matchTf(maxH), HGRID);
console.log("L for B1/16/32", lB1, lB16, lB32, "ridges", (lB1*util/bwTBs).toFixed(1), (lB16*util/bwTBs).toFixed(1), (lB32*util/bwTBs).toFixed(1));
console.log("H Decode-match", hDec, "ridge", (hDec*util/bwTBs).toFixed(1));
const vSnap = snapUp(matchTf(maxV), VGRID);
console.log("V", vSnap, "ridge", (vSnap*util/bwTBs).toFixed(1));

const hPfNeed = per.map(r => r.pfTp[1].I);
console.log("Prefill TP1 I so large F_match would be", hPfNeed.map(I => f(matchTf(I), 0)));
[8, 16, 32].forEach(tp => {
  const mx = Math.max(...per.map(r => r.pfTp[tp].I));
  console.log("Prefill max I+网 TP" + tp, f(mx, 1), "F_match", f(matchTf(mx), 0), "vs H2097 ridge 351; vs H1573 ridge", (1572.864*util/bwTBs).toFixed(1), "vs H1049 ridge", (1048.576*util/bwTBs).toFixed(1));
});
