# model-workload — MoE 推理的模型侧参数与量化

> **本文件是知识，不是证据。** 内容全部来自外部公开资料，没有仓库内出处，不得作为任何 claim 的 `evidence`，不得用来覆盖、修正或重算仓库里的任何基线数字。
> 用途只有一个：判断某个假设是否偏离行业常规，从而决定值不值得花力气去要实测数据。

## 0. 覆盖范围与口径

- **as_of：2026-01。** 本文件只收录 2026 年 1 月及以前公开发布、可核查链接的资料。公开资料里更新的材料本文件不覆盖，见 §5。
- **与已有文件的关系：** `references/sota/` 下此前只有 `README.md`，没有任何领域文件（无 `memory-subsystem.md` / `model-workload.md` 等）。因此本文件**不沿用任何已有内容**，全部为本次调研新增。`README.md` 中列出的 7 个单元文件目前均未生成。
- `premises` 原样引用自 workflow 脚本：`专家命中率 0.8、activeParams、FP8 KV`。本文件不对这些取值做任何判断、修正或重算。
- 本文件不含任何端到端 TPS 推导。看到的所有数字都是**外部同类问题的实测/声明值**，不是本项目的取值。
- 可信度分级沿用 `README.md`：`public_measurement` / `vendor_datasheet` / `industry_survey` / `model_memory`。

## 1. 专家命中率：公开实测区间

### 1.1 经典基线：频率法（frequency baseline）

上一代通行做法是**按全局频率排名取前 k 个专家预取**，不看当前 token 的隐状态。这是判断"0.8 类假设是否保守/激进"的下界参照。

一篇 IEEE 期刊的实测给出：模型每层至多选 6 个专家时，"Top-6 命中率"数值上等价于专家命中率。朴素频率基线在五个领域（Business / Code / Science / Math / Creative）的命中率为 **0.438 / 0.497 / 0.495 / 0.529 / 0.481，宏平均 0.488**；换成局部性感知预测后升到 **0.797 / 0.803 / 0.842 / 0.898 / 0.827，宏平均 0.833**（来源年份未能确认，见 §5）。该文另称 Top-6 预取策略的平均 set recall 约 83%，相对全量加载只增加约 4% 的 prefill 延迟。

**读法：** 频率基线落在 **0.44–0.53**，局部性感知预测落在 **0.80–0.90**。两代做法的差距约 0.3–0.4，而不是线性提升。

### 1.2 命中率沿深度是非均匀的

同一份实测的进一步结论：**命中率在首尾层显著下降、在中段最高**。对 Qwen3-30B-A3B，层间漂移集中在前两层，之后漂移可忽略，`recall@k` 平均约 **90%**；GPT-OSS 系列漂移更明显，尤其首尾层需要额外的轻量估计器才能把命中率拉回。

**读法：** 公开资料几乎没有"整模型单一命中率"的实测——报出来的都是 per-layer 曲线。任何把命中率写成单值的假设，都隐含了对层间分布的某种平均。

### 1.3 命中率在时间轴上有强局部性

对 DeepSeek Sparse Attention 的 top-k 选择做逐 decode step 跟踪的工程实测显示：**相邻 decode step 的 top-k 集合重合度通常达到 80%–90%**，因此每步只有不到 20% 的 cache 需要新载入。该性质被用来做增量传输（集合差分 kernel）。

**注意边界：** 这条的观测对象是 attention 的 top-k token 选择，不是 MoE 的专家路由。两者都有时间局部性，但不要直接互推。

### 1.4 预取比例：全量预取反而更慢

上一代"预测几个就取几个"的做法有一个反直觉的实测结论。一份实测用 DeepSeek 模型 + Wikitext 给出 *GoodPrefetch* 分数：

| 预取策略 | GoodPrefetch | 端到端 |
|---|---|---|
| top-1/2（只取一半） | 86.06% | 加速 |
| top-3/6 | 93.40% | 加速 |
| top-2/2、top-4/4、top-6/6（全取） | ≤77.52% | **变慢** |

即：预测精度不是越高越好，**过度预取本身会吃掉带宽**。

另一条来自 SpecMD（2026-02，超出本文件 as_of）方向的思路是引入 overfetch 因子（OLMoE k=8 时预取 12 个），显式用精度换 recall——本文件不展开。

### 1.5 预测错取的代价与恢复路径

- **恢复路径有两条**：把专家权重搬到计算侧，或把激活搬到权重侧（compute-near-weights）。两者保语义一致，差别在传输量、占用设备和同步延迟位置。这属于"miss recovery 是一个联合调度决策"这一代认知。
- **错取直接落在 critical path 上**：预取只有在预测的专家在用到之前到达时才隐藏延迟；miss 会触发逐出 + 同步加载。
- **投机执行有精度风险**：有实测显示，让 draft 模型只走 top-2 而非 top-6 专家时，GSM8K 精度从 **46.34% 掉到 34.76%**；而如果每个 draft token 都做验证，加速会消失甚至为负。
- **offload 场景下的量化结论**：profiling Qwen1.5-MoE-A2.7B 与 DeepSeek-V2-Lite 显示 offload 开销可**超过**实际计算时间，留给"传输与专家计算 overlap"的空间很有限；在某 FPGA 平台的 profiling 中，**专家取数占 MoE 推理总执行时间的约 88%**。

**读法：** 这些实测的硬件前提几乎全是"单卡显存装不下全部专家、专家权重在 host memory"的资源受限场景。它们的命中率对延迟的敏感度远高于专家权重常驻场景。

## 2. activeParams、路由分布与吞吐

### 2.1 active/total 比例：公开的几档

| 模型 | total | active/token | 比例 |
|---|---|---|---|
| DeepSeek-V3 | 671B | 37B | 约 1:18（5.5%） |
| Mixtral 8x7B | 约 47B | 约 12.9B | 约 27% |
| DeepSeek-V2 / V2.5 | 236B | 21B | 约 1:11 |

来源：DeepSeek-V3 官方 README（2024-12）；NVIDIA 技术博客对 Mixtral 8x7B 的逐层核算（该文特别纠正了"8x7B = 56B"的读法错误，指出实际是 47B、单 token 走 12.9B 参数）。

### 2.2 关键结论：MoE 省算力，不省容量

NVIDIA 那篇的原话意思是：**稀疏 MoE 相比同等规模的稠密模型，用更少的 compute、但同样的 memory capacity。** 训练时因为 token 成批，几乎所有专家都会被用到；推理时每个 token 只走一小部分。

同一逻辑的另一处表述（2025 年的综述性材料）：671B 的 DeepSeek-V3 即使在 FP8 下也占 **超过 670 GB**，而每 token 只激活 37B。

**读法：** 这是"activeParams 决定 compute、totalParams 决定 footprint"这条通用认识的最直接来源。任何把 activeParams 当作显存需求的做法，在公开资料里找不到对应先例。

### 2.3 路由不均衡如何放大开销

`MoE-GPS`（arXiv:2506.07366，2025）给出一个被广泛借用的量化口径：

- **skewness** = 最热门专家收到的 token 数 ÷ 完全均衡时每专家平均 token 数。
- 该文举例：最热专家吃掉 75% 的 token、共 4 个专家时，skewness = 3。
- **FFN 计算时间按 skewness 线性放大**，因为瓶颈专家的耗时决定整体。
- **all-to-all 通信时间同样按 skewness 放大**：完全均衡（skewness=1）时每卡需搬走 (N−1)/N 的 token，坏情况下整体通信时间正比于 (N−1)·skewness/N²。
- 该文以 Mixtral 8x7B 为基准，明确假设 attention 用 TP、FFN 用 EP；理由是 EP 相比 TP 把通信延迟降低约 N 倍，且避免把每个专家的权重切成更窄的矩阵而降低 Tensor Core 利用率。

同一篇还给了两条方法论上的取舍结论：

- **Distribution-Only 预测**（只预测专家的 token 数量分布，用于放置/复制专家）在低偏斜或通信不是瓶颈时更优——它复杂度低、无额外开销。
- **Token-to-Expert 预测**（预测具体哪些 token 走哪个专家）在偏斜高、或互联带宽低（如 PCIe）时才开始占优。

### 2.4 路由熵：另一套"路由分布"的读法

- **Mixtral-8x7B-Instruct**（E=8, top-2, λ_aux≈0.001）：per-token 路由熵 **H_token = 2.23 bits，约为理论最大值 log2(8)=3.0 bits 的 74.3%**。层间变化：浅层约 80%、深层约 65%；per-layer std **0.28–0.60 bits**。作者的解释是"聚合后看着均衡，是因为不同 token 各自特化、平均掉了"。
- **gpt-oss-20b**（λ_aux=0.9，比 Mixtral 大两三个数量级）：全层熵 **>82%**，作者称之为 **over-dispersed（过分散）**，并给出一条软阈值：`H̄ > 0.85·log2(E)` 可用来识别"全局重要性信号开始失效"的区间（Mixtral 74.3% 可靠，gpt-oss 90.8% 不可靠，两者间隔约 11 个百分点）。
- 该文还给出 **λ_aux 的典型量级：Mixtral 与 Switch Transformer 约 0.001–0.01，gpt-oss 为 0.9**。

**读法：** 路由分布是不是"均衡"，取决于路由器的正则化强度。同一族架构在 λ_aux 差两个数量级时，专家可预测性完全不同。这条对"命中率"类假设有直接含义。

辅助证据（AdaMoE, EMNLP Findings 2024）：Mixtral-8x7B 在 SocialIQA 上，**路由分布的尖锐程度 per-token 差异很大**——有些 token 概率集中到单一专家，也有相当比例的 token 把概率摊到 2 个以上专家。该文由此论证固定 top-k 不是最优，并在 ARC-Challenge 上取得 **FLOPs 减少 14.5%、精度上升 1.69%**。

## 3. KV cache 与权重的实际开销

### 3.1 MLA：压缩"每个 token 存多宽"

DeepSeek-V2/V3 用 MLA（Multi-head Latent Attention）替代标准 MHA/GQA 的 KV 缓存。官方 README 的说法是 MLA 用于"高效推理"。

工程侧的直接对比（对 GLM-5 代理配置的实测，bf16 prefill，13 层）：

| prompt tokens | 缓存展开 K/V | 缓存压缩 latent |
|---|---|---|
| 2048 | 0.406 GiB | 0.029 GiB |
| 4096 | 0.812 GiB | （同比例） |

即每 token 每层从 `64 × (256 + 256) = 32768` 个值降到 `512 + 64 = 576` 个值，约 **1/57**。代价是每个 decode step 都要把缓存的 latent 重新投影回 K/V（多一次 `kv_b_proj`）。DeepSeek-V3 自始就接受这个 trade-off。

**注意：** 这条实测来自 2026 年 9 月的一份框架 PR（超出本文件 as_of），我用它只是因为它是唯一给出"展开 vs latent"逐 token 数字的公开来源；数值本身与 V3 起就确立的 MLA 设计一致。来源列在卡片里并标了年份，请按"超出 as_of"对待。

### 3.2 KV 量化的容量比

SGLang 官方文档给出的相对 BF16 的有效容量（**已计入 block scaling factor 的开销**）：

| 格式 | 等效 token 容量 |
|---|---|
| BF16 | 1.00× |
| FP8 | **约 2.00×** |
| FP4 | **约 3.56×** |

注意 FP4 的 3.56× 明显低于"位宽减 4 倍"的 4.0×——差额就是 scaling factor。文档同时说明 E4M3 比 E5M2 精度更好、动态范围更小（±240 vs ±57344），推荐 E4M3。

**这条是框架厂商自述**，不是第三方实测。

### 3.3 低位 KV 的精度失效模式

SGLang 文档的实测表（`public_measurement` 性质的框架自测，非独立第三方）：

| 模型 | 数据集 | BF16 | FP8 E4M3 | FP4 E2M1 |
|---|---|---|---|---|
| Qwen3-235B-A22B | gsm8k | 0.9168 | 0.9181 | 0.9186 |
| Qwen3-235B-A22B | aime25 | 0.7733 | 0.7333 | **0.6000** |
| Qwen3-235B-A22B | gpqa_diamond | 0.7010 | 0.6899 | 0.6778 |
| DeepSeek-R1-0528 | gsm8k | 0.9157 | 0.9154 | 0.9124 |
| DeepSeek-R1-0528 | aime25 | 0.5067 | 0.4934 | **0.4000** |
| DeepSeek-R1-0528 | gpqa_diamond | 0.7707 | 0.7697 | 0.7273 |
| GPT-OSS-120B | aime25 | 0.7533 | 0.7667 | **0.3533** |
| GPT-OSS-120B | gpqa_diamond | 0.5081 | 0.5434 | 0.3202 |

该文档给出的三条定性结论：

1. **简单数据集（gsm8k 一类）上 FP4 与 FP8/BF16 接近**；
2. **模型越大越能容忍 FP4**（200B+ 比小模型稳）；
3. **上下文越长，量化误差累积越明显**。

跨来源的补充证据（vLLM 博客 2026-05，超出 as_of）：在 256k 上下文的 Qwen3-30B-A3B 上 BF16/FP8 在标准差内一致（45.8% / 43.1%），但 3-bit 类 KV 掉到 31.2%（相对退化约 30%），且**退化集中在 128k–256k 段**；该文明确归因为"低位 KV 的量化误差随序列长度累积"。同文另有一条重要的口径区分：**FP8 KV 会连注意力计算本身一起量化**（Qwen/Key/Value 都用 FP8 且 QK、ScoreV 都在 FP8 下算），而纯存储压缩类方案只压存储、计算前要反量化，后者实测带来 10%–68% 的额外延迟。这个区分对本项目的 FP8 KV 假设很重要。

### 3.4 FP8 的累加精度问题（长 K 维必踩）

DeepSeek-V3 技术报告（arXiv:2412.19437，2024-12）在训练侧记录了一个硬件级现象：**Hopper 的 FP8 Tensor Core 名义上累加到 FP32，但当收缩维（K 维）很大时，中间累加会丢精度**（报告 Fig. 7(b)）。V3 的应对是 tile-wise / block-wise 分组量化 + 提高累加精度。

vLLM 博客（2026-04，超出 as_of）把它外推到了推理：长上下文 decode 时，`Softmax(AttnScore) × V` 的收缩维就是上下文长度，因此**同一个累加精度问题会在长上下文注意力上重演**——某 128k 大海捞针任务上 FP8 从 BF16 的 91% 掉到 13%，加两级累加后恢复到 89%；代价是寄存器压力，**head_dim=256 时 prefill 的 TTFT 反而比 BF16 慢**。

**读法：** "FP8 KV 只是省一半内存"这个理解在公开资料里站不住——它同时改动了注意力的数值路径，且失效点在长 K 维，即长上下文。

### 3.5 MoE 权重精度

- **DeepSeek-V3 的 FP8 混合精度训练框架**：FP8 覆盖 attention / MLP / MoE，BF16 保留参数更新与权重，FP32 用于梯度累积与全局标量；官方称同等 GPU 数下训练时间减少约 30%。这确立了"大规模 MoE 权重可以用 FP8"的可行性先例。
- **MoE 权重的 4-bit 趋势**：DeepSeek-V4 用 MXFP4 存 MoE 权重（该信息来自 2026-04 之后的材料，超出本文件 as_of，仅作方向性提示，不列入卡片）。
- **量化误差的次级后果**：一份 2026-01 的 RL rollout 实测（arXiv:2601.18150）把 FP8 量化的影响讲得比较直白——**FP8 量化引入的误差会加大训练分布与推理分布之间的偏离**，该文建议 FP8 rollout 必须搭配 token-level importance sampling 之类的 mismatch 修正，并给出 KV cache FP8 校准时训练侧重新标定的开销约为整个 step 时间的 **2%–3%**。

## 4. 1M 级长上下文的 KV 管理与稀疏化

### 4.1 学习式 token 级稀疏：DSA

DeepSeek-V3.2（arXiv:2512.02556，2025-12；架构层面可引用的来源）的 **DeepSeek Sparse Attention (DSA)** 由两个部件构成：

- **lightning indexer**：一个低秩的多头 query 分支 + 单头共享的 indexer key，打分 `I(t,s) = Σ_j w_j · ReLU(q_j · k_s)`；
- **Top-k Selector**：从缓存里挑出 k 个位置交给核心注意力。

核心注意力是 **MQA mode 的 MLA**（不是 MHA）。这个组合有一个不太直观但重要的后果：**MLA 的 latent 本来就被所有 head 共享，因此 token 级选择自动满足访存稀疏，不需要再做 blockwise 的组内聚合**。这与前一代 NSA 的"必须做成 blockwise 才能对齐硬件"形成了明确分歧，而 DeepSeek 在出货模型里选了 token 级。

**k 的取值**：发布代码里 `top_k = 2048`。

V3.2 与 V3.2-Exp 的关系（报告原文口径）：**架构完全相同，唯一的架构改动是通过 continued training 引入 DSA。** V3.2-Exp 的技术报告只发布在 GitHub 上，没有 arXiv entry；架构层面引用 2512.02556。

**分层代价：** 这类方案对短上下文 prefill 不友好——稀疏选择本身引入了不在成熟 dense kernel 路径上的算子，短 prefill 阶段的性能更依赖 kernel 成熟度，而长上下文 decode 直接受益于 KV 缩小。

### 4.2 时间局部性与增量传输

前面 §1.3 提到的"相邻 decode step 的 top-k 重合度 80%–90%"在工程上被这样用：

- GPU 端维护一个容量为 top-k 的 **2–4 倍**的 LRU buffer（典型 **4K–8K token**），吸收 top-k 的短期波动；
- 集合差分 kernel 只搬 Δ（新增 token 的 latent cache）；
- 实测口径：**128K 长上下文推理的 GPU 显存占用从约 8GB 降到约 200MB**（latent cache 常驻 CPU、按需增量上卡）。

该来源同时指出一个容量-命中率的权衡：**buffer 只放大到 2K（等于 top-k）时长序列命中率显著下降、I/O 成为瓶颈；扩到 4K–8K 才能以可控显存换回成倍 I/O 效率**。

### 4.3 经典方案（上一代通行做法）

判断"是不是落后了"的参照系在这里：

- **标准 MHA/GQA 全量 KV**：KV 随上下文线性增长，是长上下文显存与带宽的主要来源（通俗量化：Llama-3.1-70B 每 token KV 约 320KB，32K 上下文单序列约 10GB——二手博客口径，低可信度）。
- **滑动窗口 / 局部注意力**：把计算范围切掉，代价是失去全局感知。
- **固定稀疏模式**：人工设计稀疏模式跳过部分计算，模式是死的，不同任务信息分布差异大，泛化受限。
- **RAG**：绕开长文本本身，把问题转成检索质量。
- **MLA（V3, 2024-12）**：压缩每个 token 存多宽（§3.1）。
- **DSA（V3.2, 2025-12）**：改变读哪些位置（§4.1）。

## 5. 沿用、缺口与刷新

**沿用：** 无。`references/sota/` 下此前没有本领域文件。

**本文件** 没有覆盖但公开资料里存在、且值得下一轮补上的部分（见 `unresolved`）。

**刷新建议：** MoE 架构与 KV 量化方案的半衰期很短（见各卡片的 `relative_validity`）。建议按 `README.md` 的机制只重跑本单元：`Workflow({scriptPath: '.../k3_agent_learning.workflow.js', args: {as_of: '<新日期>', units: ['model-workload']}})`。本文件刻意把 `as_of` 收在 2026-01，重跑时应由 `args.as_of` 显式给出新日期。

## 6. 知识卡

### SOTA-MODEL-01 MoE 专家命中率的经典基线（频率法）落在什么区间

- **approach**：frequency-baseline Top-k 预取（全局专家频率排名）
- **what_it_is**：上一代最通行的专家预取做法：统计每个专家在语料上的全局激活频率，按频率排序，每层固定预取前 k 个专家。不看当前 token 的隐状态，因此实现极简、几乎零额外算力，但无法捕捉 token 级特化。它等价于假设"专家受欢迎程度是静态的"。
- **who_uses_it**：资源受限的单机 MoE offload/缓存场景（专家权重放 host memory，按需上卡）的默认对照基线；学术论文里普遍作为 locality-aware 方法的 lower bound 出现。用于 Mixtral、OLMoE、DeepSeek-MoE 一类 top-2 到 top-6 路由的模型。
- **typical_numbers**：模型每层至多选 6 个专家时 Top-6 命中率即等于专家命中率。频率法在 Business/Code/Science/Math/Creative 五个领域的命中率分别为 0.438 / 0.497 / 0.495 / 0.529 / 0.481，宏平均 0.488（即 0.44–0.53 区间）。换成局部性感知预测后同表为 0.797 / 0.803 / 0.842 / 0.898 / 0.827，宏平均 0.833。条件：单卡或少量卡、专家权重不在显存常驻、逐层 top-k 预取。
- **applies_when**：需要判断一个专家命中率类系数是否偏离行业常规时，频率法给出的是**下界**参照：公开实测里朴素基线就在 0.44–0.53，任何高于 0.8 的假设都已经要求超出朴素基线的预测能力。也适用于评估"如果预测器退化成静态排名会掉多少"。
- **not_applicable_when**：该表实测于资源受限的 offload 场景（专家权重在 host memory、PCIe 传输在 critical path），命中率的收益通过节省传输体现。本项目 TP32 单芯片、专家权重若常驻（HBM/SRAM），命中率的收益路径完全不同（省的是 MC 读取而非 PCIe），这组数字不可直接搬运。此外该表的领域划分基于英文评测集，且模型是 Mixtral/OLMoE 一代（E=8 或 E=64、top-2 到 top-6），不能外推到 E=256 且 top-k 更大的架构。
- **project_premises**：专家命中率 0.8
- **what_to_check_here**：向 model 团队（`teams/model/docs/deployment/OPERATOR_LEDGER.md`）确认预测器退化到静态频率排名时的命中率是多少；要求 workload-operator 给出按层分解的命中率曲线而不是单一均值，对齐 `docs/architecture/21_TPS_DESIGN_BASELINE.md:262` 与 `:340` 里命中率 0.8 的记账方式；把这组 0.44–0.53 / 0.80–0.90 的两代区间写进 B-003 的取证请求，作为"0.8 落在哪一代做法上"的定位依据。
- **sources**：
  - IEEE（MoE 专家预测预取的 domain-wise 实测，Top-6 预取策略表 4），2025，https://ieeexplore.ieee.org/ielx8/6287639/11323511/11397596.pdf
  - fMoE: Fine-Grained Expert Offloading for Large Mixture-of-Experts Serving (相关工作中的 Mixtral-Offloading LRU + speculative prediction)，2025，https://ar5iv.labs.arxiv.org/html/2502.05370
- **confidence**：public_measurement
- **relative_validity**：约 2 年。预测器的实现手段（轻量神经估计器、跨层耦合）迭代很快，但"频率法基线在 0.5 附近"这个量级随 MoE 代际变化慢。IEEE 那篇的期刊卷号与年份未能从检索结果中确认，见 unresolved。

### SOTA-MODEL-02 局部性感知的专家预测命中率公开实测区间

- **approach**：locality-aware / hidden-state 驱动的专家预取（含跨层预测）
- **what_it_is**：用当前层的隐状态或准隐状态预测下一层会被路由到哪些专家，在计算还在进行时并行把专家权重搬进来。做法分三类：纯路由信号（当前层 router 输入）、准隐状态（带 default vector 的修正信号）、以及轻量神经估计器。关键取舍是预测精度与预取带宽开销的平衡，不是精度越高越好。
- **who_uses_it**：资源受限 MoE 推理（单卡/消费级 GPU + host memory，专家权重不在显存常驻），以及 GQA/MQA 与 MLA 混用的 MoE 架构。覆盖 Mixtral、OLMoE、Qwen3-30B-A3B、GPT-OSS、DeepSeek 系列。
- **typical_numbers**：命中率（recall@k，k = 激活专家数）：局部性感知方案 0.797–0.898，宏平均 0.833（五领域）。层间差异显著——Qwen3-30B-A3B 的漂移集中在前两层，之后 recall@k 平均约 90%；GPT-OSS 系列首尾层漂移大，需额外轻量估计器。实现收益：端到端 TPOT 相比 on-demand CPU 加载降低 5%–14%（跨多种硬件/模型配置）。预取比例上 top-1/2 得 86.06% GoodPrefetch，top-3/6 得 93.40%，而全取（top-k/k）最多 77.52% 且整体变慢。
- **applies_when**：评估"专家预测"这条优化路径的收益上限时：公开资料里做得好的方案在**中段层**能到 0.85–0.90，首尾层更低。可用它判断一个整模型单值命中率假设是落在"乐观上限"还是"保守中位"。也可用来论证"预测必须按层评估"。
- **not_applicable_when**：所有实测都在专家权重不常驻、传输在 critical path 的前提下取得，收益以延迟（TPOT）度量。本项目 B=1 decode 若权重常驻，命中率的收益体现为 MC/NoC 读流量减少，两者不可换算。此外这些模型的专家数（8–256）与 top-k（2–8）与本项目部署对象不同，层间漂移分布会随 E 和 top-k 变化。5%–14% 的 TPOT 收益是 PCIe 传输场景数字，与片内带宽受限场景无关。
- **project_premises**：专家命中率 0.8
- **what_to_check_here**：核 `docs/architecture/21_TPS_DESIGN_BASELINE.md:262` 的每 token 每 rank 预测取数 0.81 GB 与其中"错取 0.16 GB"是否隐含了单一命中率；要求 workload-operator 提供按 78 层（或其他实际层数）分解的命中率，指出首尾层的命中率通常低于中段。同时按 B-003（`docs/GETTING_STARTED.md:246`）把"runtime trace 回标"拆成"按层命中率"这一具体交付物。
- **sources**：
  - IEEE（locality-aware expert prediction，domain-wise accuracy 表 4），2025，https://ieeexplore.ieee.org/ielx8/6287639/11323511/11397596.pdf
  - Speculating Experts Accelerates Inference for Mixture-of-Experts（per-layer recall@k、准隐状态 vs 路由输入），2026，https://export.arxiv.org/pdf/2603.19289
  - GoodPrefetch 分数与 top-k/r 预取比例（ACM DOI 10.1145/3774904.3792218），2025，https://dl.acm.org/doi/pdf/10.1145/3774904.3792218
  - MoE-SpeQ: Speculative Quantized Decoding with Proactive Expert Prefetching，2025，https://arxiv.org/html/2511.14102v1
- **confidence**：public_measurement
- **relative_validity**：约 18 个月。命中率的量级（中段约 0.85–0.90、首尾层更低）较稳定，但具体数字随模型代际与 E/top-k 变化；预测器本身迭代很快。

### SOTA-MODEL-03 MoE 路由分布到底有多不均衡，以及不均衡如何放大 FFN 与 all-to-all

- **approach**：skewness 度量 + 逐 token 路由熵（含 over-dispersed 诊断）
- **what_it_is**：两套互补的量化口径。(1) skewness = 最热专家收到的 token 数 ÷ 完全均衡时每专家平均 token 数，直接刻画负载不均衡，因为瓶颈专家决定整体耗时。(2) 逐 token 路由熵 H = -Σ π_i log2 π_i，刻画路由分布是尖锐还是平坦；aggregate 看似均衡的模型，逐 token 可能是尖的。
- **who_uses_it**：做 expert placement / 冗余专家复制 / EP 负载均衡的系统工作（MoE-GPS、Prophet、FlexMoE、SE-MoE、FasterMoE 一系），以及做专家剪枝的模型侧工作。Mixtral-8x7B、DeepSeek-MoE-16b-chat、gpt-oss-20b 是主要被测对象。
- **typical_numbers**：skewness 示例：4 个专家、最热专家吃 75% token 时 skewness = 3。FFN 计算时间按 skewness 线性放大；all-to-all 通信时间正比于 (N−1)·skewness/N²（N = 设备数）；完全均衡（skewness=1）时每卡需搬走 (N−1)/N 的 token。路由熵：Mixtral-8x7B-Instruct（E=8, top-2, λ_aux≈0.001）H_token = 2.23 bits，为 log2(8)=3.0 bits 的 74.3%（浅层约 80%、深层约 65%，per-layer std 0.28–0.60 bits）；gpt-oss-20b（λ_aux=0.9）全层 >82%。过分散的软诊断阈值：H̄ > 0.85·log2(E)。λ_aux 典型量级：Mixtral / Switch Transformer 约 0.001–0.01。
- **applies_when**：判断"路由分布对吞吐的影响"这一命题时：公开资料的口径是**瓶颈专家决定整体**，且 FFN 计算与 all-to-all 都按 skewness 线性放大。也适用于评估"路由不均衡是否需要用推理时重均衡来吸收"。
- **not_applicable_when**：skewness 的放大模型假设 attention 用 TP、FFN 用 EP，且专家按 EP 分布到多卡；本项目 TP32/PP1 的并行方式不同，专家是否跨卡、all-to-all 是否出现在关键路径都需要单独确认，公式不可直接套用。路由熵的数字来自 E=8、top-2 的小专家池模型（Mixtral），E=256 级模型的熵上限与实测分布不同，不能按比例外推。
- **project_premises**：activeParams
- **what_to_check_here**：向 model 团队要部署对象（GLM-5.2 / DeepSeek-V4-Pro 一类）的**逐层逐专家**路由统计：最热专家占比、skewness、以及路由熵占 log2(E) 的比例。核对 `teams/model/docs/deployment/OPERATOR_LEDGER.md` 里 token-time 公式的 `expertReread` 项与 `docs/architecture/21_TPS_DESIGN_BASELINE.md:262` 的"错取 0.16 GB"是否假设了均衡路由；若假设均衡，需按 skewness 重算取数分布。
- **sources**：
  - MoE-GPS: Guidelines for Prediction Strategy for Dynamic Expert Duplication in MoE Load Balancing (arXiv:2506.07366)，2025，https://web3.arxiv.org/pdf/2506.07366
  - When Load-Balancing Goes Too Far: Expert Pruning in Over-Dispersed Mixture-of-Experts Models，2025，https://www.semanticscholar.org/reader/ab3f30b26f28334d1d023fb7b879430df6947a79
  - AdaMoE: Token-Adaptive Routing with Null Experts (Findings of EMNLP 2024)，2024，https://aclanthology.org/2024.findings-emnlp.361.pdf
- **confidence**：public_measurement
- **relative_validity**：约 2 年。skewness 的放大关系（FFN 与通信按 skewness 线性）是结构性结论，随代际变化慢；具体熵值随模型与 λ_aux 变化快。

### SOTA-MODEL-04 MoE 的 activeParams 与 totalParams 各自约束什么

- **approach**：active/total 解耦：active 决定 compute，total 决定 footprint
- **what_it_is**：MoE 的核心交易是：总参数量决定知识容量和显存/存储 footprint，每 token 激活参数量决定算力开销。NVIDIA 的核算明确指出，稀疏 MoE 相比同等规模的稠密模型**用更少的 compute、但同样的 memory capacity**——因为所有专家都必须驻留。DeepSeek-V3 的 671B/37B 把这套交易推到了公开模型的极值。
- **who_uses_it**：所有主流开源 MoE（Mixtral 8x7B、DeepSeek-V2/V2.5/V3、Qwen3-30B-A3B 一系）与围绕它们做容量规划的推理部署方。NVIDIA 的 MoE 架构博客是这套口径被最广泛引用的科普来源。
- **typical_numbers**：DeepSeek-V3：671B total / 37B active per token ≈ 1:18（5.5%），96 层 MoE，每层 256 路由专家 + 1 共享专家；FP8 下权重占 >670 GB。DeepSeek-V2 / V2.5：236B total / 21B active ≈ 1:11。Mixtral 8x7B：约 47B total / 约 12.9B active ≈ 27%（注意"8x7B=56B"是错的读法）。
- **applies_when**：核对任何把 activeParams 当容量用的表述时：公开资料的一致口径是**容量由 totalParams 决定**。适用于做权重 footprint、常驻比例、MC 容量档位这类推导的交叉检查。
- **not_applicable_when**：这些比例来自 2024–2025 一代开源模型（E=8 到 E=256）。若部署对象是更新代际或不同专家切分粒度（如更细的专家 + 更多激活数），比例会显著不同。另外该口径不涉及注意力部分的参数占比，对 MLA 类架构（注意力参数被低秩压缩）与 GQA 类架构，同样的 total 参数对应的 KV/权重切分不同。
- **project_premises**：activeParams
- **what_to_check_here**：取部署对象的资格矩阵里 activeParams / totalParams / expertHidden / moeLatent 各字段（`teams/council/docs/reviews/2026-09-26_K3_P1_FREEZE_GAP_REVIEW.md:313` 指出这些字段曾经缺失），核对权重 footprint 的推导是否用 totalParams 而非 activeParams；重算常驻权重比例时用 totalParams 作分母。
- **sources**：
  - Applying Mixture of Experts in LLM Architectures（NVIDIA 技术博客，含 12.9B/47B 的逐层核算），2023，https://developer.nvidia.com/blog/applying-mixture-of-experts-in-llm-architectures/
  - DeepSeek-V3 官方 README（671B total / 37B activated 对照表），2024，https://github.com/deepseek-ai/DeepSeek-V3/blob/main/README.md
  - DeepSeek-V3 Technical Report (arXiv:2412.19437)，2024，https://arxiv.org/abs/2412.19437
- **confidence**：public_measurement
- **relative_validity**：约 3 年。"active 决定 compute、total 决定 footprint"是结构性结论，几乎不会过期；具体的 active/total 比例随代际推进（趋势是比例越来越小）。

### SOTA-MODEL-05 负载均衡的几代做法：从辅助损失到推理时重均衡

- **approach**：aux-loss-free bias / 冗余专家复制 / 推理时 plug-and-play 重路由
- **what_it_is**：三代做法：(1) 训练期加 auxiliary balance loss（λ_aux 典型 0.001–0.01），代价是扰动主任务梯度；(2) DeepSeek-V3 的无辅助损失方案——给每个专家维护可学习 bias，按实际收到 token 数增减，bias 不走梯度只做流量调节；(3) 推理时重均衡——不改权重、不重训，直接按 gate 分数分布形态决定路由到最强者还是最闲者。
- **who_uses_it**：训练侧：DeepSeek-V2/V3 系列、Switch Transformer（λ_aux）。部署侧：DeepSeek-V3 的"冗余专家部署"、vLLM/SGLang 的 EP 负载均衡、以及 LASER 一类推理时路由器（被测于 Mixtral-8x7B 与 DeepSeek-MoE-16b-chat）。
- **typical_numbers**：λ_aux 典型值：Mixtral 与 Switch Transformer 约 0.001–0.01；gpt-oss-20b 为 0.9（过分散区间）。推理时重均衡的效果：LASER 在 Mixtral-8x7B 与 DeepSeek-MoE-16b-chat 上跨 ARC-Easy / ARC-Challenge / MMLU / GSM8K 四个数据集改善了负载均衡、降低延迟、提升吞吐，而精度变化可忽略；LASER 不需要重训或微调，只在 gate 之后、MoE 前向里插入。容量约束类的做法：Mixtral 上只丢弃 12% 的溢出 token 即可换来 85% 加速；Mixtral-8x7B-Instruct 上 Expanded Drop（把溢出 token 改路由到同卡低负载专家）平均性能 +0.2%、推理加速 1.85×（来源为 ICLR 2026，超出本文件 as_of，仅作方向提示）。
- **applies_when**：当路由不均衡被识别为吞吐风险时，公开资料里成本最低的一档是**推理时重均衡**（不改权重、不需重训），成本最高的是训练期辅助损失。可据此评估"用运行时手段吸收不均衡"这条路线在行业上的成熟度。
- **not_applicable_when**：推理时重路由改变了实际执行的专家集合，因此**改变了输出**——LASER 声称精度变化可忽略是在 Mixtral/DeepSeek-MoE-16b 这两代模型上的结论，对更新的、路由更平坦（熵更高）的架构未必成立（over-dispersed 区间下重要性信号本身会失效）。本项目若要求数值可复现（例如与参考实现逐 token 对齐），推理时重路由会引入不可忽略的分布偏移。容量丢弃类方案会直接丢 token，不适用于要求确定性输出的验收口径。
- **project_premises**：activeParams
- **what_to_check_here**：向 model 团队确认部署对象的 λ_aux 落在哪个区间（0.001–0.01 还是 0.9 量级），因为这直接决定路由熵与可预测性；向软件团队确认推理栈是否支持推理时重路由，以及它是否破坏与参考实现的逐 token 对齐（`teams/software/docs/COMPILER_RUNTIME_AND_FIRMWARE.md`）。
- **sources**：
  - DeepSeek-V3 官方 README（auxiliary-loss-free 负载均衡策略），2024，https://github.com/deepseek-ai/DeepSeek-V3/blob/main/README.md
  - LASER: From Score Distributions to Balance: Plug-and-Play Mixture-of-Experts Routing (arXiv:2510.03293)，2025，https://arxiv.org/abs/2510.03293
  - When Load-Balancing Goes Too Far（λ_aux 典型量级对照），2025，https://www.semanticscholar.org/reader/ab3f30b26f28334d1d023fb7b879430df6947a79
- **confidence**：public_measurement
- **relative_validity**：约 2 年。"无辅助损失 bias"与"推理时重均衡"两代做法在 2025 年已稳定下来，但重均衡的具体算法迭代快。

### SOTA-MODEL-06 MLA 如何压缩 KV cache 的"每 token 宽度"

- **approach**：Multi-head Latent Attention（缓存低秩 latent 而非展开的 K/V）
- **what_it_is**：MLA 把每层的 K/V 投影到一个低秩 latent 空间，KV cache 只存这个 latent（外加一个解耦的 RoPE 分量），推理时再把 latent 上投影回 K/V。它压缩的是"每个 token 每个 head 存多宽"，不改变缓存里的 token 条目数——这一条必须和序列轴压缩（CSA/HCA 一类）区分开。
- **who_uses_it**：DeepSeek-V2 起全系（V2/V2.5/V3/V3.2）的标准注意力；后续被 GLM-5 一系采纳。是大规模 MoE 部署里最主流的 KV 压缩手段。
- **typical_numbers**：对 GLM-5 代理配置（13 层、bf16 prefill、kv_lora_rank=512、qk_nope=192、qk_rope=64、v_head_dim=256，即每层 64 head）的实测：2048 token 时展开 K/V 缓存 0.406 GiB，改缓存 latent 后 0.029 GiB；4096 token 时 0.812 GiB 对同比例。逐 token 逐层从 64×(256+256)=32768 个值降到 512+64=576 个值，约 1/57。DeepSeek-V3 自始就接受这个 trade-off：代价是每个 decode step 要把缓存的 latent 重新投影回 K/V（多一次 kv_b_proj）。
- **applies_when**：核对"权重与 KV 的实际开销"时：MLA 是公开资料里 KV 压缩幅度最大、被最大规模部署验证过的一档，把"每 token 每层 KV 字节数"的整体量级判断锚在这里是合理的。也适用于判断"KV 容量规划是否必须假设展开形式"。
- **not_applicable_when**：MLA 的压缩比与 head 数、head_dim 强相关，不能跨架构搬运：128 head × 128 dim 与 64 head × 256 dim 恰好都得到 32768 的展开值，是巧合而非常数。若部署对象不用 MLA（用 GQA/MHA），这套压缩不成立。另外 MLA 需要模型训练时就采用该结构，不是推理期可开关的优化。
- **project_premises**：FP8 KV
- **what_to_check_here**：取部署对象的资格矩阵，确认 attention 类型是否为 MLA/DSA 以及 kv_lora_rank / qk_rope_head_dim 的实际取值；用这些字段重算"每 token 每层 KV 字节数"，并与 `docs/architecture/HIGH_LEVEL_ARCHITECTURE.md` 第 2 节里 shared SRAM 余量依赖 FP8 KV 的推导对齐（`k3_agent_learning.workflow.js` 的 compute-core 单元 premises 也引用了这一条）。
- **sources**：
  - transformers PR #48761 [DSA] Cache compressed MLA latents instead of expanded K/V（逐 token 缓存字节数与 2048/4096 token 的 GiB 实测），2026，https://github.com/huggingface/transformers/pull/48761
  - DeepSeek-V3 Technical Report / 官方 README（MLA 用于高效推理），2024，https://github.com/deepseek-ai/DeepSeek-V3/blob/main/README.md
- **confidence**：public_measurement
- **relative_validity**：约 3 年。MLA 的压缩机制稳定，但具体压缩比随架构的 head 配置变化，且该实测的年份晚于本文件 as_of。

### SOTA-MODEL-07 KV 量化能省多少容量（计入 scaling factor 后的真实值）

- **approach**：FP8 E4M3 / FP4 E2M1 KV 量化
- **what_it_is**：把 KV cache 用低位宽浮点存储。FP8 提供约 2 倍容量；FP4 提供约 3.56 倍——注意 3.56 明显低于"位宽减 4 倍"，差额来自 block-based scaling factor 的额外开销。E4M3 比 E5M2 精度好、动态范围小（±240 vs ±57344），是推荐档。更关键的是要区分两条路线：FP8 KV 会连注意力计算本身一起量化（QK 与 ScoreV 都在 FP8 下算），而纯存储压缩类方案只压存储、计算前要反量化，后者会带来额外延迟。
- **who_uses_it**：vLLM（--kv-cache-dtype fp8）、SGLang 一系推理框架的生产默认；长上下文与高并发服务的常规优化项。
- **typical_numbers**：相对 BF16 的等效可缓存 token 容量：BF16 1.00×、FP8 约 2.00×、FP4 约 3.56×（已计入 scaling factor）。E4M3 动态范围 ±240，E5M2 ±57344。注意这些是框架厂商自述口径，不是第三方实测。
- **applies_when**：做 KV 容量档位规划时，2.0× 是公开资料里"FP8 KV"被普遍接受的容量收益；若考虑更低位宽，需要按 3.56× 而非 4× 记账。也适用于纠正"位宽减半就容量翻倍"这类账面推导。
- **not_applicable_when**：2.0× 与 3.56× 是通用账面比，只有在 KV 确实是显存/容量瓶颈时才转化为收益；对短上下文或 sliding-window 占比较高的模型，收益会明显缩水（混合注意力模型里跳过 sliding-window 层往往更好）。这两个比值也不包含量化带来的精度代价与计算路径改动，不能用来单独支撑"FP8 KV 总收益 2 倍"的结论。
- **project_premises**：FP8 KV
- **what_to_check_here**：核 `docs/architecture/HIGH_LEVEL_ARCHITECTURE.md` 第 2 节与 `k3_agent_learning.workflow.js` 中 compute-core 单元的 "shared SRAM 余量依赖 FP8 KV" 是否按 2.0× 记账；确认部署对象的 attention 是全局注意力还是混合（含 sliding-window），因为后者会稀释 FP8 的收益；确认用的是 e4m3 而非 e5m2。
- **sources**：
  - SGLang 官方文档 Quantized KV Cache（容量比表、E4M3/E5M2 对照），2025，https://docs.sglang.io/docs/advanced_features/quantized_kv_cache.md
- **confidence**：vendor_datasheet
- **relative_validity**：约 2 年。位宽与 scaling factor 的账面关系稳定；具体的等效比值随量化方案（block size、是否含 indexer cache）变化。

### SOTA-MODEL-08 低位 KV 量化的精度失效模式

- **approach**：FP8/FP4 KV cache 的精度-吞吐权衡与失效条件
- **what_it_is**：KV 量化的精度损失不是均匀的，它有三个系统性规律：(1) 简单任务上低位宽几乎无损，复杂推理任务上掉得厉害；(2) 模型越大越能容忍；(3) 误差随上下文长度累积，长上下文是主要失效区。另有一条独立的失效模式在 FP8 的累加精度上（见单独条目）。
- **who_uses_it**：所有做 KV 量化的推理栈（vLLM、SGLang）与模型侧。被测模型集中在 Qwen3-235B-A22B、DeepSeek-R1-0528、GPT-OSS-120B 一档。
- **typical_numbers**：SGLang 官方表：Qwen3-235B-A22B 上 gsm8k 0.9168/0.9181/0.9186（BF16/FP8/FP4，几乎无差），但 aime25 从 0.7733(BF16) → 0.7333(FP8) → 0.6000(FP4)；DeepSeek-R1-0528 的 aime25 0.5067 → 0.4934 → 0.4000；GPT-OSS-120B 的 aime25 0.7533 → 0.7667 → 0.3533，gpqa_diamond 0.5081 → 0.5434 → 0.3202。更大参数模型（200B+）比小模型更能容忍 FP4。独立第三方口径（vLLM 2026-05，超出 as_of）：Qwen3-30B-A3B 在 256k 上下文下 BF16 45.8% / FP8 43.1% 在标准差内一致，3-bit 类掉到 31.2%（相对退化约 30%），退化集中在 128k–256k 段。同一文指出纯存储压缩类方案额外带来 10%–68% 的延迟（反量化开销随访问的 KV 量增长）。
- **applies_when**：评估 FP8 KV 是否"免费"时：在长上下文 + 复杂推理任务上，公开资料显示 FP8 一般仍在噪声内，但需要显式验证而不是默认；FP4 则是明显要按任务分档的。也适用于给精度验收设计分层测试（简单 vs 复杂任务、短 vs 长上下文）。
- **not_applicable_when**：表里的模型全是 100B+ 的推理向模型，且退化最严重的都是 aime25 这类高难数学推理；不能把"FP8 无损"外推到所有任务类型（长文档检索、多轮 agent 类任务的敏感性未被这张表覆盖）。表中没有 1M 级上下文的数据点——最长只到 256k，且退化在 128k 之后才显现，1M 处的外推没有实测支撑。
- **project_premises**：FP8 KV
- **what_to_check_here**：要求 V&V 团队在 1M 上下文长度上单独设 FP8 KV 的精度验收点（`teams/vv/docs/VV_PLAN.md`），因为公开数据的最长实测只到 256k 且退化集中在长端；向 model 团队索取部署对象在 1M 上下文下 FP8 KV 的 MRCR/长文检索类指标，而不是只看短上下文 benchmark。
- **sources**：
  - SGLang 官方文档 Quantized KV Cache（精度对照表与三条定性结论），2025，https://docs.sglang.io/docs/advanced_features/quantized_kv_cache.md
  - vLLM: A First Comprehensive Study of TurboQuant（长上下文精度退化集中区、反量化开销），2026，https://vllm.ai/blog/2026-05-11-turboquant
- **confidence**：vendor_datasheet
- **relative_validity**：约 18 个月。"FP8 在长上下文仍近似无损、4-bit 以下要在长上下文上单独验证"这个格局短期内稳定，但具体数字随模型代际与 kernel 实现快速变化。

### SOTA-MODEL-09 FP8 的累加精度问题在长上下文注意力上重演

- **approach**：两级累加 / 提高收缩维的累加精度
- **what_it_is**：FP8 Tensor Core 名义上把乘积累加到 FP32 寄存器，但当收缩维（K 维）很大时中间累加会丢精度。训练时这个收缩维是 GEMM 的 K；推理长上下文 decode 时，Softmax(AttnScore)×V 的收缩维就是上下文长度，于是同一个硬件级问题会直接表现为长上下文精度崩塌。缓解手段是把部分累加结果写进真正的 FP32 寄存器（两级累加），代价是寄存器压力。
- **who_uses_it**：DeepSeek-V3 训练时首次系统记录该现象；推理侧由 vLLM 的 FP8 Flash Attention 3 路径暴露并修复（flash-attention#104 默认开启两级累加）。所有在 Hopper 类硬件上用 FP8 做长上下文注意力的系统都会遇到。
- **typical_numbers**：DeepSeek-V3 技术报告 Fig. 7(b) 记录了 Hopper FP8 Tensor Core 在收缩维很大时累加精度丢失。推理侧实测（超出本文件 as_of）：某 128k 大海捞针任务上 FP8 准确率从 BF16 的 91% 掉到 13%，加两级累加后恢复到 89%。代价：head_dim=256 时 prefill 的 TTFT 二次项系数从 6.93e-07 升到 1.12e-06 ms/token²，即 prefill 反而比 BF16 慢约 1.6×；head_dim 64/128 则 prefill 与 decode 都能加速。B200 上该累加问题不存在，无需两级累加。
- **applies_when**：当 KV 精度决策涉及"注意力计算本身是否用 FP8"时：公开资料的结论是 FP8 注意力在长上下文上有真实的数值失效点，必须显式处理，而不是免费获得容量收益。这一条对 1M 级上下文尤其相关。
- **not_applicable_when**：该失效模式的具体表现依赖硬件代际——B200 上不需要两级累加，Hopper 上需要。本项目若用自研 AI Core 而非 NVIDIA Tensor Core，累加路径与寄存器压力完全由自身微架构决定，这些数字只能作为"这类问题存在"的证据，不能作为量级依据。此外 head_dim 大小是触发条件（256 明显更差），本项目部署对象的 head_dim 决定这条是否适用。
- **project_premises**：FP8 KV
- **what_to_check_here**：核 compute-core 单元要做的"SRAM 带宽随精度切换的变化"与本条的交集：向 AI Core 团队确认自研阵列的 FP8 累加路径是否支持长收缩维下的高精度累加，以及该路径的 SRAM/寄存器开销；在 `teams/vv/docs/VV_PLAN.md` 里为 1M 上下文下的 attention 数值行为单独设验收点。
- **sources**：
  - DeepSeek-V3 Technical Report（Fig. 7(b)，Hopper FP8 累加精度），2024，https://arxiv.org/abs/2412.19437
  - vLLM: The State of FP8 KV-Cache and Attention Quantization（128k 大海捞针 91%→13%→89%，TTFT 代价，B200 差异），2026，https://vllm.ai/blog/2026-04-22-fp8-kvcache
- **confidence**：public_measurement
- **relative_validity**：约 2 年，且在硬件代际切换时会失效（新一代 Tensor Core 可能不再需要两级累加）。

### SOTA-MODEL-10 MoE 权重精度的实际做法与量化的次级后果

- **approach**：FP8 混合精度（W8A8 + 高精度累加）+ 权重/激活分档
- **what_it_is**：DeepSeek-V3 确立的 FP8 混合精度框架：FP8 覆盖 attention/MLP/MoE 的矩阵乘，BF16 保留参数更新与权重副本，FP32 用于梯度累积与全局标量；配合 tile-wise / block-wise 分组量化与提高累加精度来维持稳定性。推理侧的对应做法是 W8A8 线性层 FP8，可选叠加 KV cache FP8。
- **who_uses_it**：DeepSeek 全系（V3 起）、以及所有基于 DeepSeek 架构做部署与 RL rollout 的框架（vLLM 0.11+、SGLang 0.55+ 默认启用 DeepGEMM 加速 FP8 GEMM）。
- **typical_numbers**：V3 官方口径：同等 GPU 数下训练时间减少约 30%，同时在 14.8T token、2.788M H800 GPU 小时上全程没有不可恢复的 loss 尖峰或回滚。量化误差的次级后果（arXiv:2601.18150，2026-01）：FP8 量化引入的误差会**加大训练分布与推理分布之间的偏离**，该文强烈建议 FP8 rollout 搭配 token-level importance sampling（TIS）一类 mismatch 修正；KV cache FP8 的 scale 重新标定开销约为整个 step 时间的 2%–3%。
- **applies_when**：当需要论证"大模型 MoE 权重用 FP8 是否可行"时：公开资料里有超大规模 MoE 全程 FP8 混合精度训练并稳定收敛的完整先例，推理侧 W8A8 也已是框架默认路径。也适用于提醒量化的次级后果（分布偏移）需要修正机制配套。
- **not_applicable_when**：V3 的 FP8 框架是针对 Hopper + Transformer Engine 设计的，且依赖 kernel 库（DeepGEMM）与特定 CUDA 版本；迁移到自研加速器时，分组量化粒度与累加精度的实现成本完全不同。2%–3% 的校准开销是 RL rollout 场景的口径，与纯推理服务无关。此外这条讲的是权重/激活精度，不等价于 KV 精度。
- **project_premises**：FP8 KV
- **what_to_check_here**：区分"权重要不要 FP8"与"KV 要不要 FP8"两个独立决策——本项目的给定条件是 FP8 KV，不自动蕴含权重 FP8。向 model 团队确认部署对象的权重精度（是否 MXFP4/FP8，是否有 per-block scale）以及量化格式对 kernel 的要求，据此校对 compute-core 单元的矩阵密度 3.2 假设所隐含的精度档。
- **sources**：
  - DeepSeek-V3 官方 README / Technical Report（FP8 混合精度训练框架与收益），2024，https://github.com/deepseek-ai/DeepSeek-V3/blob/main/README.md
  - verf: FP8 W8A8 Linear Rollout 与 KV Cache Quantization 配置（arXiv:2601.18150，训练-推理不匹配与 TIS 修正），2026，https://arxiv.org/pdf/2601.18150
  - DeepSeek-V3 Technical Report (arXiv:2412.19437)，2024，https://arxiv.org/abs/2412.19437
- **confidence**：public_measurement
- **relative_validity**：约 2 年。FP8 作为大模型权重精度已稳定；向 4-bit（MXFP4/NVFP4）迁移的窗口正在打开，重跑时应重点更新这一条。

### SOTA-MODEL-11 1M 级上下文的学习式 token 级稀疏（DSA）

- **approach**：lightning indexer + Top-k Selector，核心注意力用 MQA mode 的 MLA
- **what_it_is**：DeepSeek Sparse Attention：一个低秩多头 indexer query 分支配一个单头共享的 indexer key，算出 index score 后由 Top-k Selector 从缓存里挑 k 个位置交给核心注意力。核心注意力是 MQA-mode 的 MLA，不是 MHA。关键洞察是：MLA 的 latent 本来就被所有 head 共享，因此 token 级选择自动满足访存稀疏，不需要像 NSA 那样做 blockwise 的组内聚合。它改变的是"读哪些位置"，与 MLA 压缩"每个位置多宽"正交。
- **who_uses_it**：DeepSeek-V3.2（官方口径：与 V3.2-Exp 架构完全相同，唯一架构改动是通过 continued training 引入 DSA）；后续 GLM-5 一系采纳 DSA + MLA。是当前 1M 级上下文 MoE 的主流注意力方案。
- **typical_numbers**：发布代码里 top_k = 2048。V3.2-Exp 的技术报告只发布在 GitHub 上（无 arXiv entry）；架构层面可引用的来源是 arXiv:2512.02556，其 §2.1 明确 V3.2 与 V3.2-Exp 架构相同。分层性能特征：长上下文 decode 直接受益于 KV 缩小；短上下文 prefill 则会因为稀疏选择引入了不在成熟 dense kernel 路径上的算子（indexer 打分、压缩读）而更依赖 kernel 成熟度。
- **applies_when**：评估"1M 级上下文下 KV 怎么管"时：DSA 是公开资料里被出货模型验证过的 token 级稀疏方案，且它明确论证了在 MLA 的 MQA mode 下 token 级稀疏是可行的。适用于判断一个长上下文方案是"学习式稀疏"还是"固定模式"这一代际分野。
- **not_applicable_when**：DSA 需要模型在训练/继续训练阶段就引入 indexer，不是推理期可开关的优化；对未用 DSA 训练的模型不适用。top_k=2048 是特定模型的取值，随上下文长度与层数变化不成立。该方案的收益在长上下文 decode 上兑现，对短上下文或 prefill 为主的负载反而可能变慢。本项目 B=1 + 1M 上下文的组合与公开实测的 batch/concurrency 前提不同。
- **project_premises**：FP8 KV
- **what_to_check_here**：取部署对象的资格矩阵，确认 attention 是否为 DSA 类（含 indexer cache、index_topk、index_head_dim 等字段），以及是否有"第二个 KV cache"（DSA 每层额外维护 indexer cache，这会影响 KV 容量的记账口径）；把 indexer cache 的容量单独计入 KV 预算而不是漏掉。
- **sources**：
  - DeepSeek-V3.2 (arXiv:2512.02556)（DSA 架构与 V3.2/V3.2-Exp 架构相同的声明），2025，https://arxiv.org/abs/2512.02556
  - DeepSeek Sparse Attention（indexer/selector 与 top_k=2048 的代码口径整理），2025，https://sebastianraschka.com/llm-architecture-gallery/deepseek-sparse-attention/
  - llm-infra-atlas: sparse 路线（三）：DSA 与 MLA MQA mode 下的 token 级稀疏论证，2025，https://github.com/llm-infra-atlas/llm-infra-atlas.github.io/blob/main/docs/attention/mechanisms/05_sparse_dsa_frontier.md
- **confidence**：public_measurement
- **relative_validity**：约 12–18 个月。稀疏注意力方案在 2025–2026 更替很快（blockwise → token 级 → 序列轴压缩），这是本领域半衰期最短的一条。

### SOTA-MODEL-12 长上下文 KV 的时间局部性与增量传输

- **approach**：LRU 差分缓存 + 集合差分 kernel（只搬 Δ）
- **what_it_is**：长上下文 decode 时，每步被选中的 KV 位置在时间上有强局部性，于是可以只把"新增的"那部分 cache 搬上 GPU，已驻留的直接更新页表复用。GPU 侧维护容量为 top-k 的 2–4 倍的 LRU buffer 来吸收短期波动，超过容量才按 LRU 淘汰。这套做法把长上下文的 KV 压力从"全量常驻"变成"增量搬运"。
- **who_uses_it**：SGLang 的 Hierarchical Sparse Attention 路径（面向 DeepSeek DSA 的 offload 实现），以及 LMCache 一类的 KV 分层缓存。属于 128K–1M 级长上下文服务的工程标配。
- **typical_numbers**：相邻 decode step 的 top-k 集合重合度通常 **80%–90%**，因此每步理论上只需载入不到 20% 的新 cache。LRU buffer 容量：典型 **4K–8K token**（top-k 的 2–4 倍）；buffer 只放大到 2K（等于 top-k）时长序列命中率显著下降、I/O 成为瓶颈。实测口径：128K 长上下文推理的 GPU 显存占用从约 8GB 降到约 200MB（latent cache 常驻 host、按需增量上卡）。
- **applies_when**：当 KV 需要在多级存储间分层时：公开资料给出"重合度 80%–90%"这一可复用的一阶量级，以及"buffer 要放到 top-k 的 2–4 倍"这一经验配置。适用于评估片上/片外 KV 分层策略的有效性上限。
- **not_applicable_when**：这套机制的全部收益前提是**存在比 GPU 显存更慢更便宜的一级存储**（host memory），收益来自 PCIe 传输的节省。本项目单芯片、KV 在片内 SRAM/HBM 的层级里，"增量搬运"省的是片内带宽还是容量需要重新界定，8GB→200MB 这类显存数字不可搬运。重合度 80%–90% 是在 DSA 的 top-k 选择上测的，MoE 专家路由的重合度是另一回事。
- **project_premises**：FP8 KV
- **what_to_check_here**：核 `docs/architecture/HIGH_LEVEL_ARCHITECTURE.md:95` 提到的"按路由命中率覆盖"常驻权重的做法是否与本条同构——两者都是"只搬变化量"的思路。向 memory-subsystem 单元要 KV 在 SRAM/HBM 之间的分层假设，确认"增量搬运省的是带宽还是容量"这个界定在哪里写清楚。
- **sources**：
  - SGLang Hierarchical Sparse Attention 技术解析（相邻 step top-k 重合度 80%–90%、LRU buffer 4K–8K、128K 显存 8GB→200MB），2025，https://developer.aliyun.com/article/1708086
- **confidence**：industry_survey
- **relative_validity**：约 18 个月。"相邻步选择高度重合"是结构性观察，较稳定；具体 buffer 配置与显存数字随实现变化。

### SOTA-MODEL-13 经典长上下文方案：从切范围到学习式稀疏的两代谱系

- **approach**：滑动窗口 / 固定稀疏模式 / RAG / MLA / DSA 的谱系对照
- **what_it_is**：长上下文成本问题的四代应对：(1) 切掉计算范围——滑动窗口只看局部邻居，全局感知随之消失；(2) 绕开长文本——RAG 先检索再喂给模型，上限变成检索质量；(3) 固定稀疏注意力——人工设计稀疏模式跳过部分计算，模式是死的，不同任务信息分布差异大，泛化受限；(4) 学习式稀疏——模型在训练中自己学出哪里需要高密度注意力，DSA 是其出货形态。另有一条正交轴是 MLA 式的宽度压缩。
- **who_uses_it**：各代做法在 2023–2026 都有出货实例。判断一个方案"是不是落后了"，主要看它落在哪一代，以及是否同时用了宽度压缩与序列轴压缩两条轴。
- **typical_numbers**：各代做法的公开收益口径差异很大，不能横向比较：滑动窗口给的是常数级 KV 上限但损失全局能力；固定稀疏给的是固定的计算削减比例但泛化受限；学习式稀疏（DSA）自述在 1M 上下文下有明确的 FLOPs 与 KV 压缩收益。注意：后者的收益数字是整个模型设计（含训练数据、优化器、残差连接、数值精度、系统实现）的综合结果，不能单独归因到稀疏机制，这一点在公开分析中被明确指出。
- **applies_when**：用于给"本项目在长上下文方案上处于第几代"定位，从而决定值不值得花力气取证。也适用于识别"混合注意力模型里跳过 sliding-window 层的量化"这类细分实践。
- **not_applicable_when**：各代方案的收益口径不可横向搬运（一个报的是常数级 KV 上限，一个报的是相对上一代的 FLOPs 百分比）。另外这些方案的训练成本差异极大：学习式稀疏需要模型训练阶段就引入，对"架构冻结"类项目而言不是推理期可选开关。
- **project_premises**：FP8 KV
- **what_to_check_here**：取 `references/sota/` 下另建时的 sustained-tps 单元与本条的交叉：确认 1M 上下文的 KV 账是按"全量常驻"还是"序列轴压缩 + 宽度压缩"两种轴同时记账。向 model 团队确认部署对象在两条轴上分别用了什么（MLA 宽度压缩 + DSA 序列稀疏 是当前主流组合），据此判断 KV 预算的记账口径是否完整。
- **sources**：
  - DeepSeek V4 深度：一次注意力机制的结构性颠覆（四代方案的谱系叙述，含收益不可单独归因的提醒），2026，http://www.163.com/dy/article/KR9FSG5R05198NMR.html
  - DeepSeek Sparse Attention（学习稀疏 vs 固定窗口的对照），2025，https://sebastianraschka.com/llm-architecture-gallery/deepseek-sparse-attention/
  - DeepSeek-V3.2 (arXiv:2512.02556)，2025，https://arxiv.org/abs/2512.02556
- **confidence**：industry_survey
- **relative_validity**：约 12 个月。代际谱系本身变化快，判据（是否同时用宽度压缩与序列轴压缩两条轴）相对稳定。

### SOTA-MODEL-14 上一代通行做法：LRU 专家缓存 + 单层前瞻预测 + 全量预取

- **approach**：Mixtral-Offloading 式 LRU 缓存 + speculative prediction
- **what_it_is**：MoE offload 的第一代工程范式：把不常用专家放 host memory，用 LRU 缓存把激活的专家上卡，配一个只预测下一层（单层前瞻）的 speculator 来重叠传输。命中率的收益完全通过减少 PCIe 传输体现。后续工作（fMoE、ProMoE、MoE-Infinity、EdgeMoE、Pre-gated MoE、DAOP）都是在这一代基础上分别改进预测精度、缓存粒度或调度。
- **who_uses_it**：资源受限的单机 MoE 部署（消费级 GPU、边缘设备）、以及所有把"专家放 CPU、按需上卡"作为默认架构的推理引擎。是理解"专家命中率"这类指标来源的原始场景。
- **typical_numbers**：profiling 结果：Qwen1.5-MoE-A2.7B 与 DeepSeek-V2-Lite 在受限显存预算下，offload 开销可超过实际计算时间，留给传输与专家计算 overlap 的空间有限；某 FPGA 平台 profiling 中专家取数占 MoE 推理总执行时间的约 **88%**。改进型方案的自述收益：fMoE 相对 SOTA 降低推理延迟 47%、提升专家命中率 36%（六卡测试台，基于 HuggingFace Transformers 原型）。
- **applies_when**：用于判断"专家命中率"这类指标的**原始语义**：它诞生于专家权重不在加速器本地、传输在 critical path 的场景，收益以延迟度量。理解这一点，才能判断把同类指标搬到权重常驻场景是否改变了语义。
- **not_applicable_when**：这条的全部数字前提是"存在 host memory 一级、传输走 PCIe"。本项目单芯片、专家权重若在 HBM/SRAM 常驻，则不存在"命中/未命中触发传输"这一机制，命中率会退化为"是否命中片上缓存"，两者不可比。fMoE 的 47%/36% 是相对其自身 SOTA 基线，不是相对全量常驻的收益。
- **project_premises**：专家命中率 0.8
- **what_to_check_here**：核 `docs/architecture/21_TPS_DESIGN_BASELINE.md:262` 的"每 token 每 rank 预测取数 0.81 GB、其中错取 0.16 GB"：确认这里的"取数"是指 MC/HBM 读取还是跨芯片传输——这决定命中率指标在本项目里是不是同一语义。若是指 MC 读取，则它与本条这一代做法的"命中率"是同名不同物，取证时应向 workload-operator 明确要求给出定义。
- **sources**：
  - fMoE: Fine-Grained Expert Offloading for Large Mixture-of-Experts Serving (arXiv:2502.05370)（Mixtral-Offloading 的 LRU + speculative prediction 综述，及 47%/36% 自述收益），2025，https://ar5iv.labs.arxiv.org/html/2502.05370
  - EARTH: An Efficient MoE Accelerator with Entropy-Aware Speculative Prefetch and Pattern Reuse（MoE offload 相关工作谱系，专家取数约占执行时间 88%），2025，https://dlnext.acm.org/doi/pdf/10.1145/3779212.3790155
- **confidence**：public_measurement
- **relative_validity**：约 3 年。这已是上一代范式，且其收益结构（PCIe 传输在 critical path）与本项目的常驻前提不同，作为"经典方案"参照的价值大于作为性能参照的价值。

## 7. 未解（UNVERIFIED）

1. **IEEE 那篇 MoE 专家预测实测的题名、卷号与确切年份未能确认。** 检索结果只给了 PDF 直链（ieeexplore.ieee.org/ielx8/6287639/11323511/11397596.pdf），没有标题行。文中表 4 的五领域命中率（频率基线宏平均 0.488、locality-aware 宏平均 0.833）与 Top-6 预取策略是本次调研里唯一给出"跨领域命中率分布"的实测，价值高但出处标注不完整。重跑时应补全。

2. **ACM DOI 10.1145/3774904.3792218 的题名、会议与年份未能确认。** 只知道它用 DeepSeek 模型 + Wikitext 做了 GoodPrefetch 分数实测（top-1/2 得 86.06%、top-3/6 得 93.40%、全取 ≤77.52% 且变慢）。会议/年份是从 DOI 前缀推断的。另有一条同批检索到的数据（GSM8K 46.34% → 34.76%，当 draft 从 top-6 降到 top-2 专家）也出自此源。

3. **MLA 每 token 每层 KV 字节数的直接公式来源没取到。** 唯一给出"展开 K/V vs latent"逐 token 数字的公开来源是 2026-09 的一份框架 PR，晚于本文件 as_of。DeepSeek-V3 技术报告原文（arXiv:2412.19437）中 MLA 的 KV 公式部分本次未取到原文，需要下载报告正文核对 kv_lora_rank / qk_rope_head_dim 的取值与压缩比推导。

4. **1M 级上下文下 FP8 KV 的精度衰减曲线没有单一权威来源。** 现有实测最长到 256k（Qwen3-30B-A3B），且退化集中在 128k–256k 段。1M 处的行为只能外推，没有任何公开的第三方长文检索指标覆盖。这是本项目 1M 上下文 + FP8 KV 组合最需要实测的部分。

5. **专家命中率的公开实测与常驻场景的可迁移性未知。** 检索到的全部命中率实测（0.44–0.53 基线、0.80–0.90 局部性感知、80%–90% 时间重合度）都来自专家权重不在加速器本地、传输在 critical path 的 offload 场景。没有找到任何"专家权重全常驻、命中率体现为片上缓存命中"的公开实测区间。这类系统（单芯片大 HBM + 大 SRAM 常驻专家）的命中率没有行业参照系。

6. **MoE 权重精度在 batch=1 decode 下的端到端精度-吞吐权衡缺乏公开实测。** 找到的资料要么是训练/RL rollout 口径（FP8 混合精度训练、rollout mismatch 修正），要么是 batch>1 的服务吞吐口径。B=1 decode 且受内存带宽约束时，权重精度如何影响可达吞吐，没有可引用的实测。

7. **本项目部署对象（GLM-5.2、DeepSeek-V4-Pro 一类）的官方架构细节与技术报告链接未取到。** 本文件只能覆盖到其架构前身（DeepSeek-V3 的 MLA、V3.2 的 DSA）。资格矩阵所需的 activeParams / totalParams / expertHidden / moeLatent / 线性注意力层数 / stateDim / 专家命中率 / token-time 系数等字段（`teams/council/docs/reviews/2026-09-26_K3_P1_FREEZE_GAP_REVIEW.md:313` 已指出曾缺失）仍需从供应商或模型方直接获取。

8. **本文件的知识 horizon 是 2026-01。** 公开资料里更新的 MoE 架构、KV 量化方案与量化精度实测存在，但本次调研按既定口径未纳入。重跑本单元时应由 args.as_of 显式给出新日期，并优先补：4-bit 权重精度（MXFP4/NVFP4）、序列轴压缩类注意力、以及 2026 年内的 KV 量化第三方实测。

9. **未覆盖的方向**：专家预测的"投机执行"（把预测到的专家直接算掉、用近似结果替代 miss）在精度上的损失边界，本次只找到定性描述与一个 GSM8K 数据点，没有系统性的评测表；固定稀疏模式（如 blockwise / NSA 式）与 token 级稀疏的算子级开销对比也没有量化的公开数据。
