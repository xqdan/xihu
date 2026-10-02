# ADR-0024：GLM-5.2 / DeepSeek-V4-Pro 的注意力按 context 分片，权重保持 1/TP，每层计一次 q all-gather

- 日期：2026-10-02
- 状态：`PROPOSED`（`ASSUMPTION` 等级；待 Software / Model owner 复核每层集合通信的构成）
- 变更控制：只改 manifest 的 `collectivesPerLayer`，不触及 K3 模型和搜索输入，所以只重跑 `npm run model:planning`（K3 的 `search:final`、`baseline:sync` 不受影响）

## 背景

两个模型的规划行把所有字节统一除以 TP，包括注意力和 indexer 的投影权重（GLM 12.9 GB，占稠密投影字节的 69%）。
manifest 同时声明稀疏注意力按 context 分片（indexer 必须如此，否则每个 rank 每 token 要读完整的索引键，GLM 约 2.9 GB）。
context 分片要求每个 rank 拿到全部 head 的 q，两条路：

1. 复制一部分注意力权重；
2. 权重按 head 分片，投影后做一次 q all-gather。

原先的每层集合通信（GLM full 层 4、shared 层 3，DeepSeek 4）是 indexer top-k 合并、LSE 合并、attention 输出 all-reduce、FFN/MoE 输出 all-reduce，没有 q 的广播，两条路的代价都不在账上。

## 决策

1. 选第 2 条：注意力权重保持 1/TP，每层多一次 q all-gather（indexer 的 q 在同一条消息里）。
2. GLM-5.2：full 层 5 次、shared 层 4 次，21 × 5 + 57 × 4 = 333 次/token（原 255）；DeepSeek-V4-Pro：每层 5 次，61 × 5 = 305 次/token（原 244）。
3. 消息字节仍按一个 BF16 hidden 向量计（GLM 的 q 约 74 KB），两者都低于 τ 对应的数据量，时间由次数 × τ 决定，字节取法不影响结果。

## 为什么不选复制权重

敏感度（`out/detailed/stage_b_planning_run_20260925.md`，TP32，P1）：复制 10% 的注意力权重，GLM 在 MC320 降到 981，低于 1000；全部复制，两个模型在两个 MC 上都远低于目标（GLM 193 / 386，DeepSeek 205 / 410）。

## 后果（TP32，P1）

| 模型 | MC | 变更前 | 变更后 |
| --- | --- | ---: | ---: |
| GLM-5.2 | MC640 | 2416.8（集合通信受限） | 1927.7（集合通信受限） |
| GLM-5.2 | MC320 | 1793.1 | 1793.1（内存受限，不变） |
| DeepSeek-V4-Pro | MC640 | 2299.3 | 1934.2（区间 1934.2–1947.7） |
| DeepSeek-V4-Pro | MC320 | 1855.4 | 1855.4（不变） |

- τ = 1.5 / 2.0 µs：GLM 1526.5 / 1176.6，DeepSeek 1557.9 / 1219.0，仍高于 1000。TP16/MC640：GLM 1779，DeepSeek 1660。
- 两个模型的名义值在所有槽位仍达标；选型规则的结论不变（最差的模型仍是 K3）。
- ADR-0006、ADR-0007、ADR-0008 里的 255 / 244 次和对应 TPS 是当时的记录，被本 ADR 修订；活文档（00、21 号、README、部署文档、COLLECTIVE_SCHEDULE、VV_PLAN）已同步。

## 口径差异（必须随结论一起读）

K3 的 reference-393 把 `Q / new-KV all-gather` 留作本地算子，不计入 393 次（ADR-0004，`countBasis`）；repo-510 计入它，K3 为 941.74 TPS/usr，低于 1000。
本 ADR 在 GLM/DeepSeek 一侧计入这次 all-gather，因此 K3 的 1102 与 GLM/DeepSeek 的 1928 / 1934 不在同一计数基础上，GLM/DeepSeek 这一侧更保守。
这是有意的：它们没有对应参考页的计数，保守取值不会让结论变乐观。若要统一口径，应在 ADR-0004 的层面处理，不在本 ADR 内。

## 未验证的部分

- 每层 5 次是 `ASSUMPTION`。q all-gather 与 indexer q 是否能合并为一条消息、是否能与前一步重叠，没有协议或时序模型支撑；若可重叠，TPS 会回到原值与本值之间。
- 没有 GLM/DeepSeek 的详细模型可以对账，数字属 `UNCORROBORATED`（doc 21 §6.2）。
- 没有建模的两项（见 doc 21 §6.3）：L 核上专家切片的 tile 填充，专家未命中取数在关键路径上的暴露。
