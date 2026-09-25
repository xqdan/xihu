# ADR-0001: D-Gate 阻塞时只允许探索性 Stage B TP Sweep

- 日期：2026-09-21
- 状态：Accepted；已失效（D-Gate 已通过，Stage B 为 `PLANNING_QUANTIFICATION`，见 ADR-0007；P0 规格已由 ADR-0021 删除）
- 适用范围：当时的 P0 规格、MC320、TP8/TP16/TP32

## 背景

Stage A 的三模型正式配置、敏感性分析和候选聚合证据尚未闭环，因此 D-Gate 不能通过。与此同时，需要尽早暴露 K3 的算术强度、Roofline、计算与带宽 sizing 风险。

## 决策

允许执行一个明确标记为 `EXPLORATORY_AFTER_BLOCKED_D_GATE` 的 Stage B TP sweep：

```text
<P0>-MC320-TP8 / TP16 / TP32（P0 规格已删除，见 ADR-0021）
```

该 sweep：

1. 只能生成 planning ledger、风险和 blocker；
2. 不得声称候选已由 D-Gate 正式选中；
3. 不得输出 Q8 signed-off fine TPS；
4. GLM-5.2 和 DeepSeek-V4-Pro 在 manifest 冻结前保持 `BLOCKED_CONFIG`；
5. 必须从 `out/governance/candidate_register.json` 读取候选，禁止在 Stage B runner 中硬编码；
6. 必须由独立 gate validator 重新计算 D-Gate 和 Q-Gate。

## 后果

- Stage B 可以提前验证模型结构和资源守恒，但不能用于架构冻结。
- D-Gate 通过后，需要创建新的 ADR，将正式候选写入 candidate register。
- 该 sweep 的任何结果都不能外推到 MC640、其他规格或未冻结模型。
