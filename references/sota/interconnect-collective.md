# 互联、Die-to-Die 与集合通信（knowledge, not evidence）

as_of: 2026-01

**本文不是证据**，不得作为任何 claim 的 `evidence`，不得覆盖、修正或重算仓库内任何基线数字。本文只回答一个问题：本领域同行通常怎么做、那些"当作给定条件"的系数通常取多少，从而判断某个假设是否偏离常规、值不值得优先取证。

## 0. 本领域的四层账

讨论"有效带宽折减"和"allreduce 开销"时，公开资料里其实是四层独立的账，混在一起谈就会得到互相矛盾的数字。分清层次是本单元最重要的结论：

| 层 | 折减来源 | 公开资料里的典型量级 |
|---|---|---|
| L1 链路层 | 无 8b/10b、无 128b/130b（UCIe 明确不需要）；DDR 转发时钟 | 几乎为 0 |
| L2 D2D adapter（flit） | flit header + CRC（+ retry） | 68B flit 约 5.9%；256B flit 约 2%；Raw/Format-6 可降到 0 |
| L3 协议层 | 包/缓存行粒度、读写转向、credit、MPE 的 NOP 插入 | 公开资料缺端到端实测；MPE 模式下上限 50% |
| L4 系统层 | 电源态进出、拥塞、同步/启动开销、SM 争用 | 与消息大小强相关，小消息由 α（延迟项）主导 |

只看 L2 会得出"UCIe 协议效率接近 1"，只看 L4 会得出"效率不到一半"。二者都对，但**不能互相替代**。

## 1. UCIe / Die-to-Die 协议效率与有效带宽折减

### 1.1 flit 格式与 D2D adapter 的字节账（现行标准做法）

UCIe 的可靠性层在 D2D adapter，用固定长度 flow-control unit（Flit）做 CRC 与链路级 retry。Hot Chips 2023 的官方教程给出了逐格式的字节分布：

- **Format 1 Raw**：协议层填满全部字节，D2D adapter 数据通路被旁路，不做任何修改或追加。Streaming 协议**必须**支持 Raw。
- **Format 2 68B**：协议层在 FDI 上给 64B，adapter 加 2B flit header + 2B CRC 并做 barrel shift。→ 有效载荷比 64/68 ≈ **94.1%**。因为 68 不是 lane 数的整数倍，需要一个 pause-of-data-stream 指示，且该指示后面至少还要传 256B 的全零数据。
- **Format 3/4 Standard 256B**（PCIe Flit Mode / CXL 3.0 必需）：结尾带 2 组 CRC。PCIe 与 CXL 的原生 flit 有 6B FEC + 8B CRC，UCIe 版本去掉了 FEC。
- **Format 5/6 256B latency-optimized**：Format 6 把为 FEC/CRC 预留的 **14B 重新用于协议载荷**；对 CXL.cachemem 而言"flit 中不再有保留字节"，规范**强烈推荐**。

另有一条容易忽略的**正向**事实：UCIe 明确**不需要** 8b/10b 或 128b/130b 编码。所以和 PCIe 系链路比，UCIe 少掉的是编码开销，剩下的是 flit header/CRC 这一小块。

**结论型常识**：flit 级别的协议开销是几个百分点量级，不是几十个百分点。

### 1.2 可以完全消掉的协议开销：Raw Mode

Raw Mode 在 UCIe 里是**合规选项**而非 hack：CRC/retry 由协议层自己负责或不做，D2D adapter 旁路。代价是可靠性责任转移（UCIe 链路本身目标 BER < 1e-15，这也是 Format 6 敢丢掉 14B CRC 的前提）。

同类思路在别的互联里也通行："链路足够可靠时，把检错/重传字节换成载荷"。判断一个链路效率假设是否保守，第一步就是问：它假设的是 Flit Mode（带 adapter）还是 Raw Mode。

### 1.3 MPE / 多协议复用带来的**硬性**带宽上限

UCIe D2D adapter 支持多协议栈共用一条链路。规范规定：**MPE 模式下不允许两个连续 flit 属于同一协议栈**，因此每个栈最多拿到 **50%** 带宽；只有一个栈活跃时，要**插入 NOP flit** 来维持这个间隔。Enhanced MPE 允许不同栈、且每个栈可配置为 50% 或 100% 能力。

这是本领域少见的、有明确规范条文的**成倍**折减：如果端口按 MPE 配置而实际只有一个协议栈在工作，有效带宽直接腰斩。任何"链路带宽 → 有效带宽"的折减系数，都应当先确认这一项是否被计入。

### 1.4 PHY 与每 hop 时延

| 量 | 公开数值 | 条件 | 来源 |
|---|---|---|---|
| UCIe D2D PHY 时延（Pin → FDI） | **~2 ns**（TX+RX < 2 ns） | 并列接口，advanced/standard 封装 | Synopsys 2022 |
| UCIe 往返时延 | **2 ns**（平面 2D/2.5D）；**< 1 ns**（3D） | 规范汇总值 | arXiv 2510.06513 Table 1 |
| UCIe 能效 | **0.5 pJ/b**（≤16G）/ **0.6 pJ/b**（>16G）— 2D；**0.25 / 0.3 pJ/b** — 2.5D；**0.05–0.01 pJ/b** — 3D | 含 D2D adapter 与 PHY（FDI 到 bump 往返） | 同上 |
| UCIe advanced 实测 | **0.6 pJ/bit @ 0.75V, 32 Gb/s**，×64-lane 模块 388.8 µm × ~1000 µm，电流密度 >4.1 A/mm² | 10-column form factor | IEEE Vol.4 2024 |
| NoC 片上链路 | 互连金属线 **~220 ps/mm**；12mm die / 8 router 每维 → 单跳 ~1.5mm ≈ 330 ps | 无中继/有中继近似 | SAMOS 2014 |
| 2.5D 跨 die PHY | 每个 D2D link 需要**两个** PHY（收发各一）；建模时 PHY 时延要加 1 次（接 interposer router）或 **2 次**（die 对 die 直连） | 2.5D 架构 | RapidChiplet 2021 |
| 有源/无源 interposer 走线 | 有源 interposer **1 cycle / 10 mm**；无源 interposer **3 cycle / 10 mm** | Stow et al.，被多篇架构论文沿用 | UToronto 学位论文（年份 UNVERIFIED） |

**关键量级结论**：UCIe PHY 本身是**纳秒级**的；跨 die 的一次往返在 2 ns 量级。把它和"每 hop 时延"混同会严重低估——真正的每 hop 代价来自 NoC router（1 cycle/跳 + 转向 +1 + 跨时钟域 +1）、协议层、以及软件侧的一次 collective 步骤（微秒级，见 §3）。

### 1.5 带宽密度与 shoreline 账

UCIe 各代的关键指标（引自同一组公开汇总，注意厂商/联盟口径）：

| 指标 | UCIe-2D (Standard) | UCIe-2.5D (Advanced) | UCIe-3D |
|---|---|---|---|
| 数据率 | 4/8/12/16/24/32 GT/s | 同 | ≤ 4 G |
| 位宽/方向 | 16 | 64 | 80 |
| bump pitch | 100–130 µm | 25–55 µm | ≤ 1–9 µm |
| 信道 reach | ≤ 25 mm | ≤ 2 mm | 0（混合键合） |
| B/W shoreline | 28–224 GB/s/mm | 165–1317 GB/s/mm | N/A（只有面密度） |
| B/W density | 22–125 GB/s/mm² | 188–1350 GB/s/mm² | 4000（9µ）–300000（1µ）GB/s/mm² |

- 6 种 advanced-package form factor，数据率 4–32 Gb/s。
- **bump-limited**：UCIe 的带宽密度由 bump pitch 决定。N7 下 45 µm pitch 支持 16 Gb/s，24/32 Gb/s 需要 55/65 µm → **超过 16 Gb/s 后面积带宽密度反而下降**。N4/N5 可支持到 24 Gb/s。
- 生态在推 **48/64 Gb/s** 提案。
- 一个常被引用的对比结论：UCIe-S 在 110 µm pitch 下各项指标优于 LPDDR6；HBM4 在 45–55 µm pitch 下"每条 shoreline 的带宽"仍优于 UCIe-S（因为 HBM 向 die 内走得深，2.8mm vs 1.5mm），但 UCIe-S 可通过叠两个模块或把频率翻倍补回。

### 1.6 Serial (XSR) vs Parallel (UCIe)：两条路线的分工

| | Parallel（UCIe） | Serial（112G-XSR） |
|---|---|---|
| 每 lane 速率 | 16 → 32 Gbps | 112 → 224 Gbps |
| 能效 | <0.25 pJ/b（advanced）/ <0.5 pJ/b（std） | ~1.2 pJ/b |
| 时延 | <2 ns（TX+RX） | **FEC 相关** |
| BER | <1e-15 | <1e-9 |
| 带宽/mm | ~1 Tb/mm（std）/ ~5 Tb/mm（adv） | ~2 Tb/mm |
| reach | 25 mm（std）/ 2 mm（adv） | ~50 mm（XSR） |

**要点**：serial 路线的时延被 FEC 主导，公开资料普遍不给硬数字（只写"FEC dependent"）；这也是为什么"每 hop 时延"在光学/串行链路上是**查不到的**，只能找供应商确认。

## 2. Ring 与 hierarchical allreduce 的 hop 数与可达时延

### 2.1 经典成本模型（Hockney α-β）与各架构的通信次数

《计算机学报》的参数同步架构综述给出的对照表（n = 节点数，a = 两节点间一次通信的时延开销，参数总量归一为 1）：

| 架构 | 通信次数 | 理论同步时间 |
|---|---|---|
| PS（参数服务器） | 2 | 2a + 2(n−1)/(nB) |
| **Ring Allreduce** | **2(n−1)** | **2a(n−1) + 2(n−1)/(nB)** |
| **HD Allreduce（层次化）** | **2 log₂ n** | **2a log₂ n + 2(n−1)/(nB)** |
| 2-D Torus | 4(√n − 1) | 2a(√n − 1) + … |
| BML（假设 2 层） | 4(√n − 1) | 4a + … |

**所有架构的通信量都是 2(n−1)/n B**——即带宽项几乎相同，**差别全在时延项**。原文明确指出：Ring 需要串行通信 2(n−1) 次，时延项占比最大，这正是它在节点规模很大时性能下降的理论原因。

vLLM 的延迟优化文档给出了同一件事的另一种表述（N = 节点数，P = 每 rank 数据量，L = 单向 p2p 时延）：

| 算法 | 时延（不含同步开销） | 每 rank 通信量 | 带宽最优 | >2 GPU 需要全互联？ |
|---|---|---|---|---|
| Ring | **2(N−1)·L** | 2(N−1)/N·P | 是 | 否 |
| One shot | L | (N−1)·P | 否 | 是 |
| Two shot | 2L | 2(N−1)/N·P | 是 | 是 |
| Half butterfly | **log₂N·L** | log₂N·P | 否 | 否 |
| Butterfly | 2log₂N·L − 1 | 2(N−1)/N·P | 是 | 否 |

**把它直接翻译成 hop 数**：
- Ring：**2(N−1) 个串行 hop**，每个 hop 只承载 1/N 的数据。N=32 → **62 个 hop**。
- Hierarchical / 蝶形：**log₂N**（或 2log₂N−1）个 hop。N=32 → **5 个**（或 9 个）。
- 中间态：**两步法（reduce-scatter + all-gather）在层次化拓扑上**可以把跨慢链路的流量压缩到 Θ(log N)，而 Ring 是 Θ(N)。

**数量级结论**：从 ring 换成 hierarchical/树，hop 数从 O(N) 降到 O(log N)。但注意带宽项**不变**，所以换拓扑只在**时延受限区**（小消息、小 β）有收益；在带宽受限区换拓扑几乎没用（见 §2.3 的实测反例）。

### 2.2 Tree / Double Binary Tree 的代价

NCCL 的 Double Binary Tree 用两棵互为镜像的二叉树分担 reduce 与 broadcast，深度 O(log N)。

- **量级实例**：N=16 时 Ring 需 2(16−1)=30 个 hop-by-hop step，而树深度 log₂16=4，一轮完整 reduce+broadcast 共 **8 个 step**。
- **不变的结构性代价**：树归约是 many-to-one，每个内部节点必须等齐所有子节点，二叉树上每条内部边是**恒定的 2:1 incast**。双子树的互补角色只**分摊**这个 incast 到两棵树上（单树最大并发发送者 8 → 双树 16；最大并发接收者 4 → 8），**不能消除**它。
- 因此"树比 ring 好"不是无条件成立：它在 ring 的 hop 税（O(N)）与树的 incast 税（每层一次 2:1 归约等待）之间做交换，后者在链路缓冲/ECN/PFC 响应窗口不足时会恶化。

### 2.3 层次化 allreduce 的成本模型（可直接用于"每 hop 数 × α"的推演）

NVRAR（2025）给出的三段式模型，符号：G = 节点内 GPU 数，N = 节点数，α_intra/α_inter = 节点内/间单次交换时延，β_intra/β_inter 为对应带宽，M 为消息量，η 为跨节点流量系数：

- Reduce-scatter：`T_RS ≈ log₂(N)·α_inter + (N−1)/N · (η|M| / (G·β_inter))`
- All-gather：`T_AG ≈ (G−1)·α_intra + (G−1)/G · (|M| / β_intra)`
- 合计：`T = 2(G−1)α_intra + log₂N·α_inter + |M|/G · [2(G−1)/β_intra + (N−1)η/(N·β_inter)]`
- 小消息（忽略带宽项）：`T ≈ 2(G−1)·α_intra + log₂N·α_inter`

**这是本领域最有用的一条参照式**：它把"TP 规模扩大时 collective 占比如何演化"拆成了**节点内项（线性于 G）**和**节点间项（对数于 N）**。在单芯片 N=1 的情形下，整式退化为节点内项——**时延随 TP 规模线性增长**。

同文的实测细节（Perlmutter / Vista，NCCL 2.27.3 + PyTorch 2.8）：
- 1024 KB 消息下 NCCL 在所有节点数上**一致使用 Tree 算法（LL 协议）**；
- 256 KB 消息下 NCCL 在 **>16 GPU 时从 Ring 切到 Tree**；
- NVRAR 在 64 KB / 128 KB 上只有 NCCL 的 **0.7–0.8 倍**（被 kernel 启动开销吃掉），256 KB 起才有 1.06–1.44 倍收益。

### 2.4 一条反直觉的实测：小消息下 Ring 反超 Recursive Doubling

Astra-Sim 仿真（16 GPU 环拓扑、800 Gbps 链路、固定启动时延可忽略）显示：

- **Ring Allreduce 在传播时延低（10 ns）时比 Recursive Doubling 快约 1.6 倍**，且小消息也如此；传播时延增大后差距缩小。
- 原因：Recursive Doubling 的**路径更长**，端到端传播时延与路径拥塞都更高。

**含义**：α-β 模型忽略端到端传播时延与拥塞，会给出"小消息应该用对数算法"的错误建议。任何基于纯 hop 数的 collective 推导都要加一条免责：**hop 数少不等于完成时间短，路径长度和拥塞同样进入时延项**。

### 2.5 变换思路：拓扑感知的路径选择（hiccup 与 Swing）

AI Infra Book 的 16 卡双向环 ReduceScatter 前 3 轮对照：

| 轮 | Recursive 物理 hop 数 | Recursive 最忙链路 | Swing 物理 hop 数 | Swing 最忙链路 |
|---|---|---|---|---|
| 1 | 1 | 4 MiB | 1 | 4 MiB |
| 2 | 2 | 4 MiB | 1 | 2 MiB |
| 3 | 4 | 4 MiB | 3 | 2 MiB |

在 TPU v4 的 50 GB/s/方向/链路 下，瓶颈链路决定的传输时间约为 **252 µs vs 168 µs**（降三分之一）。**"每卡发送量相同"不等于"链路负载相同"**——路由决定数据集中在哪条链路上。

## 3. TP 规模扩大时 collective 占比的演化

### 3.1 TP 的固定调用模式

vLLM 的延迟优化文档给出一条被广泛引用的经验：**多数 LLM 的 tensor-parallel 推理每层需要 2 次 allreduce**；decode 阶段一次只解 1 个 token，因此 allreduce 消息很小（文档给的例子：batch 32、fp16 的 Llama 65B/70B 只需 **512 KB**；计算式为 32 × 8192 × 2）。

**这条决定了性质**：TP 推理的 collective 在**小批量/解码**时落在**时延受限区**（α 主导），而 TP 规模 N 恰好线性增加 α 项的系数（Ring 的 2(N−1)）或对数增加（树）。

### 3.2 占比演化：能从公开资料确证的与确证不了的

可以从上面几条推出**方向性**结论（不是本项目取值）：
- TP 增大，**带宽项不变**（2(N−1)/N → 2），**时延项变大**（Ring 线性、树对数）；
- 因此 collective 占 decode step 的比例随 TP 增大而上升，**上升速度取决于所用算法的时延项系数**；
- 单节点内（无跨节点链路）时延项由节点内 α 与 kernel 启动开销构成，**换算法只能把 O(N) 压到 O(log N)，不能压到 O(1)**——除非硬件支持 one-shot（时延 L，但要求全互联且非带宽最优）或 in-network reduction。

**公开资料里查不到的**：TP=N 的具体占比曲线、decode-only 场景下 TP32 的 collective 时间占 step 的百分比。这条属于 unresolved（见文末）。

### 3.3 关键参照：busbw 不等于可达带宽

AI Infra Book 记录的一个具体实测：两台 HGX H100、共 16 ranks，每卡 **64 MiB** AllReduce 耗时 **466.1 µs** → algbw 143.99 GB/s，busbw 269.98 GB/s（1.875×）。

原文明确警告：**busbw 是归一化指标，不能直接当作任何单张 NIC 的实际吞吐**；层次化通信、交换机内归约、链路共享都要沿物理路径逐项计入。这是"用 busbw 反推链路需求"时最常见的错误来源。

## 4. 通信与计算 overlap 的成熟度与失效条件

本领域的成熟度分三档，**不要混为一谈**：

1. **同一 stream 顺序执行**：无 overlap。
2. **多 micro-batch / 多 stream 手写 overlap**（成熟，训练与 prefill 侧主流）：把 collective 与另一个 micro-batch 的 GEMM 放在不同 stream，靠 event 同步。DeepSeek 的 DualPipe 属此类，用 PTX 精细控制分配给计算与通信的 SM 数量以求"完全重叠"。
3. **SM-free / hook 式 overlap**（较新，decode 侧）：DeepEP 的 low-latency 内核用 receiving hook 接口，**RDMA 流量在后台进行而不占用任何 SM**；代价是 buffer 空间远大于普通模式，且官方建议 `num_max_dispatch_tokens_per_rank`（即 decode 引擎的实际 batch size）**小于 256**。

### 4.1 失效条件一：SM / 带宽资源争用（有实测）

AI Infra Book 的 Experiment 6-5（Gloo，4 个 CPU 进程，AllReduce 与矩阵乘并发，5 次取中位数）：

| 归约数据量 | 单独通信 | 单独计算 | 并发时通信 | 并发时计算 | 并发组完成 |
|---|---|---|---|---|---|
| 4 MiB | 2.67 ms | 11.53 ms | **6.14 ms**（2.3×） | 11.52 ms | 11.58 ms（几乎完全隐藏） |
| 64 MiB | 36.92 ms | 11.03 ms | **45.21 ms** | 12.89 ms | 45.24 ms |

- 4 MiB：通信被计算**完全隐藏**（组完成 ≈ 单独计算时间）。
- 64 MiB：单独运行合计约 48.0 ms，并发只省 **2.7 ms**，而不是计算的 11 ms。
- 原文的判据：**评估 overlap 必须比较"两者并发时的耗时"，不能用各自单独耗时的差来减**。

GPU 上同理：增加通信线程/channel 会加快单独通信，但占用计算所需的执行资源，**仅凭单独通信带宽选配置会让整体变慢**。AutoCCL 因此把并发干扰纳入反馈，实测在 recomputation 干扰下 AllGather 带宽从 18.26 GB/s 提升到 32.44 GB/s（并提醒：搜索与切换本身有成本，需要 S/Δ 次调用才能回本）。

### 4.2 失效条件二：overlap 会改变最优算法/协议（有实测）

Stanford CS244c 的测量（8×A100-SXM4-80GB，AllReduce fp32，32 KB–256 MB，并发 4096×4096 fp32 matmul 模拟反向计算，3 种拓扑）：

- **单节点下，9 个消息大小中有 6 个的最优 (算法, 协议) 组合在 overlap 下发生翻转**；overlap 时 **Ring+Simple 在 ≥2 MB 全面占优**，挤掉原本在单独运行时获胜的 Tree+LL128。
- 原因是协议对 SM 的占用模式不同：Simple 用大块 GPU 发起的 DMA，**只在每次传输建立时短暂占用 SM**；LL128 用 128B flag-based 传输、LL 用 8B 原子单元，**持续占用 SM 轮询/标记**。
- **多节点会把代价放大**：同一份工作的 AUTO gap 从单节点 1.2% 涨到 2 节点 64 MB 下的 **57.2%**（25× 放大）；64 MB 时 Ring+Simple 337 ms vs Tree+Simple 117 ms（2.9×）。
- 多节点下 Ring 的问题在于每个数据块要走 N−1 跳，其中一部分跨慢速节点间链路；Tree 在节点内用 NVLink 归约，跨节点只发一条聚合消息，跨节点消息数 Θ(log N_nodes) vs Ring 的 Θ(N)。

**结论**：overlap 不是"把通信藏起来"的中性操作，它会**改变最优算法选择**，因此任何"先按单独运行 benchmark 选算法、再假设 overlap 能藏住剩余时间"的推导都不成立。

### 4.3 失效条件三：EP/MoE 侧的负载与放置

- 专家权重迁移的**量级对比**（DeepSeek-R1 级别，专家约 **42 MB**）：H20/H800 上 NVLink 450/200 GB/s 搬一个专家需 **92/210 µs**；RDMA 200/400 Gbps 需要 **1.7/0.8 ms**。给定 O(10) ms 级 TPOT 预算、O(100) µs 级每层预算，**实时再平衡被限制在节点内**。
- DeepEP 的普通（高吞吐）内核需要 **~20 个 SM** 就能同时打满 NVLink 与 RDMA 两条路径；token 先经 IB 到节点内索引相同的 GPU，再经 NVLink 转发到目标专家，两条路径完全重叠。
- NUMA/HCA 亲和是可测的失效点：GPU 未与所用 NIC 同 NUMA 时数据要额外跨 PCIe switch 或 CPU socket。

## 5. RDMA / scale-out 的时延构成

公开资料在这一块**只给量级和构成项，不给可复用的单值**：

| 构成项 | 典型量级 | 来源/条件 |
|---|---|---|
| NVLink（节点内）单链路 | ~25 GB/s/方向/链路；H800 整卡 ~160 GB/s；NVLink 4.0 18 lane × 50 GB/s 双向 = 900 GB/s/GPU | CS244c / DeepEP README / 路线图文档 |
| RDMA 单 NIC | CX7 InfiniBand 400 Gb/s → ~50 GB/s | DeepEP README，2025 |
| 跨节点 vs 节点内搬 42 MB | 1.7/0.8 ms（RDMA 200/400 Gbps） vs 92/210 µs（NVLink 450/200 GB/s） | EPIC，2026 |
| 协议/网络跳 | IB 自适应路由可"完全消除路由冲突导致的拥塞"，但**引入额外延迟**；建议重负载时启用、轻负载时用静态路由 | DeepEP README |
| 主机侧 | DGX H100 双路 Xeon 8480C、UPI 16 GT/s；每 GPU PCIe Gen5 x16 = 64 GB/s/方向；ring 归约经 host memory 中转时，跨 CPU 链路流量随 buffer 放置与环上顺序在 2:1:2 之间变化 | AI Infra Book |
| 交换机内归约 | NCCL 的 CollNet/NVLS 属于可选路径，与 Ring/Tree 并列 | NCCL 算法族 |

**要点**：RDMA 时延构成 = NIC + 交换机 hop + 链路传播 + FEC/协议 + 主机侧（PCIe/UPI/内存放置）。公开资料里能查到的只有**带宽**和**相对倍数**；单跳 RDMA 的绝对时延数字在各家文档里口径不一，属于需要向供应商确认的量。

## 6. 对本领域的元结论

1. **"协议效率"必须分层报**：链路层 ≈ 1，flit 层 94–98%，MPE 模式 ≤50%，系统层取决于消息大小与 overlap 是否成立。单给一个系数无法判断偏离常规与否。
2. **hop 数与时延不是同义词**：ring 是 2(N−1) hop、树是 O(log N)，但小消息下 ring 可能反超对数算法（路径长度与拥塞进入时延项）。任何"用 hop 数算时延"的推导都要标注这个反例。
3. **overlap 是条件成立的，不是默认成立的**：有公开实测表明它在 4 MiB 完全隐藏、在 64 MiB 几乎不省；并且会翻转最优算法选择。把 overlap 当作"通信时间 × 一个小于 1 的系数"的建模方式，在这两份实测里都得不到支持。
4. **单芯片（N=1）情形下，层次化模型的跨节点项消失，只剩下线性于 G 的节点内项**。这是本项目 TP32 / PP1 与公开的多节点集群资料之间最大的结构性差异，所有引用多节点数字的类比都要在这一步打住。

## 7. 未解（UNVERIFIED）

1. **UCIe 端到端有效带宽折减的实测**。公开资料只到 flit 级字节账（94–98%）与规范层面的 MPE 上限（50%），没有"协议层 + credit 流控 + 读写转向 + 电源态进出"的 sustained/peak 实测曲线。缺的是：某厂商的 UCIe 控制器 datasheet 里的 sustained 带宽表，或一篇带流量的 UCIe 实测论文。
2. **单芯片内跨 reticle 的 D2D NoC 每 hop 时延。** UCIe PHY 的 ~2 ns 是 **Pin → FDI**，不含 NoC router、跨 reticle 的时钟域跨越、以及绕 shoreline 的走线。缺的是：把这三项加起来的公开数据；只有架构论文级的建模值（1 cycle/router + turn + CDC）。
3. **112G SerDes 在 D2D reach 下的实测时延。** 公开对比表只写 "FEC dependent"。缺的是厂商 datasheet 里的 TX+RX + FEC 时延。
4. **TP=N 时 collective 占 decode step 时间的比例曲线。** 公开资料给的是"每层 2 次 allreduce"与算法时延项，没有 TP=32 单节点 decode-only 的占比实测。
5. **1M context 下的 KV collective 量级。** 现有公开资料（DeepEP、vLLM、NCCL 生态）都是 4K–128K context 与训练/prefill 场景；1M context 的 KV cache 分片/广播/重算 collective 量级查不到。
6. **MoE 大模型（GLM / DeepSeek 这一代）在单节点内 TP32 的实测 collective 占比**，公开资料里没有任何一份是同规模同拓扑的。
7. **两条本次未能完成检索的方向**：**(a)** 各家 UCIe 端口在 Flit Mode 下的 sustained 带宽厂商声明对比；**(b)** ring 与 hierarchical allreduce 在**片内/单封装**层级（而非多节点 GPU 集群）的 hop 数与时延实测——后者尤其重要，因为它才是与本项目规模对得上的参照系，但目前公开文献几乎全是数据中心级。下一轮刷新时优先补这两条。

## 8. 知识卡

本节是结构化条目，字段含义与 `references/sota/README.md` 一致。`confidence` 分四档：`public_measurement` / `vendor_datasheet` / `industry_survey` / `model_memory`（后者已被隔离，不出现在正文）。

### SOTA-IC-01 UCIe flit 格式带来的 D2D adapter 协议开销到底占几个百分点

- **approach**：UCIe Flit Mode：68B / 256B 定长 flit + D2D adapter CRC/retry
- **what_it_is**：UCIe 把可靠性放在 D2D adapter 层，用定长 flow-control unit（Flit）承载 CRC 与链路级 retry。协议层在 FDI 上交付载荷，adapter 追加 flit header 与 CRC 后送 RDI。Hot Chips 2023 的官方教程逐个格式给了字节分布：Format 2（68B）由 64B 协议载荷 + 2B flit header + 2B CRC 组成；Format 3/4 是 256B 的 PCIe/CXL 帧，带 2 组 CRC 且已经去掉了原生 PCIe/CXL 的 6B FEC。另有明确规范事实：UCIe 不需要 8b/10b 或 128b/130b 编码。
- **who_uses_it**：UCIe 联盟成员的所有 D2D 设计；PCIe Flit Mode 与 CXL 3.0 Flit Mode 走 Format 3/4，Streaming（厂商自定义）协议走 Raw。任何基于 UCIe 做 chiplet 互联的 AI 芯片都在这个框架内。
- **typical_numbers**：68B flit：载荷比 64/68 ≈ 94.1%，协议开销约 5.9%。256B flit：header+CRC 合计约 6B 量级，开销约 2%。链路层编码开销 ≈ 0（不需要 8b/10b、128b/130b）。适用条件：Flit Mode（D2D adapter 在路径上）；Raw Mode 下这些开销不适用。
- **applies_when**：讨论的是 D2D adapter 这一层引入了多少字节开销；链路工作在 Flit Mode；协议载荷是连续大块数据。
- **not_applicable_when**：链路配置为 Raw Mode（adapter 被旁路，本条字节账全部消失）；协议层本身有远大于 flit 头的开销（如 CXL.io 的小包 TLP、cacheline 粒度的读写转向）——此时 flit 级 2–6% 完全不是瓶颈；或者链路对端不是 UCIe 而是厂商私有 D2D（字节账不同）。
- **project_premises**：与 UCIe 0.8 相关：本条给出的是 flit 级字节账（94–98%），不含协议层与系统层折减。
- **what_to_check_here**：找 UCIe 控制器 IP 供应商（如 Synopsys/Cadence/Alphawave）要他们控制器的 sustained 带宽表，确认 Flit Mode 与 Raw Mode 各一行的实测值；同时确认本项目的端口是单协议还是 MPE 配置（决定 §1.3 的 50% 上限是否生效）。
- **confidence**：industry_survey
- **relative_validity**：约 3–5 年（UCIe 1.0/2.0/3.0 保持向后兼容，flit 格式稳定）；若引入新的 256B-优化格式或 48/64 Gb/s 修订，需复核。
- **sources**：
  - Hot Chips 2023 — UCIe Tutorial: Protocol Part（flit 格式与 D2D adapter 逐字节分布），2023，https://www.hc2023.hotchips.org/assets/program/tutorials/ucie/UCIe%20Protocol.pdf
  - UCIe flit 格式与协议复用综述（ACM，DOI 10.1145/3819235），2025，https://dlnext.acm.org/doi/pdf/10.1145/3819235

### SOTA-IC-02 把 D2D 协议开销降到 0 的合规路径：Raw Mode 与 latency-optimized flit

- **approach**：UCIe Raw Mode（Format 1）+ 256B latency-optimized flit（Format 5/6）
- **what_it_is**：UCIe 提供两种把 adapter 字节开销挤掉的做法。其一是 Raw Mode（Format 1）：协议层填满全部字节，D2D adapter 数据通路被完全旁路，CRC/retry 由协议层自负或不做；规范要求支持 Streaming 协议时必须实现 Raw。其二是 Format 6（enhanced 256B latency-optimized）：把原生为 FEC/CRC 预留的 14B 重新用作协议载荷，对 CXL.cachemem 而言 flit 中不再保留任何字节，规范强烈推荐。二者成立的前提是链路本身足够可靠（UCIe 目标 BER < 1e-15）。
- **who_uses_it**：Streaming / 厂商自定义协议的 chiplet 互联（Raw 是强制项）；CXL 3.0 内存语义链路（Format 6 被强烈推荐）。做 AI 加速器 D2D 的团队多数走 Raw 或自定义 streaming，而不是 PCIe/CXL 帧。
- **typical_numbers**：Raw Mode 下 adapter 追加字节 = 0，理论载荷比 100%。Format 6 下 CXL.cachemem 保留字节 = 0（相比 Format 4 省约 14B/256B ≈ 5.5%）。UCIe 链路目标 BER < 1e-15（与 XSR 的 <1e-9 是同一个数量级差的两个世界）。适用条件：链路误码率足够低、且协议层能自行兜底。
- **applies_when**：讨论的是能否把协议效率做到接近 1；链路的 BER 指标与重传责任安排是设计自由度；对端是同厂商或已协商好的私有协议。
- **not_applicable_when**：需要与第三方 chiplet 互操作（此时只能走规范强制格式，Raw 之上没有互操作定义）；链路余量不足、必须依赖 CRC/retry 覆盖误码（Raw 会把误码责任推给上层，可能触发上层重传，反而更贵）；协议层是 PCIe/CXL 且不允许改帧格式。
- **project_premises**：与 UCIe 0.8 相关：本条说明 0.8 这个量级的折减在规范层面等价于假设了 Flit Mode + 协议层开销，而非 Raw Mode。
- **what_to_check_here**：找 NoC/Die-to-Die 设计负责人确认本项目端口采用的是 Flit Mode 还是 Raw Mode，以及是否有 MPE 配置；如果实际是 Raw，则 UCIe 0.8 这一项的物理来源需要重新定位到协议层或系统层。
- **confidence**：industry_survey
- **relative_validity**：约 3 年，随 UCIe 修订与 Streaming 生态变化。
- **sources**：
  - Hot Chips 2023 — UCIe Tutorial: Protocol Part（Raw Format 1 与 Format 6 定义），2023，https://www.hc2023.hotchips.org/assets/program/tutorials/ucie/UCIe%20Protocol.pdf
  - UCIe flit 格式与协议复用综述（ACM，DOI 10.1145/3819235，Format 6 与 MPE），2025，https://dlnext.acm.org/doi/pdf/10.1145/3819235

### SOTA-IC-03 多协议复用（MPE）引入的 50% 硬性带宽上限与 NOP flit 插入

- **approach**：UCIe MPE / Enhanced MPE 的 flit 调度规则
- **what_it_is**：UCIe D2D adapter 支持多个协议栈共用一条物理链路。规范规定：MPE 模式下不允许两个连续 flit 属于同一协议栈——这条规则同时保证了每个栈最多拿到 50% 带宽；若只有一个栈活跃，adapter 必须插入 NOP flit 维持间隔。Enhanced MPE 允许不同类的栈（如一个 streaming + 一个 CXL），且每个栈可配置为 50% 或 100% 能力，100% 能力的栈允许连续 flit 指向自己。协议层则是通过 Arb/Mux 块做 fair 或加权 round-robin 仲裁。
- **who_uses_it**：需要在一个 UCIe 端口上跑多种语义（如内存语义 + streaming 数据面）的多 chiplet SoC。规范举的例子是 x64 UCIe @32 GT/s 上跑两个 x16 PCIe 6.0 栈（等效 x16 PCIe 7.0 带宽）。
- **typical_numbers**：MPE 每栈上限 50%（硬性，由「不允许连续同栈 flit」推出）；单栈活跃时插 NOP，有效带宽可低至配置能力的一半。Enhanced MPE 每栈可配 50% 或 100%。规范例子：x64 @32 GT/s ↔ 两个 x16 PCIe 6.0 栈。适用条件：端口配置为多栈复用。
- **applies_when**：端口上有多个协议栈共享同一条 UCIe 链路；或评估「链路标称带宽 → 单协议可见带宽」时需要判断是否被仲裁规则限住。
- **not_applicable_when**：端口是单协议配置（此时 MPE 规则完全不生效，带宽上限不存在）；或者多栈流量在时间上天然错开（一个栈长期空闲时插 NOP 的浪费才显现，两栈都忙时反而是均分而非浪费）。
- **project_premises**：与 UCIe 0.8 相关：本条是 UCIe 0.8 这类「成倍折减」的规范级候选来源之一，需要在端口配置上核对是否触发。
- **what_to_check_here**：在 teams/hardware 的 NoC/Die-to-Die 设计文档里核对该端口的协议栈数量与 MPE 配置（单栈 / MPE / Enhanced MPE）；若为多栈，重算每个栈实际可用的链路带宽份额。
- **confidence**：industry_survey
- **relative_validity**：约 3–5 年（UCIe 向后兼容，MPE 语义稳定）。
- **sources**：
  - UCIe flit 格式与协议复用综述（ACM，DOI 10.1145/3819235，MPE 与 Enhanced MPE 规则），2025，https://dlnext.acm.org/doi/pdf/10.1145/3819235
  - Hot Chips 2023 — UCIe Tutorial: Protocol Part（Arb/Mux 与多栈配置），2023，https://www.hc2023.hotchips.org/assets/program/tutorials/ucie/UCIe%20Protocol.pdf

### SOTA-IC-04 UCIe PHY 的每 hop 时延与能耗量级

- **approach**：UCIe 并列 D2D PHY：Pin → FDI 时延与 pJ/bit 指标
- **what_it_is**：UCIe PHY 是单端、转发时钟、DDR 式并列接口，每个 module 含 N 条单向数据 lane（UCIe-S N=16，UCIe-A N=64）+ valid lane + track lane + 每方向一个差分转发时钟；sideband 每方向 2 条（1 数据 + 1 个 800 MHz 转发时钟），用于链路训练与寄存器访问。1/2/4 个 module 可聚合。厂商（Synopsys）给出的接口级 FOM 是「Pin → FDI 时延 ~2 ns」，规范汇总给出平面链路往返 2 ns、3D < 1 ns。
- **who_uses_it**：所有 UCIe-S/UCIe-A 设计；2.5D interposer 与 organic substrate 上的 chiplet 互联。3D 混合键合（bump pitch ≤1–9 µm）路线。
- **typical_numbers**：时延：Pin → FDI ~2 ns；平面（2D/2.5D）Round-trip 2 ns；3D < 1 ns。能耗（含 D2D adapter + PHY，FDI 到 bump 往返）：2D 0.5 pJ/b（≤16G）/ 0.6 pJ/b（>16G）；2.5D 0.25 / 0.3 pJ/b；3D 0.05（9 µm）– 0.01（1 µm）pJ/b。独立 form-factor 实测：0.6 pJ/bit @ 0.75 V、32 Gb/s，×64-lane 模块 388.8 µm × ~1000 µm，电流密度 >4.1 A/mm²。低功耗态进出 <1 ns，省电 85%+。适用条件：advanced 或 standard 封装、≤32 Gb/s、标称室温电压。
- **applies_when**：评估 D2D 链路本身（PHY + adapter）给一次跨 die 传输加了多少绝对时延和能量；用于把「跨 reticle 一次往返」与「片上 NoC 一跳」做区分。
- **not_applicable_when**：把 2 ns 当作「跨 die 一次通信的端到端时延」使用——它只是 Pin 到 FDI，不含 NoC router、跨时钟域、协议层与软件侧 collective 步骤；也不适用于串行（XSR/112G）链路（那条路的时延由 FEC 决定，量级完全不同）；3D 混合键合的 <1 ns 与 pJ/b 数据不适用于平面封装设计。
- **project_premises**：与 UCIe 0.8 相关：本条给出的绝对时延量级用于判断 allreduce 时延项里「跨 die」部分的物理下界。
- **what_to_check_here**：在 teams/hardware 的 Die-to-Die/NoC 文档里核对：一次跨 reticle 往返的时延预算里，是否已经把 NoC router 跳数、转向惩罚与跨时钟域单列；再向 UCIe IP 供应商索要其 PHY 在目标数据率下的实测 Pin→FDI 时延（不要用规范标称值）。
- **confidence**：vendor_datasheet
- **relative_validity**：约 2–3 年（随 SerDes/PHY 代际与 bump pitch 演进；32G→48/64G 会改变能效曲线）。
- **sources**：
  - Synopsys, Short Reach Interconnect for the Emerging Multi-Die System Era（IEEE Toronto 演讲，D2D PHY FOM），2022，https://www.ieeetoronto.ca/wp-content/uploads/2022/12/Short-Reach-Interconnect-for-the-Emerging-Multi-Die-System-Era.pdf
  - On-Package Memory with UCIe（arXiv 2510.06513，Table 1 各代关键指标），2025，https://browse-export.arxiv.org/pdf/2510.06513
  - IEEE Vol.4 2024：UCIe advanced-package form factor 的电流密度与能效实测（IEEE Xplore 10767590），2024，https://ieeexplore.ieee.org/ielx8/8782712/10381508/10767590.pdf

### SOTA-IC-05 UCIe 的 shoreline 带宽账与 bump-limited 特性

- **approach**：UCIe-2D / 2.5D / 3D 的带宽密度表 + bump pitch 约束
- **what_it_is**：UCIe 是 bump-limited 接口：单位 shoreline（die 边缘长度）能提供的带宽由 bump pitch 与每 lane 速率共同决定。规范/公开汇总给出三档封装（Standard 2D、Advanced 2.5D、3D 混合键合）的数据率、位宽、bump pitch、reach、shoreline 带宽与面密度。共同结论是：减小 bump pitch 可持续提升带宽密度，但提高数据率在落后工艺上反而会因驱动/校准电路变大而降低面密度。
- **who_uses_it**：所有做 chiplet 划分与 floorplan 的团队（决定一条 die 边能挂多少带宽）；AI 加速器与 on-package memory 方案（把内存挂在逻辑 die 的 shoreline 上而不占用计算 die）。
- **typical_numbers**：UCIe-2D：4–32 GT/s、16 lane/方向、bump pitch 100–130 µm、reach ≤25 mm、28–224 GB/s/mm、22–125 GB/s/mm²。UCIe-2.5D：64 lane/方向、pitch 25–55 µm、reach ≤2 mm、165–1317 GB/s/mm、188–1350 GB/s/mm²。UCIe-3D：≤4 G、80 lane/方向、pitch ≤1–9 µm、4000–300000 GB/s/mm²、0.05–0.01 pJ/b。工艺相关性：N7 下 45 µm pitch 支持 16 Gb/s，24/32 Gb/s 需要 55/65 µm（>16 Gb/s 后面密度下降）；N4/N5 可到 24 Gb/s。shoreline 密度随工艺从 ~1.5 → 2 Tb/s/mm。生态在推 48/64 Gb/s 提案。
- **applies_when**：做 die 边带宽预算、chiplet 划分、或判断「这个总带宽在给定 shoreline 上是否物理可实现」。
- **not_applicable_when**：用于估算芯片内部 NoC 或 SRAM 带宽（这些不是 shoreline 受限的）；直接把 2.5D 的高密度数字套到 organic substrate 设计上（reach 与 pitch 都不同）；把带宽密度上限当作可持续实际带宽（未计入协议层与系统层折减、也未计入读写转向与 refresh）。
- **project_premises**：与 UCIe 0.8 相关：本条说明 UCIe 的标称带宽本身是 bump-limited 的物理上限，协议效率折减叠加在这之上。
- **what_to_check_here**：在 teams/hardware 的 package/floorplan 文档里核对：跨 reticle 所需的 D2D 总带宽对应的 shoreline 长度与 die 边长预算是否对得上；用给定的 bump pitch 与目标数据率反查面密度是否在 N7/N5 的可达区间内。
- **confidence**：industry_survey
- **relative_validity**：约 2 年（HBM4/UCIe 代际与 bump pitch 演进很快）。
- **sources**：
  - On-Package Memory with UCIe（arXiv 2510.06513，Table 1 带宽密度与 bump pitch），2025，https://browse-export.arxiv.org/pdf/2510.06513
  - IEEE Vol.4 2024：技术与带宽缩放、48/64 Gb/s 提案（IEEE Xplore 10767590），2024，https://ieeexplore.ieee.org/ielx8/8782712/10381508/10767590.pdf

### SOTA-IC-06 串联（112G XSR）与并联（UCIe）D2D 的取舍与量化对比

- **approach**：Serial XSR vs Parallel UCIe 的 FOM 对照
- **what_it_is**：Die-to-Die 互联有两条并存的技术路线。并联（UCIe 为代表）走单端 CMOS 驱动 + 转发时钟 + DDR 式采样，reach 短、能效高、时延低、BER 极低。串联（112G-XSR 为代表）走 PAM4 SerDes，每 lane 速率高出一个数量级、reach 长，但能效差约 5 倍、BER 高 6 个数量级、且时延由 FEC 决定（公开资料只写「FEC dependent」，不给数字）。两条路线在标准演进中被认为会长期共存，CPO（共封装光学）正在把 XSR 往更短 reach 推。
- **who_uses_it**：并联路线用于 2.5D/3D 封装内与 on-package memory；串联路线用于有机封装、跨 package 的较长 reach，以及 die-to-optical-engine（D2OE）与 CPO。
- **typical_numbers**：并联：每 lane 16→32 Gbps；能效 <0.25 pJ/b（advanced pkg）/ <0.5 pJ/b（std）；时延 TX+RX <2 ns；BER <1e-15；带宽/mm ~1 Tb/mm（std）/ ~5 Tb/mm（adv）；reach 25 mm（std）/ 2 mm（adv）。串联：每 lane 112→224 Gbps；能效 ~1.2 pJ/bit；BER <1e-9；带宽/mm ~2 Tb/mm；112G-XSR 目标 reach ~50 mm；时延 FEC dependent。适用条件：并联数字对应 advanced/standard 封装两类；串联数字对应 <10 dB 损耗通道。
- **applies_when**：在封装方案上做 D2D 技术选型，或判断「跨 reticle」用的是并联还是串联、以及串联路线的时延为何查不到硬数字。
- **not_applicable_when**：把并联的 <2 ns 时延套到串联链路上（串联是 FEC 主导，量级完全不同，通常高出 1–2 个数量级）；把 <0.25 pJ/b 用在有机封装设计上（那是 advanced package 的数，std 是 <0.5 pJ/b，串联是 ~1.2 pJ/b）；把 5 Tb/mm 的 shoreline 密度用于 std 封装。
- **project_premises**：与 UCIe 0.8 相关：本条给出「UCIe 并联」这条路线在能效/时延/BER 上的位置，用于判断 UCIe 相关假设是否按并联路线解读。
- **what_to_check_here**：确认本项目的跨 reticle 互联属并联还是串联路线；若为串联，向 SerDes IP 供应商索要含 FEC 的 TX+RX 时延数字，并把它替换进跨 die 往返预算。
- **confidence**：vendor_datasheet
- **relative_validity**：约 3 年；CPO 与 224G SerDes 进展会改变串联侧的能效/时延。
- **sources**：
  - Synopsys, Short Reach Interconnect for the Emerging Multi-Die System Era（UCIe 与 XSR FOM 对照表），2022，https://www.ieeetoronto.ca/wp-content/uploads/2022/12/Short-Reach-Interconnect-for-the-Emerging-Multi-Die-System-Era.pdf

### SOTA-IC-07 Ring allreduce 的 hop 数、时延项与带宽最优性——经典方案的基线

- **approach**：Ring Allreduce（reduce-scatter + all-gather，两阶段各 N−1 步）
- **what_it_is**：Ring allreduce 把 N 个 rank 串成一个逻辑环，做 N−1 步 reduce-scatter 再 N−1 步 all-gather，每步每 rank 发送 S/N 的数据。它是带宽最优算法（每 rank 发送量 ≈ 2S，与 N 无关），但必须**串行**走 2(N−1) 次通信。这是 HPC/训练集群里的经典基线，也是所有「上一代通行做法」的来源：多数项目里的 collective 开销假设实际来自这一代模型。
- **who_uses_it**：NCCL 在大消息与 NVLink 拓扑上的默认算法；RCCL 的默认环；MPI 生态。近年在多节点异构拓扑上被 Tree 取代，但在同构高速互联上仍是大消息首选。
- **typical_numbers**：通信次数 2(N−1)；时延项 2(N−1)·L（L = 单向 p2p 时延）；通信量 2(N−1)/N·S（→ 2S）；峰值带宽利用率 (N−1)/N（N=8 → 87.5%，N=16 → 93.75%）。N=32 → 62 个串行 hop，带宽利用率 96.9%。实测参照：16 ranks、每卡 64 MiB AllReduce 466.1 µs（algbw 143.99 GB/s，busbw 269.98 GB/s = 1.875×）。适用条件：同构链路、消息足够大（带宽受限区）、无拥塞的环/环嵌入拓扑。
- **applies_when**：把「allreduce 开销」理解为 per-hop 时延 × 2(N−1) 这种形式的模型；或者判断某个 collective 假设是否落在「ring 时代」的取值区间。
- **not_applicable_when**：拓扑是异构的（节点内 NVLink + 节点间慢速网络）——此时 Ring 会把每个数据块逼着走 N−1 跳且其中一部分跨慢链路，实测在 2 节点 64 MB 下比 Tree 慢 2.9×；消息很小且链路时延极低时也不适用（此时 Ring 反而可能赢过对数算法，见 SOTA-IC-11）；单节点全互联拓扑下 Ring 的 hop 含义与跨节点完全不同。
- **project_premises**：与 τ=1.15、TP32 下的 allreduce 开销 相关：本条给出 ring 这一经典基线的时延项形式 2(N−1)·L，用于判断采用 ring 假设时的 hop 数量级。
- **what_to_check_here**：在 integration/ 与 teams/software 的 collective 文档里核对：本项目的 allreduce 假设是按 ring（2(N−1) 步）还是层次化/树（O(log N) 步）建模的，两者在 TP32 下相差一个数量级；再确认 466 µs / 64 MiB 这类公开实测是否被误当作可外推的基线。
- **confidence**：public_measurement
- **relative_validity**：时延项形式长期有效（10 年以上）；实测数字约 2 年（随 GPU/NVLink 代际变化）。
- **sources**：
  - Latency-optimal allreduce and cuda graph optimization（vLLM，含 Ring/One-shot/Butterfly 对照表），2024，https://github.com/vllm-project/vllm/files/13574639/Latency-optimal.allreduce.and.cuda.graph.optimization.pdf
  - 参数同步架构性能比较（计算机学报，PS/Ring/HD/2D-Torus/BML 通信次数表），2022，http://cjc.ict.ac.cn/online/onlinepaper/wangs-2022711150724.pdf
  - AI Infra Book（bojieli，实验 7-3：16 ranks 64 MiB AllReduce 实测），2025，https://github.com/bojieli/ai-infra-book/releases/latest/download/AI-Infra-Book-EN.pdf

### SOTA-IC-08 Tree / Double Binary Tree 的 O(log N) 深度与不可消除的 2:1 incast 代价

- **approach**：NCCL Double Binary Tree（两棵互补二叉树分担 reduce 与 broadcast）
- **what_it_is**：NCCL 的 AllReduce 不只有 ring，还有 (Double Binary) Tree 与 CollNet/NVLS，按消息大小、拓扑、硬件能力在运行时选择。DBT 把参与 rank 组织成两棵互为镜像的二叉树：每个 rank 在一棵树里是内部节点（做 2:1 合并）、在另一棵树里是叶子。这样单树最大并发发送者从 8 提到 16、最大并发接收者从 4 提到 8，link 利用率约翻倍。但树归约本身是 many-to-one，每条内部边的 2:1 incast 是结构性的，双子树只能分摊、不能消除。
- **who_uses_it**：NCCL 在 NVSwitch 拓扑与多节点异构拓扑上的默认选择，常与 LL/LL128 协议搭配用于延迟敏感的小到中消息（小 batch 推理、MoE 路由同步）。
- **typical_numbers**：深度 log₂N；一轮完整 reduce+broadcast = 2·log₂N 步。量级实例：N=16 时树深 4、一轮 8 步，而 Ring 需 2(16−1)=30 个 hop-by-hop 步。代价：每个内部节点 reduce 阶段必须等齐所有子节点数据（恒定 2:1 incast），内部节点还要完成 2:1 加法再前转。NCCL 在 256 KB 消息、>16 GPU 时从 Ring 切到 Tree；1024 KB 消息在所有节点数上都用 Tree（LL 协议）。适用条件：同构或分层拓扑、消息落在延迟受限区。
- **applies_when**：评估用树/层次化替代 ring 能省多少 hop；或判断某个 collective 模型是否已经把 incast 等待计入。
- **not_applicable_when**：把「树一定比 ring 好」当作普遍结论——在带宽受限的大消息区，两者带宽利用率接近，树不会更快；在链路缓冲 / ECN / PFC 响应窗口不足时，2:1 incast 的突发会被放大而非被吸收；单节点全互联（NVLink switch）下树与 ring 的带宽表现接近，收益主要来自 hop 数。
- **project_premises**：与 TP32 下的 allreduce 开销 相关：本条给出树/层次化的 hop 数 O(log N) 及其结构性代价，用于对照 ring 的 O(N)。
- **what_to_check_here**：在 teams/software 的 collective overlap 设计文档里核对：选用的 allreduce 算法是 ring 还是 tree/hierarchical，以及模型里是否包含 incast 等待项；若只按 hop 数×L 建模，把 incast 与 kernel 启动开销补进去后再看结论是否变化。
- **confidence**：public_measurement
- **relative_validity**：结构与渐近行为长期有效；算法切换阈值（256 KB / >16 GPU）随 NCCL 版本变化，约 1–2 年。
- **sources**：
  - NCCL Algorithms & How It Achieves 900 GB/s（ai-hardware-engineer-roadmap，Ring/Tree/DBT 结构与带宽分析），2024，https://github.com/ai-hpc/ai-hardware-engineer-roadmap/blob/af3ab17f64d78218793931b4c61b68613e9067c3/Phase%205%20-%20Advanced%20Topics%20and%20Specialization/1.%20GPU%20Infrastructure/Nvidia%20GPU/HPC%20Setup/NCCL-Deep-Dive/02-Algorithms-and-Bandwidth.md
  - NVRAR: 层次化 allreduce 与 NCCL 算法切换点实测（arXiv 2511.09557），2025，https://browse-export.arxiv.org/pdf/2511.09557

### SOTA-IC-09 层次化 allreduce 的成本模型：节点内项线性于 G、节点间项对数于 N

- **approach**：两级层次化 allreduce（节点内 reduce-scatter + 跨节点对数交换 + 节点内 all-gather）
- **what_it_is**：把 allreduce 拆成三段：先在节点内做 reduce-scatter，再在节点间做对数级的 reduce（递归加倍式交换），最后节点内 all-gather。这样做的效果是把跨慢链路（IB/RoCE）的流量压到每个节点只发一条聚合消息，跨节点交换次数从 Θ(N) 降到 Θ(log N)，而节点内高速链路承担大头。这是目前多节点 MoE/TP 部署的主流做法，也是理解「TP 规模扩大时 collective 占比如何演化」的正确公式来源。
- **who_uses_it**：NCCL 的多节点层次化路径、NVRAR（NVIDIA 提出的递归加倍变体）、各类 hierarchical/H-Ring allreduce 研究与 RDMA 侧实现。TP/EP 并行的生产部署普遍依赖它。
- **typical_numbers**：成本模型（G=节点内 GPU 数，N=节点数，M=消息量，η=跨节点流量系数）：T ≈ 2(G−1)·α_intra + log₂N·α_inter + |M|/G·[2(G−1)/β_intra + (N−1)η/(N·β_inter)]。小消息极限（忽略带宽项）：T ≈ 2(G−1)·α_intra + log₂N·α_inter。NVRAR 相对 NCCL：64/128 KB 只有 0.7–0.8×（kernel 启动开销吃掉），256 KB 起 1.06–1.44×。适用条件：两级（或以上）层次化拓扑，节点内带宽显著高于节点间。
- **applies_when**：需要写出「TP 增大时 collective 时延如何变化」的公式；或者判断某个 collective 开销假设属于层次化代际还是单级 ring 代际。
- **not_applicable_when**：单节点/单芯片情形下 N=1，跨节点项整项消失，公式退化为 2(G−1)·α_intra——此时引用任何多节点的实测数字（包括 NVRAR 的加速比）都不成立，本条的 log₂N 部分同样不适用；同时 α_intra 在片内与跨 die 的物理含义不同（片内是 NoC+软件步骤，跨 die 还要加 PHY），不能直接套用。
- **project_premises**：与 TP32 下的 allreduce 开销 相关：本条给出层次化模型的项结构，其中节点内项线性于 G，是本项目 TP32/PP1/单芯片情形下唯一存活的一项。
- **what_to_check_here**：在 teams/software 的 collective 文档里核对：allreduce 时延模型里是否出现 2(G−1)·α 这一线性项；若项目实际是单节点 TP32，把跨节点项置零后重算 collective 时间，并确认 α 的取值来源（是实测、供应商数据还是估计）。
- **confidence**：public_measurement
- **relative_validity**：模型形式约 3–5 年；系数（α/β 实测值）约 1–2 年，随互联代际变化。
- **sources**：
  - NVRAR: 层次化 allreduce 成本模型与 NCCL 对比（arXiv 2511.09557），2025，https://browse-export.arxiv.org/pdf/2511.09557
  - 参数同步架构性能比较（计算机学报，HD Allreduce 通信次数 2log₂n），2022，http://cjc.ict.ac.cn/online/onlinepaper/wangs-2022711150724.pdf

### SOTA-IC-10 片上/2.5D NoC 每 hop 时延的构成：router、转向、跨时钟域、跨 die PHY

- **approach**：NoC 每 hop 时延建模：1 cycle/跳 + 转向惩罚 + CDC + 每 die 两个 NoP router hop
- **what_it_is**：把「一次跨 die 通信」的时延分解成四段：片内 NoC 的 router hop、链路 wire delay、跨 die 时点（PHY + 可能的 interposer router）、以及时钟域跨越。架构论文的通行建模是：每 router 1 cycle（直行）+ 转向额外 1 cycle；跨芯片/interposer/package substrate 再加 1 cycle；跨时钟域再加 1 cycle。RapidChiplet 的模型把 PHY 时延显式作为参数：chiplet 对 chiplet 直连时 PHY 时延要加两次，经 interposer router 时加一次；interposer router 自身有 L_IR。
- **who_uses_it**：chiplet 架构探索工具（RapidChiplet + BookSim2）、多 die NoC 的学术建模、2.5D 架构的时延预算研究。
- **typical_numbers**：片上 wire：~220 ps/mm（SAMOS 2014）；12 mm die、每维 8 router → 单跳链路 ~1.5 mm ≈ 330 ps；有源 interposer 1 cycle/10 mm，无源 interposer 3 cycle/10 mm（Stow et al.）。router：直行 1 cycle + 转向 1 cycle；跨衬底/interposer 各 +1 cycle；跨时钟域 +1 cycle。2.5D 的每个 D2D link 需要**两个 PHY**（收发各一）。D2D link 的 pJ/bit 在建模中约 0.1 pJ/bit（1 Gbps/link，学术近似）。适用条件：≤2 GHz 量级 NoC 时钟、20 世纪工艺节点建模；数值为架构级近似而非签核值。
- **applies_when**：需要把「每 hop 时延」从一个笼统系数拆成可分类核算的项；或者判断某个跨 die 往返预算是否漏掉了 CDC / 转向 / 两端 PHY 这些项。
- **not_applicable_when**：把学术建模值（1 cycle/router、0.1 pJ/bit）当作本项目可实现值使用——这些是架构探索的近似；也不能把片内 NoC 的 wire delay（220 ps/mm）直接套到跨 reticle 的绕线（后者可能走 shoreline、经 bump、跨封装，量级不同）；高 radix router 的最优流水级数是 4–5 级而非 3 级，不能统一按 1 cycle/跳 假设。
- **project_premises**：与 TP32 下的 allreduce 开销 相关：本条提供把 allreduce 时延项里的「每 hop」拆成可核算分量所需的分项，而 UCIe PHY 的 2 ns 只是其中一段。
- **what_to_check_here**：在 teams/hardware 的 NoC/Die-to-Die 设计文档里核对：跨 reticle 一次往返的时延预算是否逐项列出了「NoC router 跳数 × 每跳 cycle × 频率」「转向惩罚」「跨时钟域」「两端 PHY」；缺哪一项就向该单元 owner 索要该项的量级估计。
- **confidence**：industry_survey
- **relative_validity**：建模方法约 5 年有效；具体 cycle 数与 wire delay 已随工艺节点明显变化，取值需按本项目工艺重新核定。
- **sources**：
  - RapidChiplet: A Toolchain for Rapid Design Space Exploration of Chiplet Architectures（PHY/router/wire 时延参数化），2021，http://vwgwjkk.unixer.de/publications/img/iff-rapidchiplet.pdf
  - NoC 路由器与链路的每 hop 延迟/功耗建模（SAMOS 2014，wire delay 220 ps/mm），2014，https://samos-conference.com/Resources_Samos_Websites/Proceedings_Repository_SAMOS/2014/Files/2014-IC-18.pdf
  - 2.5D 跨 die NoC 建模（多伦多大学学位论文，1 cycle/router + 转向 + CDC + Stow et al. interposer 走线），UNVERIFIED，https://utoronto.scholaris.ca/server/api/core/bitstreams/a5341f64-b104-459b-9c55-ab1c7c7d21a3/content

### SOTA-IC-11 小消息下 Ring 反超对数算法——hop 数少不等于完成时间短

- **approach**：Astra-Sim 仿真对照：Ring AllReduce vs Recursive Doubling（16 GPU 环，800 Gbps 链路）
- **what_it_is**：长期通行认知是「小消息用对数级算法（Recursive Doubling / 蝶形），大消息用 Ring」。Astra-Sim 的仿真给出了反例：在环拓扑、传播时延较低时，Ring 在**小消息上也不输**，在 10 ns 传播时延下 Recursive Doubling 慢约 1.6×，且差距随传播时延增大而收敛。原因是对数算法的路径更长，端到端传播时延与路径拥塞都更高。论文同时指出经典 Hockney α-β 模型忽略了端到端传播时延与拥塞这两项。
- **who_uses_it**：chip-to-chip 背靠背互联（环拓扑）的集合通信设计；所有用 α-β 模型推 collective 时间的团队（作为反例校正）。
- **typical_numbers**：16 GPU、800 Gbps/链路、固定启动时延可忽略：传播时延 10 ns 时 Recursive Doubling 比 Ring 慢约 1.6×；传播时延增大后差距缩小。大消息下 Recursive Doubling 约慢 2×。对照组：NCCL 在 256 KB、>16 GPU 时从 Ring 切到 Tree；NVRAR 在 64/128 KB 只有 NCCL 的 0.7–0.8×（三阶段设计的 kernel 启动开销）。适用条件：环/环嵌入拓扑、传播时延与链路速率在给定区间、消息从很小到大。
- **applies_when**：判断「按 hop 数少的算法推时延」是否安全；或者解释为什么某些小消息集体通信实测与理论排序不一致。
- **not_applicable_when**：拓扑是分层异构的（节点内 + 节点间），此时对数算法在跨节点跳数上的优势是结构性的、不会被路径长度抵消（实测多节点下 Ring 慢 2.9×）；也不能反推成「对数算法没有价值」——论文本身只是指出在低传播时延的环拓扑上 Ring 不输，并据此做光子可重构拓扑的论证。
- **project_premises**：与 TP32 下的 allreduce 开销 相关：本条是「用 hop 数推时延」这一做法的反例，用于判断该项目 allreduce 假设的建模层次。
- **what_to_check_here**：核对本项目的 allreduce 覆盖时间推导是否只用了 hop 数 × 每 hop 时延；若是，标出这个反例并检查是否漏掉了路径长度/拥塞项（在单芯片环状/网格拓扑上尤其相关）。
- **confidence**：public_measurement
- **relative_validity**：约 2–3 年（结论依赖拓扑与链路参数，推广到其他拓扑需重新验证）。
- **sources**：
  - Short-circuiting Rings for Low-Latency AllReduce（arXiv 2510.03491，Astra-Sim 仿真），2025，https://browse-export.arxiv.org/pdf/2510.03491

### SOTA-IC-12 NCCL 三种协议（LL / LL128 / Simple）的交叉点与它们对 SM 的不同占用

- **approach**：按消息大小在协议间切换：LL 小步低延迟、LL128 中段、Simple 大块带宽
- **what_it_is**：NCCL 的每个算法（Ring/Tree）都可以跑在三种协议上。LL 用 8 字节原子单元，延迟最低但吞吐最低；LL128 用 128 字节 flag-based 传输，中段均衡；Simple 用大块 GPU 发起的 DMA，只在每次传输建立时短暂占用 SM，之后交给链路硬件搬运、SM 被释放。三者与 Ring/Tree 的交叉点共同决定实际性能，交叉点与硬件密切相关而非纯理论推导。
- **who_uses_it**：所有用 NCCL 的 TP/DP 训练与推理；也是判断「collective 开销应该按哪个协议口径估」的依据。
- **typical_numbers**：协议交叉点（归一化视角）：Ring/LL 在小消息区最优，量级在 **~256 KB 以下**；LL128 覆盖中段；Simple 用于大块带宽区。每步实测时长（Ring AllGather，256 MB，p=2/PCIe 平台）：LL 发送均值 13.0 µs / 接收 12.6 µs（较对称）；LL128 发送 103.9 µs / 接收 92.7 µs；Simple 接收 196.3 µs vs 发送 358.5 µs（接收标准差 223.6 µs > 均值，CV 114%，右偏）。测点覆盖 4 KB–256 MB、Ring 与 Tree、p=2（PCIe）与 p=4。适用条件：NCCL 的 Ring/Tree 实现，消息 4 KB–256 MB。
- **applies_when**：判断一个 collective 时间模型应按「协议」还是「算法」分层；或者解释为什么同一个 allreduce 在不同消息大小下性能曲线不连续。
- **not_applicable_when**：把 PCIe p=2 平台上的每步绝对值外推到 NVLink 或片内互联（论文明确把「这些分布特性是否在大 rank 数与不同互联上不变」列为开放问题）；也不适用于非 NCCL 的 collective 实现（自研 runtime 的协议分层与 SM 占用模型完全不同）。
- **project_premises**：与 TP32 下的 allreduce 开销 相关：本条说明 collective 时间由「算法 × 协议 × 消息大小」三维决定，单一系数无法覆盖全区间。
- **what_to_check_here**：在 teams/software 的 collective/overlap 文档里核对：allreduce 时间假设对应的是哪种协议口径（小消息 LL 级还是大消息 Simple 级），以及是否按消息大小分段；若用一个常数覆盖全部 token 长度，指出 §1 的交叉点证据。
- **confidence**：public_measurement
- **relative_validity**：交叉点约 1–2 年（随 NCCL 版本与硬件变化）；协议分层结构约 5 年。
- **sources**：
  - Enhancing the Performance Analysis of NCCL GPU Collectives（TU Wien 学位论文，kernel 级 primitive 计时），2026，https://repositum.tuwien.at/bitstream/20.500.12708/229234/1/Cerar%20Jurij%20-%202026%20-%20Enhancing%20the%20Performance%20Analysis%20of%20NCCL%20GPU%20Collectives.pdf
  - Bandit-Guided NCCL Tuning for Multi-Node GPU Clusters（Stanford CS244c，协议 SM 占用模式），2026，https://www.scs.stanford.edu/26wi-cs244c/proj/bandit_guided.pdf

### SOTA-IC-13 Overlap 的失效条件（一）：通信本身变慢，且不能按「单独耗时相减」估算收益

- **approach**：并发流 overlap 实测（通信与矩阵乘同时运行，取中位数）
- **what_it_is**：「把通信藏到计算后面」在实现上就是让集体通信与另一个 micro-batch 的 GEMM 并发执行。公开实测显示：通信在并发时会明显变慢（与计算争抢 SM、HBM、互联），而并发组的总完成时间并不等于「max(通信, 计算)」。判据必须是比较「两者各自单独耗时」与「两者并发耗时」，不能用单独的差值来减。
- **who_uses_it**：所有做 TP/DP/MoE overlap 的团队；也是 AutoCCL 这类自动调优系统把「并发干扰」纳入反馈的原因。
- **typical_numbers**：Gloo、4 个 CPU 进程、AllReduce 与矩阵乘并发、5 次取中位数：4 MiB 时通信单独 2.67 ms → 并发 6.14 ms（↑2.3×），计算 11.53 → 11.52 ms，并发组完成 11.58 ms（通信几乎完全隐藏）；64 MiB 时通信 36.92 → 45.21 ms，计算 11.03 → 12.89 ms，并发组完成 45.24 ms——单独运行合计约 48.0 ms，并发只省约 2.7 ms，而非计算的 11 ms。另一个参照：AutoCCL 在 recomputation 干扰下把 AllGather 带宽从 18.26 GB/s 提到 32.44 GB/s（并指出搜索与切换本身有成本，需 S/Δ 次调用回本）。适用条件：Collective 与 GEMM 并发、执行资源（SM/核、内存带宽、互联）被两者共享。
- **applies_when**：评估 overlap 能带来多少收益；或者判断某个「通信开销已被 overlap 隐藏」的假设是否成立。
- **not_applicable_when**：把 CPU/Gloo 实验的绝对时间外推到 GPU/NVLink（机制相同、倍率不同）；也不适用于通信量小到可完全隐藏的情形（4 MiB 那一行就是完全隐藏的反面例子，此时 overlap 假设成立）；采用 SM-free 设计（如 DeepEP 的 hook 式 RDMA）时「通信占用 SM」这一失效机制不适用。
- **project_premises**：与 τ=1.15 相关：本条给出 overlap 系数在什么条件下会明显偏离 1，用于判断该系数是否落在公开实测的支持区间内。
- **what_to_check_here**：在 teams/software 的 collective overlap contract 文档里核对：overlap 收益的推导方式是「单独耗时相减」还是「并发实测」；若是前者，要求补一份并发条件下的实测或仿真，并注明并发时通信自身的退化倍率。
- **confidence**：public_measurement
- **relative_validity**：机制长期有效；具体倍率随硬件与实现变化，约 1–2 年需复核。
- **sources**：
  - AI Infra Book（bojieli，Experiment 6-5：通信与矩阵乘并发实测，含 AutoCCL 数据），2025，https://github.com/bojieli/ai-infra-book/releases/latest/download/AI-Infra-Book-EN.pdf

### SOTA-IC-14 Overlap 的失效条件（二）：并发会改变最优算法/协议组合

- **approach**：overlap 下的 NCCL 配置扫描（5 种算法×协议组合 × 9 个消息大小 × 3 种拓扑）
- **what_it_is**：NCCL 的 AUTO 成本模型是针对「孤立 collective」标定的。在计算并发（overlap）条件下，最优的 (算法, 协议) 组合会发生变化；原因是不同协议对 SM 的持续性占用不同——Simple 只在传输建立时短暂占用 SM，LL128/LL 用 flag 轮询与原子操作持续占压 SM，在计算并发时反而不利。因此「先按单独运行 benchmark 选算法、再假设 overlap 藏住剩余时间」的推导链不成立。
- **who_uses_it**：所有在 GPU 上做通信-计算 overlap 的部署；NCCL AUTO 调优、bandit 式在线调优、AutoCCL 这类系统。
- **typical_numbers**：8×A100-SXM4-80GB、AllReduce fp32、32 KB–256 MB、并发 4096×4096 fp32 matmul：单节点下 **9 个消息大小中 6 个**的最优配置在 overlap 下翻转；overlap 时 Ring+Simple 在 ≥2 MB 全面占优（挤掉单独运行时获胜的 Tree+LL128）。多节点放大：AUTO gap 从单节点 1.2% 涨到 2 节点 64 MB 下的 57.2%（25×）；64 MB 时 Ring+Simple 337 ms vs Tree+Simple 117 ms（2.9×）。4×2 拓扑下 Ring 要求每元素 7 跳、其中 3 跳跨节点间链路；Tree 跨节点只需 Θ(log N_nodes) 条聚合消息。参考带宽：单条 NVLink ~25 GB/s。适用条件：GPU 上有计算并发、消息 32 KB–256 MB、单/多节点 NVLink+网络的组合。
- **applies_when**：评估 overlap 场景下的 collective 时间；或者审核任何用「孤立 benchmark 结果」支撑 overlap 后性能结论的推导。
- **not_applicable_when**：不适用于非 NCCL 的自研 collective 实现（协议分层不同，翻转点不同）；也不适用于无并发（顺序执行）的场景，此时 AUTO 的选择基本正确；单节点全互联拓扑下 AUTO 的误差被一致的链路带宽掩盖（仅 1.2%），把多节点 57% 的放大效应套到单芯片上不成立。
- **project_premises**：与 τ=1.15 相关：本条说明 overlap 系数不仅取决于 overlap 比例，还取决于算法选择是否随 overlap 重调。
- **what_to_check_here**：在 teams/software 的 overlap contract 与 teams/hardware 的 NoC 文档里核对：算法/协议的选择是否在 overlap 条件下重新标定过；若沿用孤立 benchmark 的选型，要求补一份并发条件下的选型复核。
- **confidence**：public_measurement
- **relative_validity**：约 1–2 年（依赖 NCCL 版本与 GPU 代际；结论方向性比数值更稳）。
- **sources**：
  - Bandit-Guided NCCL Tuning for Multi-Node GPU Clusters（Stanford CS244c），2026，https://www.scs.stanford.edu/26wi-cs244c/proj/bandit_guided.pdf

### SOTA-IC-15 MoE 专家并行 all-to-all 的 SM-free overlap 与低延迟内核

- **approach**：DeepEP low-latency 内核 + receiving hook（通信在后台进行且不占 SM）
- **what_it_is**：MoE 的专家并行需要 all-to-all（dispatch / combine）。DeepEP 提供两类内核：面向训练与 prefill 的高吞吐内核（支持 NVLink 与 RDMA 的不对称域带宽转发，token 先经 IB 到节点内索引相同的 GPU 再经 NVLink 转发到目标专家，两条路径完全重叠，约 20 个 SM 即可同时打满），以及面向 decode 的低延迟内核（纯 RDMA）。低延迟内核的关键机制是 receiving hook：调用 hook 之前张量不会真正收到，因此 RDMA 流量可在后台推进而**不占用任何 SM**，实现两 micro-batch 重叠。软件层面还依赖 NVSHMEM 单边通信与 NUMA/HCA 亲和。
- **who_uses_it**：DeepSeek-V3/R1 系列的生产训练与推理；开源 MoE 部署（DeepEP 是最早的开放 EP 通信库）；云厂商在 Azure 等平台上做 DeepEP 调优。
- **typical_numbers**：普通（高吞吐）内核测试条件：H800（NVLink 上限 ~160 GB/s）+ CX7 InfiniBand 400 Gb/s（~50 GB/s），沿用 DeepSeek-V3/R1 预训练设置。低延迟内核：H800 + CX7 IB 400 Gb/s，纯 RDMA。官方建议 decode 场景 `num_max_dispatch_tokens_per_rank`（实际 batch size）**< 256**，且低延迟模式占用的 buffer 空间远大于普通模式；QP 数**必须**等于本地专家数。NUMA 亲和举例（DGX H100）：2 NUMA node × 48 核，8 进程/节点 → 每进程 12 核。路由建议：重负载时启用自适应路由、轻负载时用静态路由；普通节点间内核启用自适应路由可能导致死锁或数据损坏。适用条件：InfiniBand 网络（已在 IB 上完整测试，理论兼容 RoCE）；支持原子操作的网卡。
- **applies_when**：评估 MoE 部署里 EP all-to-all 的 overlap 可行性；或者判断「通信完全被隐藏」是否需要一个专门的 SM-free 机制而非普通多 stream。
- **not_applicable_when**：把「SM-free」外推到所有 collective——它只适用于这套 hook 式设计，且只在 decode 低延迟内核上提供；不适用于 TP 的 allreduce（DeepEP 处理的是 EP 的 all-to-all 语义）；也不适用于 batch 远大于 256 的 decode 或 prefill（此时应走高吞吐内核）；网卡不支持原子操作时该路径直接失效（Azure 的 Ethernet 控制器即为例）。
- **project_premises**：与 TP32 下的 allreduce 开销 相关：本条给出 MoE 专家并行（与 TP 不同的并行维度）在 overlap 上的成熟做法与边界，用于区分本项目 TP allreduce 与 EP all-to-all 两类通信。
- **what_to_check_here**：在 teams/software 的 MoE/EP 部署方案里核对：本项目是否区分 TP allreduce 与 EP all-to-all 两类通信；若混用同一套 overlap 结论，指出 EP 侧的 SM-free 机制并不自动适用于 allreduce。
- **confidence**：vendor_datasheet
- **relative_validity**：约 1–2 年（DeepEP 仍在迭代，SM-free 与 TMA 路线未完成）。
- **sources**：
  - DeepEP README（deepseek-ai/DeepEP，low-latency kernels 与 hook overlap 说明），2025，https://github.com/deepseek-ai/DeepEP/blob/567632dd/README.md
  - Achieving Optimal Performance for DeepSeek Expert Parallelism (DeepEP) on Azure（20 SM 打满、NUMA/HCA 亲和），2025，https://argonsys.com/microsoft-cloud/library/achieving-optimal-performance-for-deepseek-expert-parallelism-deepep-on-azure/

### SOTA-IC-16 RDMA / scale-out 的时延构成与 NVLink 的量级差

- **approach**：跨节点通信路径分解：NIC + 交换机 hop + 链路传播 + FEC/协议 + 主机侧（PCIe/UPI/内存放置）
- **what_it_is**：scale-out 的一次通信时延由多段构成：网卡处理、交换机/路由器 hop、链路传播、协议/FEC、以及主机侧（PCIe switch、跨 CPU 的 UPI、内存放置与 NUMA）。公开资料普遍只给出**带宽**与**相对倍数**，不给可复用的单值绝对时延。可确证的是量级关系：跨节点链路比节点内慢 5–20 倍，且主机侧布局（buffer 放在哪个 NUMA 节点、环上卡序）会改变跨 CPU 链路的流量，进而改变时延。
- **who_uses_it**：多节点训练/推理的通信路径设计；MoE 专家放置与实时再平衡的可行性判断；NCCL/DeepEP 的拓扑感知。
- **typical_numbers**：NVLink：单链路 ~25 GB/s/方向；NVLink 4.0 每 GPU 18 lane × 50 GB/s 双向 = 900 GB/s；H800 整卡 NVLink 上限 ~160 GB/s；H20/H800 上 NVLink 450/200 GB/s。RDMA：CX7 InfiniBand 400 Gb/s ≈ 50 GB/s/卡。搬一个 42 MB 的专家（DeepSeek-R1 量级）：NVLink 450/200 GB/s → 92/210 µs；RDMA 200/400 Gbps → 1.7/0.8 ms。主机侧（DGX H100）：双路 Xeon 8480C、UPI 16 GT/s、每 GPU PCIe Gen5 x16 = 64 GB/s/方向；48 MiB 的 4 卡环归约中，跨 CPU 链路流量随 buffer 放置与环上顺序在 12–24 MiB/方向之间变化（2:1:2）。路由：IB 自适应路由可消除路由冲突导致的拥塞但引入额外延迟。适用条件：InfiniBand 或 RoCE 网络、给定 NIC 速率与拓扑。
- **applies_when**：评估跨节点通信是否可行（例如实时专家迁移、跨节点 allreduce）；或者判断某个 scale-out 时延假设属于哪个量级区间。
- **not_applicable_when**：单芯片/单节点内部署（N=1）下整条 RDMA 路径不存在，本卡片的绝对数字不适用；也不能把 RDMA 的时延构成直接搬到片内 D2D（后者无 NIC、无交换机 hop、无 FEC，时延低 2–3 个数量级）；此外公开资料没给单跳 RDMA 绝对时延，需要向网卡/交换机供应商确认。
- **project_premises**：与 TP32 下的 allreduce 开销 相关：本条给出 scale-out 路径的量级，用于判断该 allreduce 开销假设对应的是片内、节点内还是跨节点路径。
- **what_to_check_here**：确认本项目的 TP32 allreduce 是否全部落在单芯片/单节点内；若含跨节点段，向网络供应商（NIC/交换机）索要含自适应路由开关两种配置的单跳时延实测，并核对 NUMA/HCA 亲和是否已在软件设计中落实。
- **confidence**：public_measurement
- **relative_validity**：约 1–2 年（NIC/交换机与 NVLink 代际变化快）。
- **sources**：
  - EPIC: MoE 负载均衡与实时专家迁移（ACM DOI 10.1145/3789240.3829201，专家传输时间对比），2026，https://dlnext.acm.org/doi/pdf/10.1145/3789240.3829201
  - AI Infra Book（bojieli，DGX H100 主机侧拓扑与跨 CPU 流量），2025，https://github.com/bojieli/ai-infra-book/releases/latest/download/AI-Infra-Book-EN.pdf
  - DeepEP README（CX7 IB 400 Gb/s 带宽与路由建议），2025，https://github.com/deepseek-ai/DeepEP/blob/567632dd/README.md

### SOTA-IC-17 TP 推理每层 2 次 allreduce，decode 阶段消息极小 → 落在时延受限区

- **approach**：TP 推理的固定通信模式：每层 2 次 allreduce，decode 时消息大小 = batch × hidden × 2 字节
- **what_it_is**：张量并行推理每层需要 2 次 allreduce（attention 与前馈各一次，bfloat16）。decode 阶段一次只生成 1 个 token，因此单次 allreduce 的数据量极小，通信完全落在 α（时延）主导区间而非 β（带宽）主导区间。这决定了 TP 推理的 collective 优化目标与训练截然不同：训练按带宽最优（Ring/大消息），推理按延迟最优（小消息、常数或对数跳数）。因此围绕 TP 推理的公开优化路线包括 one-shot / two-shot 全互联归约、half butterfly、butterfly，以及在 CUDA graph 中捕获通信。
- **who_uses_it**：所有 TP 推理服务（vLLM 等）；也是 custom allreduce kernel 生态（one-shot/two-shot）的直接动因。
- **typical_numbers**：每层 2 次 allreduce；举例：batch 32、fp16 的 Llama 65B/70B，单次 allreduce 大小 = 32 × 8192 × 2 = **512 KB**。时延与带宽权衡（N=rank 数、P=每 rank 数据、L=单向 p2p 时延）：Ring 时延 2(N−1)L（带宽最优，不要求全互联）；One shot L（非带宽最优，要求全互联）；Two shot 2L（带宽最优，要求全互联）；Half butterfly log₂N·L（非带宽最优，不要求全互联）；Butterfly 2log₂N·L−1（带宽最优，不要求全互联）。全互联系统上的量级分界：one-hop 优于 two-hop 的临界在 4×A100 约 ≤512 K、8×A100 约 ≤256 K。PCIe 系统（4×A10）上 one shot 只在 <10 K 有意义，half butterfly 到 512 K 仍优于 NCCL。适用条件：单机 TP、fp16/bf16、小 batch decode。
- **applies_when**：判断 TP 推理的 collective 是延迟受限还是带宽受限；或者评估 one-shot / butterfly 这类「以带宽换时延」的方案是否值得。
- **not_applicable_when**：prefill 或大 batch 场景（消息变大后回到带宽受限区，此时 Ring/带宽最优算法重新占优）；跨节点 TP（one-shot/two-shot 要求全互联，跨节点不满足）；该 512 KB 例子是 Llama 65B/70B 的 hidden=8192，hidden 或 batch 不同则消息大小按比例变化，不能直接引用；也不适用于 MoE 的 EP all-to-all（那是不同的通信模式，见 SOTA-IC-15）。
- **project_premises**：与 TP32 下的 allreduce 开销 相关：本条给出 TP 推理每层 allreduce 的调用次数与消息量级来源，用于判断该开销对应的是延迟受限区还是带宽受限区。
- **what_to_check_here**：在 teams/model 的 workload ledger 里核对：每层 allreduce 的调用次数（是否为 2）与 decode 阶段的单次消息字节数（batch=1 时的 KV/hidden 流量）；再把规模 N 代入相应算法（ring 2(N−1)·L vs butterfly 2log₂N·L−1）判断 hop 数量级。
- **confidence**：public_measurement
- **relative_validity**：约 2 年（模型 hidden 维度与量化格式变化会改变消息大小；算法时延形式长期有效）。
- **sources**：
  - Latency-optimal allreduce and cuda graph optimization（vLLM，含五算法时延/通信量对照表），2024，https://github.com/vllm-project/vllm/files/13574639/Latency-optimal.allreduce.and.cuda.graph.optimization.pdf
  - NCCL Algorithms & How It Achieves 900 GB/s（Double Binary Tree 与 NVLink 带宽），2024，https://github.com/ai-hpc/ai-hardware-engineer-roadmap/blob/af3ab17f64d78218793931b4c61b68613e9067c3/Phase%205%20-%20Advanced%20Topics%20and%20Specialization/1.%20GPU%20Infrastructure/Nvidia%20GPU/HPC%20Setup/NCCL-Deep-Dive/02-Algorithms-and-Bandwidth.md

## 9. 未解的取证方向（汇总）

按优先级排列，每条说明缺什么、以及去哪里要。

1. **UCIe 端到端有效带宽折减的实测（最缺）**：公开资料只到 flit 级字节账（68B flit 94.1%、256B flit 约 98%）与规范层面的 MPE 上限（50%），以及 PHY 的 pJ/bit 与 ns 级时延。**没有**任何一份公开的「协议层 + credit 流控 + 读写转向 + 电源态进出」叠加后的 sustained/peak 实测曲线。取证对象：UCIe 控制器 IP 供应商（Synopsys / Cadence / Alphawave / 自研 PHY 团队）。
2. **单芯片内跨 reticle 的 D2D NoC 每 hop 时延**：UCIe PHY 的 ~2 ns 是 Pin → FDI，不含片内 NoC router 跳数与转向惩罚、跨 reticle 的时钟域跨越、绕 shoreline 的走线。缺的是这四项相加后的跨 reticle 往返时延。
3. **112G SerDes 在 D2D reach 下的实测时延**：公开对比表只写 "FEC dependent"。取证对象：SerDes IP 供应商的 datasheet。
4. **TP=N 时 collective 占 decode step 时间的比例曲线**：公开资料能确证的是「每层 2 次 allreduce」「解码时消息极小」「ring 是 2(N−1) 跳、层次化是 O(log N)」，**没有** TP=32、单节点、decode-only 场景下 collective 占 step 时间的百分比实测。这正是「TP 规模扩大时 collective 占比演化」这一问在公开资料里唯一确证不了的部分。
5. **1M context 下的 KV collective 量级**：现有公开资料覆盖的是 4K–128K context 与训练/prefill 场景。
6. **单芯片 32-way TP 的实测 collective 数据**：公开资料里没有任何一份是同规模（TP32、单芯片、B=1、1M context）与同拓扑的。所有可比数字都来自多节点 GPU 集群（NVLink 8 卡/节点 + IB）。
7. **两条本次未能完成检索的方向**：**(a)** 各家 UCIe 端口在 Flit Mode 下的 sustained 带宽厂商声明对比；**(b)** ring 与 hierarchical allreduce 在片内/单封装层级的 hop 数与时延实测——后者才是与本项目规模对得上的参照系。
