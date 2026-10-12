# SRAM Attribution Contract

版本：`sram-attribution-v0.1`

`out/attribution/sram_card.json` 的 `tradeoffStudies` 是 SRAM 侧的规划探索结果。它回答三种不同问题，三者不能合并成一个“SRAM 效率”数字：

| 模式 | 固定项 | 可变项 | 结论口径 |
|---|---|---|---|
| 单项敏感度 | 其他硬件、软件和模型参数 | 一个 SRAM / TMA / mapping 参数 | 该参数一阶邻域的 TPS、时延、面积和功耗变化 |
| `FIXED_DIE_AREA_REPLACEMENT` | 发布点 die 面积上限 | 一个 SRAM 侧参数 + 一个算力/通信参数 | 候选 `dieArea <= published die area` 时的替代结果；未使用的离散面积余量不隐式分配 |
| `SOFTWARE_RESCHEDULE` | SRAM 改动及其他硬件参数 | `kvTile`、`headTile`、`depth` | 现有调度自由度能恢复多少 nominal / stress 结果；不添加软件收益假设 |

所有数值由 `integration/detailed/tps_attribution.js` 调用生产模型重放，证据等级为 `MODEL_WITH_ASSUMPTIONS`。候选不是新的设计空间，也不直接修改 baseline、candidate register 或 Gate。发布点为 K3 / TP32 / Batch=1 / 1M context / decode；其他模型没有此卡的详细 SRAM replay 时必须保持 `BLOCKED_CONFIG` 或 `UNCORROBORATED`。

固定面积模式要求两个资源一增一减，只接受名义 die 面积不超过当前设计点的候选；双方同时缩减不算替代。面积、功耗和 TPS 仍分别保留，不能用面积节省抵销卡功耗或 package 约束。联合设计点的固定 Comm Core 面积不在该详细模型面积中（卡的 `caveats` 明示），比较只针对模型包含的可变部分，并非完整 floorplan 签核。

软件重调度只复用模型已经定义的 `kvTile`、`headTile`、`depth`，不得把调度变化解释为额外利用率、精度变化或 silicon measurement。其压力重放固定联合悲观参数中的硬件利用率、预测和 launch 假设，但保留每个候选的 mapping，不沿用标准 stress 卡强制固定的 `kvTile`。`bestNominal` 与 `bestStress` 是分别优化的两种配置，不能拼成同一配置的收益；名义最优配置在压力下的结果应读取 `bestNominal.stress`。

`tradeoffStudies.provenance` 记录模型版本、形状来源 hash、commit、runId、seed、profile 和单位；`inputs.sourceArtifacts` 钉住实现及合同。runner 拒收缺失或过期来源。全部调度候选及固定面积被拒候选的原因均保留，硬约束不成立时不补性能数字。原 `parameters` 行分类、联合悲观卡和 Gate 计算保持独立。

重新生成：`npm run attribution:cards`。验证：`node tests/regression/test_tps_attribution.js`。规划估算、validated replay 和 silicon observation 必须在后续产物中继续分开。
