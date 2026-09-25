# ADR-0018：7-reticle 单芯片物理边界

- 旧编号：ADR-010（原 `docs/design/DECISIONS.md`，2026-09-25 迁入独立文件；正文只把 ADR 引用改为新编号）
- 日期：2026-09-21
- 决策：将一个 7-reticle advanced package 定义为单芯片系统边界；包含 8 个 Compute Die、16 个 Memory Cube、package-local fabric、collective 和 scale-out endpoint。一个 package 是一个 TP rank，32 个 package 构成 TP32。
- 状态：`BASELINE`
- 规格（ADR-0021 修订）：唯一硬件规格 P1，8 颗 Compute Die（Final Tuning 搜索决定，`teams/hardware/inputs/k3_mc_baseline.json#computeDieCandidate`）+ 16×100 mm² MC（规划值）；封装面积 = 8 × Die 面积 + 1600 mm²，须在 5,248 mm² placement window 内（`k3_mc_baseline.json#package`）。原 8×400 mm²、96 MiB/Die 的物理主候选已删除。
- 关闭条件：7R placement/bump/RDL、P1 tile/PPA model、MC payload 和 package thermal 通过联合签核。
