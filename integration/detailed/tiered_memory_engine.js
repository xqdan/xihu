/*
 * tiered_memory_engine.js — 在 design_engine.js 之上叠加「两级片上/近存」存储模型
 *
 * 架构：单卡 = N 颗计算 Die；每颗 Die 与 1 颗 3D-DRAM 做 1+1 F2F 堆叠（Raptor 口径：逻辑在上、DRAM 在下），
 *       每颗 Die 再接 1 颗 LPDDR5X 封装作容量层。没有 MC / HBM。
 *
 *   热层 T1 = 3D-DRAM：容量 dies × dram3dGBPerDie，带宽 dies × dram3dTBsPerDie × dram3dEff
 *   冷层 T2 = LPDDR5X：容量 dies × lpddrGBPerDie，带宽 dies × lpddrGBsPerDie × lpddrEff
 *
 * 放置策略（每卡）：确定性权重 + LM Head 分片 + KV/状态 必须驻热层；剩余热层容量按「专家热度」装 Routed 专家，
 *   装不下的专家落冷层。每 token 命中冷层的专家读取比例 = 1 − hitRate(f1, γ)，f1 = 热层装下的专家比例，
 *   γ = 路由倾斜指数（1 = 均匀路由，>1 = 热门专家集中，按热度放置能覆盖更多流量）。
 * 时间模型：两层并行出带宽，Stage 存储时间 = max(T1 字节/B1, T2 字节/B2)；其余（计算、归约、预取缓冲、
 *   未命中补读、PP 跳、LM Head）沿用 design_engine.js 的口径，只是把带宽项换成分层版本。
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory(require("../../teams/model/src/design_engine.js"));
  else root.TieredEngine = factory(root.DesignEngine);
})(typeof self !== "undefined" ? self : this, function (E) {
  "use strict";

  const MIB = 1024 * 1024;

  // Raptor 口径（Hot Chips 2026，silicon-area basis）：容量密度 11.4 MB/mm²、带宽密度 32.6 GB/s/mm²、有效利用率 83%
  const RAPTOR = { capMBPerMm2: 11.4, bwGBsPerMm2: 32.6, eff: 0.83, ioPjPerBit: 0.37 };

  // Raptor 口径折算到 400 mm² Die：11.4 MB/mm² → 4.56 GB；32.6 GB/s/mm² → 13 TB/s 峰值；83% 利用率
  const TIER_DEFAULT = {
    dies: 8,
    dieMm2: 400,
    dram3dGBPerDie: 4.5,
    dram3dTBsPerDie: 13,
    dram3dEff: 0.83,
    lpddrGBsPerDie: 68,       // LPDDR5X x64 @ 8533 Mbps
    lpddrGBPerDie: 32,
    lpddrEff: 0.85,
    expertSkew: 1,            // γ：1 = 均匀路由
    sramMib: 256,
    linearTflops: 262.144,
    collectiveLatencyUs: 1.15,
    collectiveScaling: "flat",
    linkBandwidthGBs: 200
  };

  function clone(o) { return JSON.parse(JSON.stringify(o)); }

  // 把分层规格映射成 design_engine 的单层芯片：T1 当作 MC，容量放开由本层自行判定
  function engineChip(tier) {
    const c = clone(E.CHIP_DEFAULT);
    c.mcCount = tier.dies;
    c.mcBandwidthGBs = tier.dram3dTBsPerDie * 1000;
    c.mcEfficiency = tier.dram3dEff;
    c.mcCapacityGB = 1e9;
    c.sramMib = tier.sramMib;
    c.linearTflops = tier.linearTflops;
    c.attnTflops = tier.linearTflops * 8;
    c.collectiveLatencyUs = tier.collectiveLatencyUs;
    c.collectiveScaling = tier.collectiveScaling || "flat";
    c.linkBandwidthGBs = tier.linkBandwidthGBs;
    return c;
  }

  // 热层装下比例 f1 的专家时，命中热层的读取比例。γ=1 均匀；γ=2 时装 50% 覆盖 75%
  function hitRate(f1, gamma) {
    if (f1 >= 1) return 1;
    if (f1 <= 0) return 0;
    return 1 - Math.pow(1 - f1, gamma || 1);
  }

  function capacities(tier) {
    return {
      C1: tier.dies * tier.dram3dGBPerDie * 1e9,
      C2: tier.dies * tier.lpddrGBPerDie * 1e9,
      B1: tier.dies * tier.dram3dTBsPerDie * 1e12 * tier.dram3dEff,
      B2: tier.dies * tier.lpddrGBsPerDie * 1e9 * tier.lpddrEff
    };
  }

  function evaluate(model, tier, config, opts) {
    const chip = engineChip(tier);
    const r = E.evaluate(model, chip, config, opts);
    const { C1, C2, B1, B2 } = capacities(tier);
    const s = model.spec;

    // ---- 放置 ----
    const routedTotalCard = model.bytes.routedTotal / r.cards;
    const lmCard = Math.max(0, r.weightsCard - r.detCard - routedTotalCard);
    const stateResident = r.statePerUserCard * opts.users;
    const hotRequired = r.detCard + lmCard + stateResident;
    const totalResident = r.weightsCard + stateResident;
    const feasible = r.pp <= s.layers && hotRequired <= C1 && totalResident <= C1 + C2;
    const room = Math.max(0, C1 - hotRequired);
    const routedHot = Math.min(routedTotalCard, room);
    const routedCold = routedTotalCard - routedHot;
    const f1 = routedTotalCard > 0 ? routedHot / routedTotalCard : 1;
    const h = hitRate(f1, tier.expertSkew);

    // ---- 每 Stage 流量：两层并行 ----
    const pred = opts.prediction;
    const t2 = r.routedCard * (1 - h);                 // 冷层：含 (2−p) 预取多读
    const t1 = r.cardStageBytes - t2;
    const t1Ms = t1 / B1 * 1e3;
    const t2Ms = t2 / B2 * 1e3;
    const memMs = Math.max(t1Ms, t2Ms);
    const actualCold = r.routedActualCard * (1 - h);
    const memNoPrefetchMs = Math.max((r.detCard + r.stateCard + r.routedActualCard * h) / B1, actualCold / B2) * 1e3;
    const misfetch1Ms = r.routedActualCard * h * (1 - pred) / B1 * 1e3;
    const misfetch2Ms = actualCold * (1 - pred) / B2 * 1e3;
    const misfetchMs = Math.max(misfetch1Ms, misfetch2Ms);

    // ---- SRAM：预取缓冲（读满量不超过预取深度层的权重）+ 常驻 ----
    const layersPerStage = s.layers / r.pp;
    const depth = opts.prefetchDepth || 0;
    const readAheadBytes = Math.min(B1 * (r.collectiveStageMs / layersPerStage) * 1e-3, depth * r.perLayerCard);
    const bufferNeeded = depth * r.predictedPerLayerCard + (depth > 0 ? readAheadBytes : 0);
    const sramBytes = tier.sramMib * MIB;
    const bufferBytes = Math.min(sramBytes, bufferNeeded);
    const prefetchRatio = bufferNeeded > 0 ? bufferBytes / bufferNeeded : 1;
    const resident = (sramBytes - bufferBytes) * (opts.sramAlloc === undefined ? 1 : opts.sramAlloc);
    const savedMs = Math.min(resident, r.detCard) / B1 * 1e3;

    // ---- Stage / E2E ----
    const busyMs = r.computeMs + r.collectiveStageMs;
    const stageWithBufferMs = Math.max(memMs - savedMs, busyMs + misfetchMs);
    const stageNoBufferMs = memNoPrefetchMs + r.collectiveStageMs;
    const stageMs = prefetchRatio * stageWithBufferMs + (1 - prefetchRatio) * stageNoBufferMs;
    const e2eMs = (r.pp * stageMs + r.hopMs + r.lmMs) * opts.margin;

    let bottleneck;
    const bufferPenaltyMs = (1 - prefetchRatio) * Math.max(0, stageNoBufferMs - stageWithBufferMs);
    if (bufferPenaltyMs > 0.05 * stageMs) bottleneck = "SRAM 缓冲不足";
    else if (memMs - savedMs >= busyMs + misfetchMs) bottleneck = t2Ms > t1Ms ? "LPDDR 带宽" : "3D-DRAM 带宽";
    else if (misfetchMs > r.collectiveStageMs && misfetchMs > r.computeMs) bottleneck = misfetch2Ms > misfetch1Ms ? "LPDDR 补读" : "预测未命中补读";
    else if (r.collectiveStageMs > r.computeMs) bottleneck = "TP 归约";
    else bottleneck = "算力";

    const cycleMs = (Math.max(stageMs, stageMs + r.lmMs)) * opts.margin;
    return Object.assign({}, r, {
      feasible,
      tps: 1000 / e2eMs, e2eMs, stageMs, stageWithBufferMs, stageNoBufferMs, busyMs,
      throughput: 1000 / cycleMs, throughputPerCard: 1000 / cycleMs / r.cards,
      mcMs: memMs, memMs, t1Ms, t2Ms, t1Bytes: t1, t2Bytes: t2, memNoPrefetchMs,
      misfetchMs, misfetch1Ms, misfetch2Ms, savedMs,
      readAheadBytes, bufferNeeded, bufferBytes, prefetchRatio, residentBytes: resident,
      bottleneck,
      placement: {
        C1, C2, B1, B2,
        det: r.detCard, lm: lmCard, state: stateResident,
        routedTotal: routedTotalCard, routedHot, routedCold, f1, hitRate: h,
        hotUsed: hotRequired + routedHot, coldUsed: routedCold,
        hotRequired, totalResident
      }
    });
  }

  // ---- 部署搜索 ----
  const SHARD_ALL = { attn: "shard", wdown: "shard", wup: "shard", shared: "shard", denseFfn: "shard" };
  function divisors(n) { const out = []; for (let i = 1; i <= n; i++) if (n % i === 0) out.push(i); return out; }

  // 快筛：全分片 × Router 分片/复制 × Wup 分片/复制
  function screen(model, tier, opts, cards) {
    let best = null;
    for (const pp of divisors(cards)) {
      const tp = cards / pp;
      if (pp > model.spec.layers || !E.tpAllowed(model, tp, opts)) continue;
      for (const g of E.expertGroupsFor(tp, opts.maxExpertGroup)) {
        for (const router of ["shard", "replicate"]) {
          for (const wup of ["shard", "replicate"]) {
            const r = evaluate(model, tier, { pp, tp, policy: Object.assign({ expertGroup: g, router }, SHARD_ALL, { wup }) }, opts);
            if (r.feasible && (!best || r.tps > best.tps)) best = r;
          }
        }
      }
    }
    return best;
  }

  // 全策略复核：attn / wdown / wup / shared 各 shard|replicate × router × expertGroup
  function optimizeFull(model, tier, opts, cards) {
    let best = null;
    const keys = ["attn", "wdown", "wup", "shared"];
    for (const pp of divisors(cards)) {
      const tp = cards / pp;
      if (pp > model.spec.layers || !E.tpAllowed(model, tp, opts)) continue;
      for (const g of E.expertGroupsFor(tp, opts.maxExpertGroup)) {
        for (let mask = 0; mask < 16; mask++) {
          const policy = { expertGroup: g, denseFfn: "shard" };
          keys.forEach((k, i) => { policy[k] = (mask >> i) & 1 ? "replicate" : "shard"; });
          for (const router of ["shard", "replicate"]) {
            const r = evaluate(model, tier, { pp, tp, policy: Object.assign({}, policy, { router }) }, opts);
            if (r.feasible && (!best || r.tps > best.tps)) best = r;
          }
        }
      }
    }
    return best;
  }

  // 快筛的策略集是全策略的子集，因此 screen().tps 是 optimizeFull().tps 的下界。
  // 于是：快筛达标 ⇒ 全策略必达标（无需再搜）；快筛离目标远于实测最大增益（约 1.2×）⇒ 全策略也补不上。
  // 只有落在中间带的才真跑全策略。这样既不损失精度，又避免对 1000+ 规格点做完整枚举。
  const QUICK_GAP = 1.4;
  function meetsTarget(model, tier, opts, cards, target) {
    const quick = screen(model, tier, opts, cards);
    if (quick && quick.tps >= target) return true;
    if (quick && quick.tps < target / QUICK_GAP) return false;
    const full = optimizeFull(model, tier, opts, cards);
    return !!full && full.tps >= target;
  }

  // 达标最少卡数。判定用 meetsTarget 加速，命中的卡数再用全策略取精确解。
  // 不能用快筛直接定 N*：本架构归约占 Stage 比例比 HBM 方案高，Wdown 复制（省一次 all-reduce）
  // 经常胜出，固定 Wdown 分片会系统性高估卡数。
  function minCards(model, tier, opts, cardList, target) {
    for (const n of cardList) {
      if (!meetsTarget(model, tier, opts, n, target)) continue;
      const r = optimizeFull(model, tier, opts, n);
      if (r && r.tps >= target) return r;
    }
    return null;
  }

  // ---- 物理约束：3D-DRAM 密度 ----
  // PDF 的热可靠性结论有前提："1-Hi stack, Logic-on-Top with power density ≤ 0.5 W/mm² can be
  // reliably liquid-cooled (DRAM < 100°C)"。超出 1-Hi 密度就得堆多层，推翻该前提，故作硬约束。
  function density(tier) {
    const mbPerMm2 = tier.dram3dGBPerDie * 1024 / tier.dieMm2;
    return { mbPerMm2, ratio: mbPerMm2 / RAPTOR.capMBPerMm2 };
  }
  function densityOk(tier, limitMBPerMm2) {
    return density(tier).mbPerMm2 <= limitMBPerMm2 + 1e-9;
  }

  // ---- 面积 ----
  function area(tier, cost) {
    const tensor = cost.tensorAreaMm2At262Tflops * tier.linearTflops / 262.144;
    const sram = tier.sramMib / cost.sramMibPerMm2;
    const dram3dIf = tier.dies * cost.dram3dIfMm2PerDie;
    const lpddrPhy = tier.dies * cost.lpddrPhyMm2PerDie;
    const fixed = cost.fixedAreaMm2;
    const total = tensor + sram + dram3dIf + lpddrPhy + fixed;
    const budget = tier.dies * tier.dieMm2;
    // Die 尺寸被 1+1 堆叠绑定为 dies × dieMm2（要配同尺寸 3D-DRAM），用不满的面积仍要付钱
    return { tensor, sram, dram3dIf, lpddrPhy, fixed, total, budget, unused: Math.max(0, budget - total), utilization: total / budget };
  }

  // ---- 功耗与结温 ----
  // duty = 热层读取占 Stage 的比例（3D IO 只在实际搬数时耗电）。不传 duty 时按峰值算，作 TDP 用于剔除。
  function power(tier, cost, duty) {
    const p = cost.power;
    const th = p.thermal;
    const perDieTBs = tier.dram3dTBsPerDie * tier.dram3dEff;
    const ioPeak = perDieTBs * 1e12 * 8 * p.ioPjPerBit * 1e-12;          // 3D 垂直 IO，PDF 实测 0.37 pJ/bit
    const io = ioPeak * (duty === undefined ? 1 : duty);
    const array = perDieTBs * p.dramArrayWPerTBs * (duty === undefined ? 1 : Math.max(p.refreshDutyFloor, duty));
    const compute = (tier.linearTflops + tier.linearTflops * 8 * p.attnDuty) / tier.dies * p.computeWPerTflops;
    const sram = tier.sramMib / tier.dies * p.sramWPerMib;
    const lpddr = p.lpddrWPerPkg + tier.lpddrGBsPerDie * p.lpddrWPer100GBs / 100;
    const fixed = p.fixedWPerDie;
    const stack = io + array + compute + sram + fixed;                   // 堆叠内（逻辑 + DRAM）

    // 结温：Logic-on-Top 直贴冷板，DRAM 在下。热阻由 PDF 的边界点反标——
    // 0.5 W/mm² × dieMm2 时 DRAM 恰好到上限温度，热阻与面积成反比。
    const refW = th.refDensityWPerMm2 * tier.dieMm2;
    const thetaCPerW = (th.dramLimitC - th.coolantC) / refW;
    const dramTjC = th.coolantC + stack * thetaCPerW;
    const thermalFloorC = th.coolantC;                                   // 零功耗时的结温，用于反算上限功率
    // 供电经 DRAM 的 TSV 上送，PDF 列为独立挑战（IR drop）
    const tsvCurrentA = stack / th.vddV;
    return {
      io, ioPeak, array, compute, sram, lpddr, fixed, stack,
      perDie: stack + lpddr, card: (stack + lpddr) * tier.dies,
      density: stack / tier.dieMm2, refDensity: th.refDensityWPerMm2,
      dramTjC, dramLimitC: th.dramLimitC, thetaCPerW, thermalFloorC, tsvCurrentA,
      budget: th.refDensityWPerMm2 * tier.dieMm2
    };
  }

  function costOf(tier, a, cost) {
    // Die 尺寸绑定 3D-DRAM，因此按整块 dies × dieMm2 计价，而不是按用到的面积——
    // 否则"降算力、削 SRAM"会白拿成本优势，把最优解推向用不满面积的规格。
    const billedMm2 = Math.max(a.total, a.budget);
    const silicon = billedMm2 * cost.areaCostPerMm2;
    const dram3d = tier.dies * (tier.dram3dGBPerDie * cost.dram3dCostPerGB + tier.dram3dTBsPerDie * cost.dram3dCostPerTBs + cost.bondCostPerDie);
    const lpddr = tier.dies * (tier.lpddrGBPerDie * cost.lpddrCostPerGB + tier.lpddrGBsPerDie / 100 * cost.lpddrCostPer100GBs);
    const link = tier.linkBandwidthGBs / 100 * cost.linkCostPer100GBs;
    const coll = Math.max(0, cost.collectiveBaseUs - tier.collectiveLatencyUs) * cost.collectiveCostPerUsReduced;
    return { silicon, billedMm2, dram3d, lpddr, link, coll, total: silicon + dram3d + lpddr + link + coll };
  }

  // ---- 稳健性：达标不能靠擦线 ----
  // 每项扰动都在同一卡数上重跑。冷层带宽、路由倾斜、预测准确率任一项偏离标称就掉出目标的设计，
  // 不该被选为代表点——本架构的最优解天然趋向"把 LPDDR 打满、SRAM 削到刚够"的擦线配置。
  const PERTURBATIONS = [
    { name: "LPDDR 效率 0.85→0.75", tier: { lpddrEff: 0.75 } },
    { name: "路由倾斜 γ→0.8（比均匀更差）", tier: { expertSkew: 0.8 } },
    { name: "预测准确率 −10pt", opts: { prediction: -0.1 }, delta: true },
    { name: "归约延迟 +30%", mul: { collectiveLatencyUs: 1.3 } },
    { name: "3D-DRAM 效率 0.83→0.75", tier: { dram3dEff: 0.75 } },
    { name: "KV 驻留 8 用户", opts: { users: 8 } }
  ];
  function perturbed(tier, opts, p) {
    const t = clone(tier);
    if (p.tier) Object.assign(t, p.tier);
    if (p.mul) for (const k in p.mul) t[k] *= p.mul[k];
    let o = opts;
    if (p.opts) {
      o = Object.assign({}, opts);
      for (const k in p.opts) o[k] = p.delta ? o[k] + p.opts[k] : p.opts[k];
    }
    return { tier: t, opts: o };
  }
  // shortCircuit：遇到第一个失败就停，且用 meetsTarget 快速判定（大规模筛选用，只要通过/不通过）。
  // 否则每项都跑全策略拿精确 TPS（代表点展示用）。
  function robustness(model, tier, opts, cards, goal, shortCircuit) {
    const results = [];
    let pass = 0;
    for (const p of PERTURBATIONS) {
      const { tier: t, opts: o } = perturbed(tier, opts, p);
      let ok, tps = null;
      if (shortCircuit) ok = meetsTarget(model, t, o, cards, goal);
      else { const r = optimizeFull(model, t, o, cards); tps = r ? r.tps : null; ok = !!r && r.tps >= goal; }
      results.push({ name: p.name, tps, ok });
      if (ok) pass++;
      else if (shortCircuit) return { pass, total: PERTURBATIONS.length, results, robust: false, firstFail: p.name };
    }
    return { pass, total: PERTURBATIONS.length, results, robust: pass === PERTURBATIONS.length, firstFail: null };
  }

  return {
    RAPTOR, TIER_DEFAULT, PERTURBATIONS, QUICK_GAP, engineChip, hitRate, capacities, evaluate,
    screen, optimizeFull, meetsTarget, minCards, density, densityOk, area, power, costOf, robustness, perturbed, clone, SHARD_ALL
  };
});
