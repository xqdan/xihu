# ADR-0018：7-reticle 单芯片物理边界

- 旧编号：ADR-010（原 `docs/design/DECISIONS.md`，2026-09-25 迁入独立文件；正文只把 ADR 引用改为新编号）
- 日期：2026-09-21
- 决策：将一个 7-reticle advanced package 定义为单芯片系统边界；包含 8 个 Compute Die、16 个 Memory Cube、package-local fabric、collective 和 scale-out endpoint。一个 package 是一个 TP rank，32 个 package 构成 TP32。
- 状态：`BASELINE`
- 物理主候选：8×400 mm² Compute Die、16×100 mm² MC、96 MiB data SRAM/Die、256 GB/package 优先容量档。
- 兼容模型：P1 compact executable profile 由 Final Tuning 搜索决定（`teams/hardware/inputs/k3_mc_baseline.json#computeDieCandidate`），仅作为可执行对照。
- 关闭条件：7R placement/bump/RDL、P0 tile/PPA model、MC payload 和 package thermal 通过联合签核。
