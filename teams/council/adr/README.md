# 架构决策记录（ADR）索引

每条决策一个文件：`ADR-NNNN-<slug>.md`，编号连续、不复用。新决策取下一个编号，用 `teams/council/adr/` 下的文件记录；
被取代的决策保留原文，在状态行写明被哪条 ADR 取代。

2026-09-25 之前，短编号 `ADR-001`…`ADR-016` 记录在 `docs/design/DECISIONS.md`，与长编号文件 `ADR-0001`…`ADR-0008`
并存，两套编号互相冲突。现在统一为四位编号：DECISIONS.md 中有独立长文件的条目（旧 012/013/014/016）直接对应已有文件，
其余条目迁为 `ADR-0009`…`ADR-0020`。仓库活文件中的引用已改为新编号；`archive/` 与旧提交中的 `ADR-0NN` 按下表“旧编号”列解读。

| 编号 | 旧编号 | 决策 | 日期 | 状态 |
|---|---|---|---|---|
| [ADR-0001](ADR-0001-exploratory-stage-b-tp-sweep.md) | — | D-Gate 阻塞时只允许探索性 Stage B TP Sweep | 2026-09-21 | Accepted；已失效（D-Gate 已通过） |
| [ADR-0002](ADR-0002-formal-manifest-and-sensitivity-closure.md) | — | Formal planning manifest and sensitivity closure | 2026-09-22 | Accepted for architecture planning |
| [ADR-0003](ADR-0003-planning-evidence-boundary.md) | — | Planning estimates are not event replay acceptance | 2026-09-22 | accepted for repository modeling governance |
| [ADR-0004](ADR-0004-collective-tau-basis-and-count-basis.md) | — | Collective-count basis and the per-collective cost basis (τ) | 2026-09-25 | accepted for repository modeling governance |
| [ADR-0005](ADR-0005-tps-design-baseline.md) | ADR-012 | TPS/usr design baseline and its change control | 2026-09-25 | accepted for repository modeling governance |
| [ADR-0006](ADR-0006-planning-token-time-and-blocked-glm.md) | ADR-013 | Planning token time, derived DeepSeek-V4-Pro workload, and GLM-5.2 BLOCKED_CONFIG | 2026-09-25 | accepted for repository modeling governance; decision 5 superseded by ADR-0007; decision 2 calibration superseded by ADR-0008 |
| [ADR-0007](ADR-0007-glm-5.2-config-derived-workload.md) | ADR-014 | GLM-5.2 planning workload derived from the public config | 2026-09-25 | accepted for repository modeling governance; supersedes ADR-0006 decision 5. |
| [ADR-0008](ADR-0008-split-token-time-calibration.md) | ADR-016 | Split token-time calibration, τ sensitivity, dtype policy and target-gated selection | 2026-09-25 | accepted for repository modeling governance; supersedes the calibration of ADR-0006 decision 2 and ADR-0007 decision 5 |
| [ADR-0009](ADR-0009-target-metric.md) | ADR-001 | 目标口径 | 2026-09-20 | `FROZEN` |
| [ADR-0010](ADR-0010-main-memory-route.md) | ADR-002 | 主存储路线 | 2026-09-20 | `BASELINE` |
| [ADR-0011](ADR-0011-card-organization.md) | ADR-003 | 卡级组织 | 2026-09-20 | `BASELINE` |
| [ADR-0012](ADR-0012-compute-die-candidate.md) | ADR-004 | Compute Die 候选 | 2026-09-20（2026-09-23 补充） | `MODEL`；数值被 ADR-0005、ADR-0021 取代 |
| [ADR-0013](ADR-0013-sram-accounting-basis.md) | ADR-005 | SRAM 统计口径 | 2026-09-20 | `FROZEN` |
| [ADR-0014](ADR-0014-remote-sram-semantics.md) | ADR-006 | 远端 SRAM 语义 | 2026-09-20 | `BASELINE` |
| [ADR-0015](ADR-0015-lse-reduction.md) | ADR-007 | LSE 归约 | 2026-09-20 | `FROZEN` |
| [ADR-0016](ADR-0016-in-card-topology.md) | ADR-008 | 卡内拓扑 | 2026-09-20 | `OPEN` |
| [ADR-0017](ADR-0017-mc-performance-point.md) | ADR-009 | MC 性能点 | 2026-09-20 | `FROZEN` |
| [ADR-0018](ADR-0018-7-reticle-package-boundary.md) | ADR-010 | 7-reticle 单芯片物理边界 | 2026-09-21 | `BASELINE`；物理主候选由 ADR-0021 修订 |
| [ADR-0019](ADR-0019-mc-bandwidth-tiers.md) | ADR-011 | MC 带宽档位与规格网格 | 2026-09-23 | `BASELINE` |
| [ADR-0020](ADR-0020-tp-only-ffn-moe.md) | ADR-015 | 三个模型的 FFN/MoE 均按 TP 部署，不用 EP | 2026-09-25 | `DEPLOYMENT_DECISION` |
| [ADR-0021](ADR-0021-single-hardware-spec.md) | — | 唯一硬件规格 P1；删除 P0 规格与旧搜索产物 | 2026-09-26 | `BASELINE` |
