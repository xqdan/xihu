# GLM-5.2 部署设计方案

- 所有者：Model 团队（MODEL-01 manifest、MODEL-03 场景）
- 状态：`SHAPE_DERIVED_FROM_CONFIG`。形状字段来自公开 config；部署布局是 ASSUMPTION，TP-only 是部署决定
- 形状来源：`formal_model_manifests.json#/models/1/shape`（`config` 为公开字段，`assumptions` 为部署字段）
- 推导：`teams/model/src/workload_derivation.js#deriveGlm`（ADR-0007）

## 1. 模型形状（摘要，来自公开 config）

| 项 | 值 |
|---|---|
| 报告总参数 | 753B（含 1 层 MTP；推导值与报告值之比 1.0004） |
| 激活参数（推导） | 约 41.2B（不含 MTP） |
| 层数 | 78；前 3 层 dense FFN（hidden 12288），其余 75 层 MoE |
| MoE | 256 routed expert，每 token 激活 8 个，1 个 shared expert，expert hidden 2048 |
| hidden / vocab | 6144 / 154880，embedding 与 LM head 不共享 |
| MLA | 64 head，q LoRA rank 2048，KV latent 512，RoPE 64，qk nope 192，v head 256 |
| 稀疏注意力 indexer | 32 head × 128 维，top-k 2048；21 个 full indexer 层（0、1、2、6、10、…、74），其余 57 层为 shared |

## 2. 并行与切分

- TP32、PP1、B=1、decode，context 1M；TP8/TP16 用例 `GLM-5.2-TP{8,16,32}-DECODE-1M`。
- context 和所有 expert（dense FFN、shared、routed）按 TP rank 切分；无 expert parallelism、无 all-to-all（ADR-0020，`DEPLOYMENT_DECISION`）。
- 每层 FFN/MoE 输出做一次 TP all-reduce。

## 3. 精度（dtypePolicy，来自 GLM-5.2-FP8 quantization_config）

| 部分 | dtype | 字节/参数 |
|---|---|---|
| attention、indexer、dense FFN、shared 与 routed expert | FP8 E4M3，128×128 block scale | 1 |
| router、LM head | BF16 | 2 |
| embedding | BF16，按行查表，不计入每 token 字节 | — |
| 128×128 FP32 block scale | 忽略（约 0.02%） | — |

## 4. KV 与 index 布局（ASSUMPTION）

- KV cache：FlashMLA FP8，656 B/token/layer，与 K3 相同。HF 参考实现缓存的是 BF16，这是部署假设。
- index key：FP8 128 维 + 1 个 FP32 scale，132 B/token，只在 21 个 full indexer 层缓存。
- 稀疏注意力：每层只读 top-k 2048 个 KV；full 层在整段 context 上运行自己的 indexer，shared 层沿用上一个 full 层的 top-k
  （`modeling_glm_moe_dsa.py`：shared 层 `indexer = None`，复用 `prev_topk_indices`）。

## 5. 集合通信（ASSUMPTION）

| 层类型 | 次数/层 | 组成 |
|---|---|---|
| full indexer 层（21） | 4 | indexer top-k 合并、稀疏注意力 LSE 合并、attention 输出 all-reduce、FFN/MoE 输出 all-reduce |
| shared indexer 层（57） | 3 | 去掉 indexer top-k 合并 |

合计 21 × 4 + 57 × 3 = 255 次/token；消息为一个 BF16 hidden 向量（每 rank 2 × hidden × 2 B）的 ring all-reduce。

## 6. MTP

`num_nextn_predict_layers = 1` 只计入 753B 总参数；MTP / speculative decode 不计入 TPS/usr。

## 7. 未闭合项

- FP8 KV 布局、index key 字节数和每层集合通信次数都是 ASSUMPTION，需要确认的服务布局（Q1-Q2 blocker，见 `out/governance/direction_feedback.json`）。
- token-time 系数只在 K3 上拟合，用于 GLM-5.2 是规划假设（ADR-0008）。
