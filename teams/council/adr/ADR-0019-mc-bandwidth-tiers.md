# ADR-0019：MC 带宽档位与规格网格

- 旧编号：ADR-011（原 `docs/design/DECISIONS.md`，2026-09-25 迁入独立文件；正文只把 ADR 引用改为新编号）
- 日期：2026-09-23
- 背景：`HIGH_LEVEL_ARCHITECTURE.md`（2026-09-22 版）引入了规格网格：MC 带宽档 320/400/480/560/640 GB/s/颗、默认搜索上限 1.5×320 = 480 GB/s、路线 A 观测点 32 颗 × 480 GB/s × 8 GB，以及"约 6 reticle 有源中介层"的图注。这些此前没有进入 ADR、`teams/hardware/inputs/k3_mc_baseline.json` 或 04 号文档。
- 决策：
  1. 320 GB/s/颗是参考基线（沿用 ADR-0017）；
  2. 480 GB/s/颗是默认搜索上限，超过它的档位在所有报告中标记为 `AGGRESSIVE`；
  3. 560 与 640 GB/s/颗保留在网格中，只能标为 `STRETCH/AGGRESSIVE`，供应商证据闭合前不得作为制造默认值；
  4. 路线 A（32 MC × 480 GB/s × 8 GB，384 MiB SRAM/卡）是 1M context 的算力下限观测点，不是帕累托选点，也不是签核规格；
  5. reticle 张数留在封装签核：7-reticle 是仓库的工程 placement window，规格页图注的约 6 reticle 是另一份材料的估计，两者共同锁定的只是 8 颗 Compute Die 加 UCIe 直连 MC（Die 面积见 ADR-0021）。
- 机器可读：`teams/hardware/inputs/k3_mc_baseline.json#bandwidthTiers`。
- 规格来源：`references/k3_1000tps_chip_designs.html`（已入库副本，原件来自工作区 `docs/1000tps/`）。
- 状态：`BASELINE`
- 影响：B-002 的表述改为"MC 档位未选定"，关闭证据是选定颗数与每颗带宽的供应商规格。
