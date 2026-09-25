/**
 * 长序列 MLA：KV 按 Context 切开，再 reduce。
 * 三栏：家族 A（权重 TP 带着切）· CIM+NPU · CIM+独立 GPU。
 * window.K3KvLong.svg("zh"|"en")
 */
(function (root) {
  "use strict";
  const C = { ink: "#172033", muted: "#647083", accent: "#155e75", purple: "#6d28d9",
    warn: "#b45309", good: "#166534", bad: "#b91c1c", line: "#d6d8d8", panel: "#fffdf8" };
  const esc = s => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;");
  const T = {
    zh: {
      title: "长序列 MLA：KV 按 Context 切开，不是按头切（MLA KV 跨头共享 576）",
      sub: "1M 一层读 1.21 GB · 24 层约 29 GB。KDA 按头切状态，无 LSE。",
      a: "家族 A · 方案 1–4",
      a2: "权重 TP 带着切 KV",
      b: "CIM+NPU",
      b2: "权重不切 · 1M 才开 KV TP",
      c: "CIM+独立 GPU",
      c2: "柜内 GPU 组 · HBM 切 C/TP",
      q: "Q 复制 / 广播",
      kv: "KV C/TP",
      loc: "本地 QKᵀ · AV",
      lse: "LSE AR ×24",
      star1: "★1 attn 出 AR ×93",
      qbr: "Q 广播 ×24",
      out: "输出收回 ×24",
      kda: "KDA 头切收回 ×69",
      tp1: "32K TP1：这三刀 = 0",
      p2p: "★1 CIM→GPU  Q+token KV",
      gar: "组内 hidden AR ×24",
      p2p2: "★2 GPU→CIM  attn 出",
      foot: "切的都是序列轴。家族 A 的 LSE 已算进 393；CIM 路线没有 393，1M 另付 KV 这几刀。",
      card: "卡",
      gpu: "G"
    },
    en: {
      title: "Long-seq MLA: shard KV on context, not heads (MLA KV is shared, 576)",
      sub: "1M: 1.21 GB/layer · ~29 GB over 24 MLA. KDA is head-sharded, no LSE.",
      a: "Family A · schemes 1–4",
      a2: "Weight TP shards KV too",
      b: "CIM+NPU",
      b2: "Weights unsharded · KV TP at 1M",
      c: "CIM + discrete GPU",
      c2: "In-rack GPU group · HBM C/TP",
      q: "Q replicate / bcast",
      kv: "KV C/TP",
      loc: "local QKᵀ · AV",
      lse: "LSE AR ×24",
      star1: "★1 attn-out AR ×93",
      qbr: "Q broadcast ×24",
      out: "output gather ×24",
      kda: "KDA head gather ×69",
      tp1: "32K TP1: these three = 0",
      p2p: "★1 CIM→GPU  Q+token KV",
      gar: "in-group hidden AR ×24",
      p2p2: "★2 GPU→CIM  attn out",
      foot: "All shard the sequence axis. Family A LSE is inside the 393. CIM drops 393; 1M pays these KV hops.",
      card: "C",
      gpu: "G"
    }
  };

  function label(x, y, t, s, c, a, w) {
    return `<text x="${x}" y="${y}" font-size="${s}" fill="${c}" text-anchor="${a || "start"}" font-weight="${w || 400}">${esc(t)}</text>`;
  }

  function col(x, w, h, title, sub) {
    return `<rect x="${x}" y="36" width="${w}" height="${h}" rx="10" fill="#f7f5ef" stroke="${C.line}"/>` +
      label(x + 12, 56, title, 13, C.ink, "start", 700) +
      label(x + 12, 74, sub, 10.5, C.muted);
  }

  function shardRow(x0, y, n, names, fill, stroke) {
    let s = "";
    const gap = 8, bw = 72;
    for (let i = 0; i < n; i++) {
      const x = x0 + i * (bw + gap);
      s += `<rect x="${x}" y="${y}" width="${bw}" height="54" rx="6" fill="${fill}" stroke="${stroke}"/>`;
      s += label(x + bw / 2, y + 20, names[i], 10, C.ink, "middle", 700);
      s += `<rect x="${x + 8}" y="${y + 30}" width="56" height="10" rx="2" fill="${stroke}" opacity=".15"/>`;
      s += `<rect x="${x + 8 + 56 * i / n}" y="${y + 30}" width="${56 / n}" height="10" rx="2" fill="${stroke}"/>`;
    }
    return s;
  }

  function hop(x, y, w, t, bg, st) {
    return `<rect x="${x}" y="${y}" width="${w}" height="26" rx="5" fill="${bg}" stroke="${st}"/>` +
      label(x + w / 2, y + 17, t, 10, C.ink, "middle", 600);
  }

  function svg(lang) {
    const L = T[lang === "en" ? "en" : "zh"];
    const h = 368;
    let s = `<svg viewBox="0 0 1200 430" role="img" aria-label="${esc(L.title)}">`;
    s += `<defs><marker id="kv-ar" markerWidth="7" markerHeight="7" refX="6" refY="3.5" orient="auto"><path d="M0,0 L7,3.5 L0,7 z" fill="${C.purple}"/></marker></defs>`;
    s += label(14, 20, L.title, 13, C.ink, "start", 700);
    s += label(14, 36, L.sub, 11, C.muted);

    s += col(14, 380, h, L.a, L.a2);
    s += label(26, 98, L.q, 10, C.purple);
    s += shardRow(26, 108, 4, [L.card + "1", L.card + "2", L.card + "3", L.card + "4"], C.panel, C.accent);
    s += label(26, 180, L.kv + " · " + L.loc, 10, C.good);
    s += hop(26, 190, 356, L.lse, "#ede9fe", C.purple);
    s += hop(26, 224, 356, L.star1, "#ede9fe", C.purple);
    s += label(26, 272, "1M 一层 1.21 GB → 每卡 /TP", 10.5, C.muted);
    s += label(26, 290, "LSE 已在 393 里（24 次）", 10.5, C.purple);
    s += label(26, 308, "短序列也切 KV，只是字节小", 10.5, C.muted);
    s += `<path d="M44 162 H356" fill="none" stroke="${C.purple}" stroke-dasharray="4 3"/>`;

    s += col(410, 380, h, L.b, L.b2);
    s += shardRow(422, 108, 4, [L.card + "主", L.card + "闲", L.card + "闲", L.card + "闲"], "#edf5f0", C.good);
    s += hop(422, 174, 356, L.qbr, "#fff4d8", C.warn);
    s += hop(422, 208, 356, L.lse, "#ede9fe", C.purple);
    s += hop(422, 242, 356, L.out, "#fff4d8", C.warn);
    s += hop(422, 276, 356, L.kda, "#e4f2f4", C.accent);
    s += label(422, 322, L.tp1, 10.5, C.muted);
    s += label(422, 340, "卡间 AR 只有 LSE 24 次", 10.5, C.purple);
    s += `<path d="M458 162 H746" fill="none" stroke="${C.warn}" stroke-dasharray="4 3"/>`;

    s += col(806, 380, h, L.c, L.c2);
    s += shardRow(818, 108, 4, [L.gpu + "0", L.gpu + "1", L.gpu + "2", L.gpu + "3"], "#faeeee", C.bad);
    s += hop(818, 174, 356, L.p2p, "#fff4d8", C.warn);
    s += hop(818, 208, 356, L.lse, "#ede9fe", C.purple);
    s += hop(818, 242, 356, L.gar, "#ede9fe", C.purple);
    s += hop(818, 276, 356, L.p2p2, "#fff4d8", C.warn);
    s += label(818, 322, "1M 要 GPU TP32 才叠够 HBM", 10.5, C.muted);
    s += label(818, 340, "93 CIM 分时复用同一组 GPU", 10.5, C.muted);

    s += label(14, 422, L.foot, 11, C.muted);
    return s + "</svg>";
  }

  root.K3KvLong = { svg };
})(typeof self !== "undefined" ? self : this);
