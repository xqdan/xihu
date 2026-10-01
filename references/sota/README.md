# 领域 SOTA 知识库（knowledge, not evidence）

本目录由 `integration/orchestration/design.learn.workflow.js` 一次性生成。它回答的问题只有一类：

> 这个领域的同行**通常怎么做**、那些"当作给定条件"的系数**通常取多少**。

## 它不是什么

**这些文件不是证据。** 证据必须能指向仓库内的 `文件路径:行号`，才能被主评审流程的三个视角（arithmetic / evidence-chain / basis-consistency）核验、并被改判。本目录的内容来自外部公开资料，没有仓库出处，因此：

- **不得作为任何 claim 的 `evidence` 字段的值**。claim 的 evidence 只能是 `path:line` 或 `UNVERIFIED`。
- **不得用来覆盖、修正或重算仓库里的任何基线数字**。
- 有冲突时，以仓库文件为准。

违反这三条会污染 ledger：一个没有出处的数字一旦被写成证据，三视角核验就失去着力点，整条证据链的可审计性随之失效。

## 它用来做什么

只有一个用途：**判断某个假设是否偏离行业常规，从而决定值不值得花力气去要实测数据。**

主流程的盲区正在这里。`τ=1.15`、MC 效率 `0.7`、UCIe `0.8` 这类系数既没有仓库出处（所以标 `UNVERIFIED`），也不知道离常规有多远（所以排不出取证优先级）。有了本目录，探针可以在 claim 的 `statement` 里写明"该取值偏离常规区间，值得优先取证"——但 `evidence` 仍然只能写 `UNVERIFIED`。

## 文件

7 个学习单元中的 5 个已落盘（各 `as_of: 2026-01`），其余 2 个单元在首次运行时被中断，尚无 `result`，
待用 `args.units` 单独重跑。

| 文件 | 状态 | 覆盖 |
|---|---|---|
| `sustained-tps.md` | ✅ 10 卡 | 端到端吞吐账与 SLO 口径：`TPS/usr` = 1/ITL 的口径分歧、`T_token ≈ N_param·b/8 / BW` 下界、batch=1 与 batch>1 的分野、MLPerf Server 场景 |
| `interconnect-collective.md` | ✅ 17 卡 | 互联、Die-to-Die 与集合通信：四层记账、UCIe flit 效率、MPE 50% 上限、ring vs hierarchical allreduce、overlap 失效条件 |
| `compute-core.md` | ✅ 11 卡 | AI Core、阵列利用率与片上存储：M=64 小 tile 折减、FP8 WGMMA 布局约束、roofline 与 ridge point、TPU 阵列尺寸 |
| `model-workload.md` | ✅ 14 卡 | MoE 推理的模型侧参数与量化：专家命中率 0.488→0.833、MLA 字节账、FP8/FP4 精度-吞吐权衡、DSA 稀疏化 |
| `memory-subsystem.md` | ✅ 14 卡 | 内存子系统与 MC 效率：sustained 折减的分层分母、命令混合、QoS |
| `evidence-governance.md` | ⏳ 待跑 | 门槛设定、余量与证据分级方法学 |
| `package-ppa.md` | ⏳ 待跑 | 封装、面积、功耗与热 |

每个文件里的「未解（UNVERIFIED）」一节列出了该领域查不到、只能靠实测或向供应商确认的部分。取数时先读那一节，再决定要不要花力气。

## 刷新

知识会过期（HBM 代际、互联标准、MoE 结构都在变）。每个单元带 `review_due_months`（默认 12 个月）与 `as_of`。刷新时只重跑需要更新的单元：

```js
Workflow({scriptPath: '.../design.learn.workflow.js', args: {as_of: '2026-10-01', units: ['memory-subsystem']}})
```

`as_of` 必须由 `args` 传入——workflow 脚本里取不到当前时间（`Date.now()` 会破坏 resume），拿不到就写 `UNVERIFIED` 而不是猜一个日期。

## 可信度标记

每条知识带 `confidence`：

- `public_measurement`：论文或第三方实测
- `vendor_datasheet`：厂商数据表（注意厂商口径通常偏乐观）
- `industry_survey`：行业调研/标准组织材料
- `model_memory`：**没有可核查来源，仅凭模型记忆**——这类条目在合成阶段被隔离剔除，不进正文

只有 `model_memory` 的条目会被列入 `quarantined` 并说明剔除原因。这是防止模型记忆被当成行业事实的关键一步：宁可条目少，也不能让"我以为业界是这样"混进参照系。

## 强制字段

每条必须写 `not_applicable_when`：这条知识在什么条件下不适用于本项目（拓扑/规模/精度/负载类型/代际差异）。**写不出边界的条目不收。** 没有适用边界的参照系会被当成万能类比——比如把 batch=64 的吞吐优化直接套到 B=1 的 decode 场景上——那比没有参照系更糟。
