# DeepSeek-V4-Pro 部署设计方案

- 所有者：Model 团队（MODEL-01 manifest、MODEL-03 场景）
- 状态：`SHAPE_DERIVED_WITH_ASSUMPTIONS`。只有 `shape.reported` 中的字段来自公开报告，其余都是 ASSUMPTION（DeepSeek-V3/V3.2 维度）
- 形状来源：`formal_model_manifests.json#/models/2/shape`
- 推导：`teams/model/src/workload_derivation.js#deriveDeepSeek`（ADR-0006、ADR-0008）

## 1. 模型形状（摘要）

| 项 | 值 | 来源 |
|---|---|---|
| 总参数 / 激活参数 | 1.6T / 49B | 报告 |
| 层数 | 61；前 3 层 dense FFN（hidden 18432），其余 58 层 MoE | 报告 / ASSUMPTION |
| MoE | 384 routed expert，每 token 激活 6 个，1 个 shared expert | 报告 |
| expert hidden | 由激活参数反解，约 3841（点估计）；由总参数反解约 3300（变体） | 推导，见第 6 节 |
| hidden / heads | 7168 / 128 | 报告 |
| vocab | 129280，embedding 与 LM head 不共享 | ASSUMPTION |
| MLA | q LoRA rank 1536，KV latent 512，RoPE 64，qk nope 128，v head 128；decode 用吸收形式 | ASSUMPTION |
| indexer | 64 head × 128 维，top-k 2048，每层都有 | 报告（top-k）/ ASSUMPTION |

## 2. 并行与切分

- TP32、PP1、B=1、decode，context 1M；TP8/TP16 用例 `DeepSeek-V4-Pro-TP{8,16,32}-DECODE-1M`。
- context 和所有 expert（dense FFN、shared、routed）按 TP rank 切分；无 expert parallelism、无 all-to-all（ADR-0020，`DEPLOYMENT_DECISION`）。
- 每层 FFN/MoE 输出做一次 TP all-reduce。

## 3. 精度（dtypePolicy，ASSUMPTION）

| 部分 | dtype | 字节/参数 |
|---|---|---|
| attention、indexer、dense FFN、shared expert | FP8 | 1 |
| router、LM head | BF16（与 GLM-5.2 FP8 checkpoint 对齐） | 2 |
| routed expert | FP4，每 32 权重一个 8-bit scale（与 K3 MXFP4 相同） | 0.53125 |

## 4. KV 与 index 布局（ASSUMPTION）

- KV cache：FlashMLA FP8，656 B/token/layer，与 K3 相同。
- index key：FP8 128 维 + 1 个 FP32 scale，132 B/token/layer，每层都缓存（DeepSeek-V3.2 lightning indexer）。
- 稀疏注意力：attention 只读 top-k 2048 个 KV；indexer 读取全部已缓存的 index key。indexer 打分在 H tensor engine 上执行。

## 5. 集合通信（ASSUMPTION）

每层 4 次：indexer top-k 合并、稀疏注意力 LSE 合并、attention 输出 all-reduce、FFN/MoE 输出 all-reduce（shared 与 routed 合并）。
合计 61 × 4 = 244 次/token，按 K3 reference 口径计数，不含采样。消息为一个 BF16 hidden 向量的 ring all-reduce。

## 6. 形状歧义与 TPS 区间

在上述 ASSUMPTION 字段下，报告的 49B 激活与 1.6T 总参数不能同时成立：

- 点估计：expert hidden 由 49B 激活反解，隐含总参数约 1.86T（比报告值高 16%）；
- 变体 `expertHiddenFromTotal`：expert hidden 由 1.6T 总参数反解，隐含激活约 44.3B。

两者用同一套 slot 公式计算，TPS/usr 以区间报告（`planning_operator_workload.json#/variants`，scorecard 的 `shapeVariants`）。

## 7. MTP

MTP / speculative decode 不计入 TPS/usr：K3 详细模型中没有 MTP，接受率也未测量。

## 8. 未闭合项

- 需要厂商 config 确认形状（Q1-Q2 blocker，见 `out/governance/direction_feedback.json`）。
- dtype、KV/index 布局、每层集合通信次数均为 ASSUMPTION。
- token-time 系数只在 K3 上拟合，用于 DeepSeek-V4-Pro 是规划假设（ADR-0008）。
