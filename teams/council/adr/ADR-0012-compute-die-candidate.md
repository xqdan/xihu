# ADR-0012：Compute Die 候选

- 旧编号：ADR-004（原 `docs/design/DECISIONS.md`，2026-09-25 迁入独立文件；正文只把 ADR 引用改为新编号）
- 日期：2026-09-20（2026-09-23 补充频率口径）
- 决策：以 4 L Core + 4 H Core、1.2 GHz、44 MiB 数据 SRAM 作为**P1 compact executable** 细化起点。
- 状态：`MODEL`
- 说明：只有在 MC 和 tile 模型闭合后才能冻结。
- 频率口径：P1 compact executable 的频率和 Core 数由 Final Tuning 搜索决定，权威值在 `teams/hardware/inputs/k3_mc_baseline.json#computeDieCandidate`（02/03/05/09 号文档描述的是 2026-09-20 的 4 L + 4 H、1.2 GHz 候选）；P0 7R physical primary 的标称频率候选为 1.0 GHz（`teams/hardware/inputs/k3_7r_package_baseline.json`、12 号文档、AGENT_METRICS_MATRIX）。两者不是冲突，而是两个 profile；任何文档写频率时必须注明 profile。规划管线的 P0/P1 峰值算力统一由 `teams/hardware/src/resource_profiles.js` 从这两个 spec 推导。
- 2026-09-23 更新：修正 Final Tuning 模型（共享 SRAM 端口放大按面积/功耗计费、launch batching 只应用一次）后重新搜索，P1 最佳候选移动到 24 L + 8 H、1.0 GHz、88 MiB/Die，MC640 下约 859 TPS/usr、MC320 下约 534 TPS/usr。原 4 L + 4 H 候选的 998.81 TPS 不再复现，因为其中约 140 μs 的收益来自无成本的端口放大和重复的 launch 折扣。
