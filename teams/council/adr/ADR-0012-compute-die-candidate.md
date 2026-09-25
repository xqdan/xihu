# ADR-0012：Compute Die 候选

- 旧编号：ADR-004（原 `docs/design/DECISIONS.md`，2026-09-25 迁入独立文件；正文只把 ADR 引用改为新编号）
- 日期：2026-09-20（2026-09-23 补充频率口径）
- 决策：以 4 L Core + 4 H Core、1.2 GHz、44 MiB 数据 SRAM 作为**P1 compact executable** 细化起点。
- 状态：`MODEL`；候选数值已被 ADR-0005（发布点设计基线）与 ADR-0021（唯一硬件规格 P1）取代
- 说明：只有在 MC 和 tile 模型闭合后才能冻结。
- 当前口径：Compute Die 的 Core 数、engine 形状与 SRAM 由 Final Tuning 搜索决定，频率固定 1.0 GHz（ADR-0005），权威值在 `teams/hardware/inputs/k3_mc_baseline.json#computeDieCandidate`：8 L + 4 H/Die、40 MiB 数据 SRAM、373.71 mm²。本条最初的 4 L + 4 H、1.2 GHz、44 MiB 起点只作为决策来历保留。
