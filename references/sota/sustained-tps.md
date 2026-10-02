# 推理系统的端到端吞吐账与 SLO 口径

> 本文件是 `references/sota/` 的一个学习单元。**这些是知识，不是证据**：没有仓库内 `path:line`，
> 不得作为任何 claim 的 `evidence`，不得用来覆盖、修正或重算仓库里的任何基线值。有冲突以仓库文件为准。
> 详见 [`README.md`](README.md)。

**as_of**：2026-01
**覆盖范围**：TPS/usr 类指标的定义分歧、batch=1 与 batch>1 的口径差异、decode 内存带宽下界推导、
为什么端到端吞吐几乎总是 memory-bound、行业中如何声明与验证 sustained 吞吐。
**未覆盖**（属其他单元）：HBM 控制器层面的命令混合与 refresh（`memory-subsystem.md`）、
UCIe/集合通信的具体效率（`interconnect-collective.md`）、矩阵阵列利用率（`compute-core.md`）、
专家命中率实测（`model-workload.md`）、门槛余量与证据分级方法学（`evidence-governance.md`）。

## 0. 与已有文件的关系

本文件是全覆盖新写，没有沿用任何已有内容。仓库里已有的相关材料是
`references/k3_1000tps_chip_designs.html`、`references/frontier_moe_arithmetic_intensity*.html`
与 `docs/architecture/14_TPS_OBSERVATION_METRICS.md`——**它们都是本仓库内部材料，本次未被引用、
未被核对、也未被改写**；本文件只从外部公开资料总结，写成给后续探针看的参照系。

## 1. 一句话结论

公开资料对「per-user 吞吐」的口径分歧是**真实存在且被工具实现强制区分**的（`1/ITL` 与聚合 `tok/s`
被官方文档写明「not directly comparable」）；而端到端吞吐之所以几乎总是 memory-bound，是因为
decode 的算术强度 ≈ 1 FLOP/byte，远低于任何加速器的 ridge point，于是单 token 时延被
`权重字节 ÷ 带宽` 这条下界卡住。真正的工程难点不在下界本身，而在**达成率**：同一台机器，
大数组顺序 streaming 能跑到标称带宽的九成上下，而 batch=1 的 decode 只能跑到三成上下——
这两个数字都来自公开实测，且语义完全不同，混用会让「MC 效率」这类系数失去意义。

## 2. 口径分歧：per-user 到底是什么

`aiperf` 的 metrics reference 里同时存在两个指标，并在文档正文里明说两者不可直接比较：

| 指标 | 公式 | 分母含 TTFT？ |
|---|---|---|
| Output Token Throughput（聚合） | 全部并发请求的输出 token 数 ÷ 总时间 | 含 |
| **Output Token Throughput Per User** | `1 / ITL`，其中 `ITL = (request_latency − TTFT) / (output_len − 1)` | **不含** |

同一份文档还给了 `TTFT` 的定义（含网络延迟、排队、prompt 处理、首 token 生成）与
`Inter Token Latency` 的定义（稳态 token 间隔，排除 TTFT 开销）。这构成了公开资料里最清晰的一组口径边界。

**推论（用于判断某个数字是哪一类）**：一个 per-user 数字与同机的聚合 tok/s 之比近似等于并发度，
不是硬件能力之比。公开生产环境实测可佐证这个量级：同一模型在 8×H100 上 ITL p50 = 33.4 ms、
8×H200 上 18.3 ms，而聚合吞吐是 0.74 B 与 1.88 B tokens/天，对应平均并发 11.2 与 60.7。

## 3. 行业如何声明与验证 sustained 吞吐

### 3.1 MLPerf 的场景化定义（最接近标准答案的模板）

`inference_rules.adoc` 定义四种场景，其中两种与吞吐声明直接相关：

- **Offline**：全部样本一次性投入，无延迟约束，指标 = 测得吞吐。这是「裸峰值」。
- **Server/Interactive**：Poisson 到达模拟在线流量，有 benchmark-specific 延迟约束，
  尾延迟按 99% 计，指标 = **满足延迟约束下可承受的最大到达率**。

规则文档自注：Server 的 target QPS「must be determined manually. It is usually around 80% of the
Offline QPS, but on some systems, it can drop below 50%」。这就是公开资料里「无约束峰值 → 可承诺
sustained」折减的一个可引用区间。测量时长统一 600 秒；Llama2-70B 任务的 Server 约束是
6000 ms / 175 ms（TTFT / TPOT）。

**关键点**：行业标准意义上的 sustained 吞吐是**带约束的**数，四项缺一不可——延迟 SLO、到达模型、
长窗口、尾延迟分位。

### 3.2 达成带宽反推法（可执行的验证套路）

不依赖厂商声明的验证路径：精确枚举「一个 decode token 实际流过的字节数」→ 除以实测每 token 毫秒数
→ 得达成 GB/s → 除以同机 STREAM/BabelStream ceiling → 得带宽利用率。开源实现
`fak/internal/model/decode_roofline.go` 就是按这个字段集组织的（`stream_bytes` / `per_token_ms` /
`achieved_gbps` / `ceiling_gbps` / `bandwidth_utilization_pct`），并强调两点：

1. GEMV 多核并行，达成 GB/s 是**聚合**值，必须与**聚合** ceiling 比，否则会算出 >100% 的无意义利用率；
2. 分子必须排除掉那些「受 latency 限制而非带宽限制」的项——该实现明确排除了 KV cache、RMSNorm gains、
   与 bias，理由是短序列下 KV 是 L2 驻留的。

诊断结论只有两种：贴着 roofline → 唯一杠杆是少搬字节（降精度）；远低于 ceiling → kernel/前向路径还有余量。

**第 2 点的排除条件在长上下文下失效**：1M 级上下文时 KV 重新成为主导项，分子必须补上 KV。

### 3.3 吞吐声明的披露清单

公开资料已形成一份事实上的清单。报告吞吐时若缺任一项，数字即不可比：

- 输出是否被**截断**（截断减少 decode 迭代，人为抬高吞吐）；
- batch/并发策略（静态 vs 连续）、最大 batch；
- **前缀缓存**命中率（80% 命中会让 TTFT 比冷缓存低约 80%，这是工作负载结构而非硬件能力）；
- 冷 / 热缓存条件；
- 是否在**延迟优化点与吞吐优化点两个工作点**都报告（只报吞吐点低估交互成本，只报延迟点低估产能）；
- 测量边界（网络 RTT、tokenizer、调度排队是否计入）。

两个额外的坑：单进程 Python 基准客户端在目标 QPS 接近事件循环服务率时，客户端排队会**系统性抬高**
测得的 TTFT/TPOT（M/G/1 分析，需多进程分摊）；反复对同一 server 跑 bench 会命中前缀缓存从而抬高吞吐
（vLLM 官方文档自注）。

## 4. 为什么端到端吞吐几乎总是 memory-bound

### 4.1 下界式

decode 每生成一个 token 要把权重流一遍，复用次数 ≈ 1，算术强度 I ≈ 1 FLOP/byte ≪ ridge point。于是

```
T_token ≈ N_param × (b/8) / BW          [seconds/token]
```

IEEE 的 LLM accelerator 综述把它写成式 (9)，并用 LLaMA-7B FP16 / H100（3.35 TB/s）算出 4.2 ms/token，
指出与实测一致。同一条算术在 H100/H200 对比里给出 70B FP16（约 140 GB 权重）的单流上限：
H100 约 24 tok/s，H200 约 34 tok/s。

**分子在三种情况下要改写**：KV 成为主导项时（长上下文）换成「权重 + KV」；MoE 换成路由到的 active 权重
（用 total params 会高估一个数量级）；TP 分片后权重按 TP degree 除。

### 4.2 batch=1 与 batch>1 的分野

Roofline 语言下：prefill 强度高、compute-bound；decode 强度低、bandwidth-bound。
公开教学材料给出的量级感是 prefill 强度 ~2048 FLOP/byte（2048 token 的 prompt）、decode ~1 FLOP/byte。

**batch 的作用是抬高 decode 的有效强度**（权重读取被 B 个请求摊薄），因此：

- 公开资料里几乎所有「大吞吐提升」都来自提高并发：continuous batching（Orca, OSDI 2022）
  在真实不规则流量上被实测到相对静态 batching 高达 **23×**；
- 这条收益**完全依赖「有队列可填」**，B=1 时为零。

公开的 TTFT-吞吐权衡表可以量化这一点（MiniMax M2.5 类模型）：

| TTFT 目标 | 最大并发 | 达成吞吐 | 占峰值 |
|---|---|---|---|
| < 100 ms | 32 | 1,636 tok/s | 19% |
| < 250 ms | 128 | 3,943 tok/s | 45% |
| < 500 ms | 256 | 5,945 tok/s | 67% |
| < 1000 ms | 1024 | 8,838 tok/s | 100% |

即：**脱离并发度与延迟目标谈「峰值吞吐」没有意义**。

### 4.3 MoE 在低 batch 下的额外劣势

MoE 一层里 b 个 token 路由到 E 个专家中的 k 个，均匀路由下每个专家平均只收到 `b·k/E` 个 token。
要匹配同等 active 参数的 dense 模型的算术强度，MoE 需要 `b × (E/k)` 的 batch。
公开算例：E=256、k=8 → **32×**（Berkeley EECS-2025-192，原文同时承认这在 KV 与专家权重的显存约束下
「是困难的」）。另一组相关数字：DeepSeek-R1 在 8192 序列长度下 B_cap = 7360，GPT-3 只有 124（约 60× 差）；
且 all-to-all 的互连带宽从 900 GB/s 降到 300 / 100 GB/s 会显著压低满足 SLO 的可用 batch（arXiv 2507.15465）。

## 5. 长上下文把分母从「权重」推向「KV」

标准 KV 字节账（公开公式）：

```
KV bytes/token = 2 (K and V) × layers × kv_heads × head_dim × bytes_per_element
```

Llama-3-70B / Qwen2.5-72B（L=80, 8 KV heads, head_dim=128, BF16）→ **320 KB/token**。
换算单请求容量：4K ≈ 1.3 GB，16K ≈ 5.2 GB，64K ≈ 21 GB，128K ≈ 42 GB（FP16；FP8 减半、INT4 再减半）。
对照量级：LLaMA-7B 在 128K 下 KV 约 68.7 GB（接近单卡 80 GB），1M 下约 549.8 GB（远超单卡）。

**该公式在 MLA 上不成立**——MLA 存的是低秩潜向量而非完整 K/V，公开资料明确说其 bytes-per-token
「dramatically lower」，用它算会显著高估。滑窗注意力、token 驱逐、稀疏索引（DSA 类 indexer）
同样改变的是「每步实际读多少历史 token」，需要换成有效读取长度。

## 6. 经典（上一代通行）做法

上一代的容量规划是**单因子折减 + 稀疏测点线性外推**：先算理论下界，再用一个单一张的系数
（或直接「取峰值 50%」）覆盖 KV、collective、kernel launch、采样、调度、框架开销全部；
用 batch 1 与 batch 64 两端的 bench 结果线性插值外推中间点。

这种做法的合理性来源在公开资料里有明确记录：作者取 50% 时说明这一半有两个来源——一是
「一阶模型没算的活儿」（kernel tiling 的零填充行、未与计算重叠的通信），二是
「主机侧可消除开销」（逐次提交 kernel、切换前重建通信组与执行图）。
两端实测值分别是 batch 1 的 33% 与 batch 64 的 65%（插值到 batch 32 约 49%）；prefill 侧是 58%–62%。

**它作为「经典对照基线」长期有效，作为当前推荐做法已经过时**——单因子折减一旦被当成某个具体部件
（例如「MC 效率」）的效率，就会把字节账错误、collective 开销、调度开销全记到一个物理部件头上。
判断一个系数「是不是落后了」正是靠这条。

## 7. 本领域最硬的三个参照数字（并列，不合并）

以下三个都是公开实测，但**语义完全不同，不可互相代入**：

| 参照 | 数值 | 条件 | 语义 |
|---|---|---|---|
| 顺序 streaming 达成率 | H200 上 BabelStream triad 4.37 TB/s，约为 4.8 TB/s 标称的 **91%** | 大数组顺序访问 | 内存子系统本体能力 |
| decode 达成率（低 batch） | batch 1 约 **33%**，batch 32 约 49%，batch 64 约 65%（RTX PRO 6000 实测标定） | decode 访问模式，单卡 | 访问模式 + 延迟隐藏 + kernel 实现 |
| 无约束峰值 → 带 SLO sustained | Server 的 target QPS 通常约为 Offline 的 **80%**，差的系统可低于 50% | MLPerf Server 场景 | 排队与尾延迟的代价 |

## 8. 知识卡

### SOTA-TPS-01 「per-user 吞吐」在公开资料里是 1/ITL，且被明确定义为不可与聚合吞吐比较

- **approach**：Output Token Throughput Per User (1/ITL) vs Output Token Throughput (aggregate)
- **what_it_is**：NVIDIA 的 aiperf 基准工具（ai-dynamo/aiperf）在 metrics reference 里把两者拆成两个互不替代的指标：聚合 Output Token Throughput = 所有并发请求合计每秒输出 token；Output Token Throughput Per User = 单个请求的内部 token 间隔（ITL）的倒数，公式 1/ITL，其中 ITL = (request_latency − TTFT)/(output_sequence_length − 1)。文档原文明确写：「This metric is computed per-request, and it excludes the TTFT from the equation, so it is not directly comparable to the Output Token Throughput metric.」也就是说，行业主流工具在实现层面就强制区分「单用户流式速度」与「系统聚合吞吐」，并且分母口径不同（一个含 TTFT、一个不含）。
- **who_uses_it**：NVIDIA ai-dynamo / aiperf（2025–2026）、vLLM bench serve、TensorRT-LLM benchmark、生成式 AI Perf Analyzer 这一类服务端基准工具；云厂商在宣称「单用户 tok/s」时普遍用 1/ITL 口径。
- **typical_numbers**：公开资料里同一模型同一硬件的两个数可以差很多：ITL 口径给出的是单请求稳态速度（例如 io.net 生产环境中 DeepSeek-V4-Flash 类模型在 8×H100 上 ITL p50 = 33.4 ms，即约 30 tok/s/请求；8×H200 上 ITL p50 = 18.3 ms，即约 55 tok/s/请求）。聚合口径则是把并发数乘上去（同一来源：H100 集群 0.74 B tokens/天、H200 1.88 B tokens/天，平均并发 11.2 对 60.7）。两者之比近似等于并发度，而不是硬件能力之比。
- **applies_when**：当你要把一个「per-user」数字与任何厂商宣称的「吞吐」数字做比较时，必须先确认对方的 per-user 是否含 TTFT、是否含排队、并发是多少。适用于任何「单用户速度」类 SLO 的对外表述与合同口径。
- **not_applicable_when**：不适用于纯离线批处理（Offline/batch）场景的吞吐口径比较——离线场景不存在 per-user 概念（MLPerf Offline 场景的指标就是测得吞吐，无延迟约束）。也不适用于把 ITL 口径的 per-user 数字直接与「系统峰值 tok/s」比较，两者不同量。对于本项目的 B=1、Context=1M 口径，尤其不能把公开资料里「并发 60 时的聚合 tok/s ÷ 60」当作 per-user 速度来类比。
- **project_premises**：1000 目标 vs 1050 门槛、B=1
- **what_to_check_here**：去核 `docs/architecture/14_TPS_OBSERVATION_METRICS.md` 第 2 节的公式 `TPS/usr = 1,000,000 / e2e_latency_us_per_token`：确认其中 e2e_latency 是否含 TTFT/prefill、是否含排队与调度开销、是否含首 token 的生成时间。再对照 `out/detailed/detailed_architecture_run.json` 的 raw/e2e 分解，看 `fixedPerLayerUs × layers` 这一类固定项是否被算在分母里。可执行的核法：把 14_TPS_OBSERVATION_METRICS.md 的公式与本仓库 `integration/planning/token_time.js` 的实现逐项对齐，列出「含/不含 TTFT」「含/不含调度」两栏，标记任何未言明的项。
- **sources**：
  - NVIDIA ai-dynamo / aiperf — Metrics Reference (Output Token Throughput Per User, ITL, TTFT)，2025-2026，https://raw.githubusercontent.com/ai-dynamo/aiperf/d72160e20957013d6608afcc88ed24100cb27dc5/docs/metrics-reference.md
  - Measuring AI Serving Performance: Latency and Throughput (intuitionlabs, 综述并引用 vLLM/DistServe/MLPerf)，2025，https://intuitionlabs.ai/pdfs/measuring-ai-serving-performance.pdf
  - io.net — H100 or H200 for DeepSeek V4 Flash? What we measured in production，2026，https://io.net/blog/h100-or-h200-for-deepseek-v4-flash-what-we-measured-in-production
  - Red Hat OpenShift AI — Serving models, inference performance metrics (TTFT/ITL/TPOT/TPS 定义)，2025，https://docs.redhat.com/zh-cn/documentation/red_hat_openshift_ai_self-managed/2.19/pdf/serving_models/Red_Hat_OpenShift_AI_Self-Managed-2.19-Serving_models-zh-CN.pdf
- **confidence**：vendor_datasheet
- **relative_validity**：约 3 年。指标定义本身（TTFT/ITL/TPOT/per-user）已经稳定了数年，半衰期长；但 aiperf/vLLM 这类工具的具体字段名与默认行为会随版本变化，比定义短。

### SOTA-TPS-02 MLPerf 的 Server 场景是行业里「声明并验证 sustained 吞吐」最接近标准答案的模板

- **approach**：MLPerf Inference Server/Interactive 场景 + 延迟约束 + Poisson 到达 + target QPS 手动调参
- **what_it_is**：MLCommons 的 inference_rules.adoc 定义了四种场景。其中 Server/Interactive 场景用 Poisson 分布投递查询（模拟真实在线流量），有 benchmark-specific 的延迟约束（latency constraint），尾延迟按 99% 计，性能指标是「Maximum Poisson throughput parameter supported」——即在满足延迟约束前提下能承受的最大到达率。这意味着行业标准意义上的「sustained 吞吐」是一个**带约束的**数，不是一个裸的最大值。Offline 场景则是把全部样本一次性投进去、无延迟约束、指标就是测得吞吐。
- **who_uses_it**：MLCommons 成员（NVIDIA、Intel、AMD、Google、高通等）每轮 MLPerf Inference 提交；数据中心采购与招标文件经常直接引用 MLPerf 数字；欧盟等机构的 AI 算力招标规格里也写明「using latest MLPerf standards」。
- **typical_numbers**：Llama2-70B 的 Server 场景延迟约束在 rules 中给出为 6000 ms / 175 ms（TTFT / TPOT）。规则文档另注：Server 的 target QPS「must be determined manually. It is usually around 80% of the Offline QPS, but on some systems, it can drop below 50%」——即从无约束的 Offline 峰值到满足 SLO 的 Server sustained，行业里常见的折减是 ×0.8，差的系统可以掉到 ×0.5 以下。MLPerf 场景测量时长统一为 600 秒。
- **applies_when**：当你要为「sustained 吞吐」找一个有第三方签核意义的定义时：约束（延迟 SLO）+ 到达模型（Poisson 而非固定速率）+ 长窗口（600 s）+ 尾延迟（p99）这四项缺一不可。适用于需要对外可复现、可审计的吞吐声明。
- **not_applicable_when**：不适用于 B=1 / 单流（SingleStream）口径的对比——MLPerf Server 场景的吞吐来自并发与排队，其数值随并发规模变化，与单用户流式速度不是同一个量。也不适用于本项目的 1M context 长上下文：MLPerf 的 Llama2-70B 任务 max_seq_len=1024，KV 压力与 1M 级差数个量级，其 latency constraint 数值不可移植。此外 MLPerf 的 6000/175 ms 约束是特定任务卡，不代表业界的通用 SLO 惯例。
- **project_premises**：1000 目标 vs 1050 门槛
- **what_to_check_here**：核这一条：本项目 1050「架构冻结门槛」的语义是哪种——是 Offline 式的无约束峰值，还是 Server 式的带 SLO sustained？去读 `docs/architecture/21_TPS_DESIGN_BASELINE.md` 与 `teams/council/` 下相关 ADR（README 提到 ADR-0005/ADR-0008），确认门槛是否附带延迟/P99/功耗约束。可执行的核法：在 `out/governance/candidate_register.json` 的 policy 字段里，把「target」「architecture gate」「tau range is a risk annotation」三者的语义务必分开写清并各自注明约束条件——公开资料的经验是这三者混用会让一个数被当成另一个用。
- **sources**：
  - MLCommons — inference_policies / inference_rules.adoc（Scenarios 表、Server latency constraint、600s 时长、Llama2-70B 6000ms/175ms），2025-2026，https://raw.githubusercontent.com/mlcommons/inference_policies/master/inference_rules.adoc
  - MLPerf Inference Benchmark (Reddi et al., arXiv:1911.02549)，2019-2020，https://arxiv.org/pdf/1911.02549.pdf
  - Machine Learning Systems Vol 1 (Harvard CS249r) — 12.8.4.2 MLPerf execution scenarios 表 12.12/12.13，2025-2026，https://harvard-edge.github.io/cs249r_book_dev/vol1/assets/downloads/Machine-Learning-Systems-Vol1.pdf
  - Measuring AI Serving Performance (intuitionlabs) — 引用 MLCommons 关于 Server target QPS 约为 Offline 的 80%、可低于 50%，2025，https://intuitionlabs.ai/pdfs/measuring-ai-serving-performance.pdf
- **confidence**：industry_survey
- **relative_validity**：约 3–5 年。场景定义（SingleStream/MultiStream/Server/Offline）从 2019 起稳定；但具体到 LLM 的延迟约束数值与 Interactive 场景的指标定义（TTFT/TPOT 权重）每轮都在演进，引用时必须带版本号。

### SOTA-TPS-03 decode 阶段的带宽下界推导：T_token ≈ N_param × b/8 / BW，这是行业公认的第一性估算式

- **approach**：Roofline / 权重流下界（weight-streaming lower bound）
- **what_it_is**：decode 每生成一个 token，都要把模型权重（在 B=1 且未做 TP 分片时是全部权重）从 HBM 流一遍，而复用次数接近 1，所以算术强度 I ≈ 1 FLOP/byte，远低于 GPU 的 ridge point。于是单 token 时延下界近似为 T_token ≈ N_param × (b/8) / BW，其中 b 是权重位宽、BW 是可用带宽。这个式子就是行业里做「这个模型在这张卡上最快能多快」的第一性估算时所写的式子。IEEE 的一篇 LLM accelerator 综述把它写成式 (9)，并用 LLaMA-7B FP16 在 H100（BW = 3.35 TB/s）上算出 4.2 ms/token，指出与实测一致。
- **who_uses_it**：GPU/加速器厂商与推理框架的性能文档、MLSys 教材（CS249r 第 13 章、mlsysbook.ai 的 MLSys·im 教程直接以「ITL 由 3.35 TB/s 带宽上限决定」为教学主线）、所有做 capacity planning 的人。是各家「decode 为什么慢」解释的公共起点。
- **typical_numbers**：LLaMA-7B FP16 (7e9 × 2 B = 14 GB) 在 3.35 TB/s 上 → 约 4.2 ms/token ≈ 238 tok/s（IEEE 综述式 (9) 及其算例）。70B FP16（约 140 GB 权重）在 H100 3.35 TB/s 上 → 单流上限约 24 tok/s；在 H200 4.8 TB/s 上 → 约 34 tok/s（H100/H200 对比文中给出的公开算术）。注意这些是**下界**，实际达成还取决于后面的带宽利用率。
- **applies_when**：适用于 B=1（或很小 batch）、decode 阶段、权重流主导、KV 尚未成为主导项的场景。是判断「瓶颈到底在带宽还是在算力」的第一刀：如果实测 token 时延显著高于该下界，说明瓶颈不是带宽而是别的东西（利用率、调度、通信、kernel launch）。
- **not_applicable_when**：不适用于三种情形：(1) 长上下文下 KV 读取代了权重读取的主导地位——此时分母要换成「权重 + KV」两份字节（1M context 下 KV 项可以远超权重项）；(2) MoE 模型：该式的 N_param 必须换成 active/路由到的权重字节，而不是 total params，否则会高估一个数量级，而 MoE 在 B=1 下的实际字节账比该式复杂；(3) batch 足够大使注意力/KV 项与 compute 项同时上升、进入 compute-bound 区间之后，该下界不再是起作用的约束。此外该式忽略 allreduce/collective 时间，在 TP 规模大时不成立。
- **project_premises**：B=1、Memory-bound 判断
- **what_to_check_here**：去核 out/lane 账：recompute 本项目 memory lane 的分子字节数口径，确认它是否包含 (a) active 权重、(b) KV（1M context）、(c) expert dispatch/combine、(d) index bytes 四类，并与 `teams/model/src/workload_derivation.js` 生成的 bytes 账逐项对账。可执行的核法：用 `out/workload/planning_operator_workload.json` 里的 bytes 字段，按「权重 / KV / dispatch / index」四栏分别求和，再看 `out/direction/stage_a_blocker_resolution_20261002.md` 里列出的 kMemory 1.1178、expertReread 0.200 这两个标定系数各自覆盖了哪几栏——如果 kMemory 同时在承担「带宽利用率」和「字节数低估」两种解释，那它是一个混合系数，不能当纯利用率读。
- **sources**：
  - IEEE — LLM accelerator 综述，式 (9) T_token ≈ N_param·b/8 / BW 及 LLaMA-7B/H100 4.2 ms 算例，2024-2025，https://ieeexplore.ieee.org/stamp/stamp.jsp?arnumber=11534193
  - MLSys·im / MLSysBook — Two Phases, One Request（TTFT 随 FLOP/s、ITL 随 GB/s 的量化教学），2025-2026，https://mlsysbook.ai/mlsysim/tutorials/02_two_phases.html
  - Machine Learning Systems Vol 1 (Harvard CS249r) — 13.8 / 13.11 memory wall，2025-2026，https://harvard-edge.github.io/cs249r_book_dev/vol1/assets/downloads/Machine-Learning-Systems-Vol1.pdf
  - AI-Infra-Book (bojieli) — 第 9.2.3 节，Roofline 给出每阶段时间下界，含 A100/H20 算例，2025-2026，https://github.com/bojieli/ai-infra-book/releases/latest/download/AI-Infra-Book-EN.pdf
  - gekro inference-latency-estimator — decode speed = memory_bandwidth / active_weight_bytes，并显式区分 total params 与 active params，2025-2026，https://github.com/drajb/gekro/blob/5ff941f4/apps/web/src/content/apps/inference-latency-estimator.md
- **confidence**：public_measurement
- **relative_validity**：约 3–5 年。式子的形式不会变（roofline 是 2009 年的模型）；但其中的 N_param 与「权重字节」会随量化格式（FP8/FP4/混合、含 scale/zero-point 元数据）和 MoE 结构变化，每次换代都要重算分子。

### SOTA-TPS-04 MoE 在低 batch 下的有效 batch 被缩小 E/k 倍，这是 B=1 MoE decode 比 dense 更难填满带宽的结构性原因

- **approach**：Expert 粒度 batch 放大（effective batch size per expert = b·k/E）
- **what_it_is**：MoE 一层里，b 个 token 会被路由到 E 个专家中的 k 个，均匀路由下每个专家平均只收到 b·k/E 个 token。于是相对同等 active 参数的 dense 模型，MoE 每个专家看到的有效 batch 被缩小了 E/k 倍；反过来说，要达到与 dense 相同的算术强度，MoE 需要 b×(E/k) 的 batch。Berkeley 的技术报告把这个系数对 256 experts / top-8 的组合明确算成 32×，并指出「在 KV cache 与专家权重的显存约束下满足这一要求是困难的」。
- **who_uses_it**：MoE 推理的容量规划与 batch size 选型；vLLM/SGLang/TensorRT-LLM 的 MoE kernel 与 expert-parallel 设计；MLA/MoE 协同分析（arXiv 2507.15465 的 Observation-P7/P8 用 B_cap / B_attn / B_MoE 三个 batch 阈值来描述这一约束）。
- **typical_numbers**：放大系数 = E/k。公开算例：E=256、k=8 → 32×（Berkeley EECS-2025-192）。同源的另一组数字：DeepSeek-R1 在 8192 序列长度下 B_cap = 7360，而 GPT-3 的 B_cap = 124，相差近 60×（arXiv 2507.15465 图 9）；该文另实测，把互连带宽从 900 GB/s 降到 300 / 100 GB/s 会显著抬升 all-to-all 开销，从而压低满足 SLO 的可用 batch（B_SLO）。
- **applies_when**：适用于任何 expert-parallel / MoE 部署在低并发下的吞吐分析，特别是要解释「为什么 active params 明明很小，单用户速度却上不去」。适用于判断瓶颈是权重读取还是 expert 粒度填充不足。
- **not_applicable_when**：不适用于 dense 模型（E/k 概念不存在）。不适用于 batch 已经足够大、每个专家都拿到远超 tile 尺寸的 token 数、MoE 已进入 compute-bound 的区间。也不适用于路由极度倾斜的情况——此时均匀路由假设失效，实际是部分专家过载、部分闲置，瓶颈从「填充不足」转为「straggler」，用 E/k 这个平均系数会给出错误结论。
- **project_premises**：B=1、Memory-bound 判断
- **what_to_check_here**：去核 `out/workload/planning_operator_workload.json` 第 106 行附近 DeepSeek-V4-Pro 的 workload 定义：确认 (a) expertReread / expert dispatch-combine 的字节账是否按 E/k 的有效 batch 建模，还是简单按 active params × bytes；(b) 是否假设了均匀路由。可执行的核法：找 `teams/model/src/design_engine.js` 里 MoE 层的 expert 数与 top-k 取值，把 E/k 算出来，再回到 `out/direction/stage_a_blocker_resolution_20261002.md` 看标定系数 expertReread = 0.200 是否与 E/k 的量级相容——若不相容，说明 expert 重读没有被字节账正确表达。
- **sources**：
  - UC Berkeley EECS-2025-192 — MoE effective batch size, E/k amplification (256 experts top-8 → 32×)，2025，http://www2.eecs.berkeley.edu/Pubs/TechRpts/2025/EECS-2025-192.pdf
  - arXiv 2507.15465 — MLA/MoE 协同，B_cap / B_attn / B_MoE 与互连带宽敏感性（Observation-P7, P8），2025，https://www.arxiv.org/pdf/2507.15465
  - AI-Infra-Book (bojieli) — 用 r_P / r_D 与 Roofline 下界推导 prefill/decode 实例配比，2025-2026，https://github.com/bojieli/ai-infra-book/releases/latest/download/AI-Infra-Book-EN.pdf
- **confidence**：public_measurement
- **relative_validity**：约 2 年。E/k 的代数关系不变，但具体模型的 E 与 k 每隔一两个代际就变，且细粒度专家（如更细的 expert 切分 + shared expert）会改变放大系数的有效值。

### SOTA-TPS-05 decode 实际达成的带宽利用率远低于 streaming 峰值，且随 batch 单调上升——这是「peak 不等于 sustained」最硬的实测证据

- **approach**：解码带宽利用率（decode bandwidth efficiency）随 batch size 的实测曲线
- **what_it_is**：同一个加速器，用 STREAM/BabelStream 这类大数组顺序 streaming 能跑到接近峰值的利用率，但 LLM decode 的 GEMV/小 batch 访问模式跑不到。AI-Infra-Book 用 RTX PRO 6000 的逐轮记录标定出：decode 的带宽效率在 batch size 1 时约 33%，到 batch 64 约 65%，插值到 batch 32 约 49%；prefill 的计算效率稳定在 58%–62%。该书据此把两者都取 50% 作为规划值。另有 H200 的 BabelStream triad 实测 4.37 TB/s（相对 4.8 TB/s 标称峰值约 91%），说明差距的来源不是内存控制器本身，而是访问模式与延迟隐藏。
- **who_uses_it**：推理容量规划（AI-Infra-Book 类工程书、vLLM/TensorRT-LLM 的 batch size 调优指南）；做「datasheet peak → 可承诺 sustained」折减的人；云厂商做实例选型与 SLO 承诺时。
- **typical_numbers**：decode 带宽效率：batch 1 约 33%，batch 32 约 49%，batch 64 约 65%（RTX PRO 6000 实测标定，单卡单模型）。对照：BabelStream triad 在 H200 上实测 4.37 TB/s，约为 4.8 TB/s 标称峰值的 91%（大数组顺序 streaming）。工程书常用的规划取值是「取峰值 50%」。注意 33% / 49% / 65% 是 decode 访问模式下的**达成率**，与 91% 的 streaming 达成率不是同一件事。
- **applies_when**：适用于要把 datasheet 内存带宽折成可承诺的 sustained 带宽、并据此推 decode 时延时。适用于解释「为什么一台卡的实测 tok/s 只有按峰值算出来的三分之一」。是判断「MC 效率」这类系数是否偏离常规时最直接的参照。
- **not_applicable_when**：不适用于把 33%/65% 这类数字直接搬到别的硬件、别的模型、别的 batch 上——它是特定卡（RTX PRO 6000）、特定实现（该书的测量栈）、特定模型测出来的，不是普适常数。也不适用于 prefill/大 batch 场景（那边的效率是 compute 效率 58%–62%，是另一个量）。对于自研加速器，其片上 SRAM 容量、TMA 深度、访存并行度与 GPU 不同，达成率不能照搬。
- **project_premises**：Memory-bound 判断、MC 效率 0.7
- **what_to_check_here**：去核 `teams/hardware/inputs/k3_mc_baseline.json` 与 `integration/planning/token_time.js`：本项目把 MC 效率当作一个 0.7 的系数，需要确认它是「MC 控制器层面的 sustained 折减」（对应 streaming 型 91% 那一档）还是「decode 访问模式下的端到端达成率」（对应 33%–65% 那一档）——这两者语义差一倍以上。可执行的核法：用 `integration/planning/token_time.js` 里 memory lane 的分母，把 kMemory = 1.1178（见 `out/direction/stage_a_blocker_resolution_20261002.md`）反解成一个等效达成率，再与本条给出的两档区间并列标注，判断它落在哪一档；同时明确 0.7 是否只作用于 MC 而 kMemory 另算，避免两个折减系数叠加却只被记一次。
- **sources**：
  - AI-Infra-Book (bojieli) — 第 8.6.3 / 9.2.3 节，RTX PRO 6000 上 decode 带宽效率 33%(batch 1) → 65%(batch 64)、prefill 58%–62%，规划取 50%，2025-2026，https://github.com/bojieli/ai-infra-book/releases/latest/download/AI-Infra-Book-EN.pdf
  - ACM SC'25 论文（Azure Reindeer）— BabelStream triad 在 H200 上实测 4.37 TB/s，与裸金属差 1% 以内，2025，https://dl.acm.org/doi/pdf/10.1145/3731599.3767705
  - fak decode_roofline.go — 以 STREAM-triad ceiling 为分母计算 decode 的 bandwidth_utilization_pct，并要求对照「聚合天花板」而非单核天花板，2025-2026，https://raw.githubusercontent.com/anthony-chaudhary/fak/refs/tags/v0.44.0/internal/model/decode_roofline.go
  - hosn.om — H100 vs H200 Memory Bandwidth: The Practical Impact on LLM Inference（按 140 GB 权重 ÷ 带宽推单流上限），2025-2026，https://hosn.om/blog/h100-h200-memory-bandwidth-impact.html
- **confidence**：public_measurement
- **relative_validity**：约 2 年。达成率随 HBM 代际、片上 SRAM 容量、TMA/异步拷贝成熟度变化——新一代硬件通常抬高 batch 1 的达成率，所以这个区间要按代际重测，不能长期沿用。

### SOTA-TPS-06 长上下文把 decode 从「权重主导」推向「KV 主导」，字节/token 的分母随 context 增长

- **approach**：KV cache 字节账：KV bytes/token = 2 × layers × kv_heads × head_dim × bytes_per_element
- **what_it_is**：decode 每步要读的不只是权重，还有该请求的整段 KV cache。KV 的每 token 字节数由层数、KV 头数、head dim 与元素位宽决定；B=1 时每步读取的 KV 总量 = 每 token 字节数 × 当前上下文长度。因此 context 越长，分母越大、per-token 时延越高。公开资料给的标准公式是 2 (K and V) × layers × kv_heads × head_dim × bytes/param。缓解手段按公开资料的分类是：GQA/MQA 结构压缩、MLA 低秩潜表示压缩、KV 量化（FP8/INT4）、以及前缀缓存避免重算。
- **who_uses_it**：所有长上下文推理部署；DeepSeek 系列用 MLA、Llama 系列用 GQA；vLLM/SGLang 的 paged KV 与 prefix cache；云厂商的长上下文定价。
- **typical_numbers**：Llama-3-70B / Qwen2.5-72B（L=80, 8 KV heads, head_dim 128, BF16）→ 2×80×8×128×2 = 327,680 B/token ≈ 320 KB/token。换算成分段容量：4K context 约 1.3 GB/请求，16K 约 5.2 GB，64K 约 21 GB，128K 约 42 GB（全为 FP16 KV，单请求）。FP8 KV 减半、INT4 KV 再减半。作为对照的量级感：LLaMA-7B 在 128K 序列下 KV 约 68.7 GB，已接近单卡 80 GB；1M 序列下约 549.8 GB，远超单卡 HBM（IEEE 综述式 (10) 及其算例）。
- **applies_when**：适用于任何长上下文 decode 的时延与容量估算；适用于解释「为什么上下文一长，per-token 速度就掉」。适用于判断 KV 精度选择对吞吐的影响。
- **not_applicable_when**：不适用于 MLA 类低秩压缩结构——MLA 不按上述「每层 kv_heads × head_dim」的 KV 布局存放，用它算会显著高估（公开资料明确指出 DeepSeek V3 用 MLA 存储的是潜向量而非完整 K/V，bytes-per-token 数学「dramatically lower」）。也不适用于采用滑窗注意力、token 驱逐、或稀疏索引（如 DSA 类 indexer）的架构——这些改变的是「每步实际读多少历史 token」，公式需要换成有效读取长度。此外该式不适用于 prefill（prefill 是 compute-bound，KV 是写而非每步全读）。
- **project_premises**：Memory-bound 判断、FP8 KV、Context=1M
- **what_to_check_here**：去核 `out/workload/planning_operator_workload.json` 第 72 行附近的 note（该处写明 FP8 KV layout、index-key bytes、每层 collectives 数为 ASSUMPTION，且 shared indexer layers 复用上一完整层的 top-k），以及第 106 行 DeepSeek-V4-Pro 的形状假设。可执行的核法：用 `teams/model/src/design_engine.js` 里 GLM-5.2 与 DeepSeek-V4-Pro 的 layers/kv_heads/head_dim，按本条公式手算每个模型的 KV bytes/token（含 FP8 的一半折减），再与 manifest 里声明的 KV 字节数对账；同时核「index-key bytes」是否被单列（稀疏注意力下它是一份独立的、随 context 增长的读取量，混进 KV 会重复或漏计）。
- **sources**：
  - IEEE — LLM accelerator 综述，式 (10) M_KV 及 LLaMA-7B 128K/1M 算例，2024-2025，https://ieeexplore.ieee.org/stamp/stamp.jsp?arnumber=11534193
  - ai-hardware-engineer-roadmap — Part 1 Lecture 02，KV bytes/token 推导与 Llama-3.3-70B / Qwen2.5-72B 320 KB/token 算例、context → KV 容量表，2025-2026，https://raw.githubusercontent.com/ai-hpc/ai-hardware-engineer-roadmap/c075cde93c2dccbd7f9c1c6b9af7b9e1a21b99cf/Phase%205%20-%20Advanced%20Topics%20and%20Specialization/7.%20ML%20Systems%20Engineering/AI%20Inference%20Engineer%202026/Part%201%20-%20Fundamentals/Lecture-02.md
  - system-design-patterns — GPU inference internals（GQA KV bytes/token 公式，MLA/FP8 KV 作为吞吐特性），2025-2026，https://github.com/babushkai/system-design-patterns/blob/main/ja/17-llm-systems/11-gpu-inference-internals.md
  - CRYSTAL D3.1 — Report on Efficient Conversational LLMs（KV 随时间增长的核算要求、cache 状态必须声明），2025，https://zenodo.org/records/19882974/files/CRYSTAL_D3_1_Report_on_Efficient_Conversational_LLMs-1.pdf
- **confidence**：public_measurement
- **relative_validity**：约 2 年。公式形式稳定；但 KV 布局随架构（MLA/GQA/稀疏索引）与量化格式快速变化，每换一代模型都要重算。

### SOTA-TPS-07 反过来看：批处理（batch>1）的吞吐优化几乎不可移植到 B=1，两者的可达区间由 batch 决定

- **approach**：Continuous batching / 吞吐-延迟权衡曲线（throughput-latency frontier）
- **what_it_is**：公开资料里「吞吐」的巨大提升几乎都来自提高并发：continuous batching（Orca OSDI 2022 的 iteration-level scheduling）在真实不规则流量上被 Anyscale 实测到相对静态 batching 高达 23× 的吞吐提升；解码带宽效率也随 batch 上升（batch 1 的 33% → batch 64 的 65%）。vLLM 的 TTFT-goal 表格显示：把 TTFT 目标放宽到 3000 ms 允许并发 512 时达到 100% 峰值吞吐，而 TTFT < 200 ms 只允许并发 16、只有约 19% 峰值。这说明公开资料里的「吞吐数」几乎都隐含一个并发度与一个延迟目标，脱离这两个前提不可比。
- **who_uses_it**：云厂商与服务框架（vLLM、TensorRT-LLM、SGLang、TGI）的默认调优路径；MLPerf Server 场景的 target QPS 调参；容量规划里「需要多少副本」的计算。
- **typical_numbers**：Anyscale 实测 continuous batching 相对静态 batching 最高 23×（生产形流量）。Vultr 的 cookbook 表格（MiniMax M2.5 类模型）：TTFT < 100 ms → 并发 32、1636 tok/s（19% 峰值）；< 250 ms → 并发 128、3943 tok/s（45%）；< 500 ms → 并发 256、5945 tok/s（67%）；< 1000 ms → 并发 1024、8838 tok/s（100%）。另有一个 Nemotron Nano FP8 的 goodput 实测：TTFT < 500 ms 且 TPOT < 50 ms 时，goodput 在并发 64 处见顶（13.29 req/s），再往上 TTFT 越界，且 TPOT 在所有并发下都远低于 50 ms——即 TTFT 而非 TPOT 是紧约束。
- **applies_when**：适用于判断「某个公开吞吐数字能否迁移到自己的部署」：迁移的前提是并发度与延迟约束都可对齐。适用于为 batch>1 的服务设计容量。也适用于说明为什么 batch>1 的优化（continuous batching、chunked prefill、disaggregation）在 B=1 场景收益为零。
- **not_applicable_when**：**明确不适用于本项目的 B=1 情形。** continuous batching、chunked prefill、prefill/decode disaggregation 这三类收益全部来自「有多请求可填」。同时必须在特定调度与框架下才成立。此外 goodput 类数字通常以「requests/s 且同时满足 TTFT 与 TPOT 门槛」定义，若你的 SLO 只约束其中一个，结论会反转（上面例子里 TTFT 是紧约束、TPOT 全程富余）。
- **project_premises**：B=1、1000 目标 vs 1050 门槛
- **what_to_check_here**：去核 `out/governance/candidate_register.json` 与 `docs/architecture/14_TPS_OBSERVATION_METRICS.md`：确认本项目所有 TPS/usr 数字都锁定在 Batch=1 口径，且**没有任何**来自 batch>1 的连续批处理收益被计入。可执行的核法：在 `out/detailed/detailed_architecture_run.json` 里搜索是否存在按并发数缩放的乘子或 effective batch 字段；若存在，逐项标注其来源，因为公开资料中任何「×N 吞吐」类结论都绑定并发假设，一旦落到 B=1 就失效。
- **sources**：
  - Yu et al., Orca: A Distributed Serving System for Transformer-Based Generative Models (OSDI 2022)，2022，https://www.usenix.org/conference/osdi22/presentation/yu
  - Anyscale — How Continuous Batching Enables 23× Throughput in LLM Inference，2023，https://www.anyscale.com/blog/continuous-batching-llm-inference
  - Vultr Inference Cookbook (CUDA) — TTFT 目标 vs 并发 vs 达成峰值百分比表、Nemotron Nano FP8 goodput 基准，2025-2026，https://docs.vultr.com/public/doc-assets/pdfs/collection_item/inference-cookbook-cuda.pdf
  - AI-Infra-Book (bojieli) — 8.6.3 带宽效率随 batch 上升，2025-2026，https://github.com/bojieli/ai-infra-book/releases/latest/download/AI-Infra-Book-EN.pdf
- **confidence**：public_measurement
- **relative_validity**：约 2–3 年。continuous batching 已是稳定通行做法（含 23× 这类具体倍数会随流量形态变化）；但 goodput/并发-吞吐标定表高度依赖具体模型与框架版本，半年到一年就需重测。

### SOTA-TPS-08 行业对「吞吐声明」的可复现性要求：口径必须显式声明，否则数字不可比

- **approach**：吞吐声明的披露清单（disclosure checklist）与测量偏差治理
- **what_it_is**：公开资料里已经形成了一份事实上的披露清单：报告吞吐时必须同时说明 (a) 输出是否被截断（截断会人为抬高吞吐，因为减少了 decode 迭代）；(b) batch/并发策略是静态还是连续，最大 batch 是多少；(c) 是否有前缀缓存命中及其命中率（命中率 80% 会让 TTFT 比冷缓存低约 80%，这是工作负载结构而非硬件能力）；(d) 是否区分冷/热缓存；(e) 是否在延迟优化点与吞吐优化点两个工作点都报告（只报吞吐点会低估交互式成本，只报延迟点会低估产能）；(f) 服务端与客户端测量边界（网络 RTT、tokenizer、调度排队是否计入）。另有一篇论文指出单进程 Python 基准客户端在目标 QPS 接近事件循环服务率时，客户端排队会系统性抬高测得的 TTFT/TPOT，需要多进程分摊。vLLM 官方文档也警告：反复对同一 server 跑 bench 会命中前缀缓存从而抬高吞吐。
- **who_uses_it**：MLCommons 规则制定、各厂商性能白皮书的评审方、vLLM/aiperf/LLMPerf 等工具的文档、以及做第三方横向评测的机构（如 Artificial Analysis 明确把 TTFT 与「output speed」分开定义）。
- **typical_numbers**：无统一数值——这一条的「典型取值」是清单本身。可量化的两个量级：前缀缓存命中率 80% 时 TTFT 下降约 80%（对命中部分）；MLPerf Server 的 target QPS 通常约 Offline 的 80%，可低至 50% 以下。
- **applies_when**：适用于任何要对外声明或对外核验 sustained 吞吐的场合，包括内部架构门槛的签核。适用于设计 benchmark 与设计证据分级规则。
- **not_applicable_when**：不适用于纯离线、无缓存、固定长度的合成基准（此时若干披露项自然为空）。也不适用于把「披露清单」当成「性能要求」——它管的是数字可比性，不管数字的高低。对于自研硬件项目，还需额外披露 PPA/热降频条件，这一点公开的 LLM 基准清单未覆盖。
- **project_premises**：1000 目标 vs 1050 门槛
- **what_to_check_here**：去核 `docs/architecture/14_TPS_OBSERVATION_METRICS.md` 第 2 节列出的辅助指标清单（raw/e2e/P50-P95-P99、MC raw/sustained/effective payload、SRAM 占用、NoC 队列、RDMA、expert dispatch balance、index cache hit rate、MTP acceptance/rollback、功耗与热峰），把本条的披露清单与它做一次差集。可执行的核法：逐项对照后列出「本项目已要求但公开清单没有」和「公开清单要求但本项目没有」两张表；后者中特别检查三项——输出是否截断（MTP 的 accept/rollback 会改变有效输出长度，`out/contracts/software_execution_contract.json` 第 33 行已写明 MTP 不计入 TPS/usr，需确认这与「未截断」的语义是否一致）、前缀缓存命中率是否有字段、以及测量边界（host 逐 token 启动是否计入）是否声明。
- **sources**：
  - CRYSTAL D3.1 — Report on Efficient Conversational LLMs（截断抬高吞吐、冷/热缓存必须声明、必须在两个工作点报告、测量边界必须显式），2025，https://zenodo.org/records/19882974/files/CRYSTAL_D3_1_Report_on_Efficient_Conversational_LLMs-1.pdf
  - Identifying and Mitigating Systemic Measurement Bias in Production LLM Inference Benchmarks (arXiv 2605.24217) — NTPOT 定义、客户端 M/G/1 排队偏差，2026，https://browse-export.arxiv.org/pdf/2605.24217
  - Measuring AI Serving Performance (intuitionlabs) — goodput、vLLM 前缀缓存警告、LLMPerf 免责声明、Artificial Analysis 的 TTFT/output-speed 分离，2025，https://intuitionlabs.ai/pdfs/measuring-ai-serving-performance.pdf
  - MLCommons inference_rules.adoc — 确定性随机种子等规则要求，2025-2026，https://raw.githubusercontent.com/mlcommons/inference_policies/master/inference_rules.adoc
- **confidence**：industry_survey
- **relative_validity**：约 3 年。披露清单的原则稳定，但具体项随新机制（稀疏注意力、MTP/投机解码、disaggregation）不断增补，建议按年复核。

### SOTA-TPS-09 验证 sustained 吞吐的方法论：以「每 token 实际搬运字节数 ÷ 实测时延」反推达成带宽，再与机器 ceiling 比

- **approach**：达成带宽反推法（achieved-bytes / measured-latency vs STREAM ceiling）
- **what_it_is**：一个可执行、不依赖厂商声明的验证套路：先把「一个 decode token 实际流过的字节数」精确算出来（分子必须是真实执行路径读到的张量之和，而不是模型名义参数量），再用实测的每 token 毫秒数除，得到达成 GB/s；最后用同一台机器上的 STREAM/BabelStream ceiling 做分母，得到带宽利用率。公开的开源实现（fak 的 decode_roofline.go）明确按这一套路组织：DecodeRoofline 结构体同时携带 stream_bytes、per_token_ms、achieved_gbps、ceiling_gbps、bandwidth_utilization_pct 五个字段，并特别强调 GEMV 是多核并行、因此达成 GB/s 必须与「聚合 ceiling」比而不是单核 ceiling，否则会算出 >100% 的无意义利用率。其诊断结论只有两种：若已贴着 roofline，则唯一剩下的杠杆是「少搬字节」（更低精度），而不是更快的 kernel；若远低于 ceiling，则说明 kernel/前向路径还有余量。
- **who_uses_it**：做推理 kernel 与 serving 栈性能归因的工程团队；自研加速器的性能验证；把「memory-bound 判断」从定性变成定量。
- **typical_numbers**：该实现自带的示例量级：Q8_0 量化下权重占 1 + 4/32 = 1.125 B/weight，作者注明相对 f32 约 3.6× 的解码带宽收益。诊断阈值由 ceiling 反解，无通用数值。
- **applies_when**：适用于把「端到端吞吐是否 memory-bound」变成一个可被证伪的命题：只有当达成带宽逼近同机 ceiling 时，memory-bound 的结论才成立。适用于为量化决策提供依据。适用于验证任何自报的字节账。
- **not_applicable_when**：不适用于分子无法精确枚举的情形——公开实现自己就明确**排除**了若干项（KV cache、RMSNorm gains、bias），并说明理由是「在这些序列长度下 KV 是 L2 驻留的、受 latency 限制而非 bandwidth 限制，约 2 GB/s」。这个排除在短序列成立，但**在 1M 级长上下文下 KV 会成为主导项，该方法的分子必须补上 KV，否则结论反转**。此外，把达成 GB/s 与聚合 ceiling 比较这一条依赖「测量环境与 ceiling 采集环境一致」。
- **project_premises**：Memory-bound 判断、MC 效率 0.7
- **what_to_check_here**：去核 `out/direction/stage_a_blocker_resolution_20261002.md` 的标定表（kMemory 1.1178、kFlop 1.1529、fixedPerLayerUs 0.2987、kTmaExposedUsPerGB 5.793、expertReread 0.200）与 `integration/planning/token_time.js` 的实现。可执行的核法：把 K3/P1/MC640/TP32 详细点的 memory lane 分子（字节数）取出，除以 raw latency 的 memory 分量，得到等效达成 GB/s；再除以 MC 档位标称带宽，得到等效达成率。把该达成率与本领域两档参照（顺序 streaming 型约 90% 上下；decode 访问模式随 batch 约 33%–65%）并列，只做偏离度标注，不改动任何基线值。同时确认 kMemory 是否同时吸收了字节数低估与带宽利用率两项——若是，它不能被单独解释为 MC 效率。
- **sources**：
  - fak — decode_roofline.go（DecodeRoofline: stream_bytes / per_token_ms / achieved_gbps / ceiling_gbps / bandwidth_utilization_pct；明确排除 KV 的理由），2025-2026，https://raw.githubusercontent.com/anthony-chaudhary/fak/refs/tags/v0.44.0/internal/model/decode_roofline.go
  - sudhir13s/ai-ml-learning-resources — inference_serving.py（decode roofline 按 batch 扫描，断言 batch-1 必为 memory-bound、大 batch 必到 compute roofline），2025-2026，https://github.com/sudhir13s/ai-ml-learning-resources/blob/1853d33659486dcb312c731e483e22d4017f8623/09.%20LLMs/09-Inference-Optimization-and-Serving/code/inference_serving.py
  - AI-Infra-Book (bojieli) — 用实测逐轮记录反解效率系数并以 50% 作为规划折减，2025-2026，https://github.com/bojieli/ai-infra-book/releases/latest/download/AI-Infra-Book-EN.pdf
- **confidence**：public_measurement
- **relative_validity**：约 2–3 年。方法论（分子字节 + 分母 ceiling）本身长期有效；但其中的分子枚举方式随量化格式与 kernel 实现变化，ceiling 随 HBM 代际变化，都需要重测。

### SOTA-TPS-10 经典（上一代通行）做法：把 KV、collective、采样、调度按固定比例折减，而不做逐项字节账

- **approach**：第一代 serving 容量规划：单因子折减 + 稀疏 bench 测点外推
- **what_it_is**：上一代的通行做法是先算理论下界（权重字节 ÷ 带宽），再用一个单一张的折减系数（或「取峰值 50%」）覆盖所有未建模开销——KV 读取、collective、kernel launch、采样、调度、框架开销全在里面。同时用一个或少数几个工作点（常见是 batch 1 与 batch 64 两端）的 bench 结果做线性插值来外推中间点。AI-Infra-Book 明确记录了这种做法的合理性来源：作者取 50% 时说这一半有两个来源，一是「本章一阶模型没算的活儿」（kernel tiling 的零填充行、未与计算重叠的通信），二是「主机侧可消除开销」（逐次提交 kernel、切换前重建通信组与执行图）。
- **who_uses_it**：2022–2024 年的推理容量规划；很多中学规模部署至今仍在用；也是「MC 效率 0.7」「τ=1.15」这类全局系数在工程上被广泛采用的来源。本类做法对快速定档位仍然够用，但在需要判断「到底是哪一项吃掉了余量」时失效。
- **typical_numbers**：单因子折减的公开取值：50%（AI-Infra-Book 的规划值，由 batch 1 的 33% 与 batch 64 的 65% 插值到 batch 32 的 49% 得出）；两端实测值 33%（batch 1）/ 65%（batch 64）。prefill 侧对应为 58%–62% 的计算效率。
- **applies_when**：适用于早期定档位、只看数量级、以及没有条件做逐项分解时。适用于作为「与逐项分解法的偏差检查基线」。
- **not_applicable_when**：不适用于需要归因的场景——单因子折减一旦被当成某个具体部件的效率（例如当成「MC 效率」），就会把字节账错误、collective 开销、调度开销全部记到一个物理部件头上，导致优化方向错误。**也不适用于把 bench 两端线性插值外推到本项目这类极端点**：batch 1 与 batch 64 之间的插值在 batch 32 附近是合理的，但 1M context 使 KV 项随 context 增长而非线性、且 batch 1 的达成率对硬件细节极敏感，线性外推不可靠。
- **project_premises**：MC 效率 0.7、τ=1.15、1000 目标 vs 1050 门槛
- **what_to_check_here**：去核 `out/direction/stage_a_blocker_resolution_20261002.md` 里明确写下的「ADR-0006 单因子 kCompute 1.4139 仅保留用于比较」。可执行的核法：把 kCompute 1.4139 与同类单因子折减的公开取值（50%、以及两端的 33%/65%）并列，标注该系数在工程常规区间中的相对位置——**只做偏离度标注，不改动取值、不据此下结论**。同时记录该文件已把 K3 上的逐项标定（kMemory/kFlop/fixedPerLayerUs/kTmaExposedUsPerGB/expertReread）作为主路，确认探针在引用系数时区分「单因子」与「逐项」两套，避免把两者混用。另核 `out/direction/stage_a_blocker_resolution_20261002.md` 第 12 行的样本外检查（MC320 planning 551.21 对 detailed 586.46，ratio 0.940）——公开做法里对「标定点外推是否成立」的检查正是这一步。
- **sources**：
  - AI-Infra-Book (bojieli) — 8.6.3 / 9.2.3，50% 折减的两个来源（未建模工作量、主机侧可消除开销）与 33%/65% 两端实测，2025-2026，https://github.com/bojieli/ai-infra-book/releases/latest/download/AI-Infra-Book-EN.pdf
  - AI-Infra-Book (bojieli) — 第 9.2.3 节，用 Roofline 下界 + 单因子有效吞吐推导实例配比，2025-2026，https://github.com/bojieli/ai-infra-book/releases/latest/download/AI-Infra-Book-EN.pdf
  - sudhir13s/ai-ml-learning-resources — inference_serving.py，两工作点（batch 1 / batch 64）建模与中间插值的代码化示例，2025-2026，https://github.com/sudhir13s/ai-ml-learning-resources/blob/1853d33659486dcb312c731e483e22d4017f8623/09.%20LLMs/09-Inference-Optimization-and-Serving/code/inference_serving.py
- **confidence**：industry_survey
- **relative_validity**：约 3 年，正在被逐项分解法取代。作为「经典对照基线」长期有效，但作为当前推荐做法已经过时——判断某个系数「是不是落后了」正是靠它。

## 9. 未解（UNVERIFIED）

- **`TPS/usr` 这个字符串本身**：公开资料里没有找到以「TPS/usr」为名的标准指标。找到的等价物是
  aiperf 的 `Output Token Throughput Per User`（= 1/ITL）与 MLPerf 的 SingleStream 延迟。
  两者都不含「架构门槛」这一层语义。因此**无法从公开资料判断本项目 `TPS/usr` 的定义是否属于
  某个既有惯例**——这一步需要本项目自己把定义写清并与上述两个口径逐项对齐（见 SOTA-TPS-01 的
  `what_to_check_here`）。
- **「架构冻结门槛」的行业惯例**：公开资料里没有找到与「架构冻结门槛」对应的标准做法或通行余量取值。
  这是 `evidence-governance.md` 单元的范畴，本文件不覆盖。
- **自研加速器在 batch=1 decode 下的达成率**：本次找到的达成率实测（33%/49%/65%）全部来自 GPU
  （RTX PRO 6000）。自研加速器的片上 SRAM 容量、TMA 深度、访存并行度与 GPU 不同，
  没有找到可类比的公开实测。
- **1M 上下文下的 decode 达成率**：没有找到公开的、1M 级上下文、batch=1 条件下的 decode 带宽达成率实测。
  第 7 节表格里的 33% 来自短上下文测点，直接在长上下文下套用是不可靠的。
- **厂商自述的 per-user 速度声明**：本轮检索未取到 Groq / Cerebras 等以「单用户 tok/s」为卖点的
  厂商声明原文（检索步数上限打断）。**因此 SOTA-TPS-01 里没有引用任何厂商自述的 per-user 数字**，
  只用了一个生产环境实测来源。这是一个明确的缺口，值得补检索。
- **MoE 专家路由倾斜下的有效放大系数未取到实测**：E/k 是按均匀路由推的代数关系；路由倾斜时实际是
  straggler 而非填充不足，公开资料里没有找到可直接引用的倾斜分布实测区间（属 `model-workload.md`
  的专家命中率范畴）。
- **`references/private/` 下的供应商材料（Memory Cube brief specification、d-Matrix / Tensordyne 公开资料）
  本次未读取**。`references/README.md` 记录它们存在但需本地放置；本文件的结论没有依赖它们，
  因此无法判断这些材料里是否已覆盖上述缺口。
