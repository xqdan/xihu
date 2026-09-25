/*
 * design_engine.js — MoE Decode 部署与芯片规格设计空间探索引擎
 *
 * 用途：
 *   1. 给定模型 + 芯片，自动选择「层内 TP 策略」（每类张量分片还是复制）
 *   2. 给定模型 + 芯片 + 卡数，自动选择 PP×TP
 *   3. 给定模型 + 芯片旋钮及其代价，给出「最少资源、最大收益」的升级/削减路径
 *
 * 浏览器：<script src="teams/model/src/design_engine.js"></script> 后使用 window.DesignEngine
 * Node：   const E = require("./design_engine.js");  node design_engine.js 直接运行示例
 *
 * 建模口径与 k3_pp_tp_calculator.html 一致，并做了以下扩展：
 *   - 注意力/固定权重可显式推导（MLA/GQA）而不只依赖残差
 *   - Routed Experts 按 Owner 放置，可选考虑 Owner 负载不均（balls-in-bins 期望最大值）
 *   - SRAM 先作预取缓冲（装下 prefetchDepth 层的权重 + 预测专家，MC 读取才能与计算/归约重叠；
 *     预测未命中的 (1−p) 份专家在 Router 之后串行补读），缓冲之外的容量再常驻权重
 *     （优先确定性权重，剩余按均匀路由命中率覆盖 Routed 权重）
 *   - 归约/PP 跳数包含 payload ÷ 互联带宽项
 *   - LM Head 只在最后一个 Stage 读取一次
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.DesignEngine = factory();
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  const MIB = 1024 * 1024;
  const MXFP4_BYTES = 17 / 32;

  // ---------------------------------------------------------------------------
  // 模型预设
  // attention.paramsPerLayer: "derive"（按 MLA/GQA 公式推导）| "residual"（激活参数减去可推算项）| 数字
  // ---------------------------------------------------------------------------
  const MODEL_PRESETS = {
    kimiK3: {
      name: "Kimi K3（2.78T，计算器口径）",
      totalParams: 2.78e12,
      activeParams: 104.2e9,
      layers: 93,
      moeLayers: 92,
      hidden: 7168,
      vocab: 163840,
      moe: { totalExperts: 896, activeExperts: 16, sharedExperts: 2, expertHidden: 3072, expertInput: "latent", latent: 3584 },
      denseFfnHidden: 0,
      // qkHeadDim 192 = nope 128 + rope 64；KV cache 每 token 每层存 kvLatent + ropeDim = 576 个元素（DeepSeek-V3 / K2 同构）
      attention: { kind: "mla", heads: 96, qkHeadDim: 192, vHeadDim: 128, kvLatent: 512, ropeDim: 64, qLoraRank: 0, paramsPerLayer: "residual" },
      linearAttention: { layers: 69, stateDim: 128 },
      dtype: { routed: MXFP4_BYTES, dense: 2 }
    },
    deepseekV3: {
      name: "DeepSeek-V3 / R1（671B）",
      totalParams: 671e9,
      activeParams: 37e9,
      layers: 61,
      moeLayers: 58,
      hidden: 7168,
      vocab: 129280,
      moe: { totalExperts: 256, activeExperts: 8, sharedExperts: 1, expertHidden: 2048, expertInput: "hidden", latent: 0 },
      denseFfnHidden: 18432,
      attention: { kind: "mla", heads: 128, qkHeadDim: 192, vHeadDim: 128, kvLatent: 512, ropeDim: 64, qLoraRank: 1536, paramsPerLayer: "derive" },
      linearAttention: { layers: 0, stateDim: 0 },
      dtype: { routed: MXFP4_BYTES, dense: 2 }
    },
    qwen3_235b: {
      name: "Qwen3-235B-A22B",
      totalParams: 235e9,
      activeParams: 22e9,
      layers: 94,
      moeLayers: 94,
      hidden: 4096,
      vocab: 151936,
      moe: { totalExperts: 128, activeExperts: 8, sharedExperts: 0, expertHidden: 1536, expertInput: "hidden", latent: 0 },
      denseFfnHidden: 0,
      attention: { kind: "gqa", heads: 64, qkHeadDim: 128, vHeadDim: 128, kvHeads: 4, ropeDim: 0, qLoraRank: 0, paramsPerLayer: "derive" },
      linearAttention: { layers: 0, stateDim: 0 },
      dtype: { routed: MXFP4_BYTES, dense: 2 }
    }
  };

  // 单卡 = 8 计算 Die × 16 MC，口径见 ucie_7reticle_architecture.html
  const CHIP_DEFAULT = {
    mcCount: 16,
    mcBandwidthGBs: 320,
    mcEfficiency: 0.7,
    mcCapacityGB: 8,
    sramMib: 768,
    linearTflops: 262.144,
    attnTflops: 2097.152,
    utilization: 0.6,
    lcoreArrayN: 128,
    collectiveLatencyUs: 2,
    collectiveRefTp: 8,
    collectiveScaling: "log2",
    ppHopUs: 2,
    linkBandwidthGBs: 200
  };

  // 归约延迟：collectiveLatencyUs 按 collectiveRefTp 规模给出，"log2" 表示随 log2(TP) 缩放（树形归约），"flat" 表示不随规模变化
  function collectiveLatency(chip, tp) {
    switch (chip.collectiveScaling) {
      case "flat": return chip.collectiveLatencyUs;
      case "log2": return chip.collectiveLatencyUs * Math.log2(tp) / Math.log2(chip.collectiveRefTp);
      default: throw new Error("未知 collectiveScaling: " + chip.collectiveScaling);
    }
  }

  // prediction：下一层专家预测准确率
  // prefetchDepth：SRAM 预取缓冲要装下几层的「预测专家」（2 = 当前层 + 下一层双缓冲）；确定性权重按流式消费，
  //   缓冲只需再装下「归约空窗期间 MC 读满的字节」（compute 停在 all-reduce 上时 MC 继续读下一批权重）
  // sramAlloc：缓冲之外的 SRAM 用于权重常驻的比例
  // collectiveFusion：把同一层里输入相同、彼此独立的集合通信合并成一次（Wdown 的 all-gather 与 Router 的 all-gather 都吃 norm(h)）
  // mlaContextShardMerge：MLA 潜变量 KV 按 Context 分片后，每个 softmax 注意力层需要一次 flash-decoding 式的 LSE 合并，是否计入
  const OPTIONS_DEFAULT = {
    prediction: 0.8,
    prefetchDepth: 2,
    context: 1048576,
    sramAlloc: 1.0,
    margin: 1.17,
    users: 1,
    imbalance: true,
    collectiveFusion: false,
    mlaContextShardMerge: true,
    cardCounts: [8, 16, 32, 64, 128],
    maxTp: 16,
    maxExpertGroup: 64,
    objective: "tps"
  };

  // 芯片旋钮：step 为一次升级的增量（better 为 "down" 的旋钮增量为负方向），cost 为一步的相对代价
  // 默认代价为按 400 mm² Die 面积比例的粗估（SRAM 1.26 MiB/mm²，Tensor 200 mm²），请按实际回标
  const KNOBS_DEFAULT = [
    { id: "mcCount", label: "MC 数量/卡", unit: "颗", step: 2, min: 2, max: 32, cost: 80, better: "up" },
    { id: "mcBandwidthGBs", label: "MC 带宽/颗", unit: "GB/s", step: 40, min: 80, max: 800, cost: 24, better: "up" },
    { id: "mcCapacityGB", label: "MC 容量/颗", unit: "GB", step: 4, min: 2, max: 32, cost: 48, better: "up" },
    { id: "sramMib", label: "SRAM/卡", unit: "MiB", step: 96, min: 96, max: 3072, cost: 76, better: "up" },
    { id: "linearTflops", label: "L-Core 算力/卡", unit: "TFLOPS", step: 32.768, min: 32.768, max: 1048.576, cost: 40, better: "up" },
    { id: "attnTflops", label: "H-Core 算力/卡", unit: "TFLOPS", step: 262.144, min: 262.144, max: 8388.608, cost: 175, better: "up" },
    { id: "collectiveLatencyUs", label: "TP 归约延迟", unit: "μs", step: 0.25, min: 0.25, max: 5, cost: 30, better: "down" },
    { id: "ppHopUs", label: "PP 边界延迟", unit: "μs", step: 0.25, min: 0.25, max: 5, cost: 20, better: "down" },
    { id: "linkBandwidthGBs", label: "互联带宽/卡", unit: "GB/s", step: 100, min: 100, max: 3200, cost: 15, better: "up" }
  ];

  // 层内策略：每类张量 shard | replicate；expertGroup = 每个 Routed Expert 切成几份（1 = 纯 Owner 放置）
  const POLICY_KEYS = ["attn", "wdown", "wup", "shared", "router", "denseFfn"];
  const POLICY_LABELS = {
    attn: "Attention 权重+状态",
    wdown: "Wdown",
    wup: "Wup",
    shared: "Shared experts",
    router: "Router",
    denseFfn: "Dense FFN"
  };
  const OBJECTIVES = {
    tps: "单用户 TPS/usr 最大",
    throughput: "PP 流水吞吐最大（batch=1）",
    perCard: "每卡流水吞吐最大",
    balanced: "TPS × 每卡吞吐 几何平均"
  };

  // ---------------------------------------------------------------------------
  // 工具
  // ---------------------------------------------------------------------------
  function clone(obj) {
    return JSON.parse(JSON.stringify(obj));
  }

  function divisors(n) {
    const out = [];
    for (let i = 1; i <= n; i++) if (n % i === 0) out.push(i);
    return out;
  }

  // Owner 放置下，k 个激活专家（每个切成 g 份）落到 n 张 TP 卡上，最忙那张卡的期望字节 ÷ 平均字节
  const imbalanceCache = new Map();
  function imbalanceFactor(k, n, g) {
    const group = g || 1;
    if (n <= 1 || k <= 0) return 1;
    if (group >= n) return 1;
    return ballsInBinsMaxRatio(k * group, n);
  }

  function ballsInBinsMaxRatio(k, n) {
    const key = k + ":" + n;
    if (imbalanceCache.has(key)) return imbalanceCache.get(key);
    let seed = 20260907;
    const rnd = () => {
      seed = (seed * 1664525 + 1013904223) >>> 0;
      return seed / 4294967296;
    };
    const trials = 4000;
    const bins = new Array(n);
    let sum = 0;
    for (let t = 0; t < trials; t++) {
      bins.fill(0);
      let mx = 0;
      for (let i = 0; i < k; i++) {
        const b = Math.floor(rnd() * n);
        if (++bins[b] > mx) mx = bins[b];
      }
      sum += mx;
    }
    const factor = sum / trials / (k / n);
    imbalanceCache.set(key, factor);
    return factor;
  }

  // ---------------------------------------------------------------------------
  // 模型派生：把规格转成「每 token 需要读取的各类权重字节」
  // ---------------------------------------------------------------------------
  function deriveAttentionParamsPerLayer(spec) {
    const a = spec.attention;
    const h = spec.hidden;
    const oProj = a.heads * a.vHeadDim * h;
    switch (a.kind) {
      case "mla": {
        const rope = a.ropeDim || 0;
        const qProj = a.qLoraRank
          ? h * a.qLoraRank + a.qLoraRank * a.heads * a.qkHeadDim
          : h * a.heads * a.qkHeadDim;
        const kvA = h * (a.kvLatent + rope);
        const kvB = a.kvLatent * a.heads * (a.qkHeadDim - rope + a.vHeadDim);
        return qProj + kvA + kvB + oProj;
      }
      case "gqa": {
        const qProj = h * a.heads * a.qkHeadDim;
        const kvProj = 2 * h * a.kvHeads * a.qkHeadDim;
        return qProj + kvProj + oProj;
      }
      default:
        throw new Error("未知 attention.kind: " + a.kind);
    }
  }

  function deriveModel(spec) {
    const moe = spec.moe;
    const a = spec.attention;
    const la = spec.linearAttention || { layers: 0, stateDim: 0 };
    const denseLayers = spec.layers - spec.moeLayers;
    const softmaxLayers = spec.layers - la.layers;
    const expertIn = moe.expertInput === "latent" ? moe.latent : spec.hidden;

    const params = {};
    params.routedActive = spec.moeLayers * moe.activeExperts * 3 * expertIn * moe.expertHidden;
    params.routedTotal = spec.moeLayers * moe.totalExperts * 3 * expertIn * moe.expertHidden;
    params.shared = spec.moeLayers * moe.sharedExperts * 3 * spec.hidden * moe.expertHidden;
    params.wdown = moe.expertInput === "latent" ? spec.moeLayers * spec.hidden * moe.latent : 0;
    params.wup = params.wdown;
    params.router = spec.moeLayers * spec.hidden * moe.totalExperts;
    params.denseFfn = denseLayers * 3 * spec.hidden * (spec.denseFfnHidden || 0);
    params.lmHead = spec.hidden * (spec.vocab || 0);

    const knownActive =
      params.routedActive + params.shared + params.wdown + params.wup +
      params.router + params.denseFfn + params.lmHead;
    let attnSource;
    if (typeof a.paramsPerLayer === "number") {
      params.attn = a.paramsPerLayer * spec.layers;
      attnSource = "explicit";
    } else if (a.paramsPerLayer === "residual") {
      params.attn = spec.activeParams - knownActive;
      attnSource = "residual";
    } else {
      params.attn = deriveAttentionParamsPerLayer(spec) * spec.layers;
      attnSource = "derived";
    }
    if (params.attn < 0) throw new Error("推导出的注意力参数为负，请检查模型规格");

    const dense = spec.dtype.dense;
    const bytes = {
      routedActive: params.routedActive * spec.dtype.routed,
      routedTotal: params.routedTotal * spec.dtype.routed,
      attn: params.attn * dense,
      wdown: params.wdown * dense,
      wup: params.wup * dense,
      shared: params.shared * dense,
      router: params.router * dense,
      denseFfn: params.denseFfn * dense,
      lmHead: params.lmHead * dense
    };

    const kvPerTokenPerLayer =
      a.kind === "mla" ? (a.kvLatent + (a.ropeDim || 0)) * dense : 2 * a.kvHeads * a.qkHeadDim * dense;
    const kdaStateStore = la.layers * a.heads * la.stateDim * la.stateDim * dense;

    const activeSum = knownActive + params.attn;
    const totalSum = activeSum - params.routedActive + params.routedTotal;

    return {
      spec,
      params,
      bytes,
      attnSource,
      denseLayers,
      softmaxLayers,
      kvPerTokenPerLayer,
      kdaStateStore,
      attnFlopsPerToken: context =>
        softmaxLayers * 2 * context * a.heads * (a.qkHeadDim + a.vHeadDim) +
        la.layers * a.heads * la.stateDim * la.stateDim * 7,
      check: {
        activeParams: activeSum,
        activeGap: spec.activeParams ? activeSum - spec.activeParams : 0,
        totalParams: totalSum,
        totalGap: spec.totalParams ? totalSum - spec.totalParams : 0
      }
    };
  }

  function policyKeysFor(model) {
    const p = model.params;
    return POLICY_KEYS.filter(key => {
      switch (key) {
        case "attn": return true;
        case "wdown": return p.wdown > 0;
        case "wup": return p.wup > 0;
        case "shared": return p.shared > 0;
        case "router": return true;
        case "denseFfn": return p.denseFfn > 0;
        default: throw new Error("未知策略键: " + key);
      }
    });
  }

  function expertGroupsFor(tp, maxExpertGroup) {
    const cap = Math.min(tp, maxExpertGroup || tp);
    const out = [];
    for (let g = 1; g <= cap; g *= 2) out.push(g);
    return out;
  }

  function allPolicies(model, tp, opts) {
    const keys = policyKeysFor(model);
    const out = [];
    const total = 1 << keys.length;
    for (const expertGroup of expertGroupsFor(tp, opts && opts.maxExpertGroup)) {
      for (let mask = 0; mask < total; mask++) {
        const policy = { expertGroup };
        POLICY_KEYS.forEach(k => { policy[k] = "shard"; });
        keys.forEach((k, i) => { policy[k] = (mask >> i) & 1 ? "replicate" : "shard"; });
        out.push(policy);
      }
    }
    return out;
  }

  function policySummary(model, policy) {
    const keys = policyKeysFor(model);
    const rep = keys.filter(k => policy[k] === "replicate").map(k => POLICY_LABELS[k]);
    const parts = [rep.length ? "复制：" + rep.join("、") : "全部分片"];
    parts.push(policy.expertGroup > 1 ? "专家切 " + policy.expertGroup + " 份" : "专家 Owner 整放");
    return parts.join(" · ");
  }

  // TP 必须整除注意力头数；GQA 的 KV 头数不足时按复制处理（在状态分片中体现）
  function tpAllowed(model, tp, opts) {
    return tp <= opts.maxTp && model.spec.attention.heads % tp === 0;
  }

  // ---------------------------------------------------------------------------
  // 单配置评估
  // ---------------------------------------------------------------------------
  function evaluate(model, chip, config, opts) {
    const { pp, tp, policy } = config;
    const cards = pp * tp;
    const s = model.spec;
    const b = model.bytes;
    const p = model.params;
    const dense = s.dtype.dense;

    const bwCard = chip.mcCount * chip.mcBandwidthGBs * 1e9 * chip.mcEfficiency;
    const capCard = chip.mcCount * chip.mcCapacityGB * 1e9;
    const expertGroup = Math.min(policy.expertGroup || 1, tp);
    const imb = opts.imbalance ? imbalanceFactor(s.moe.activeExperts, tp, expertGroup) : 1;

    // 每卡每 Stage 确定性权重字节（分片 ÷ (PP×TP)，复制 ÷ PP）
    let detCard = 0;
    let aggregate = 0;
    let shardedParams = 0;
    let replicatedParams = 0;
    let weightsCard = 0;
    const rows = [];
    for (const key of policyKeysFor(model)) {
      const bytes = b[key];
      const replicate = policy[key] === "replicate";
      const perCard = replicate ? bytes / pp : bytes / cards;
      detCard += perCard;
      aggregate += replicate ? bytes * tp : bytes;
      weightsCard += perCard;
      if (replicate) replicatedParams += p[key]; else shardedParams += p[key];
      rows.push({ key, label: POLICY_LABELS[key], bytes, policy: policy[key], perCard });
    }

    // Attention 状态（KV + 线性注意力循环状态）跟随 attention 策略
    // MLA 的潜变量 KV 对所有头共享，分片只能按 Context 切；GQA 按 KV 头切，TP 超过 KV 头数后按复制处理
    const kvStore = model.softmaxLayers * opts.context * model.kvPerTokenPerLayer;
    const stateStore = kvStore + model.kdaStateStore;
    const stateTraffic = kvStore + 2 * model.kdaStateStore;
    const kvShards = s.attention.kind === "gqa" ? Math.min(tp, s.attention.kvHeads) : tp;
    const stateDiv = policy.attn === "replicate" ? pp : pp * kvShards;
    const stateCard = stateTraffic / stateDiv;
    aggregate += stateTraffic * (cards / stateDiv);

    // Routed experts：Owner 放置，负载不均放大最忙卡
    // 预取模式：按预测把下一层的专家提前读入 SRAM（读 1 份），Router 出来后再补读未命中的 (1−p) 份 → 共 (2−p) 份
    // 无预取模式：Router 出来后才读实际命中的专家（读 1 份），但读取无法与计算/归约重叠
    const pred = opts.prediction;
    const routedActualCard = b.routedActive / cards * imb;
    const routedCard = routedActualCard * (2 - pred);
    const routedTotalCard = b.routedTotal / cards;
    aggregate += b.routedActive * (2 - pred);
    weightsCard += routedTotalCard;

    const lmCard = b.lmHead / tp;
    weightsCard += lmCard;

    const cardStageBytes = detCard + stateCard + routedCard;
    const mcMs = cardStageBytes / bwCard * 1e3;
    const mcNoPrefetchMs = (detCard + stateCard + routedActualCard) / bwCard * 1e3;
    const misfetchMs = routedActualCard * (1 - pred) / bwCard * 1e3;
    const lmMs = lmCard / bwCard * 1e3;

    // 归约：每个「分片 → 需要完整向量」的边界一次；专家输出合并一次；Shared 与合并融合。
    // 每次的 payload 按实际传输的向量维度计：attention 输出 / Wup 输出 = hidden，Wdown 输出 / 专家合并 = latent（K3）或 hidden，
    // Router = 专家 logits，MLA Context 分片的 LSE 合并 = heads × (kvLatent + 2)。
    // collectiveFusion：Wdown 的 all-gather 与 Router 的 all-gather 都以 norm(h) 为输入、彼此独立，可合并为一次（payload 相加）。
    // 注意 o_proj → Wdown 之间有 RMSNorm（非线性），专家合并 → Wup 融合需要把 Wup 复制到每卡（字节 × TP），这两处不能靠线性融合省归约。
    const latentDim = s.moe.expertInput === "latent" ? s.moe.latent : s.hidden;
    const elemUs = elems => chip.linkBandwidthGBs > 0 ? elems * dense / (chip.linkBandwidthGBs * 1e9) * 1e6 : 0;
    const moeCollectives = [];   // 每个 MoE 层的集合通信列表：{ name, elems }
    const denseCollectives = [];
    let mlaMergeCollectives = 0; // 每个 softmax 注意力层的 LSE 合并次数（0 或 1）
    if (tp > 1) {
      if (policy.attn === "shard") {
        moeCollectives.push({ name: "attn", elems: s.hidden });
        denseCollectives.push({ name: "attn", elems: s.hidden });
        if (opts.mlaContextShardMerge && s.attention.kind === "mla" && kvShards > 1) mlaMergeCollectives = 1;
      }
      const wdownShard = p.wdown > 0 && policy.wdown === "shard";
      const routerShard = policy.router === "shard";
      if (opts.collectiveFusion && wdownShard && routerShard) moeCollectives.push({ name: "wdown+router", elems: latentDim + s.moe.totalExperts });
      else {
        if (wdownShard) moeCollectives.push({ name: "wdown", elems: latentDim });
        if (routerShard) moeCollectives.push({ name: "router", elems: s.moe.totalExperts });
      }
      moeCollectives.push({ name: "merge", elems: latentDim });
      if (p.wup > 0 && policy.wup === "shard") moeCollectives.push({ name: "wup", elems: s.hidden });
      if (p.denseFfn > 0 && policy.denseFfn === "shard") denseCollectives.push({ name: "denseFfn", elems: s.hidden });
    }
    const perMoeLayer = moeCollectives.length;
    const perDenseLayer = denseCollectives.length;
    const latencyUs = tp > 1 ? collectiveLatency(chip, tp) : 0;
    const sumUs = list => list.reduce((a, c) => a + latencyUs + elemUs(c.elems), 0);
    const mlaMergeUs = mlaMergeCollectives * (latencyUs + elemUs(s.attention.heads * ((s.attention.kvLatent || s.attention.vHeadDim) + 2)));
    const moeLayerUs = sumUs(moeCollectives);
    const denseLayerUs = sumUs(denseCollectives);
    const collectiveCount = s.moeLayers * perMoeLayer + model.denseLayers * perDenseLayer + model.softmaxLayers * mlaMergeCollectives;
    const collectiveTotalMs = (s.moeLayers * moeLayerUs + model.denseLayers * denseLayerUs + model.softmaxLayers * mlaMergeUs) / 1e3;
    const collectiveUs = collectiveCount > 0 ? collectiveTotalMs * 1e3 / collectiveCount : 0;  // 平均单次（含 payload）
    const payloadUs = elemUs(s.hidden);
    const collectiveStageMs = collectiveTotalMs / pp;
    const hopMs = (pp - 1) * (chip.ppHopUs + payloadUs) / 1e3;

    // SRAM 第一层价值：预取缓冲。确定性权重按流式消费，不需要整层驻留；缓冲要装下
    //   ① prefetchDepth 层的「预测专家」（Router 之前必须到齐，无法流式）
    //   ② 归约空窗期间 MC 读满的字节：compute 停在 all-reduce 上时不消费权重，MC 继续读下一批 → 每层 bwCard × 该层归约时间
    // 装不下时 MC 在归约期间空转、专家读取退回 Router 之后
    const layersPerStage = s.layers / pp;
    const predictedPerLayerCard = routedActualCard / layersPerStage;
    const perLayerCard = (detCard + stateCard + routedActualCard) / layersPerStage;
    const readAheadBytes = bwCard * (collectiveStageMs / layersPerStage) * 1e-3;
    const bufferNeeded = (opts.prefetchDepth || 0) * predictedPerLayerCard + (opts.prefetchDepth > 0 ? readAheadBytes : 0);
    const sramBytes = chip.sramMib * MIB;
    const bufferBytes = Math.min(sramBytes, bufferNeeded);
    const prefetchRatio = bufferNeeded > 0 ? bufferBytes / bufferNeeded : 1;

    // SRAM 第二层价值：缓冲之外的容量常驻权重。先覆盖确定性权重，剩余按均匀路由命中率覆盖 routed
    const resident = (sramBytes - bufferBytes) * opts.sramAlloc;
    function sramSavedMs(scale) {
      const det = Math.min(detCard * scale, resident);
      const left = Math.max(0, resident - det);
      const hit = routedTotalCard > 0 ? Math.min(1, left / (routedTotalCard * scale)) : 0;
      return (det + routedCard * scale * hit) / bwCard * 1e3;
    }
    const savedMs = sramSavedMs(1);

    // 计算：专家切成 g 份后每片列数 expertHidden/g，低于 L-Core 阵列长边时阵列填不满
    const expertSliceN = s.moe.expertHidden / expertGroup;
    const routedUtil = chip.utilization * Math.min(1, expertSliceN / chip.lcoreArrayN);
    const linearPeak = chip.linearTflops * 1e12;
    const fixedFlops = 2 * (shardedParams / tp + replicatedParams) / pp;
    const routedFlops = 2 * p.routedActive * imb / tp / pp;
    const linearMs = (fixedFlops / (linearPeak * chip.utilization) + routedFlops / (linearPeak * routedUtil)) * 1e3;
    const attnFlopsCard = model.attnFlopsPerToken(opts.context) / pp / (policy.attn === "replicate" ? 1 : tp);
    const attnMs = attnFlopsCard / (chip.attnTflops * 1e12 * chip.utilization) * 1e3;
    const computeMs = linearMs + attnMs;

    const busyMs = computeMs + collectiveStageMs;
    // 有预取缓冲：MC 读取与计算/归约重叠，但未命中补读在 Router 之后、计算之前，无法隐藏
    // 无预取缓冲：专家读取只能在 Router 之后开始，归约期间 MC 空转；矩阵计算按权重流式进行，视为被读取掩盖
    // 缓冲不足按覆盖比例在两者之间插值
    function stageTime(scale) {
      const withBuffer = Math.max(mcMs * scale - sramSavedMs(scale), (busyMs + misfetchMs) * scale);
      const noBuffer = (mcNoPrefetchMs + collectiveStageMs) * scale;
      return prefetchRatio * withBuffer + (1 - prefetchRatio) * noBuffer;
    }
    const stageWithBufferMs = Math.max(mcMs - savedMs, busyMs + misfetchMs);
    const stageNoBufferMs = mcNoPrefetchMs + collectiveStageMs;
    const stageNoSramMs = stageNoBufferMs;
    const stageMs = stageTime(1);
    const e2eNoSramMs = (pp * stageNoSramMs + hopMs + lmMs) * opts.margin;
    const e2eMs = (pp * stageMs + hopMs + lmMs) * opts.margin;

    // 瓶颈 Stage：层数最多的 Stage，或带 LM Head 的最后一个 Stage
    const avgLayers = layersPerStage;
    const maxScale = Math.ceil(avgLayers) / avgLayers;
    const lastScale = Math.floor(avgLayers) / avgLayers;
    const cycleMs = Math.max(stageTime(maxScale), stageTime(lastScale) + lmMs) * opts.margin;
    const throughput = 1000 / cycleMs;

    let bottleneck;
    if (prefetchRatio < 1 && stageNoBufferMs > stageWithBufferMs) bottleneck = "SRAM 缓冲不足";
    else if (mcMs - savedMs >= busyMs + misfetchMs) bottleneck = "MC 带宽";
    else if (misfetchMs > collectiveStageMs && misfetchMs > computeMs) bottleneck = "预测未命中补读";
    else if (collectiveStageMs > computeMs) bottleneck = "TP 归约";
    else bottleneck = "算力";

    // 容量
    const statePerUserCard = stateStore / stateDiv;
    const maxUsers = statePerUserCard > 0 ? Math.floor((capCard - weightsCard) / statePerUserCard) : Infinity;
    const feasible = weightsCard + opts.users * statePerUserCard <= capCard && pp <= s.layers;

    return {
      pp, tp, cards, policy,
      feasible,
      tps: 1000 / e2eMs,
      tpsNoSram: 1000 / e2eNoSramMs,
      e2eMs, e2eNoSramMs,
      throughput,
      throughputPerCard: throughput / cards,
      cycleMs,
      mcMs, mcNoPrefetchMs, misfetchMs, savedMs, computeMs, linearMs, attnMs,
      collectiveStageMs, collectiveTotalMs, collectiveCount, collectiveUs, collectiveLatencyUs: latencyUs,
      perMoeLayer, perDenseLayer, mlaMergeCollectives, moeCollectives, moeLayerUs, hopMs, lmMs, expertGroup,
      stageMs, stageWithBufferMs, stageNoBufferMs, stageNoSramMs, busyMs,
      perLayerCard, predictedPerLayerCard, readAheadBytes, bufferNeeded, bufferBytes, prefetchRatio, residentBytes: resident,
      cardStageBytes, detCard, stateCard, routedCard, routedActualCard, aggregate,
      imbalance: imb,
      weightsCard, statePerUserCard, capCard, maxUsers,
      bottleneck,
      rows
    };
  }

  function score(result, objective) {
    switch (objective) {
      case "tps": return result.tps;
      case "throughput": return result.throughput;
      case "perCard": return result.throughputPerCard;
      case "balanced": return Math.sqrt(result.tps * result.throughputPerCard);
      default: throw new Error("未知目标: " + objective);
    }
  }

  // ---------------------------------------------------------------------------
  // 优化：给定卡数集合，搜索 PP×TP × 层内策略
  // ---------------------------------------------------------------------------
  function optimizeForCards(model, chip, opts, cards) {
    const topologies = [];
    for (const pp of divisors(cards)) {
      const tp = cards / pp;
      if (pp > model.spec.layers || !tpAllowed(model, tp, opts)) continue;
      const ranked = allPolicies(model, tp, opts)
        .map(policy => evaluate(model, chip, { pp, tp, policy }, opts))
        .filter(r => r.feasible)
        .sort((x, y) => score(y, opts.objective) - score(x, opts.objective));
      if (ranked.length) topologies.push({ pp, tp, best: ranked[0], ranked });
    }
    topologies.sort((x, y) => score(y.best, opts.objective) - score(x.best, opts.objective));
    return { cards, topologies, best: topologies.length ? topologies[0].best : null };
  }

  function optimize(model, chip, opts) {
    const byCards = opts.cardCounts.map(n => optimizeForCards(model, chip, opts, n));
    const feasible = byCards.filter(x => x.best);
    feasible.sort((x, y) => score(y.best, opts.objective) - score(x.best, opts.objective));
    return { byCards, best: feasible.length ? feasible[0].best : null };
  }

  // ---------------------------------------------------------------------------
  // 芯片规格建议
  // ---------------------------------------------------------------------------
  function applyKnob(chip, knob, direction) {
    const sign = (knob.better === "down" ? -1 : 1) * direction;
    const next = chip[knob.id] + sign * knob.step;
    if (next < knob.min - 1e-9 || next > knob.max + 1e-9) return null;
    const out = clone(chip);
    out[knob.id] = Math.round(next * 1e6) / 1e6;
    return out;
  }

  function bestScore(model, chip, opts, cards) {
    const r = optimizeForCards(model, chip, opts, cards);
    return { score: r.best ? score(r.best, opts.objective) : 0, result: r.best };
  }

  function activeKnobs(knobs) {
    return knobs.filter(k => !k.locked);
  }

  function sensitivity(model, chip, opts, knobs, cards) {
    const base = bestScore(model, chip, opts, cards);
    return {
      base,
      rows: activeKnobs(knobs).map(knob => {
        const up = applyKnob(chip, knob, +1);
        const down = applyKnob(chip, knob, -1);
        const upScore = up ? bestScore(model, up, opts, cards).score : null;
        const downScore = down ? bestScore(model, down, opts, cards).score : null;
        return {
          knob,
          value: chip[knob.id],
          upValue: up ? up[knob.id] : null,
          downValue: down ? down[knob.id] : null,
          upGain: upScore === null ? null : upScore / base.score - 1,
          downLoss: downScore === null ? null : downScore / base.score - 1,
          upGainPerCost: upScore === null ? null : (upScore / base.score - 1) / knob.cost
        };
      })
    };
  }

  // 贪心升级：每步选「收益 ÷ 代价」最高的旋钮，直到预算耗尽或无正收益
  function upgradePath(model, chip, opts, knobs, cards, budget, maxSteps) {
    let current = clone(chip);
    let spent = 0;
    let base = bestScore(model, current, opts, cards);
    const start = base;
    const steps = [];
    for (let i = 0; i < maxSteps; i++) {
      let pick = null;
      for (const knob of activeKnobs(knobs)) {
        if (spent + knob.cost > budget) continue;
        const next = applyKnob(current, knob, +1);
        if (!next) continue;
        const s = bestScore(model, next, opts, cards);
        const gain = s.score / base.score - 1;
        if (gain <= 1e-6) continue;
        const ratio = gain / knob.cost;
        if (!pick || ratio > pick.ratio) pick = { knob, next, s, gain, ratio };
      }
      if (!pick) break;
      current = pick.next;
      spent += pick.knob.cost;
      base = pick.s;
      steps.push({
        step: i + 1,
        knob: pick.knob,
        value: current[pick.knob.id],
        cost: pick.knob.cost,
        spent,
        gain: pick.gain,
        score: pick.s.score,
        cumulative: pick.s.score / start.score - 1,
        result: pick.s.result
      });
    }
    return { start, steps, final: { chip: current, score: base } };
  }

  // 贪心削减：每步选「代价节省最多且性能损失 ≤ 容忍度」的旋钮，直到再削任何一项都会超出容忍度
  function downsizePath(model, chip, opts, knobs, cards, tolerance, maxSteps) {
    let current = clone(chip);
    const start = bestScore(model, current, opts, cards);
    let saved = 0;
    const steps = [];
    for (let i = 0; i < maxSteps; i++) {
      let pick = null;
      for (const knob of activeKnobs(knobs)) {
        const next = applyKnob(current, knob, -1);
        if (!next) continue;
        const s = bestScore(model, next, opts, cards);
        if (!s.result) continue;
        const loss = 1 - s.score / start.score;
        if (loss > tolerance) continue;
        const ratio = knob.cost / Math.max(loss, 1e-9);
        if (!pick || ratio > pick.ratio) pick = { knob, next, s, loss, ratio };
      }
      if (!pick) break;
      current = pick.next;
      saved += pick.knob.cost;
      steps.push({
        step: i + 1,
        knob: pick.knob,
        value: current[pick.knob.id],
        costSaved: pick.knob.cost,
        saved,
        loss: pick.loss,
        score: pick.s.score,
        result: pick.s.result
      });
    }
    return { start, steps, final: { chip: current, score: bestScore(model, current, opts, cards) } };
  }

  // ---------------------------------------------------------------------------
  // 格式化
  // ---------------------------------------------------------------------------
  function gb(bytes) { return (bytes / 1e9).toFixed(2) + " GB"; }
  function ms(x) { return x.toFixed(3) + " ms"; }
  function pct(x) { return (x * 100).toFixed(1) + "%"; }

  // ---------------------------------------------------------------------------
  // Node 直接运行时的示例
  // ---------------------------------------------------------------------------
  if (typeof require !== "undefined" && typeof module !== "undefined" && require.main === module) {
    const presetId = process.argv[2] || "kimiK3";
    if (!MODEL_PRESETS[presetId]) {
      console.error("未知预设：" + presetId + "，可选：" + Object.keys(MODEL_PRESETS).join(", "));
      process.exit(1);
    }
    const model = deriveModel(MODEL_PRESETS[presetId]);
    const opts = Object.assign({}, OPTIONS_DEFAULT);
    const chip = clone(CHIP_DEFAULT);
    const recoCards = 64;
    console.log("模型：" + model.spec.name + "，注意力参数来源：" + model.attnSource);
    console.log("口径校验：激活 " + (model.check.activeParams / 1e9).toFixed(2) + "B（差 " +
      (model.check.activeGap / 1e9).toFixed(2) + "B），总量 " + (model.check.totalParams / 1e12).toFixed(3) +
      "T（差 " + (model.check.totalGap / 1e9).toFixed(2) + "B）");
    const result = optimize(model, chip, opts);
    console.log("\n各卡数最优（目标：" + OBJECTIVES[opts.objective] + "）");
    for (const row of result.byCards) {
      if (!row.best) { console.log("  " + row.cards + " 卡：容量不可行"); continue; }
      const r = row.best;
      console.log("  " + row.cards + " 卡：PP" + r.pp + "×TP" + r.tp + " · " + policySummary(model, r.policy) +
        " · TPS " + r.tps.toFixed(0) + " · E2E " + ms(r.e2eMs) + " · 流水 " + r.throughput.toFixed(0) +
        " tok/s · 瓶颈 " + r.bottleneck + " · 不均系数 " + r.imbalance.toFixed(2) +
        " · 归约 " + r.perMoeLayer + "/层 × " + r.collectiveUs.toFixed(2) + " μs" +
        " · 预取缓冲 " + (r.bufferNeeded / MIB).toFixed(0) + " MiB 覆盖 " + pct(r.prefetchRatio) +
        " · 未命中补读 " + ms(r.misfetchMs) + "/Stage");
      const alt = row.topologies.slice(1, 3).map(t =>
        "PP" + t.pp + "×TP" + t.tp + " " + t.best.tps.toFixed(0) + " TPS").join("，");
      if (alt) console.log("      次优：" + alt);
    }
    const sens = sensitivity(model, chip, opts, KNOBS_DEFAULT, recoCards);
    console.log("\n" + recoCards + " 卡敏感性（每旋钮 ±1 步）");
    for (const row of sens.rows) {
      console.log("  " + row.knob.label.padEnd(12) + " +1步 " + (row.upGain === null ? "  —  " : pct(row.upGain).padStart(7)) +
        "  −1步 " + (row.downLoss === null ? "  —  " : pct(row.downLoss).padStart(7)) +
        "  收益/代价 " + (row.upGainPerCost === null ? "—" : (row.upGainPerCost * 1000).toFixed(2) + "‰/分"));
    }
    const up = upgradePath(model, chip, opts, KNOBS_DEFAULT, recoCards, 400, 20);
    console.log("\n升级路径（预算 400 分）");
    for (const st of up.steps) {
      console.log("  #" + st.step + " " + st.knob.label + " → " + st.value + " " + st.knob.unit +
        "（+" + st.cost + " 分，累计 " + st.spent + "）：+" + pct(st.gain) + "，累计 +" + pct(st.cumulative) +
        "，方案 PP" + st.result.pp + "×TP" + st.result.tp);
    }
    const down = downsizePath(model, chip, opts, KNOBS_DEFAULT, recoCards, 0.02, 20);
    console.log("\n削减路径（容忍损失 2%）");
    for (const st of down.steps) {
      console.log("  #" + st.step + " " + st.knob.label + " → " + st.value + " " + st.knob.unit +
        "（省 " + st.costSaved + " 分，累计省 " + st.saved + "）：损失 " + pct(st.loss));
    }
  }

  return {
    MODEL_PRESETS, CHIP_DEFAULT, OPTIONS_DEFAULT, KNOBS_DEFAULT,
    POLICY_KEYS, POLICY_LABELS, OBJECTIVES,
    deriveModel, policyKeysFor, allPolicies, policySummary, expertGroupsFor, tpAllowed,
    evaluate, score, optimizeForCards, optimize,
    applyKnob, bestScore, sensitivity, upgradePath, downsizePath,
    imbalanceFactor, collectiveLatency, clone, gb, ms, pct
  };
});
