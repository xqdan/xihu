# 精度签核路径

- 所有者：V&V（判定）；共策：Workload（模型精度）、AI Core（硬件精度）
- 状态：**计划**——`PRECISION_POLICY.md` §6 已定义验收，本文补签核路径
- 权威来源：[`PRECISION_POLICY.md`](../../software/docs/PRECISION_POLICY.md) §2/§5/§6、
  `PRODUCT_REQUIREMENTS.md` FR-07、`OPEN_ISSUES.md` B-001 / O-012 / O-013 / O-014

## 0. 本文补的是哪一段

`PRECISION_POLICY.md` 已经说清了**三个模型用哪些 dtype、在哪里取整、怎么验收**。
缺的是：**验收在什么条件下才算通过、失败时降级到哪、降级对 TPS 的影响谁来算**。

精度是本项目**唯一一条能反向吃回 TPS 的依赖**：任何一处 dtype 保守化都会增加字节或 FLOP，
而发布点的余量只有 78.95 µs。所以本文的核心不是"精度怎么测"，而是
**"精度失败时谁承担代价、承担多少"**。

## 1. 待签核项

| 项 | 当前 | 风险 | 失败时的降级 | TPS 代价 |
| --- | --- | --- | --- | --- |
| KV cache FP8（FlashMLA 布局，计算仍 BF16） | `MODEL`（B-001） | 长上下文精度 | KV 转 BF16 | **不可行**（32768 tile + BF16 KV 放不下）；16384 tile 下为 1027.08 |
| dense 权重 BF16 | `MODEL`（O-012） | 无（保守） | — | — |
| dense 权重 FP8（条件路线） | 探索（O-020） | 精度待验 | 回退 BF16 | 回退即失去 1080.78（MC400） |
| routed expert MXFP4 | `MODEL` | 已是发布格式 | — | — |
| 1M KV/state 布局与精度 | `ASSUMPTION`（O-013） | 容量与精度 | 待定 | 待定 |
| LM Head 精度与分片 | `ASSUMPTION`（O-014） | 词表精度 | 待定 | 待定 |
| 累加 FP32 | `MODEL` | 无 | — | — |
| 集合通信精度 | 见 `PRECISION_POLICY.md` §3 | all-reduce 顺序影响 | — | — |

**注意第一行的代价栏**：KV cache 从 FP8 退回 BF16 **在发布配置下不可行**（不是变慢，是放不下）。
这意味着 KV cache FP8 不是"优化"，而是**基线成立的前提**。它的精度签核因此不是可选项——
`PRECISION_POLICY.md` §2.1 把它列在 `MODEL` 而不是 `BASELINE` 是诚实的，但也说明**发布点建立在一个未验收的精度决定上**。

## 2. 签核条件

| # | 条件 | 内容 |
| ---: | --- | --- |
| 1 | 验收指标 | 按 `PRECISION_POLICY.md` §6 定义的指标（困惑度/perplexity 类与任务类） |
| 2 | 负载覆盖 | 至少覆盖长上下文（接近 1M）、代码、多语言三类，且**必须含长上下文**——KV FP8 的风险集中在长上下文 |
| 3 | 基线对照 | 与全 BF16 的同模型跑同一批负载，差值必须可归因 |
| 4 | 确定性 | 签核必须同时验证 FR-08 逐位可重现（`PRECISION_POLICY.md` §5） |
| 5 | 分层判定 | 逐项（KV / dense / expert / LM head）分别签，**不得整包签**——失败时的降级路径不同 |
| 6 | 代价核算 | 每项失败时的 TPS/容量代价必须在签核报告里给出（用本文 §1 的表，超出的走变更评审） |

## 3. 与 TPS 基线的耦合（本文最要紧的一条）

精度签核不是独立的技术活动，它**直接决定哪些 TPS 数字可用**：

| 精度结论 | 可用的 TPS 结论 |
| --- | --- |
| KV FP8 通过 | 发布点 1101.77 可用 |
| KV FP8 不通过 | 发布点需改配置（BF16 KV + 16384 tile ⇒ 1027.08），**且 393 次集合通信账需重算** |
| FP8 dense 通过 | MC400 = 1080.78 可用，MC 档位可从 640 降到 400 |
| FP8 dense 不通过 | 只能用 BF16 路线，MC 档位压力回到 B-002 |
| 两个都不通过 | **联合悲观点无解**，必须走 Die 面积再分配（O-020） |

因此签核报告必须**明确写出允许引用哪些 TPS 数字**，而不是只给"通过/不通过"。

## 4. 流程

```
定义验收 → 跑负载 → 分层判定 → 写代价 → 更新证据等级 → 解锁对应的 TPS 结论
```

- 每一层通过后，`DESIGN_EVIDENCE_MATRIX.md` §1 的对应行（#7、#9）升高证据等级；
- `PRECISION_POLICY.md` §2 的 dtype 表状态同步更新；
- 若结论是"不通过"，走 §1 的降级路径，并同步更新
  `04_MEMORY_SUBSYSTEM_MC.md` §5.1.4（FP8 稠密条件路线）与 `OPEN_ISSUES.md` O-020。

## 5. 未闭合项

| 项 | 状态 | 责任 |
| --- | --- | --- |
| KV cache FP8 验收 | 未做（B-001） | Workload |
| dense FP8 验收 | 未做（O-012） | Workload |
| 1M KV/state 布局（O-013） | `ASSUMPTION` | Workload/Memory |
| LM Head（O-014） | `ASSUMPTION` | Workload/AI Core |
| 验收负载集与阈值 | `OPEN` | Workload + Council |
| 接受判据（MTP）的精度 | `OPEN` | 见 `MTP_SCHEDULING_CONTRACT.md` C-5 |
