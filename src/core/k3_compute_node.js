/**
 * k3_compute_node.js — Decode 1M 算力下限 → 逻辑制程
 *
 * 算力密度另有 12nm 口径：TSMC 12nm、400 mm² Die 装 128 TF 没问题
 *（0.32 TF/mm²，过往经验）。Decode 下限先看每 Die TF；到 160 TF/Die
 *（24 卡 L131+H1024 = 1155 TF/卡 ≈ 144 TF/Die）仍判 N12，不为此上 N7。
 * 整卡面积仍按各页模型：N4 上 1600 mm² ↔ L 262 + H 2097 TF（1.47 TF/mm²），
 * SRAM N4 = 1.26 MiB/mm²。SRAM/PHY 挤爆不等于阵列不够。
 *
 * 浏览器：<script src="src/core/k3_compute_node.js"></script> 后使用 window.K3ComputeNode
 * Node：const CN = require("./k3_compute_node.js");
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.K3ComputeNode = factory();
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  const LIN_SWEEP = [8, 16, 32.768, 65.536, 98.304, 131.072, 196.608, 262.144, 524.288];
  const ATTN_SWEEP = [8, 16, 32, 64, 128, 256, 512, 1024, 2097, 4194, 8388];
  const TARGET = 1050;
  const CTX_1M = 1048576;
  const TF_PER_MM2_N4 = (262.144 + 2097.152) / 1600;
  const N12_TF_PER_DIE = 128;
  const N12_TF_PER_DIE_MAX = 160;
  const N12_DIE_MM2 = 400;
  const TF_PER_MM2_N12 = N12_TF_PER_DIE / N12_DIE_MM2;

  const NODES = [
    { id: "N3", ratio: 1.35, sram: 1.70, mask: "最密 / 最贵", note: "只在阵列把 N4 挤爆时才需要" },
    { id: "N4", ratio: 1.00, sram: 1.26, mask: "本项目面积基准", note: "各页 tensorArea 默认节点" },
    { id: "N5", ratio: 0.72, sram: 0.90, mask: "可退一档", note: "算力密度约 N4 的 0.72×" },
    { id: "N7", ratio: 0.45, sram: 0.63, mask: "FinFET 中档", note: "SRAM 开始变稀" },
    { id: "N12", ratio: TF_PER_MM2_N12 / TF_PER_MM2_N4, sram: 0.32, mask: "TSMC 12nm", note: "400 mm² / 128 TF 经验；至 160 TF/Die 仍算 N12" }
  ];

  const fmt0 = x => Number(x).toLocaleString("en-US", { maximumFractionDigits: 0 });
  const fmt1 = x => Number(x).toLocaleString("en-US", { maximumFractionDigits: 1 });

  function familyAScreen(E, model, chip, opts, cards) {
    const shardAll = { attn: "shard", wdown: "shard", wup: "shard", shared: "shard", denseFfn: "shard" };
    let best = null;
    for (let pp = 1; pp <= cards; pp++) {
      if (cards % pp) continue;
      const tp = cards / pp;
      if (pp > model.spec.layers || !E.tpAllowed(model, tp, opts)) continue;
      for (const g of E.expertGroupsFor(tp, opts.maxExpertGroup)) {
        for (const router of ["shard", "replicate"]) {
          for (const wup of ["shard", "replicate"]) {
            const r = E.evaluate(model, chip, { pp, tp, policy: Object.assign({ expertGroup: g, router }, shardAll, { wup }) }, opts);
            if (r.feasible && (!best || r.tps > best.tps)) best = r;
          }
        }
      }
    }
    return best;
  }

  function decodeOpts(E, ctx) {
    return Object.assign({}, E.OPTIONS_DEFAULT, {
      context: ctx, margin: 1.17, prediction: 0.8, prefetchDepth: 2,
      collectiveFusion: true, mlaContextShardMerge: true, maxTp: 32, maxExpertGroup: 64
    });
  }

  function judgeProcess(spec) {
    const lin = spec.linTf || 0;
    const attn = spec.attnTf || 0;
    const tf = lin + attn;
    const dies = spec.dies || 8;
    const dieMm2 = spec.dieMm2 || N12_DIE_MM2;
    const tfPerDie = tf / dies;
    const sramMib = spec.sramMib || 0;
    const phy = spec.phyMm2 || 0;
    const fixed = spec.fixedMm2 || 0;
    const budget = spec.budgetMm2 || dies * dieMm2;
    const rows = NODES.map(n => {
      const tensor = tf / (TF_PER_MM2_N4 * n.ratio);
      const sram = sramMib / n.sram;
      const used = tensor + sram + phy + fixed;
      const dieCap = n.id === "N12" ? N12_TF_PER_DIE : TF_PER_MM2_N4 * n.ratio * dieMm2;
      const computeCeil = n.id === "N12" ? N12_TF_PER_DIE_MAX : dieCap;
      const computeOk = tfPerDie <= computeCeil + 1e-9;
      const fail = used > budget
        ? (tensor / used > 0.45 ? "阵列" : "SRAM/PHY")
        : "";
      return {
        id: n.id, ratio: n.ratio, sramDens: n.sram, mask: n.mask, note: n.note,
        tensor, sram, phy, fixed, used, budget, ok: used <= budget, fail,
        dieCap, computeOk
      };
    });
    const oldest = [...rows].reverse().find(r => r.ok) || null;
    const oldestCompute = [...rows].reverse().find(r => r.computeOk) || null;
    return { rows, oldest, oldestCompute, tf, tfPerDie, dies, dieMm2, lin, attn, budget };
  }

  function verdictText(passed, process, extra) {
    const bits = [];
    if (!passed) {
      bits.push("1M ≥1050 加算力过不了：墙在带宽 / 归约 / 容量，不是制程。换更先进节点加密度救不了读 KV。");
      return bits.join(" ");
    }
    bits.push("1M Decode 最低算力 L " + fmt1(process.lin) + " + 注意力 " + fmt1(process.attn) +
      " = " + fmt1(process.tf) + " TF/卡（每 Die " + fmt1(process.tfPerDie) + " TF）。");
    if (process.oldestCompute) {
      bits.push("按阵列密度，最老可用 <b>" + process.oldestCompute.id + "</b>。");
      if (process.oldestCompute.id === "N12") {
        if (process.tfPerDie <= N12_TF_PER_DIE + 1e-9) {
          bits.push("TSMC 12nm、400 mm² 装 128 TF 没问题；本下限不高于此，不必上 N7/N5。");
        } else {
          bits.push("TSMC 12nm、400 mm² 经验 128 TF；本下限每 Die " + fmt1(process.tfPerDie) +
            " TF，略高一成，阵列还能挤，仍走 N12，不必上 N7。");
        }
      } else if (process.oldestCompute.id === "N7") {
        bits.push("超过 12nm 还能挤的约 160 TF/Die，退到 N7。");
      } else if (process.oldestCompute.id === "N5") {
        bits.push("12nm / N7 单 Die 算力不够，退到 N5。");
      } else if (process.oldestCompute.id === "N4") {
        bits.push("停在本项目基准 N4。");
      } else {
        bits.push("阵列太大，才需要 N3。");
      }
    }
    if (process.oldest && process.oldestCompute && process.oldest.id !== process.oldestCompute.id) {
      bits.push("整卡再算 SRAM/PHY 时，面积最老停在 " + process.oldest.id +
        "——卡住的是 SRAM 变稀或 PHY，不是 128 TF 那档阵列。");
    }
    if (extra) bits.push(extra);
    bits.push("Prefill 若仍要大阵列，制程另算，不在本目标里。");
    return bits.join(" ");
  }

  function sweepFamilyA(evalAt, target) {
    const t = target || TARGET;
    const cells = [];
    let minL = null, minH = null, minSum = null;
    for (const lin of LIN_SWEEP) {
      for (const attn of ATTN_SWEEP) {
        const r = evalAt(lin, attn);
        const tps = r && r.tps ? r.tps : 0;
        const ok = tps >= t;
        const cell = { lin, attn, tps, ok, bot: r && r.bot ? r.bot : (r && r.bottleneck) || "—" };
        cells.push(cell);
        if (ok && !minL) minL = cell;
        if (ok && (minH === null || attn < minH.attn || (attn === minH.attn && lin < minH.lin))) minH = cell;
        if (ok && (!minSum || lin + attn < minSum.lin + minSum.attn)) minSum = cell;
      }
    }
    // minL above is first passing in sweep order (low L, then H). Recompute true mins.
    minL = null;
    minH = null;
    for (const lin of LIN_SWEEP) {
      const hits = cells.filter(c => c.lin === lin && c.ok);
      if (hits.length && !minL) minL = hits.reduce((a, b) => a.attn <= b.attn ? a : b);
    }
    for (const attn of ATTN_SWEEP) {
      const hits = cells.filter(c => c.attn === attn && c.ok);
      if (hits.length && !minH) minH = hits.reduce((a, b) => a.lin <= b.lin ? a : b);
    }
    return { cells, minL, minH, minSum };
  }

  function sweep1D(values, evalAt, target) {
    const t = target || TARGET;
    let min = null;
    const rows = values.map(v => {
      const r = evalAt(v);
      const tps = r && r.tps ? r.tps : 0;
      const row = { v, tps, ok: tps >= t, bot: (r && (r.bot || r.bottleneck)) || "—" };
      if (row.ok && !min) min = row;
      return row;
    });
    return { rows, min };
  }

  function processTable(process) {
    return `<table><thead><tr>
      <th>节点</th><th>400 mm² 算力</th><th>阵列能否装下</th>
      <th class="num">阵列 mm²</th><th class="num">SRAM mm²</th>
      <th class="num">整卡合计 / 预算</th><th>整卡面积</th>
    </tr></thead><tbody>` + process.rows.map(r => `<tr>
      <td><b>${r.id}</b> · ${r.mask}</td>
      <td>${fmt0(r.dieCap)} TF/Die</td>
      <td>${r.computeOk ? '<span class="tag ok">可</span>' : '<span class="tag bad">超</span>'}</td>
      <td class="num">${fmt1(r.tensor)}</td>
      <td class="num">${fmt1(r.sram)}</td>
      <td class="num">${fmt0(r.used)} / ${fmt0(r.budget)}</td>
      <td>${r.ok ? '<span class="tag ok">可</span>' : '<span class="tag bad">超' + (r.fail ? " · " + r.fail : "") + "</span>"}</td>
    </tr>`).join("") + "</tbody></table>";
  }

  function floorTable(sweep, kind) {
    if (kind === "2d") {
      const attnCols = ATTN_SWEEP;
      const lins = LIN_SWEEP;
      const by = {};
      sweep.cells.forEach(c => { by[c.lin + "/" + c.attn] = c; });
      return `<table><thead><tr><th>L-Core \\ 注意力</th>` +
        attnCols.map(a => `<th class="num">${a}</th>`).join("") + `</tr></thead><tbody>` +
        lins.map(lin => `<tr><td>${fmt1(lin)}</td>` + attnCols.map(a => {
          const c = by[lin + "/" + a];
          if (!c) return "<td>—</td>";
          return `<td class="num" style="background:${c.ok ? "#e6f4ea" : "transparent"}">${c.tps ? fmt0(c.tps) : "—"}</td>`;
        }).join("") + "</tr>").join("") + "</tbody></table>";
    }
    return `<table><thead><tr><th>档位 TF</th><th class="num">TPS</th><th>瓶颈</th></tr></thead><tbody>` +
      sweep.rows.map(r => `<tr>
        <td>${r.v}</td>
        <td class="num" style="background:${r.ok ? "#e6f4ea" : "transparent"}">${r.tps ? fmt0(r.tps) : "—"}</td>
        <td>${r.bot}</td>
      </tr>`).join("") + "</tbody></table>";
  }

  function renderBlock(el, data) {
    if (!el) return;
    const p = data.process;
    const s = data.sweep;
    el.innerHTML =
      `<p class="caption">${data.caption || ""}</p>` +
      `<div class="callout${data.passed ? "" : " warn"}"><p>${verdictText(data.passed, p, data.extra)}</p></div>` +
      `<div class="stats" style="margin-top:12px">` +
        `<div class="stat"><div class="v">${data.baseTps != null ? fmt0(data.baseTps) : "—"}</div><div class="l">代表点 1M TPS</div></div>` +
        `<div class="stat"><div class="v">${s.minL ? fmt1(s.minL.lin || s.minL.v) + " TF" : "过不了"}</div><div class="l">最低 L-Core / 卡</div></div>` +
        `<div class="stat"><div class="v">${s.minH ? fmt1(s.minH.attn || s.minH.v) + " TF" : (s.min ? fmt1(s.min.v) + " TF" : "过不了")}</div><div class="l">最低注意力 / 卡</div></div>` +
        `<div class="stat"><div class="v">${p.oldestCompute ? p.oldestCompute.id : (p.oldest ? p.oldest.id : "装不下")}</div><div class="l">阵列最老节点</div></div>` +
        `<div class="stat"><div class="v">${s.minSum ? fmt1(s.minSum.lin + s.minSum.attn) : (p.tf ? fmt1(p.tf) : "—")}</div><div class="l">过线最少合计 TF</div></div>` +
      `</div>` +
      `<h3>制程：最低算力放进 8×400 mm²</h3>` +
      `<div class="panel" style="padding:0;overflow:auto">${processTable(p)}</div>` +
      `<p class="caption">阵列口径：TSMC 12nm、400 mm² / 128 TF（过往经验，0.32 TF/mm²）。到 160 TF/Die 仍判 N12。N4 面积模型仍是 1.47 TF/mm²。整卡「超」多半是 SRAM 变稀或 PHY，不是阵列装不下。PHY ${fmt0(data.phyMm2 || 0)} mm² + 固定 ${fmt0(data.fixedMm2 || 0)} mm² 不随节点变。</p>` +
      `<h3>${data.gridTitle || "1M TPS 网格（绿 = ≥1050）"}</h3>` +
      `<div class="panel" style="padding:0;overflow:auto">${floorTable(s, data.gridKind || (s.cells ? "2d" : "1d"))}</div>`;
  }

  return {
    LIN_SWEEP, ATTN_SWEEP, NODES, TARGET, CTX_1M, TF_PER_MM2_N4,
    N12_TF_PER_DIE, N12_TF_PER_DIE_MAX, N12_DIE_MM2, TF_PER_MM2_N12,
    familyAScreen, decodeOpts, judgeProcess, verdictText,
    sweepFamilyA, sweep1D, processTable, floorTable, renderBlock, fmt0, fmt1
  };
});
