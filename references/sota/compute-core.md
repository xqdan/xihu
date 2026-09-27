# AI Core、阵列利用率与片上存储

> 领域：peak→sustained 算力折减、脉动阵列/张量核在 MoE 与 attention 上的实际利用率、tiling 与数据复用、
> TMA/DMA 与计算的 overlap、local/shared SRAM 的带宽与容量权衡、SRAM 带宽随精度切换的变化。

`as_of`: 2026-01
`review_due_months`: 12

**本文件是知识，不是证据。** 没有仓库内 `path:line`，不得作为任何 claim 的 `evidence`，不得用来覆盖、修正或重算仓库里的任何基线值。有冲突以仓库文件为准。

## 0. 与已有文件的关系

本单元文件为本次新增。README 的文件表把本单元登记为 `compute-core.md`，本文落盘到该路径。

本文覆盖 README 列出的 6 个焦点中的前 5 个（折减、阵列利用率、tiling/复用、TMA overlap、SRAM 带宽-容量权衡），
第 6 个"SRAM 带宽随精度切换的变化"只拿到间接证据，已写入 `unresolved`。

## 1. 这个领域最重要的一件事：**算力折减不是单系数，而是随形状连续变化的一条曲线**

本项目把折减处理成一个常数（`teams/hardware/inputs/k3_mc_baseline.json#basis.tech.matrixUtil`、`vectorUtil`）。
公开资料里，同类问题的做法不是给一个常数，而是给一条**关于 M（每 GEMM 的行数/有效 batch）的曲线**：

- 同一份 FP8 kernel 库、同一块卡、同一个精度，M=64 时实测 206–336 TFLOPS，M=4096 时实测 590–1358 TFLOPS（DeepGEMM / H800，2025）。
  M 差 64 倍，实测吞吐差 2–4 倍。折减主因不是"阵列有 35% 浪费"，而是**M 太小填不满**。
- 端到端 attention 上，同一块 H100 从 FlashAttention-2 的 35% 利用率到 FlashAttention-3 的 75%，靠的是
  warp specialization + 把 softmax 藏到异步 GEMM 之下（FA3, 2024）。**同一硬件、同一算法，折减从 0.35 变到 0.75。**
  这说明"填充率/kernel 利用率"是可被 kernel 工程吃掉的部分，而不是硬件的固有属性——两者必须分开记账。

对本项目的意义（作为参照系，不是结论）：decode、B=1、MoE top-k 稀疏激活这三个条件叠在一起，
落在公开资料里**利用率最低的那一档**（见 SOTA-CORE-03/06/07）。任何单一常数折减都会在这一档里偏乐观。

## 2. 方案分节

### 2.1 经典方案（上一代通行做法，用来判断"是不是落后了"）

**经典 A：脉动阵列 + 大 tile，靠 K 方向长流水吃满阵列。** TPU v1 用 256×256 的 8-bit MAC 阵列，
v2/v3 用 2 个 128×128，v4i 用 4 个 128×128（Jouppi ISCA 2017 / ISCA 2023）。这一代设计的隐含假设是
**batch 足够大、GEMM 的 M/N 能盖住阵列边长**。M 小于阵列边长时，阵列按 `M/边长` 线性降效——
这就是"阵列填充率"这个词的来源。B=1 decode 正是把 M 压到 1 的场景，是这个假设的反面。

**经典 B：register blocking / 增大 tile 提高算术强度。** 把输出 tile 放大到 (n,n,n) 形状，
使 SMEM 读一次的操作数被复用 n 次，把 kernel 从 memory-bound 推过 ridge point（WMMAe/SMEM 论文，年份 UNVERIFIED）。
当前通行做法仍是这样，只是 tile 从寄存器搬到了 shared memory / tensor memory。

**经典 C：把折减写成利用率常数。** 教科书口径的做法是：`sustained = peak × 利用率`，
利用率按 kernel 类别给经验值，并配合 roofline 判断类别是否选错（CS249r Vol.1，2025）。
这**就是本项目目前的做法**，所以本项目在方法论上并不落后于教科书；落后的风险在于
教科书明确要求"利用率按 kernel 类别分别给"，而 MoE/attention 属于该书单独点名的 low-AI 与不规则两类。

### 2.2 SOTA 方案（近两代）

**SOTA A：warp-specialized producer/consumer + 异步拷贝（TMA），把数据搬运从计算的关键路径上摘掉。**
FA3（2024）把这个做到 attention 上：producer warp 用 TMA 搬 HBM→SMEM，consumer warp 只从 SMEM 取数喂张量核，
用 `setmaxnreg` 动态分配寄存器，用 pingpong 调度让一组 warp 做 GEMM 时另一组做 softmax。
公开结果是 H100 上 FP16 达到 740 TFLOPS / 75% 利用率，FP8 接近 1.2 PFLOPS。
**关键点：overlap 不是"自动"的，是靠 warp 专门化和流水深度手工做出来的**；说"TMA 与计算 overlap 了 X%"
如果不指名流水深度、buffer 级数、障碍仲裁者，是无法核验的说法。

**SOTA B：TMA 多播 + descriptor 预取 + MoE 专用 scheduler。**
DeepGEMM（2025）在 grouped GEMM 里用 TMA multicast（一份权重广播给多个消费块）、
descriptor 预取、以及一个 MoE scheduler 来兼容多播。这是"MoE 的权重共享"在搬运层的对应做法。

**SOTA C：布局一致性作为一等约束。** FA3 明确记录：FP8 的 WGMMA **只接受 k-major 布局**，
而 attention 里背靠背 GEMM 的 FP32 累加器布局与 FP8 操作数布局会冲突，构成"调用依赖 FP8 WGMMA 的障碍"。
也就是说**切到一个更快的精度，可能因为布局/转换开销而拿不到收益**——这是本项目"SRAM 带宽随精度切换变化"必须一起记账的部分。

## 3. 明确查不到的部分（不要用相邻领域数字凑）

1. **没有任何公开来源给出"脉动阵列在 decoder 形状下的填充率分布"**（比如 48×128 阵列在 head tile 96 下的填充率）。
   能给的是端到端利用率（FA3 的 35%/75%）和 GEMM 库分形状吞吐（DeepGEMM），中间那层"阵列占用率"没有公开实测。
   本项目若要填这个洞，只能自己跑波形或 RTL 仿真。
2. **没有公开的"BF16→FP8 时 SRAM 读带宽需求变化"的折减系数。** 逻辑上推导：位宽减半 → 同样 FLOP 需要的操作数字节数减半，
   但**解包/反量化要在向量单元上再做一遍**，或者按 SOTA C 需要布局转换。公开资料只给了方向（k-major、two-level accumulation），
   没给数。DeepGEMM 的"CUDA-core 两级累加"正是这个代价的表现形态之一。
3. **没有公开的"TMA 掩盖比例"基准数。** FA3 给的是端到端结果，不是"掩盖了百分之几的搬运时间"。
4. 本轮检索中，`WebSearch` 工具在多次调用间出现分类器不可用而失败；成功的调用均通过运行时 `web_search` 取得。
   未因工具失败而编造任何一条来源。

## 4. 各卡片索引

见结构化卡片。confidence 的分配原则：论文/第三方实测 = `public_measurement`；
厂商或开源库自报自家库性能 = `vendor_datasheet`；教科书/课程讲义汇总 = `industry_survey`。
没有一条是 `model_memory`。

## 5. 知识卡

### SOTA-CORE-01 同一块 GPU 上，attention 的算力利用率可以靠 kernel 工程从 35% 提到 75%，说明折减里有一部分是可偿的

- **approach**：FlashAttention-3 的 warp-specialization + 异步 GEMM/softmax 交叠
- **what_it_is**：把 attention kernel 拆成 producer warp（只用 TMA 把 HBM 的 Q/K/V tile 搬进 SMEM）和 consumer warp（只从 SMEM 取操作数喂张量核），用 setmaxnreg 给两类 warp 动态分配寄存器，再用 pingpong 调度让一个 warpgroup 做矩阵乘、另一个做 softmax，从而把非 GEMM 的 exp/mul 藏到异步 WGMMA 之下。这套做法要求硬件同时具备异步张量核指令、异步批量拷贝（TMA）和寄存器重分配。
- **who_uses_it**：NVIDIA Hopper（H100/H800）上的生产级 attention 实现；FA3 已并入 PyTorch / HuggingFace 生态，是长上下文 attention 的默认参照实现。
- **typical_numbers**：H100 SXM5，head dim 128、长序列（无 causal mask）条件下：FlashAttention-2 BF16 约 35% 利用率；FlashAttention-3 FP16 最高 740 TFLOPS（约 75% 理论峰值，另有讲义口径写 65–85% 区间），FP8 接近 1.2 PFLOPS（H100 FP8 dense 峰值 1978 TFLOPS）；相对 FA2 加速 1.5–2.0×。注意 75% 是**无 causal mask 的长序列**条件，带 causal mask 时 FP8 相对 FP16 不占优。
- **applies_when**：稠密 attention、序列足够长（softmax 的工作量能被 GEMM 盖住）、硬件有异步张量核 + TMA + 寄存器重分配三者；kernel 实现有专门的 producer/consumer 分工。
- **not_applicable_when**：不适用于 (a) 分块 attention/稀疏 attention（本项目的 indexer、sparse attention 走的不是 QK/PV 全量路径）；(b) 序列短、softmax 相对 GEMM 占比高的场景，此时没有可掩盖的余量；(c) 阵列不是 GPU 那种「SM + 独立异步拷贝引擎」结构的自研张量核，warp specialization 的前提（独立发射流）不成立；(d) 把 75% 当作「本项目也应达到」——它是无 causal mask 的长序列最优条件，B=1 decode 不在这个条件下。
- **project_premises**：阵列填充率
- **what_to_check_here**：去核 `teams/hardware/docs/02_AI_CORE.md` 第 7 节风险 1 与第 5.4 节：H Core 的 MLA 负载是不是唯一能吃到高利用率的算子（文档自述 MLA 占近一半且几乎全在 H Core）；再核 `KERNEL_SPEC.md` 里 MLA kernel 是否给出了 producer/consumer 分工与流水级数——若没有，则「阵列填充率」目前无法从 kernel 结构反推。
- **sources**：
  - FlashAttention-3: Fast and Accurate Attention with Asynchrony and Low-precision (Dao, Shah, Bikshandi, Zhang, Thakkar, Ramani), arXiv 2407.08608 / NeurIPS 2024，2024，https://arxiv.org/abs/2407.08608
  - FlashAttention-3 官方博客（含 35%→75% 的表述与 FP8 布局约束），2024，https://tridao.me/blog/2024/flash3/
  - NeurIPS 2024 讲义 FlashAttention-3: Optimizing FlashAttention for H100 GPUs（含 up to 85% utilization 口径），2024，https://neurips.cc/media/neurips-2024/Slides/93328.pdf
- **confidence**：public_measurement
- **relative_validity**：约 2 年。绑定 Hopper 一代（WGMMA/TMA/setmaxnreg）与长序列 attention；Blackwell 之后异步模型变化，数值需重取。

### SOTA-CORE-02 切到更快的低精度会带来布局/累加器约束，可能把精度收益吃掉一部分

- **approach**：FP8 WGMMA 的 k-major 布局约束与 CUDA-core 两级累加
- **what_it_is**：Hopper 的 FP8 WGMMA 只接受 k-major 形式的 SMEM 操作数，而 FP16/BF16 WGMMA 同时接受 mn-major 与 k-major。这让「背靠背 GEMM」（attention 的 QK→PV 就是典型）难以直接连续调用 FP8 WGMMA，因为 FP32 累加器与 FP8 操作数的布局要求冲突。DeepGEMM 的应对是引入基于 CUDA core 的两级累加（two-level accumulation / promotion）来修 FP8 张量核累加精度不足的问题。两件事都意味着：低精度不是纯粹把位宽减半，它附带布局转换与额外累加步骤。
- **who_uses_it**：Hopper 上的 FP8 生产 kernel：FlashAttention-3 的 FP8 前向、DeepSeek 的 DeepGEMM（V3/R1 推理与训练）。
- **typical_numbers**：Hopper 上 FP8 张量核相对 FP16/BF16 为每 SM 2× 吞吐（H100 FP8 dense 1978 TFLOPS vs BF16 989 TFLOPS）；FA3 实测 FP8 约 1.2 PFLOPS，相对 FP16 的 740 TFLOPS 约 1.6×，而非名义 2×。DeepGEMM 在 H800 上 FP8 自报最高 1358 TFLOPS（2025-02 口径），后续版本自报 1550 TFLOPS（2025-04）。
- **applies_when**：硬件张量核对低精度操作数有布局限制、且 kernel 需要在同一循环里连续做依赖的多个 GEMM（attention、融合 FFN 等都是）。
- **not_applicable_when**：不适用于 (a) 阵列接受任意布局、或编译器/硬件能在片内低成本重排的自研张量核——此时布局约束不构成代价；(b) 单发 GEMM、无背靠背依赖的算子；(c) 只在存储侧用低精度、计算仍是 BF16 的方案（本项目的 FP8 KV + BF16 QK/PV 就属于这一类，其代价落在反量化而非布局）；(d) 不能把「FP8 名义 2×」当成实际可得 2×。
- **project_premises**：shared SRAM 余量依赖 FP8 KV
- **what_to_check_here**：去核 `teams/hardware/docs/02_AI_CORE.md` 第 7 节风险 6（原生 FP8 MAC 是否值得面积未评估，O-012）与第 5 节 FP8 KV 反量化路径；要 SW 侧回答的问题是：FP8 KV 反量化在 H Core Vector 上的开销（unpackParamsPerLaneCycle=2）是否已计入阵列填充率的分母——即反量化占用向量单元时，矩阵阵列是否同时空闲。
- **sources**：
  - FlashAttention-3（FP8 k-major 约束与累加器布局冲突的原始描述），2024，https://arxiv.org/abs/2407.08608
  - DeepGEMM README（two-level accumulation、TMA multicast、分形状吞吐表），2025，https://github.com/deepseek-ai/DeepGEMM
- **confidence**：public_measurement
- **relative_validity**：约 2 年。布局约束是 Hopper 一代的；新一代张量核的布局模型不同，约束形态会变。

### SOTA-CORE-03 小 M（decode 形状）下 GEMM 实测吞吐塌陷的具体量级

- **approach**：分形状实测 FP8 GEMM 吞吐（DeepGEMM 在 H800 上的公开表）
- **what_it_is**：同一份 FP8 GEMM 库、同一块 H800、同一精度，只改 M/N/K 形状，公开的实测 TFLOPS 表。M 是 GEMM 的行数，decode 阶段 M 约等于「一个 batch 里被路由到同一个专家的 token 数」，因此 M 直接对应阵列的填充程度。这张表是公开资料里最接近「按形状给出有效算力」的实测分布。
- **who_uses_it**：DeepSeek-V3/R1 的推理与训练；同类 FP8 kernel 库（CUTLASS 派生实现）作为对比基线；任何要在 Hopper 上做 MoE 推理的团队都在用这套形状做选型。
- **typical_numbers**：H800 SXM5、FP8、NVCC 12.8，实测（TFLOPS）：M=64 时 206–336（对应 N/K 不同的 6 组形状）；M=128 时 352–645；M=4096 时 590–1358。对照 H800 FP8 dense 峰值约 1978 TFLOPS，即 M=64 档落在峰值的约 10–17%，M=4096 档落在约 30–69%。MoE grouped（contiguous 布局）：4 组 × M=8192 得 1297 TFLOPS；8 组 × M=4096 得 1288 TFLOPS。内存带宽列同时给出 343–2668 GB/s，说明小 M 档同时是带宽受限的。
- **applies_when**：Hopper 级、FP8、规则 dense 或 grouped GEMM，且能以 M 作为形状参数描述负载。适合用来给「decode 形状的有效算力」划定区间。
- **not_applicable_when**：不适用于 (a) 自研非 NVIDIA 张量核——其阵列形状、累加器组织、MMA 指令粒度都不同，M 的临界点会移动；(b) BF16/FP16 路径——同一库的 BF16 吞吐表不同；(c) 不能把这张表的 M=64 档直接当作本项目的 sustained 折减系数，因为本项目 decode 的每个 GEMM 的 M 取决于「每专家 token 数 × TP 切分」，与本表的 M 定义需要先对齐；(d) 表里没有 TP（作者明确说明未做张量并行），TP32 下每个 rank 看到的 M 会更小。
- **project_premises**：阵列填充率
- **what_to_check_here**：去核 `teams/model/src/workload_derivation.js` 与 `out/workload/planning_operator_workload.json#operators`：把 K3/GLM-5.2/DeepSeek-V4-Pro 的每个 MoE 算子的 M 取出来（每专家 token 数、TP32 切分后的每 rank M），再与 `integration/detailed/k3_architecture_search.js` 里 L 的 1×256、H 的 48×128 阵列形状对照，算出每类算子的填充率——而不是用单一 matrixUtil。
- **sources**：
  - DeepGEMM README 分形状性能表（Normal GEMMs for dense models / Grouped GEMMs for MoE），2025，https://github.com/deepseek-ai/DeepGEMM
  - NVIDIA H100/H800 FP8 dense 张量核峰值（官方规格，用于对照），2022，https://www.nvidia.com/en-us/data-center/h100/
- **confidence**：vendor_datasheet
- **relative_validity**：约 2 年。是单个开源库自报的、绑定 H800+Hopper 一代的实测；换代际或换库数值会变，但「M 小一个数量级、吞吐掉 2–4 倍」的量级关系稳定。

### SOTA-CORE-04 MoE grouped GEMM 的组数与每组 M 共同决定有效算力

- **approach**：Grouped GEMM（只沿 M 分组，N/K 固定）
- **what_it_is**：MoE 推理把「多个专家、每个专家处理不同数量 token」组织成一次 kernel launch 的 grouped GEMM：DeepGEMM 的设计是只沿 M 轴分组、N 与 K 必须固定，这正是「专家形状相同」的 MoE 的形态。分组的好处是省掉每专家的 kernel launch；代价是每组的 M 变小，且各组的 M 不相等。另一种布局是 masked grouped GEMM，给一个 mask tensor，kernel 只算有效部分——decode 阶段在 CUDA graph 下 CPU 不知道每专家收到多少 token 时用这种。
- **who_uses_it**：DeepSeek-V3/R1 的 MoE 推理（contiguous 与 masked 两种布局），以及所有在 Hopper 上跑 MoE 的推理栈。
- **typical_numbers**：H800、FP8：4 组 × M=8192（contiguous）实测 1297 TFLOPS（速度优势 1.2× vs CUTLASS 3.6 基线）；8 组 × M=4096 实测 1288 TFLOPS（1.2×）；8 组 × M=4096 的 N=7168/K=2048 组合实测 1093 TFLOPS（1.1×）。即组数从 4 增到 8、每组 M 从 8192 降到 4096 时，吞吐基本持平但优势收窄。
- **applies_when**：专家形状相同（N/K 一致）的 MoE；推理服务里希望把多专家计算压到一次 launch；能提供 mask 或按 M 块对齐的连续布局。
- **not_applicable_when**：不适用于 (a) 专家形状不一致（N/K 不同）的 MoE——只分组 M 的做法失效，退化回逐专家 launch；(b) 要把组数 × 每组 M 的乘积直接当作可用算力——组数增加会同时抬高调度与 mask 开销；(c) 非 Hopper 张量核；(d) 本项目若把 FFN/MoE 映射为 TP-only（仓库记录这是一个部署决定），则每 rank 的专家数与 M 分布和公开资料的 EP 场景不同，数值不可平移。
- **project_premises**：阵列填充率
- **what_to_check_here**：去核 `teams/model/docs/deployment/` 下 GLM-5.2 与 DeepSeek-V4-Pro 的部署方案：确认 TP-only 映射下每个 rank 上每层被激活的专家数、以及每专家的 token 数（= M）；再核 `integration/detailed/k3_rdma_final_tuning_model.js` 里 Router/Expert 算子是否按 grouped GEMM（一次 launch）还是按专家逐个建模——逐个建模会低估 launch 开销但也高估了每组的 M。
- **sources**：
  - DeepGEMM README（grouped GEMM contiguous / masked 布局与性能表），2025，https://github.com/deepseek-ai/DeepGEMM
  - 从汇编到 PyTorch: 基于 MI300X 的 DeepSeek 算子全栈设计和调优（AMD Developer Contest 2025，MoE→grouped GEMM 的动机与 SplitK 并发展示），2025，https://ipads.se.sjtu.edu.cn/_media/talk/radeonflow-amd-develop-challenge-2025.pdf
- **confidence**：vendor_datasheet
- **relative_validity**：约 2 年。绑定 Hopper + 单库自报；grouped GEMM 这一组织形式本身是当前通行做法，会持续存在。

### SOTA-CORE-05 MoE 路由的 padding 会直接吃掉阵列的有效算力，且两种 padding 方案的最坏情况相反

- **approach**：blockwise padding vs max padding
- **what_it_is**：MoE 路由后每个专家拿到的 token 数不相等，GEMM kernel 要求对齐的维度，于是要把 ragged 输入补齐，补出来的空槽仍然要过阵列。公开分析指出两种生产 kernel 常用方案：blockwise padding（每个专家的 token 数各自向上取整到块边界，FusedMoE 与 DeepGEMM prefill 用）与 max padding（所有专家补齐到同一个等于最大每专家 token 数的维度，DeepGEMM decode 用）。两者的最坏情况相反：blockwise 被「专家多、每专家 token 少」的分散分布放大，max 被「单专家 token 极多」的集中分布放大。
- **who_uses_it**：生产 MoE 推理 kernel（FusedMoE 系与 DeepGEMM 系）；做 MoE 服务容量规划的团队用它估算 padding 税。
- **typical_numbers**：在 TP + FusedMoE kernels、用剖析得到的实际 token 分布下：prefill 阶段 padding 税随 batch 增大而增大，达到约 15–25%；专家数多的模型（如 Qwen）比专家数少的（如 Mixtral）更严重。decode 阶段两者随 batch 的 padding 延迟影响都更小。另有一条同源结论：即使 token 分布完全均匀也可能产生 padding，因为开销取决于块对齐而非偏斜。
- **applies_when**：任何有 top-k 路由、且 kernel 要求对齐维度的 MoE；用来把「路由造成的算力浪费」从这个折减系数里单独拆出来。
- **not_applicable_when**：不适用于 (a) 不用 grouped GEMM、逐专家单独 launch 且 kernel 不要求 M 对齐的实现；(b) 把 15–25% 当作通用常数——它是特定模型、特定 kernel、特定分布下的实测，本项目专家数、top-k、TP 切分都不同；(c) 该数据主要来自 prefill，decode 的 padding 影响来源未给数；(d) 专家数与 top-k 差异大的模型之间不可直接平移。
- **project_premises**：阵列填充率
- **what_to_check_here**：去核 `out/contracts/model_workload_contract.json` 与 `teams/model/src/workload_derivation.js` 里是否对每专家 token 数做了对齐/padding 建模；若 Router/Expert 算子按「理论激活 token 数」直接算 FLOP，则 padding 浪费尚未入账，应在 `KERNEL_SPEC.md` 里补一行。
- **sources**：
  - MoE inference tax analysis（padding scheme：blockwise vs max；prefill padding 15–25%；专家激活随 batch 饱和），UNVERIFIED，https://openreview.net/pdf?id=lELxqcgrsN
- **confidence**：public_measurement
- **relative_validity**：约 2 年。方案分类（blockwise/max padding）稳定，具体百分比随模型与 kernel 变动大。

### SOTA-CORE-06 MoE 要达到与稠密模型相同的算术强度，batch 要放大约 E/k 倍——这是 decode 张量核填不满的结构性来源

- **approach**：MoE 每专家有效 batch 的 E/k 折损
- **what_it_is**：均匀路由时每专家平均只收到 b·k/E 个 token（b=batch，k=top-k，E=专家总数）。因此 MoE 的「每专家有效 batch」比同规模稠密模型小 E/k 倍，要拿到与稠密模型相同的算术强度，batch 需要放大约 E/k 倍。这是一个组合性质，与硬件无关，也是为什么 decode 阶段 MoE 的阵列填充率天生比稠密模型差。
- **who_uses_it**：MoE 推理系统设计的通用分析口径（作为 batch 放大需求的推导基础）；用来解释「为什么 MoE decode 必须靠 continuous batching 把 batch 抬起来」。
- **typical_numbers**：以 E=256、k=8 为例，放大倍数为 32×（即要达到稠密模型 batch=b 的算术强度，MoE 需要 batch≈32b）。同源结论：小 batch 下非均匀分布会把 token 集中到更少专家上，减少被激活的专家数 E_active，反而降低 decode 的权重装载量（对 MoE decode 有利）；prefill 阶段大部分专家本来就会被激活，且 kernel 是 compute-bound，分布影响不显著。另有公开实测口径：专家激活数随 batch 迅速饱和。
- **applies_when**：top-k 路由的 MoE，且能用「每专家平均 token 数」刻画负载；用来把 batch 放大需求写成可核验的倍数。
- **not_applicable_when**：不适用于 (a) batch=1 的 decode——此时 E/k 的放大需求无法通过 batching 满足，结论退化为「张量核在这个形状下拿不到高利用率」，而不是「多 batch 就好」；(b) 非均匀路由且能被利用的场景（专家集中在少数几个时，E_active 变小，权重装载减少，MoE decode 反而受益）；(c) 不能把 32× 当作普适常数——它完全由 E 与 k 决定，本项目模型的具体 E/k 不同。
- **project_premises**：阵列填充率
- **what_to_check_here**：去核 `teams/model/src/design_engine.js` 的 kimiK3 preset 与 GLM-5.2 / DeepSeek-V4-Pro 的 manifest（E 与 k），算出各自的 E/k；再核该值是否已被写进任何以「阵列填充率」为由的折减依据里——如果没有，说明 MoE 结构性折损与 kernel 效率折损目前混在同一个系数里。
- **sources**：
  - Berkeley EECS-2025-192 技术报告（MoE 每专家有效 batch 的 E/k 折损，E=256/k=8 → 32×），2025，http://www2.eecs.berkeley.edu/Pubs/TechRpts/2025/EECS-2025-192.pdf
  - MoE inference tax analysis（专家激活随 batch 饱和、E_active 影响 GroupGEMM 算术强度），UNVERIFIED，https://openreview.net/pdf?id=lELxqcgrsN
- **confidence**：public_measurement
- **relative_validity**：约 3 年。E/k 的代数关系与硬件代际无关，长期有效；具体模型的 E/k 随模型换代变化快。

### SOTA-CORE-07 batch-1 decode 在 roofline 上的位置：算术强度约 1 FLOP/byte，而机器平衡点是两三个数量级更高

- **approach**：roofline / 算术强度分析（经典口径）
- **what_it_is**：算术强度 = FLOPs / 移动的字节数。roofline 给出上界 T ≤ min(peak_compute, BW × I)。prefill 的强度高、是 compute-bound；decode 每生成一个 token 要把整个权重矩阵过一遍内存总线而只做 1 个 token 的计算，强度极低、是 bandwidth-bound。这是判断「算力折减该不该发生」的第一性口径：在 decode 上，算力阵列大部分时间是空的，不是因为阵列差，而是因为工作本身没给它活干。
- **who_uses_it**：推理系统容量规划与硬件选型的通用口径（教科书、MLPerf 分成 bulk-throughput 与 latency-constrained 两类跑法正是对应这一点）；也用于解释为什么大 batch 的 continuous batching 能提升吞吐。
- **typical_numbers**：典型算例：70B 参数、FP16、batch=1，把 140 GB 权重从 HBM 搬一次、做约 140 GFLOP，算术强度约 1 FLOP/byte。H100 SXM 的 BF16 dense 峰值约 989 TFLOPS、HBM 带宽 3.35 TB/s，机器平衡约 295 FLOP/byte。教科书给出的 batch 扫描：M=N=2048 的 FP16 层，batch=1 时 AI≈1 FLOP/byte（memory-bound），batch=32 时 AI≈31（仍 memory-bound），batch=256 时 AI≈204.8（在 A100 上转 compute-bound）。另有实测：batch=1 时同源 roofline 上界与实测可达之间有较大差距，实测可达比例在不同模型上落在约 18%–74% 的宽区间。
- **applies_when**：用 roofline 判断某阶段该不该期待高算力利用率；给「算力折减」这一系数划出一条物理下界；解释 batch 扫描的方向。
- **not_applicable_when**：不适用于 (a) 本项目 B=1 且 context=1M——此时 KV 读取量远大于权重读取量，算术强度公式必须把 KV 字节计入分母（分母主导项从 W 变成 KV），结论会与本卡片举例的 batch-1 短上下文算例不同；(b) 该口径只能定「上界在哪」，不能给出「实际能达到多少」——实测可达比例区间极宽（18%–74%），不能用它反推折减系数；(c) TP32 下权重按 rank 切分，每 rank 的权重字节与机器平衡点都要重算。
- **project_premises**：阵列填充率
- **what_to_check_here**：去核 `teams/hardware/docs/02_AI_CORE.md` 第 2.3 节（模型对所有矩阵算子乘 0.65、向量算子乘 0.35、layout imbalance 1.15）与 21 号文档：把发布点的 compute 时间按算子拆开，标出每个算子在 roofline 上的位置（compute-bound 还是 bandwidth-bound）。bandwidth-bound 的算子不该用矩阵利用率折减，而该用带宽折减——两套口径混用会让「阵列填充率」这个前提无法被单独证伪。
- **sources**：
  - Machine Learning Systems (Vol.1), Harvard CS249r（roofline、算术强度分档表、batch 扫描算例、MLPerf bulk-throughput vs latency-constrained），2025，https://harvard-edge.github.io/cs249r_book_dev/
  - What is GPU VRAM bandwidth and why is decoding memory-bound（70B/FP16/batch-1 算例，H100 989 TFLOPS vs 3.35 TB/s），UNVERIFIED，https://raw.githubusercontent.com/mchittineni/ultimate-ai-engineering-guide/refs/heads/main/ai-system-design/what-is-gpu-vram-bandwidth-and-why-is-decoding-memory-bound.md
- **confidence**：industry_survey
- **relative_validity**：约 5 年。roofline 口径本身长期有效；举例中的峰值/带宽数字随代际变化。

### SOTA-CORE-08 脉动阵列的填充率损失是阵列边长的函数——这是「阵列填充率」这个词在经典设计里的原始含义

- **approach**：TPU 系大边长脉动阵列（256×256 / 128×128）
- **what_it_is**：经典脉动阵列设计用固定的方形阵列（TPU v1 为 256×256 的 8-bit MAC 阵列，v2/v3 为 2 个 128×128，v4i 为 4 个 128×128），数据从阵列两侧按节拍流入。当 GEMM 的 M 或 N 小于阵列边长时，阵列的一部分在这一次矩阵乘里没有活干；当 K 小于阵列深度时需要多次载入/排空。阵列越大，峰值越高，但填充率对小形状越敏感——这是「阵列填充率」作为独立损耗项的来源，也是经典设计用**大 batch 训练**作为主场景的隐含原因。
- **who_uses_it**：Google TPU 全系（v1–v4i）以及所有以「大方形 MAC 阵列 + 软件管理的片上缓冲」为组织方式的推理/训练加速器；本项目 L 的 1×256、H 的 48×128 属于这一谱系。
- **typical_numbers**：TPU v1：1 个 256×256 MXU，28 MB 片上存储、34 GB/s 内存带宽、92 TOPS int8、700 MHz、40 W。TPU v2/v3：2 个 128×128 MXU，32 MB 片上存储，v3 内存带宽 900 GB/s、123 TFLOPS bf16、940 MHz。TPU v4i：4 个 128×128 MXU，144 MB 片上存储，138 TFLOPS bf16/int8、1050 MHz、175 W（1.1 PFLOPS 密集 / 2.2 PFLOPS 含 2:4 稀疏，为 v4 芯片口径）。片上存储与峰值算力之比在这一代间变化很大（v3 约 32 MB / 123 TFLOPS，v4i 约 144 MB / 138 TFLOPS）。
- **applies_when**：用方形大阵列、由软件显式管理片上缓冲的加速器；评估「阵列形状 vs 算子形状」是否匹配时。
- **not_applicable_when**：不适用于 (a) GPU 那种小 MMA 片段（如 16×16）拼接的路线——其填充率损失的来源与形态完全不同（受 warp 数与寄存器供给约束，而不是阵列边长）；(b) 阵列形状不等边时的分析不能套用方阵结论——本项目 L 是 1×256、H 是 48×128，填充率的正则也不同（L 的 1 行意味着 M 方向永远是 1，填充率只能靠 N 方向）；(c) 不能拿 TPU 的批处理训练场景的利用率去类比 B=1 decode。
- **project_premises**：阵列填充率
- **what_to_check_here**：去核 `teams/hardware/docs/02_AI_CORE.md` 第 7 节风险 3（1×256 与 48×128 是逻辑阵列形状，物理子阵列划分尚未定义，O-005）与风险 1（H 的 48×128 在 head tile 96 下的填充率未验证）：先算出每个算子的 (M, N, K) 对阵列的填充率，再决定是否需要引入物理子阵列划分（例如把 48×128 拆成两个 24×128 以提升小 N 的填充率）。
- **sources**：
  - Jouppi et al., In-Datacenter Performance Analysis of a Tensor Processing Unit, ISCA 2017（TPUv1 256×256 MXU），2017，https://dl.acm.org/doi/10.1145/3079856.3080246
  - Jouppi et al., TPU v4: An Optically Reconfigurable Supercomputer for ML with Hardware Support for Embeddings, ISCA 2023，2023，https://arxiv.org/abs/2304.01433
  - NYCU IOC5009 课程讲义：Tensor Processing Unit / Systolic Execution（TPUv1–v4i 规格汇总表与 128×128 阵列填充率算例），2024，https://people.cs.nycu.edu.tw/~ttyeh/course/2024_Fall/IOC5009/slide/lecture-5.pdf
- **confidence**：industry_survey
- **relative_validity**：约 5 年。阵列形状这条设计轴长期存在；具体规格是 TPU 特有。

### SOTA-CORE-09 片上存储带宽/算力比随张量核代际恶化，操作数供给成为新的瓶颈——这是 SRAM 带宽权衡的定量出发点

- **approach**：操作数供给路径的代际演进（私有寄存器 → shared memory → tensor memory / cross-SM 共享）
- **what_it_is**：张量核每 SM 每周期 FLOPs 逐代翻倍（Ampere 2048 → 后来 4096 → 8192 FLOPs/SM/cycle），而每个 SM 的操作数供给带宽相对滞后。公开分析指出：Ampere 上靠私有寄存器供操作数已接近饱和；到 4096 FLOPs/SM/cycle 时私有寄存器供给到达 compute-/memory-bound 的转折点，其控制开销使其无法完全发挥；到 8192 时私有寄存器供给明确是 memory-bound。Hopper/Blackwell 的应对是把操作数供给改到 shared memory / tensor memory，消除 SM 内的数据重复，使计算强度翻倍；Blackwell 进一步做跨 SM 共享。这是「SRAM 带宽必须随算力同比放大」这条约束的定量版本。
- **who_uses_it**：NVIDIA Ampere 之后的全部数据中心张量核；对本项目这类自研阵列，是「local SRAM 带宽应当按什么比例配」的直接参照。
- **typical_numbers**：Ampere 张量核 2048 FLOPs/SM/cycle；代际演进到 4096、8192 FLOPs/SM/cycle。实测 SMEM 带宽与算力对照：V100 上 SMEM 约 14.1 TB/s 对 125.0 TFLOPS；A100 上 SMEM 约 19.5 TB/s 对 312.0 TFlop/s。换算成每 FLOP 需要的 SMEM 字节数约为 V100 0.113 B/FLOP、A100 0.063 B/FLOP——即同样的算力增量，需要新增的 SRAM 带宽比例在下降，但这依赖寄存器阻塞 (n,n,n) 的复用因子。另：Volta 的 L1/shared 合并吞吐为 128 B/cycle，Turing 为 64 B/cycle。
- **applies_when**：评估「矩阵阵列峰值算力」与「喂它的 SRAM 读带宽」是否配平；判断增加阵列面积时 SRAM 端口/bank 面积是否会被动放大。
- **not_applicable_when**：不适用于 (a) 拿 GPU 的 B/FLOP 数值直接给自研阵列定端口规格——复用因子由 tile 形状与寄存器/累加器组织决定，与阵列形状强相关；(b) 数据源不是 SMEM 而是 direct RDMA-to-SRAM 的搬运路径时——此时瓶颈可能是搬运通道而非 SRAM 端口，另一套口径；(c) 稀疏/掩码执行下有效 FLOP 与名义 FLOP 不同，B/FLOP 会失真；(d) 0.063 B/FLOP 是 A100 特定 tile 配置下的数，不能当通用常数。
- **project_premises**：matrix density 3.2、shared SRAM 余量依赖 FP8 KV
- **what_to_check_here**：去核 `teams/hardware/docs/03_TMA_AND_SRAM.md` 与 `integration/detailed/k3_architecture_search.js` 第 22 行（sharedRead = slices×512×f/1000×bankUtil，sharedWrite = sharedRead/2）与第 133 行（ports = max(wire/sharedRead, wire/sharedWrite)）：算出发布点的每 FLOP 需要多少 shared SRAM 读字节，与 local SRAM 的 3.07 TB/s（bank 利用率 0.75）对照，确认端口带宽放大（k3_mc_baseline.json#sharedPortScalingCost）是按 compute 峰值同比算的，还是按发布点实际 compute 算的。
- **sources**：
  - Reducing shared memory footprint to leverage high throughput on Tensor Cores and its flexible API extension library（V100 SMEM 14.1 TB/s / 125 TFLOPS，A100 19.5 TB/s / 312 TFlops，register blocking (n,n,n) 算术强度），UNVERIFIED，https://www.semanticscholar.org/reader/c842a5c79f8312cd2f626052996ed416c91c5b29
  - A Thread-Register Decoupled GPU Execution Model for Efficient Tensor Computation (FIBER)（2048/4096/8192 FLOPs/SM/cycle 的操作数供给转折点；Hopper/Blackwell 改用 shared/tensor-memory 供给），UNVERIFIED，https://www.semanticscholar.org/reader/4b5e5626f4e68e3576d3519c936e3966f05e8016
  - NVIDIA GTC 2019, Volta and Turing Architecture and Performance Optimization（Volta L1/shared 128 B/cycle、Turing 64 B/cycle，L1/shared carveout），2019，https://developer.download.nvidia.com/video/gputechconf/gtc/2019/presentation/s9234-volta-and-turing-architecture-and-performance-optimization.pdf
- **confidence**：public_measurement
- **relative_validity**：约 3 年。趋势（算力涨得比操作数供给快）稳定；具体 B/FLOP 数值绑定各代 GPU 的 tile 配置。

### SOTA-CORE-10 TMA/DMA 与计算 overlap 的成熟做法是 producer-consumer 分工 + 多级 buffer，而不是「自动重叠」

- **approach**：warp specialization + 多级流水 SMEM buffer + TMA 多播/描述符预取
- **what_it_is**：把搬运与计算分派给不同的 warp 角色：producer 只发异步批量拷贝（TMA）并用 barrier/semaphore 报到达，consumer 只从 SMEM 读操作数做 MMA；SMEM 用多级循环 buffer（如 4 级）让搬运始终领先计算若干级。FA3 用 8 个 consumer warp + 4 个 producer warp + 4 级流水作为其默认配置；DeepGEMM 用 TMA multicast（一份权重广播给多个消费块）、descriptor 预取、以及跨调度块的流水级共享。要点是：overlap 程度由**流水级数、buffer 容量、barrier 仲裁者数**这三个参数决定，是可指名的工程量，不是一个可以随手填的百分比。
- **who_uses_it**：Hopper 上的生产 attention 与 GEMM kernel（FA3、DeepGEMM、CUTLASS 3.x 派生实现）；昇腾侧对应 AIC/AIV 双核独立指令流 + MTE 搬运 + BufferID 标识缓冲组交接的同类机制。
- **typical_numbers**：FA3 默认配置：8 个 consumer warp、4 个 producer warp（每 block 共 12 warp）、4 级输入流水；producer 侧只需 1 个 warp（实际 1 个线程）即可发出 TMA，用 `tma::expect` 告诉 barrier 有 64×64 与 64×256 的 tile 各要到达多少字节。这套结构换来的端到端结果是 attention 从 35% 到 75% 利用率。DeepGEMM 侧 TMA 用于 load/store、多播与描述符预取。Volta 的 L1/shared 为 128 B/cycle，SMEM 容量按 carveout 在 0/8/16/32/64/96 KB 等档位分配（Volta 最大 96 KB shared，Turing 64 KB）。
- **applies_when**：有独立的异步拷贝引擎（TMA/DMA）+ 多缓冲 SMEM + 可分配寄存器或 warp 角色的硬件；kernel 的搬运量与计算量比例使得多级流水有东西可藏。
- **not_applicable_when**：不适用于 (a) B=1 decode 下每层集合通信都在依赖主链上的场景——公开的 producer/consumer 结构藏的是**同一 kernel 内的搬运**，藏不住跨 rank 的同步等待，两者不能混算成同一个 overlap 项；(b) 没有硬件异步拷贝引擎、只能靠软件流水模拟的阵列——overlap 上限低得多；(c) 把「4 级流水」当作通用建议——级数由延迟×带宽（在途字节数）决定，不满足在途字节时提高级数不解决问题，反而挤占 SMEM 容量；(d) 不能把 FA3 的 overlap 结果迁移到 MoE grouped GEMM 上，后者的搬运模式（多播权重 + 散列 token）不同。
- **project_premises**：shared SRAM 余量依赖 FP8 KV
- **what_to_check_here**：去核 `integration/detailed/k3_rdma_final_tuning_model.js` 里 `OPT.tmaLane` / `services.tmaFill` / `services.tmaHidden` / `b.tmaExposedUs` 的算法：确认 tmaHidden 是「一个算子内搬运与计算重叠」还是「跨算子/跨集合通信重叠」，并核 `teams/hardware/docs/03_TMA_AND_SRAM.md` 给出的 TMA 并发状态机是否写明了流水级数与 buffer 容量——没有这两项，重叠时间就不可核验（对齐 `teams/hardware/docs/02_AI_CORE.md` 第 7 节风险 2 的 B-003 要求：融合必须以具体 kernel 表达）。
- **sources**：
  - FlashAttention-3（producer-consumer warp specialization、4 级流水、tma::expect 配置细节），2024，https://arxiv.org/abs/2407.08608
  - DeepGEMM README（TMA load/store/multicast/descriptor prefetch、跨调度块共享流水级），2025，https://github.com/deepseek-ai/DeepGEMM
  - Stanford CS149 Fall 2025 讲义 11: Specialized Hardware Programming（H100 上 TMA descriptor + 多级流水 producer/consumer 模板代码与「>90% TFLOPS 要求计算永不空闲」的设计原则），2025，https://gfxcourses.stanford.edu/cs149/fall25content/media/proghardware/11_SpecializedHardwareProgramming.pdf
- **confidence**：public_measurement
- **relative_validity**：约 2 年。producer/consumer + 多级缓冲的结构是当前主流；具体级数与参数随硬件与 kernel 变化。

### SOTA-CORE-11 数据复用（tiling/register blocking）决定「有效算力」，而精度本身不改变复用——精度的收益可能被转换开销吃掉

- **approach**：tiling + 寄存器/片上阻塞提升算术强度；低精度的收益需扣除转换与缩放开销
- **what_it_is**：片上复用的程度由数据流（dataflow）与 tile 形状决定，不由精度决定：把输出 tile 放大到 (n,n,n) 使同一份操作数在片上被复用 n 次，算术强度随之上升，kernel 从 memory-bound 越过 ridge point 进入 compute-bound。降精度（FP32→FP16→FP8）同时做两件事：减少每个操作数的字节数、提高单位面积的 MAC 密度，因此同时压低 roofline 两侧；但**布局转换、缩放（scaling）与回退（fallback）的开销会抵消一部分收益**——这一点在 FP8 上尤其明显（见 SOTA-CORE-02）。
- **who_uses_it**：所有 GPU 上高性能 GEMM 的实现路线（CUTLASS/CuTe 及其派生）；教科书把它列为 medium-AI（20–200 FLOP/byte）区间的首选手法。
- **typical_numbers**：教科书按算术强度分档给出优先手法：高 AI（>200 FLOP/byte）优先提算力利用率（张量核、thread-block 调优、高 occupancy）；中 AI（20–200）平衡算力与访存（增大 batch、register tiling、与相邻算子融合）；低 AI（<20）优先减少访存（激进融合、降精度 FP16→INT8、算法改动）；极低 AI（<2）消除访存往返（融合、in-place）。量化示例：M=N=2048 的 FP16 层，batch=1/32/256 分别对应 AI≈1/31/204.8，即在 A100 上 batch=256 才转 compute-bound。另外，公开分析显示：在同一块 GPU 上，纯 GEMM 投影类负载从寄存器共享等数据流改造中受益最小（约 80% 的场景受益明显的是**GEMM 与其它算子交错**的负载）。
- **applies_when**：评估「提高 tile/增大复用能否把有效算力拉上来」；判断某个算子在 roofline 上处于哪一档、该用哪一类优化。
- **not_applicable_when**：不适用于 (a) B=1 decode —— 该档位的 AI 由权重装载（batch=1 时权重只被复用 1 次）锁死，tile 调优救不回来，只有增大 batch 或减少权重字节才行；(b) 交错大量非 GEMM 操作的负载（attention、MoE 路由）不能套用「纯 GEMM 的 tile 调优结论」——公开分析明确说这类负载的收益来自数据流改造而非 tile 尺寸，且 decode 负载本来就不用张量核；(c) 不能因为「降精度同时缓解两侧」就假定线性收益，转换/缩放开销需单独记账；(d) 教科书的分档阈值（20/200 FLOP/byte）绑定具体机器的 ridge point，换机器要重算。
- **project_premises**：matrix density 3.2、阵列填充率
- **what_to_check_here**：去核 `teams/software/docs/KERNEL_SPEC.md` 每类 kernel 的 cycle 模型：确认 tile 形状（weight tile / KV tile / head tile）与每类算子的算术强度是否已被列出——若只有矩阵利用率一个系数，则无法判断「提高 tile 复用的收益空间」。同时核 `teams/hardware/docs/02_AI_CORE.md` 第 5.4 节三个模型的 H 侧负载表：GLM/DeepSeek 的 H 负载远低于 K3，文档自述瓶颈转到权重字节与集合通信，与 (a) 的判断一致。
- **sources**：
  - Machine Learning Systems (Vol.1), Harvard CS249r（算术强度分档与优先手法表；batch 与 AI 的量化算例；精度对 roofline 两侧同时作用），2025，https://harvard-edge.github.io/cs249r_book_dev/
  - A Thread-Register Decoupled GPU Execution Model (FIBER)（数据流改造对 GEMM-bound 负载收益最小、对交错负载收益最大；decode 负载不用张量核、1.12× 加速），UNVERIFIED，https://www.semanticscholar.org/reader/4b5e5626f4e68e3576d3519c936e3966f05e8016
- **confidence**：public_measurement
- **relative_validity**：约 3 年。tiling/复用是长期有效的方法论；分档阈值与收益百分比绑定具体硬件。

## 6. 未解（UNVERIFIED）

### 1. 阵列级填充率的实测分布（本单元最关键的缺口）
公开资料能给两端，给不了中间：
- 一端：端到端利用率（FA3 实测 35%→75%，H100，长序列）；
- 另一端：GEMM 库按形状的吞吐（DeepGEMM，H800，M=64 档 206–336 TFLOPS vs M=4096 档 590–1358 TFLOPS）。

**中间那层——「阵列在一次矩阵乘里被填了百分之几」以及它在真实 workload 上的分布——没有公开实测。**
DeepGEMM 的 M 已经把「填充」折算进了吞吐，但它绑定 Hopper 的阵列形状与 MMA 粒度。
本项目 L 是 1×256、H 是 48×128，形状与 GPU 不同，M 的临界点会移动。
需要补的是：**每个算子 (M, N, K) → 阵列占用率的映射，以及在这个映射下的加权平均占用率**。
来源上，行业里这类数字通常来自 RTL 波形/门级仿真或 FPGA 原型，且属厂商内部资料，不公开发表。

### 2. SRAM 带宽随精度切换的变化量
只拿到方向性证据，没拿到数：
- FP8 张量核的 WGMMA 只接受 k-major 操作数（FA3，2024）→ 布局转换有成本；
- DeepGEMM 用 CUDA core 做两级累加来补 FP8 累加精度（2025）→ 累加路径有额外步骤；
- 操作数供给路径逐代从私有寄存器搬到 shared/tensor memory 以「使计算强度翻倍」（FIBER，年份未标注）→ 供给带宽是紧约束。

但**没有任何公开来源给出「BF16 → FP8 时，喂满同样 FLOP 所需的 SRAM 读字节数变化比例」**，
也没有给出解包/反量化在向量单元上的开销占多少。缺的是：
- 厂商（NVIDIA/AMD/华为）关于 shared memory 端口带宽随精度切换的微基准；
- 或针对本项目阵列的反量化开销量化。

### 3. TMA/DMA 与计算的 overlap 上限
FA3 给了端到端利用率，DeepGEMM 给了 TMA 使用方式，但两者都没给
「搬运时间中被掩盖的比例」这个独立指标。公开资料里这个量通常以 kernel profile 的形式出现在
厂商的 profiler 文档或会议 tutorial 里，本轮未检索到可直接引用的数值。
需要补的：Nsight Compute 的「memory throughput pipe busy vs tensor pipe busy」对照基线。

### 4. peak → sustained 的行业通行折减区间
没有找到任何权威来源给出一个「行业通行的 peak→sustained 折减系数」。
公开资料的做法一律是**分形状/分 kernel 实测**，不给单一系数。
这一点本身是结论性的：**用单一系数（不论它是 0.65 还是 0.88）描述 sustained 折减，
在市场实践里没有对应的参照物**——参照物是一条曲线，不是一个点。
本项目若要为这个系数取证，能取到的是「该形状下的实测吞吐」，而不是「该系数的正确取值」。

### 5. 本轮未能完成的检索
- `WebSearch` 工具在会话中途多次返回分类器不可用错误；所有成功的结果均通过运行时 `web_search` 取得。
- 想找但没找完的三条线索：MLPerf Inference 的 datacenter 分项里 attention/GEMM 的实测 MFU 报告；
  NVIDIA CUTLASS 官方的 effective FLOPs 分析文档；昇腾/寒武纪等国产加速器的阵列利用率公开材料。
  这三条若拿到，可显著补强 SOTA-CORE-03 与 SOTA-CORE-11 的 not_applicable_when 边界。

### 6. 关于来源年份
部分来源（WMMAe SMEM 论文、FIBER 论文、CS249r 二手引用页、MoE tax 分析）的检索结果里没有返回明确年份，
已在该卡片 sources 的 `year` 字段标 `UNVERIFIED`，未推测年份。这类条目的 `relative_validity`
也相应写成更保守的表述。
