# ADR-0021：唯一硬件规格 P1

- 日期：2026-09-26
- 状态：`BASELINE`
- 取代：ADR-0012 的候选数值、ADR-0018 的"物理主候选"、ADR-0001/0002/0003/0007/0008 中的 P0 维度与 P0 候选

## 背景

仓库同时维护两份硬件规格：

| 规格 | 来源 | 内容 |
|---|---|---|
| P0 7R physical primary | `k3_7r_package_baseline.json`、硬件 12 号文档 | 8 L + 8 H/Die、96 MiB、400 mm²、250 W，未经 Final Tuning 搜索 |
| P1 | `k3_mc_baseline.json#computeDieCandidate` | Final Tuning 搜索得到的发布点 |

两份规格带来了几个问题：

- 规划矩阵翻倍为 36 行；
- Gate 需要 `p0P1Separated`、`p0P1DistinctResources` 两项检查；
- 文档里的频率、Core 数和 SRAM 须逐处注明 profile；
- 发布点（1101.77 TPS/usr）只在 P1 上算过，P0 没有详细模型结果，却与 P1 并列为正式候选。

同时，Final Tuning 之前的搜索（architecture search、B1-1000 search、RDMA/SRAM search）及其报告只记录了已被取代的候选。它们的数字仍被文档引用，与当前的 TPS 计算过程对不上。

## 决策

1. **只有一份硬件规格。**
   - 硬件规格为 P1，权威值在 `teams/hardware/inputs/k3_mc_baseline.json`：
     - `computeDieCandidate`：8 L + 4 H/Die、40 MiB 数据 SRAM、1.0 GHz、373.71 mm²；
     - `package`：7-reticle placement window 5,248 mm²；
     - `card`：8 Die + 16 MC。
   - 封装面积 = 8 × Die 面积 + 16 × 100 mm²（MC 规划值），必须在 placement window 内，当前为 4,589.71 mm²。
   - P0 规格（`k3_7r_package_baseline.json`）与硬件 12 号文档删除。
2. **规划矩阵收敛为 18 行。**
   - 维度：3 模型 × TP8/16/32 × MC320/640，共 6 个候选槽位。
   - 正式候选为 `P1-compact-MC640-TP32`，MC320 参考为 `P1-compact-MC320-TP32`。
   - `teams/hardware/src/resource_profiles.js` 只从 spec 文件推导 P1 的 core-class 峰值。
3. **Gate 检查改名。**
   - Q-Gate 的 `singleHardwareSpec` 取代 `p0P1Separated` / `p0P1DistinctResources`。
   - 该检查要求：
     - `availableResources` 只有一个 profile；
     - L/H/V 资源的 `source` 都是 spec 文件；
     - 每行 ledger 都落在这个 profile 上。
   - D-Gate 的 `areaConservation` 改为：Die 面积 ≤ 400 mm²，且封装面积 ≤ placement window。
4. **删除旧搜索产物，保留依赖代码。**
   - 删除以下内容：
     - Final Tuning 之前的结果 JSON 与 HTML 报告（`out/search/`、`out/sram/`、`out/rdma/` 下除 final tuning 外的文件）；
     - 这些报告的生成脚本与模板；
     - 只守护这些结果的回归测试；
     - 描述旧候选的软件策略文档。
   - Final Tuning 依赖的模块保留：
     - `k3_architecture_search.js`（`A.*`）；
     - `k3_operator_sram_sim.js`；
     - `k3_sram_memory_rdma_model.js`；
     - `k3_physical_basis.js`。
   - 旧搜索留下的起点候选冻结在 `k3_rdma_final_tuning_search.js` 的 `PRIOR_SEEDS` 中。`npm run search:final` 仍复现 1101.77 TPS/usr。
5. **文档只写当前计算过程。**
   - 性能口径有两条：
     - 详细模型发布点：`docs/architecture/21_TPS_DESIGN_BASELINE.md`，ADR-0005；
     - 规划 token 时间：ADR-0008。
   - 汇总在 `docs/architecture/00_CURRENT_STATE.md` 第 3 节。
   - 被取代的发布点数字不再出现在活文档中，来历只保留在 git 历史里。

## 后果

- 硬件规格变更只有一个入口：
  1. `npm run search:final`；
  2. `npm run baseline:sync`；
  3. `npm run model:planning`。
- `tests/regression/test_design_baseline.js` 强制 spec 与搜索结果一致。
- Stage B 有 18 个可比槽位，其中 11 个低于 1000。唯一的正式候选是 τ 条件候选：
  - 规划模型 τ ≤ 1.41 µs；
  - 详细模型 τ 约 1.35 µs（B-008）。
- 失去一个"更大 Die"的对照点。如果需要再比较 400 mm²/96 MiB 这类规格，应作为 Final Tuning 搜索空间的变更提出，并有自己的 ADR，而不是恢复第二份手写规格。
- `archive/` 与 2026-09-26 之前的提交中仍有 P0 字样，按本 ADR 解读。
