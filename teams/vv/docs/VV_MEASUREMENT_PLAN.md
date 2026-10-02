# 未测量参数的测量计划

- 所有者：V&V（计划与判定）；执行：各归口团队
- 状态：**计划**——全部 14 项尚未开始
- 权威来源：[`VV_PLAN.md`](VV_PLAN.md) §1（证据等级）、
  `docs/architecture/DESIGN_EVIDENCE_MATRIX.md` §2（风险排序）、
  `docs/architecture/DESIGN_TARGETS_AND_MARGINS.md` §2（指标线）

## 0. 本文解决什么

`VV_PLAN.md` §1 定义了一句话：**升级证据等级只能靠新的产物，不能靠改标签。**
`DESIGN_EVIDENCE_MATRIX.md` §2 排出了 12 类未测量输入的优先级。
但"要测量"不是计划——没有方法、没有完成定义、没有验收线。

本文为每一项给出：**怎么测、测到什么算完、达到什么值才算通过**。
验收线直接取自 `DESIGN_TARGETS_AND_MARGINS.md` 的**下达指标**，不另立标准。

## 1. 计划总表

| # | 参数 | 测什么 | 方法 | 完成定义 | 验收线 | 归口 |
| ---: | --- | --- | --- | --- | --- | --- |
| 1 | `matrixUtil` / `vectorUtil` | 阵列利用率 | RTL 周期模型或综合后微基准 | 覆盖率 ≥ 90% 的 kernel 路径 | ≥ 0.60 / ≥ 0.30 | HW-02 |
| 2 | 软件机制 10 项 | 各机制实际收益 | kernel + 调度器 trace | 10 项各有独立 trace 证据 | 每项收益 ≥ 模型值 | SW-01/02/03 |
| 3 | `unpackParamsPerLaneCycle` | 每 lane 每周期解包参数 | 微基准（合成 kernel） | L core kernel 时长实测 | ≥ 1.5 | HW-02 |
| 4 | 专家预测命中率 | 预测准确率 | 真实 prompt 分布的路由统计 | ≥ 3 类负载统计 | ≥ 0.75 | SW-06 / HW-02 |
| 5 | `mcUtil` | MC 持续效率 | MC 原型或供应商持续带宽 | 长稳态测量（非峰值） | ≥ 0.68 | HW-04 |
| 6 | `layoutImbalance` | SRAM 形状不均衡 | memory compiler 实际宏 | 全 SRAM 实例统计 | ≤ 1.30 | HW-03 |
| 7 | 冷板/VRM 建模 | 散热与供电损耗 | 热仿真 + VRM 选型 | 见 `HARDWARE_POWER_BUDGET.md` §2 | §2 合计 ≤ 55.125 W | Package/Power |
| 8 | FP8 KV cache 精度 | 精度影响 | 见 `PRECISION_POLICY.md` §6 | 精度验收通过 | 见 §6 | Workload |
| 9 | FP8 dense 精度 | 精度影响 | 同上 | 同上 | 同上 | Workload |
| 10 | SF4 面积/密度系数 | 实际缩放 | SRAM compiler + MAC 宏 | 见 `HARDWARE_11_FLOORPLAN_AREA.md` §4 | Die ≤ 400 mm² | HW-01 |
| 11 | 规划 token-time 系数 | 样本外偏差 | 用详细模型核对非标定点 | 至少 2 个额外详细点 | 偏差 ≤ 10% | Model |
| 12 | GLM/DS 部署布局 | 逐模型详细点 | 建立详细模型点 | 每模型 ≥ 1 个 `MODEL_OBSERVED` 点 | 与规划偏差 ≤ 15% | Model |
| 13 | τ = 1.15 µs | 物理推导 | 拓扑 + PHY 推导（B-004/B-005） | 推导文档 + 余量分析 | ≥ 1.15，每次余量 ≥ 0.201 µs | Comm/PHY |
| 14 | MC 640 GB/s | 可制造规格 | 供应商规格或替代架构 | 规格书 | 见 `04_MEMORY_SUBSYSTEM_MC.md` | Memory MC |

## 2. 优先级与顺序

`DESIGN_EVIDENCE_MATRIX.md` §2 的风险排序决定了执行顺序。前四项是**瓶颈**：

1. **#5 `mcUtil`**——盈亏点 0.63 离发布值 0.70 只有 0.07，是最薄的一条；
2. **#13 τ**——决定 53% 的 raw 预算，没有物理推导；
3. **#14 MC 带宽**——`BLOCKER`，决定发布点能否成立；
4. **#2 软件机制**——10 项机制全部是 `MODEL` 且无 trace。

**#2 的特殊性**：它不是一个数，是十个机制的集合。`GAIN` 全部为 1（B-003）意味着模型**没有**给这些机制任何经验收益，
所以风险不在"收益被高估"，而在"机制本身在当前硬件上不可实现"——
比如 TMA 独立端口是否真实存在（O-007）、4096-bit NoC link 是否可布线（O-003）。
**#2 的完成定义因此是"每个机制有独立 trace 且被证明可实现"，不是"总时长对得上"。**

## 3. 完成的判定

每一项的完成必须产生：

1. **产物**（`out/` 下，带 `inputHash` 与 runId）；
2. **证据等级跃迁**：`ASSUMPTION` → `MODEL_OBSERVED`（`VV_PLAN.md` §1 的规则）；
3. **同步更新**：`DESIGN_EVIDENCE_MATRIX.md` §1/§2、`DESIGN_TARGETS_AND_MARGINS.md` §2；
4. **回归**：`npm test` 全绿，且 `test_integration_freshness.js` 通过。

## 4. 与 Q-Gate 的关系

`VV_PLAN.md` §4：Q-Gate 要求 **18 个观测槽位**（3 模型 × TP8/16/32 × MC320/640）全部为
`MODEL_OBSERVED` / `SILICON_OBSERVED`，当前 18/18 是 `PLANNING_ESTIMATE`。

本文的 14 项**不是** Q-Gate 的槽位。关系是：

- 本文关闭的是**详细模型输入**的不确定性；
- Q-Gate 关闭的是**逐槽位可比性**；
- 前者是后者的前提——输入未测，18 个槽位即使升级也只是把 `ASSUMPTION` 换了个标签。

## 5. 未开始

**本文件中 14 项全部未开始。** 这是当前项目最大的结构性风险：
发布点 1101.77 是一个 `MODEL` 等级的**点估计**，它成立的前提是一组未测量的输入同时取乐观值，
而联合悲观点（906.51）已经跌破目标（`PRODUCT_REQUIREMENTS.md` §0）。

换句话说：**今天没有一条路径能把 1101.77 变成可信结论，除了本文这 14 项。**
