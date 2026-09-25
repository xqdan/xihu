# 架构决策记录

## ADR-001：目标口径

- 日期：2026-09-20
- 决策：以 B=1、Context=1M、TP32、PP1、1000 TPS/usr 为主目标。
- 状态：`FROZEN`
- 备注：架构冻结门槛建议为 1050 TPS/usr，P99 不低于 1000。

## ADR-002：主存储路线

- 日期：2026-09-20
- 决策：本轮以外置 Memory Cube 为主线，MC 不承担 Tensor/GEMM。
- 状态：`BASELINE`
- 影响：近存计算 MC 文档保留为备选，不与主线性能数字混用。

## ADR-003：卡级组织

- 日期：2026-09-20
- 决策：8 Compute Die + 16 MC，每 Die 本地 2 MC；一张卡是一个 TP rank。
- 状态：`BASELINE`

## ADR-004：Compute Die 候选

- 日期：2026-09-20（2026-09-23 补充频率口径）
- 决策：以 4 L Core + 4 H Core、1.2 GHz、44 MiB 数据 SRAM 作为**P1 compact executable** 细化起点。
- 状态：`MODEL`
- 说明：只有在 MC 和 tile 模型闭合后才能冻结。
- 频率口径：P1 compact executable 的频率和 Core 数由 Final Tuning 搜索决定，权威值在 `spec/k3_mc_baseline.json#computeDieCandidate`（02/03/05/09 号文档描述的是 2026-09-20 的 4 L + 4 H、1.2 GHz 候选）；P0 7R physical primary 的标称频率候选为 1.0 GHz（`spec/k3_7r_package_baseline.json`、12 号文档、AGENT_METRICS_MATRIX）。两者不是冲突，而是两个 profile；任何文档写频率时必须注明 profile。规划管线的 P0/P1 峰值算力统一由 `models/planning/resource_profiles.js` 从这两个 spec 推导。
- 2026-09-23 更新：修正 Final Tuning 模型（共享 SRAM 端口放大按面积/功耗计费、launch batching 只应用一次）后重新搜索，P1 最佳候选移动到 24 L + 8 H、1.0 GHz、88 MiB/Die，MC640 下约 859 TPS/usr、MC320 下约 534 TPS/usr。原 4 L + 4 H 候选的 998.81 TPS 不再复现，因为其中约 140 μs 的收益来自无成本的端口放大和重复的 launch 折扣。

## ADR-005：SRAM 统计口径

- 日期：2026-09-20
- 决策：122.20 MiB peak 是整卡 Shared SRAM 工作窗口峰值，不是每 Die。
- 状态：`FROZEN`

## ADR-006：远端 SRAM 语义

- 日期：2026-09-20
- 决策：保留 write→visible→commit/ready→consume→ACK→release→epoch reuse。
- 状态：`BASELINE`

## ADR-007：LSE 归约

- 日期：2026-09-20
- 决策：使用 m/l/O online-softmax 语义，不允许按普通 sum 近似。
- 状态：`FROZEN`

## ADR-008：卡内拓扑

- 日期：2026-09-20
- 候选：4×2 mesh + 4+4 hierarchical reduce。
- 状态：`OPEN`
- 关闭条件：packet 模型、封装 floorplan 和 PPA 同时通过。

## ADR-009：MC 性能点

- 日期：2026-09-20
- 决策：320 GB/s/MC 是当前参考兼容点；640 GB/s/MC 只能标为 Stretch。
- 状态：`FROZEN`
- 影响：P1 的 MC640 Stretch 结果不能作为已实现承诺。

## ADR-010：7-reticle 单芯片物理边界

- 日期：2026-09-21
- 决策：将一个 7-reticle advanced package 定义为单芯片系统边界；包含 8 个 Compute Die、16 个 Memory Cube、package-local fabric、collective 和 scale-out endpoint。一个 package 是一个 TP rank，32 个 package 构成 TP32。
- 状态：`BASELINE`
- 物理主候选：8×400 mm² Compute Die、16×100 mm² MC、96 MiB data SRAM/Die、256 GB/package 优先容量档。
- 兼容模型：P1 compact executable profile 由 Final Tuning 搜索决定（`spec/k3_mc_baseline.json#computeDieCandidate`），仅作为可执行对照。
- 关闭条件：7R placement/bump/RDL、P0 tile/PPA model、MC payload 和 package thermal 通过联合签核。

## ADR-011：MC 带宽档位与规格网格

- 日期：2026-09-23
- 背景：`HIGH_LEVEL_ARCHITECTURE.md`（2026-09-22 版）引入了规格网格：MC 带宽档 320/400/480/560/640 GB/s/颗、默认搜索上限 1.5×320 = 480 GB/s、路线 A 观测点 32 颗 × 480 GB/s × 8 GB，以及"约 6 reticle 有源中介层"的图注。这些此前没有进入 ADR、`spec/k3_mc_baseline.json` 或 04 号文档。
- 决策：
  1. 320 GB/s/颗是参考基线（沿用 ADR-009）；
  2. 480 GB/s/颗是默认搜索上限，超过它的档位在所有报告中标记为 `AGGRESSIVE`；
  3. 560 与 640 GB/s/颗保留在网格中，只能标为 `STRETCH/AGGRESSIVE`，供应商证据闭合前不得作为制造默认值；
  4. 路线 A（32 MC × 480 GB/s × 8 GB，384 MiB SRAM/卡）是 1M context 的算力下限观测点，不是帕累托选点，也不是签核规格；
  5. reticle 张数留在封装签核：7-reticle 是仓库的工程 placement window，规格页图注的约 6 reticle 是另一份材料的估计，两者共同锁定的只是 8 颗约 400 mm² Compute Die 加 UCIe 直连 MC。
- 机器可读：`spec/k3_mc_baseline.json#bandwidthTiers`。
- 规格来源：`references/k3_1000tps_chip_designs.html`（已入库副本，原件来自工作区 `docs/1000tps/`）。
- 状态：`BASELINE`
- 影响：B-002 的表述改为"MC 档位未选定"，关闭证据是选定颗数与每颗带宽的供应商规格。

## ADR-012：TPS/usr 设计基线与变更控制

- 日期：2026-09-25
- 决策：支撑 TPS/usr 发布点的软硬件设计统一写入 [`21_TPS_DESIGN_BASELINE.md`](21_TPS_DESIGN_BASELINE.md)，数值来自 `spec/k3_mc_baseline.json#tpsDesign`（由 `npm run baseline:sync` 重算），`tests/test_tps_design_baseline.js` 强制一致；任何 OPT/GAIN/TECH/LIMITS/调度语义/搜索空间变更须同一次提交重新搜索、同步并更新文档 21。
- 详细记录：[decisions/ADR-0005-tps-design-baseline.md](decisions/ADR-0005-tps-design-baseline.md)
- 状态：`BASELINE`（按 ADR-0003 不得标为 `FROZEN`）

## ADR-013：规划 token 时间、DeepSeek-V4-Pro 推导工作负载与 GLM-5.2 BLOCKED_CONFIG

- 日期：2026-09-25
- 决策：
  1. 规划 TPS/usr 改为规划 token 时间：`raw = max(访存 × kMemory, 计算 × kCompute + 集合通信 × τ)`，再乘 1.17；kMemory/kCompute 在 K3 详细模型发布点（1101.77）上标定，MC320 做样本外核对；
  2. K3 规划 KV 按 FP8 FlashMLA 布局 656 B/token/层；
  3. DeepSeek-V4-Pro 由 manifest `shape` 推导，公布字段以外全部标 `ASSUMPTION`，不含 EP dispatch，MTP 不计入 TPS/usr；
  4. GLM-5.2 标 `BLOCKED_CONFIG`，不出 TPS、不参与排名；D-Gate 因此阻塞，Stage B 按 `EXPLORATORY_AFTER_BLOCKED_D_GATE` 运行；
  5. 旧 runner `models/detailed_run.js`、`models/direction/run_directional_tps.js` 已删除（先加抛错守卫，同日删除）。
- 详细记录：[decisions/ADR-0006-planning-token-time-and-blocked-glm.md](decisions/ADR-0006-planning-token-time-and-blocked-glm.md)
- 状态：`PLANNING_ESTIMATE`（不构成 D-Gate/Q-Gate 证据）；第 4 项由 ADR-014 取代

## ADR-014：GLM-5.2 工作负载改由公开 config 推导

- 日期：2026-09-25
- 决策：
  1. GLM-5.2 形状取公开 HF `config.json`（78 层、hidden 6144、256 专家 top-8、expert hidden 2048、MLA 64 头、indexer 32×128 top-k 2048，21 个 full indexer 层、57 个 shared 层复用上一 full 层的 top-k），写入 manifest `shape.config`；
  2. 部署布局（FP8 KV 656 B、索引键 132 B、无 EP、每层集合通信 full 4 / shared 3、MTP 不计入）写入 `shape.assumptions`，逐项标 `ASSUMPTION`；
  3. 含 MTP 总参数 753.3B 对公布 753B（1.0004），测试要求误差 < 0.5%；
  4. 三模型可比后 D-Gate 按现有规则为 `PASS`，Stage B 转 `PLANNING_QUANTIFICATION`，Q-Gate 仍阻塞。
- 详细记录：[decisions/ADR-0007-glm-5.2-config-derived-workload.md](decisions/ADR-0007-glm-5.2-config-derived-workload.md)
- 状态：`PLANNING_ESTIMATE`（不构成 Q-Gate 证据）
