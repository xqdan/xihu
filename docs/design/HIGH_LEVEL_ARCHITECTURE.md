# K3 1000 TPS/usr 高层架构设计

版本：2026-09-22  
状态：`BASELINE / ARCHITECTURE PLANNING`  
规格空间来源：`references/k3_1000tps_chip_designs.html`（Kimi K3、目标 1000 TPS/usr 的芯片规格搜索页，已从工作区 `docs/1000tps/` 入库；MC 带宽档位决策见 [ADR-011](DECISIONS.md#adr-011mc-带宽档位与规格网格)）

## 1. 文档目的

本文是 K3 推理芯片项目的高层架构总纲，用于：

1. 定义从模型、系统、卡、Die、Core 到 tile 的架构分层；
2. 划分各子系统的功能边界和接口责任；
3. 规划后续详细设计文档、可执行模型和验证交付物；
4. 建立统一的性能、带宽、容量、功耗、可靠性和可制造性目标；
5. 为架构冻结、RTL 前规格和后续实现建立需求追踪入口。

本文不展开 Tensor engine 内部流水线、SRAM bitcell、PHY 电路、RTL 状态机和具体工艺实现；这些内容由下一级详细设计文档负责。

> 本设计面向 K3 工程推理 workload，当前项目中的 K3 模型、PPA 系数和部分性能参数仍是工程假设，不代表模型提供方、Memory Cube 供应商或物理实现已经签核的规格。架构冻结必须以正式模型清单、可制造的内存路线和可回标的精确性能模型为依据。

---

## 2. 顶层设计目标

高层架构分成两层。第一层是规格页里不随搜索改变的封装与数据流。第二层是同一页上的规格网格：MC、SRAM、算力、归约延迟、互联和卡数都要在面积约束下选点，不能先写成唯一数字。

### 2.1 主要产品目标

| 类别 | 目标 | 来源 |
|---|---|---|
| 主要 workload | K3 Decode，B=1，单用户 | 规格页页脚 |
| 默认 Context | 1,048,576 token；对照档 32K / 2M | 页首输入，默认 1M |
| 目标性能 | 1000 TPS/usr，端到端 ≤ 1 ms/token | 页首目标 |
| 达标判据 | TPS ≥ 1000 × 1.05 = 1050 | 页首达标裕量 5% |
| 建模裕量 | 1.17，乘在 Stage、PP 跳和 LM Head 之后 | `OPTIONS_DEFAULT.margin` |
| 层预算 | 93 层摊完后每层约 9.2 μs | 1 ms / 1.17 / 93 |
| 主要模式 | Decode 优先；Prefill 与多用户 KV 另核 | 页脚 |
| 软件介入 | 一个 decode step 内不依赖 host 逐 kernel、逐 collective 介入 | 沿用系统约束 |

K3 工程口径与规格页内嵌的 `kimiK3` 预设一致：2.78T 总参数、104.2B 激活参数、93 层、92 个 MoE 层、hidden 7168、latent 3584、896 experts、每 token 激活 16 个 routed expert 加 2 个 shared expert、24 层 Softmax MLA、69 层线性 Attention。Routed 权重按 MXFP4（17/32 byte），dense 按 2 byte。1M KV 按 1152 B × 24 层 × Context，沿 TP 分片后计入每 token 的 MC 读取。

### 2.2 固定的封装与数据流

```text
单用户 Decode
└── N 张卡，N = PP × TP，由每个芯片点单独求最少达标卡数
    └── 1 张卡 = 1 个封装 = 1 个 TP rank 内的计算单位
        ├── 8 × Compute Die，每颗约 400 mm²
        │   ├── L-Core：线性阵列，Decode GEMV / 专家 GEMM
        │   ├── H-Core：Attention
        │   ├── SRAM 切片：8 颗 Die 的切片合成「SRAM/卡」
        │   └── Die 内 NoC + UCIe
        ├── Nmc 颗 3D-DRAM Memory Cube，经 UCIe 接到计算 Die
        └── 卡内再按 8 Die 分片
```

规格页架构图给出的系统分法：

1. **卡。** 8 颗计算 Die 排成 2×4，经 UCIe mesh 互连，上下两侧接 MC。MC 只提供容量和带宽，矩阵计算留在 Compute Die。
2. **TP 组。** TP 张卡同时为一个 token 提供带宽。权重和 KV 各切成 1/TP。每张卡每层的时间线是：MC 读下一层、SRAM 预取缓冲、计算、all-reduce。缓冲装得下「预测专家 + 归约空窗期间 MC 能读满的字节」时，MC 在计算和归约期间继续读；装不下时，归约期间 MC 空转，专家读取退回到 Router 之后。预测未命中的 `(1−p)` 份专家在 Router 之后串行补读。
3. **PP 流水。** Stage 串行，总卡数是 PP×TP。单用户延迟靠 TP 把字节切开并行读。PP 用来吸收卡数、摊薄每卡权重容量，并换流水吞吐。PP 边界只传一次 hidden 向量。

集合通信次数按页首开关：融合打开时每个 MoE 层 4 次 all-reduce（Wdown 与 Router 的 all-gather 合并）；关闭时 5 次。每个 Softmax MLA 层另加一次 LSE 合并，语义是 `m/l/O`，不能当成普通 FP32 sum。默认输入是融合打开、LSE 合并计入、归约延迟用内存语义的 flat 缩放（TP8 到 TP32 近似不涨）。消息语义的 log2 缩放保留为对照，不作为默认时间模型。

面积硬约束，按整卡计算 Die 预算：

```text
SRAM 面积 + 张量阵列 + MC PHY + 固定开销 ≤ 8 × 400 mm² = 3200 mm²
```

默认面积系数：SRAM 1.26 MiB/mm²；张量阵列在 L-Core 262.144 TFLOPS 时占 1600 mm²，并按 L-Core 算力线性缩放；每颗 MC 的 PHY 为 12 mm² + 0.025 mm²/(GB/s)；固定开销 400 mm²。规格网格里 H-Core 峰值按 L-Core 的 8 倍同比计入这块张量面积。1M 算力下限一节允许 L 与 H 分开扫，那一节的面积判断要单独标注，不能和 8 倍锁定混用。

封装的 reticle 数仍待 floorplan 对齐。规格页图注写的是约 6 reticle 有源中介层；仓库里的 7-reticle 规划窗口是 8×400 mm² Die 加 MC 的 placement。两份材料共同锁定的是 8 颗约 400 mm² 计算 Die 和 UCIe 直连的 MC，reticle 张数留在封装签核。

### 2.3 规格网格

这些维度在每个芯片点上取值，再为该点求达标的最少卡数。页首默认：专家预测准确率 80%，SRAM 预取深度 2 层，TP 上限 32，MC 带宽上限 1.5×320 GB/s = 480 GB/s。超过该上限的带宽档在结果里标为激进。归约延迟低于 0.85 μs 同样标为激进。

| 维度 | 档位 | 单位与口径 |
|---|---|---|
| MC 数量 | 8、16、24、32 | 颗/卡 |
| MC 带宽 | 320、400、480、560、640 | GB/s/颗；320 为参考基线；560 与 640 超过 1.5 倍上限 |
| MC 容量 | 8、16 | GB/颗；权重 + KV 必须放得下 |
| SRAM | 128、192、256、384、512、640、768、1024、1536、2048 | MiB/卡，等于 8 个 Die 切片之和 |
| L-Core 算力 | 65.536、98.304、131.072、262.144、524.288 | TFLOPS/卡，按 Decode 1000 TPS 搜下限 |
| H-Core 算力 | 网格内 = 8 × L-Core | TFLOPS/卡 |
| 归约延迟 | 2、1.5、1.15、0.85、0.66 | μs，一次 all-reduce 在 TP8 的参考值 |
| 互联带宽 | 200、400 | GB/s/卡；归约时间含 payload ÷ 互联带宽 |
| 卡数 | 16、24、32、48、64、96、128、192、256 | 张；每个芯片点从小到大取第一个达标的 N* |
| 部署 | PP×TP、层内分片或复制、专家切分 | 每个芯片点单独优化，TP 整除头数且不超过上限 |

SRAM 有两层用途，容量模型必须分开记账：

1. **预取缓冲。** 要装下「预取深度 × 每层预测专家」以及「归约空窗期间 MC 按有效带宽读满的字节」。装下之后，MC 读取才能与计算、归约重叠。
2. **常驻权重。** 缓冲之外的容量按确定性权重优先、其余按路由命中率覆盖，直接减少 MC 读取。归约受限的方案里，继续加大常驻没有收益。

有效 MC 带宽 = 颗数 × 每颗带宽 × 0.70。Stage 时间取下面两项的较大值：

```text
MC 净读取 = (MC 读取 − SRAM 常驻节省) × PP
忙侧 = 计算 + 全部 TP all-reduce + 预测未命中补读
Stage = max(MC 净读取, 忙侧)
E2E = (PP × Stage + PP 跳 + LM Head) × 1.17
TPS/usr = 1000 / E2E_ms
```

PP 跳 = PP 边界延迟 + hidden payload ÷ 互联带宽。默认 PP 边界延迟 2 μs。

### 2.4 1M Context 上已经标出的观测点

规格页把下面这颗芯片标成路线 A，用来看 1M Context 的算力下限，不是帕累托选点，也不是签核规格：

| 项目 | 路线 A |
|---|---|
| MC | 32 颗 × 480 GB/s × 8 GB |
| SRAM | 384 MiB/卡 |
| 归约 | 1.15 μs，flat |
| 16 卡，PP1×TP16 | 约 883 TPS/usr。墙在 MC 读取 1M KV。把阵列加到该节的上限仍然过不了线 |
| 32 卡，PP1×TP32 | KV 按 TP32 切开后，墙转到约 393 次归约。过线的算力下限约 L 98 + H 512 = 610 TFLOPS/卡，每 Die 约 76 TFLOPS。按该页的面积判断，TSMC 12nm、400 mm²、128 TFLOPS/Die 的量级足够，不必为这条 Decode 线升到 N7 或 N3 |

因此 1M 的第一刀是 TP 把 KV 字节切开，第二刀才是归约延迟和算力。16 颗 MC、96 MiB/Die、8L+8H 这些先前写进物理主候选的数字，在这张网格里分别只是 MC=16、SRAM=768 MiB/卡附近的一档，以及算力档的一种组织方式。

### 2.5 关键架构原则

1. **本地性优先**：权重、KV、Linear Attention state 和工作 tile 优先绑定到本地 Die/MC；远端访问只作为显式的重平衡、collective 或故障降级路径。
2. **显式数据移动**：Local SRAM、Shared SRAM、MC 和 remote SRAM 不采用 CPU 式隐式 cache coherence；使用 Tile Descriptor、TMA、epoch 和 mailbox 管理数据所有权与可见性。
3. **计算与搬运重叠**：Tensor、Vector、TMA、MC、NoC 和 Collective 通过双缓冲/多缓冲、依赖 token 和资源预约实现流水化。
4. **分层归约**：先在 Core/Die 内归约，再在 8 Die 卡内归约，最后进入该芯片点选出的 TP 组。默认时间模型用 flat 归约延迟；log2 缩放只作消息语义对照。
5. **可验证优先**：每一项性能优化都必须能够映射到明确的 tile、packet、transaction、队列或硬件资源，禁止只使用无法解释的全局经验缩放因子。
6. **降级可运行**：MC、Die、链路、lane、温度和功耗异常必须有显式的隔离、重映射、降频或退出策略。
7. **统一契约**：编译器、模拟器、固件、NoC、MC、RDMA 和 RTL 共享同一套 Tile IR、地址语义、epoch 语义和 PMU 事件定义。

---

## 3. 架构分层

### 3.1 L0：Workload 与 KPI 层

这一层定义“芯片需要完成什么”，是所有后续设计的输入。

```text
正式模型清单
  ├── 93 层结构与算子顺序
  ├── Attention / Linear Attention 配置
  ├── MoE / Router / Expert 配置
  ├── Tensor shape 与分片
  ├── 权重、激活、KV、state dtype
  ├── Context / Batch / Decode 运行场景
  └── KPI、P99、功耗、容量和故障目标
```

L0 的输出必须是机器可读 manifest，能够自动生成 operator DAG、tile trace 和容量/带宽统计。当前 K3 preset 在该层仍属于 `MODEL`，不能直接作为最终芯片规格。

### 3.2 L1：System 与 PP×TP 层

这一层为每个芯片点选择卡数和 PP×TP：权重、KV、state 按 TP 切开；卡内先归约，再进入 TP 组的 all-reduce 和 MLA 的 LSE 合并；PP 只串行 Stage 并传递 hidden。同时还要定义 Decode/Prefill QoS、慢卡和故障处理。TP32、PP=1、32 张卡是 1M 路线 A 上离开 KV 带宽墙之后的观测部署，其他芯片点可以选出不同的 N*。

### 3.3 L2：单卡封装层

一张卡是一个封装，包含 8 个约 400 mm² 的 Compute Die，以及网格选出的 MC 数量。MC 经 UCIe 接到计算 Die。MC 数量为 8、16、24、32 时，每 Die 的本地 MC 数分别是 1、2、3、4，本地绑定随这个数量改变。

主要职责：

- 8 Die 的任务分派和 NUMA 管理；
- MC home 与本 Die 的数据绑定；
- 卡内 UCIe mesh，以及待闭合的 reduce domain；
- 卡内先归约，再把 partial 送进 TP 组；
- 整卡 SRAM 的预取缓冲和常驻权重窗口；
- 整卡功耗、热和 RAS；
- 跨卡 Scale-out 端点。

规格页把 8 颗 Die 画成 2×4，并用 UCIe mesh 互连。4×2 mesh 加两个四 Die reduce domain 仍是待 packet 模型闭合的拓扑候选，状态保持 `OPEN`。

### 3.4 L3：Compute Die 层

```text
Compute Die（约 400 mm²，一卡 8 颗）
├── L-Core 线性阵列
├── H-Core Attention 阵列
├── SRAM 切片（8 颗之和 = 规格网格中的 SRAM/卡）
├── TMA
├── Data NoC / Control NoC
├── MC controller（数量随 MC/卡 ÷ 8）
├── UCIe Die-to-die 与 Die-to-MC
├── Collective / Reduce engine
├── Scale-out gateway
├── Scheduler / PMU
└── Clock / Reset / RAS
```

Compute Die 负责执行 tile，不负责隐式管理全局一致性。Core、TMA、SRAM、NoC、MC controller 和 collective 通过显式 descriptor 与 event 连接。

### 3.5 L4：Core 与执行单元层

- **L Core**：GEMV、Skinny GEMM、Decode FFN、低复用投影、Expert tile；
- **H Core**：Attention QK/PV、高复用 GEMM、Linear Attention 主要矩阵；
- **Vector**：RMSNorm、RoPE、Softmax、SiLU、量化、路由和归约尾部；
- **Tensor engine**：BF16/FP16/FP8/INT8 等矩阵计算；
- **TMA**：MC/Shared/Local SRAM 之间的显式 tile 搬运；
- **Collective/Reduce**：局部 partial、LSE `m/l/O` 和跨层级归约。

本层只冻结单元数量、能力、接口和性能预算；内部流水线由 microarchitecture 文档负责。

### 3.6 L5：Tile / Transaction 层

Tile 是计算、搬运、同步、抢占、性能核算和验证的最小统一单位。

```text
Tile IR
  ├── operator / layer / tensor shape
  ├── dtype / layout / placement
  ├── compute unit / resource reservation
  ├── TMA / SRAM buffer
  ├── MC / NoC / RDMA transaction
  ├── dependency / event / epoch
  ├── QoS / deadline / timeout
  └── completion / fault / poison
```

L5 必须能够被编译器生成、模拟器回放、硬件执行和 PMU 观测。

---

## 4. 端到端数据流

### 4.1 每层时间线

规格页把单卡单层收成四拍，高层性能模型按这四拍记账，再在卡内展开成 tile：

```text
MC 读下一层权重 / KV / state
  -> SRAM 预取缓冲（预测专家 + 归约空窗能读满的字节）
  -> L-Core / H-Core 计算
  -> 卡内归约
  -> TP all-reduce（MoE 每层 4 或 5 次；MLA 层另加 LSE 合并）
  -> 下一层
```

缓冲足够时，MC 读取与计算、归约重叠，Stage 取 MC 净读取和忙侧的较大值。缓冲不足时，归约期间 MC 空转，专家读取改到 Router 之后。预测未命中部分始终在 Router 之后串行补读。编译器仍把这四拍展开成 Tile IR：放置、TMA、本地 partial、卡内归约、跨卡 mailbox。

### 4.2 Attention 路径

```text
KV/state tile
  -> H Core Q/K/V projection
  -> QK
  -> online softmax: m/l
  -> PV
  -> O partial
  -> LSE semantic merge: m/l/O
  -> output projection
  -> residual / norm
```

`m/l/O` 归约不能按普通 FP32 sum 近似，必须在 Tile IR、Collective、模拟器和 RTL 前规格中保持一致的数值语义。

### 4.3 MoE 路径

```text
RMSNorm
  -> Router / Top-K
  -> token packing
  -> expert weight prefetch
  -> gate/up
  -> activation / SiLU
  -> down
  -> routed expert merge
  -> shared expert
  -> residual
```

Router、token packing、expert 选择和融合必须在 operator DAG 中显式表示，不能用一个整体利用率乘数替代。

---

## 5. 高层模块划分

### M0：Workload、KPI 与系统契约

**职责**

- 冻结 K3 模型、层清单、dtype、KV/state、权重分片；
- 定义 1000 TPS/usr 的测量边界；
- 定义 1050 TPS/usr 架构冻结门槛；
- 定义 P99、功耗、容量和降级目标。

**关键文档**

- `spec/workload/WORKLOAD_SPEC.md`
- `spec/workload/K3_LAYER_MANIFEST.json`
- `spec/workload/DTYPE_AND_LAYOUT_SPEC.md`
- `spec/system/KPI_ACCEPTANCE_SPEC.md`

**退出条件**

- 逐层模型清单冻结；
- 所有性能输入可追溯；
- 不再使用 residual 参数替代正式 Q/K/V 图。

### M1：System、PP×TP 与数据放置

**职责**：为每个芯片点确定最少达标卡数、PP×TP、TP shard、权重/KV/state placement、token step、慢卡和 group completion、Decode/Prefill QoS、容量和带宽预算。1M 路线 A 的观测部署是 32 卡、PP1×TP32。

**关键文档**

- `spec/system/SYSTEM_ARCHITECTURE_SPEC.md`
- `spec/system/TP32_TOPOLOGY_SPEC.md`
- `spec/system/DATA_PLACEMENT_AND_NUMA_SPEC.md`
- `spec/system/END_TO_END_LATENCY_BUDGET.md`

**主要接口**：Workload manifest、Tile IR、Package Scheduler、Collective/RDMA、PMU/telemetry。

### M2：AI Core 与计算阵列

**职责**：定义 L/H Core 数量和职责、Tensor/Vector 能力、dtype、累加精度和 shape、Core command queue、Core/TMA/SRAM 并发和 kernel cycle budget。

**关键文档**

- `spec/ai_core/AI_CORE_ARCH_SPEC.md`
- `spec/ai_core/L_CORE_SPEC.md`
- `spec/ai_core/H_CORE_SPEC.md`
- `spec/ai_core/TENSOR_ENGINE_SPEC.md`
- `spec/ai_core/VECTOR_ENGINE_SPEC.md`
- `spec/ai_core/CORE_COMMAND_AND_EVENT_SPEC.md`

**基线候选**：规格网格按整卡 L-Core 算力档位搜索，H-Core 在网格内取 8 倍并计入同一块张量面积。1M、32 卡、路线 A 的过线下限约 610 TFLOPS/卡（L 约 98、H 约 512），每 Die 约 76 TFLOPS。4 L + 4 H、44 MiB/Die 的 compact profile 只保留给旧回归对照。Core 个数和频率要由选定的 TFLOPS 档、面积系数和工艺回标反推，不单独冻结 8+8 或 1.0 GHz。

### M3：TMA、Local SRAM 与 Shared SRAM

**职责**：定义容量、bank、slice、端口和仲裁；TMA descriptor、队列和 DMA 事务；buffer 生命周期；ECC、scrub、repair；tile fit 和 bank-cycle 模型。

**关键文档**

- `spec/tma_sram/TMA_ARCH_SPEC.md`
- `spec/tma_sram/LOCAL_SRAM_SPEC.md`
- `spec/tma_sram/SHARED_SRAM_SPEC.md`
- `spec/tma_sram/SRAM_ADDRESS_AND_BANK_MAP.md`
- `spec/tma_sram/BUFFER_LIFECYCLE_SPEC.md`

**基线候选**：容量按整卡记账，档位从 128 MiB 到 2048 MiB。每颗 Die 的切片是整卡容量除以 8。报告必须同时给出预取缓冲需求和常驻权重容量。768 MiB/卡（96 MiB/Die）是网格中的一档；路线 A 的 1M 观测点使用 384 MiB/卡。44 MiB/Die 的 compact profile 只用于旧回归对照。

### M4：Memory Cube 与内存控制器

**职责**：定义 MC 数量、容量、带宽和持续 payload；MC controller、channel、queue 和地址映射；TMA/MC 事务；ECC、CRC、retry、lane repair；NUMA、prefetch 和 read/write 合并；MC 故障和降容。

**关键文档**

- `spec/memory_mc/MC_PRODUCT_SPEC.md`
- `spec/memory_mc/MC_CONTROLLER_SPEC.md`
- `spec/memory_mc/MC_ADDRESS_MAPPING_SPEC.md`
- `spec/memory_mc/MC_TRANSACTION_SPEC.md`
- `spec/memory_mc/MC_POWER_THERMAL_SPEC.md`

**当前决策**：主线是外置 3D-DRAM Memory Cube，MC 不承担 Tensor/GEMM，经 UCIe 接到 8 颗计算 Die。数量取 8、16、24、32 颗/卡。320 GB/s/颗是参考基线，有效带宽按 0.70 持续效率。规格页默认搜索上限是 1.5 倍，即 480 GB/s/颗；560 与 640 留在网格里并标为激进。路线 A 的 1M 观测点是 32 颗 × 480 GB/s × 8 GB。

**阻塞项**：冻结前要选定一档可制造的颗数和每颗带宽，并给出持续 payload。1M、16 卡、TP16 在路线 A 上约 883 TPS，墙在 KV 读取；只提高单颗带宽或只增加算力，不能代替把 KV 切到更多 TP rank。

### M5：Die-local NoC

**职责**：Core、SRAM、MC、collective 和 PHY gateway 互联；Data NoC 与 Control NoC；VC、credit、QoS、路由和死锁避免；packet、flit、buffer、backpressure；packet-level P99 和物理可布线性。

**关键文档**

- `spec/noc/NOC_ARCH_SPEC.md`
- `spec/noc/DATA_NOC_SPEC.md`
- `spec/noc/CONTROL_NOC_SPEC.md`
- `spec/noc/ROUTING_QOS_AND_DEADLOCK_SPEC.md`
- `spec/noc/NOC_PACKET_FORMAT.md`

**基线候选**：5×5 mesh 作为单 Die 逻辑候选；Data NoC、Control NoC 和 Collective fast path 分层；4096-bit/方向只作为模型候选，必须通过物理布线和 PPA 验证。

### M6：8 Die Package Fabric

**职责**：8 Die 物理拓扑、die-to-die 链路、card-local route、4+4 reduce domain、MC home/NUMA、链路故障绕行、卡内 collective 和热均衡。

**关键文档**

- `spec/multidie/CARD_DIE_TOPOLOGY_SPEC.md`
- `spec/multidie/DIE_TO_DIE_LINK_SPEC.md`
- `spec/multidie/CARD_ROUTE_TABLE.md`
- `spec/multidie/CARD_LOCAL_COLLECTIVE_SPEC.md`
- `spec/multidie/CARD_NUMA_AND_FAILURE_SPEC.md`

**推荐候选**：4×2 mesh + 两个四 Die reduce domain。普通数据访问走 mesh；collective 先在 domain 内归约，再跨 domain 归约和广播。通过 packet、封装和 PPA 后才能从 `OPEN` 变为 `BASELINE`。

### M7：TP32 Scale-out、RDMA 与 Collective

**职责**：跨卡物理拓扑；RDMA-to-SRAM one-sided write；mailbox、epoch、commit、ready、ACK、release；All-Reduce、Reduce-Scatter、All-Gather、Broadcast；LSE `m/l/O` 归约；credit、replay、timeout 和故障隔离。

**关键文档**

- `spec/scaleout/SCALEOUT_FABRIC_SPEC.md`
- `spec/scaleout/PHY_AND_PORT_BUDGET.md`
- `spec/collective/RDMA_TRANSACTION_SPEC.md`
- `spec/collective/REMOTE_SRAM_SEMANTICS.md`
- `spec/collective/MAILBOX_EPOCH_SPEC.md`
- `spec/collective/REDUCE_AND_LSE_SPEC.md`
- `spec/collective/REPLAY_TIMEOUT_AND_RAS_SPEC.md`

**核心语义**：`FREE -> RESERVED -> RECEIVING -> PARTIAL_READY -> READY -> CONSUMING -> ACK_WAIT -> RELEASED -> FREE(next epoch)`。RDMA write 完成不等于 consumer ready。

### M8：Scheduler、Compiler、Firmware 与 PMU

**职责**：生成和优化 Tile IR；TP group、Package、Die、Core 四级调度；TMA、MC、NoC 和 collective 资源预约；persistent decode-step execution；bring-up、DVFS、故障处理；PMU 和性能 trace。

**关键文档**

- `spec/scheduler/TILE_IR_SPEC.md`
- `spec/scheduler/COMPILER_MAPPING_SPEC.md`
- `spec/scheduler/TP_GROUP_SCHEDULER_SPEC.md`
- `spec/scheduler/DIE_AND_CORE_DISPATCH_SPEC.md`
- `spec/scheduler/FIRMWARE_API_SPEC.md`
- `spec/scheduler/PMU_TRACE_SPEC.md`

**关键原则**：host 不逐 kernel 介入；PMU 必须能重建模拟器中的时间账。

### M9：Package、Power、Thermal、Clock 与 RAS

**职责**：Compute Die、MC、interposer、bump 和 PHY floorplan；卡级端口和岸线；PDN、IR drop、时钟和电源域；液冷和热降频；ECC、CRC、retry、RAS、secure boot 和隔离。

**关键文档**

- `spec/package/PACKAGE_FLOORPLAN_SPEC.md`
- `spec/package/IO_AND_BUMP_MAP.md`
- `spec/package/POWER_BUDGET_SPEC.md`
- `spec/package/THERMAL_AND_COOLING_SPEC.md`
- `spec/package/CLOCK_RESET_POWER_DOMAIN_SPEC.md`
- `spec/package/RAS_AND_SECURITY_SPEC.md`

**当前风险**：250 W/Die 和约 2.8–3.2 kW/package 是 P0 规划预算；P1 compact 模型的 Die 功耗和约 2.4 kW 卡功耗（`spec/k3_mc_baseline.json`）是模型结果，不是物理签核结果。必须纳入高速 PHY、ECC、VRM、BMC、冷却、PVT 和老化余量。

### M10：性能模型、验证与签核

**职责**：从 manifest 生成 operator DAG；L0 解析模型；L1 operator/tile 离散事件模型；L2 NoC/MC/RDMA transaction 模型；L3 kernel cycle 模型；L4 RTL/emulation trace；统一 golden trace、回归和需求追踪。

**关键文档**

- `models/tile/TILE_MODEL_SPEC.md`
- `models/kernel_cycle/KERNEL_CYCLE_MODEL_SPEC.md`
- `models/noc_packet/NOC_PACKET_MODEL_SPEC.md`
- `models/mc_transaction/MC_TRANSACTION_MODEL_SPEC.md`
- `models/rdma_transaction/RDMA_TRANSACTION_MODEL_SPEC.md`
- `verification/ARCHITECTURE_TESTPLAN.md`
- `verification/GOLDEN_TRACE_SPEC.md`
- `verification/REQUIREMENT_TRACEABILITY.md`
- `verification/PPA_THERMAL_SIGNOFF_PLAN.md`

**模型要求**：matrix utilization、attention fusion、MoE token packing、phase fusion、hierarchical/direct reduce、local SRAM port scale、launch batching 和 partial-ready threshold 必须由具体 tile、资源占用、packet、queue 和依赖关系产生，不能使用无法解释的全局缩放。

---

## 6. 详细设计文档树

建议最终采用以下模块化目录。`spec/` 是正式架构规格，`models/` 是可执行模型，`verification/` 是验证证据，`implementation/` 是 RTL 前输入。

```text
docs/chip_design/
├── HIGH_LEVEL_ARCHITECTURE.md       # 本文：总纲和文档地图
├── 00_CURRENT_STATE.md              # 当前基线、证据等级和阻塞项
├── DECISIONS.md                     # ADR 决策记录
├── OPEN_ISSUES.md                   # 问题、owner、关闭证据
└── detail/
    ├── workload/
    ├── system/
    ├── ai_core/
    ├── tma_sram/
    ├── memory_mc/
    ├── noc/
    ├── multidie/
    ├── scaleout/
    ├── collective/
    ├── scheduler/
    ├── package_power_thermal_ras/
    └── verification/

spec/
├── workload/
├── system/
├── ai_core/
├── tma_sram/
├── memory_mc/
├── noc/
├── multidie/
├── scaleout/
├── collective/
├── scheduler_firmware/
└── package_power_thermal_ras/

models/
├── tile/
├── kernel_cycle/
├── noc_packet/
├── mc_transaction/
├── rdma_transaction/
└── ppa/

verification/
├── testplan/
├── golden_traces/
├── regressions/
└── coverage/

implementation/
├── interface_control/
├── floorplan/
├── clocks_resets/
├── power_domains/
└── ip_manifest/
```

### 6.1 文档编号规则

```text
ARCH-00  Workload / KPI
ARCH-10  System / TP32
ARCH-20  AI Core
ARCH-30  TMA / SRAM
ARCH-40  Memory Cube
ARCH-50  Die-local NoC
ARCH-60  Multi-die Card
ARCH-70  Scale-out / RDMA / Collective
ARCH-80  Scheduler / Firmware / PMU
ARCH-90  Package / Power / Thermal / RAS
ARCH-100 Verification / Sign-off
```

每一份正式文档必须包含：目的和范围、依赖文档、功能/非功能需求、单元清单和实例数量、接口/位宽/时钟域/流控、容量/带宽/延迟/吞吐/面积/功耗预算、正常/背压/错误/复位流程、tile/operator 映射、可执行模型和验证用例、未决项/owner/关闭证据、版本/状态/变更记录。

---

## 7. 关键接口契约

### 7.1 Workload Manifest → Compiler / Simulator

输入是 layer/operator、shape、dtype、layout、权重和 KV/state placement、TP shard、依赖关系；输出是 operator DAG、Tile IR、golden trace、容量/带宽和 FLOP/byte 统计。

### 7.2 Tile IR → Core / TMA / Collective

必须统一 opcode、shape、地址和 stride、dtype、buffer slot、dependency token、epoch、QoS、timeout、completion 和 poison/fault。

### 7.3 TMA / SRAM → NoC / MC

必须定义请求粒度、burst、source/destination、bank/slice、cache-line 或 stripe、ordering、credit、completion 和 ECC/poison。

### 7.4 NoC → Die Fabric / Scale-out

必须区分 data packet、control packet、collective packet、request/response、writeback、ACK、replay 和 fault。

### 7.5 RDMA → Remote SRAM Mailbox

必须定义 source/destination rank、address、length、sequence、epoch、commit/ready、ACK、release、replay 去重、timeout、generation mismatch 和 poison。

---

## 8. 性能预算与资源目标

### 8.1 端到端时间账

高层预算跟规格页同一套式子，不再使用按 390/250/115/55/20 μs 拆开的旧分账。那组分账没有对应到 MC 读取、预取缓冲和 all-reduce 次数。

| 项目 | 口径 |
|---|---|
| 目标 | E2E ≤ 1 ms/token，即 1000 TPS/usr |
| 达标 | E2E 对应 TPS ≥ 1050 |
| 裕量 | 乘在整段 E2E 上，系数 1.17 |
| Stage | max(MC 净读取, 计算 + 归约 + 补读) |
| E2E | (PP × Stage + PP 跳 + LM Head) × 1.17 |
| 层预算 | PP=1 且跳与 LM Head 另计之前，93 层约 9.2 μs/层 |

MC 颗数、每颗带宽、SRAM 常驻或归约延迟一变，Stage 的两项都要重算。有效带宽用 0.70 持续效率。归约次数默认是每 MoE 层 4 次，每个 Softmax MLA 层再加 1 次 LSE 合并。

### 8.2 容量与带宽目标

固定结构是每卡 8 颗约 400 mm² 计算 Die，面积和 ≤ 3200 mm²。MC、SRAM 和算力取第 2.3 节的网格。

1M 路线 A 观测点：32 MC × 480 GB/s × 8 GB，384 MiB SRAM/卡，归约 1.15 μs flat。16 卡约 883 TPS，32 卡才进入算力下限问题，过线约 610 TFLOPS/卡。互联档位是 200 或 400 GB/s/卡。持续 payload、PHY 岸线和 reticle 张数仍要供应商与 floorplan 回标。

### 8.3 PPA 目标

架构冻结前必须同时满足：8 颗 Die 的 SRAM、张量阵列、MC PHY 与固定开销之和不超过 3200 mm²，并留 10–15% 余量；卡级功耗留至少 10% 余量；频率在目标 PVT corner 下可实现；热降频不破坏所选 TP 组的 P99；UCIe 与 Scale-out 端口有可实现的岸线、bump 和布线。超过 480 GB/s/MC 或低于 0.85 μs 归约延迟的点，在签核材料里保持「激进」标记。

---

## 9. 设计阶段与交付门槛

### G0：需求冻结

**交付**：Workload Specification、K3 layer manifest、dtype/layout/KV/state 规格、KPI 和验收规格、ADR 与风险清单。

**通过条件**：模型逐层清单冻结；1000 TPS 测量方法冻结；1050 TPS 架构门槛冻结；所有性能输入可追溯。

### G1：内存路线冻结

**交付**：MC product spec、MC controller spec、MC transaction model、网格中选定的颗数与带宽档、卡级容量/带宽/功耗报告。

**通过条件**：选定一档可制造的 MC 数量和每颗带宽；得到持续 payload、延迟、功耗和故障参数；该档进入第 4.1 节的 Stage 时间账。320 GB/s 是参考基线，480 GB/s 是默认搜索上限，560 与 640 只有在供应商证据闭合后才能去掉激进标记。

### G2：精确性能模型冻结

**交付**：Tile IR、operator/tile DAG、bank-cycle、NoC packet、MC transaction、RDMA/collective 模型、P50/P95/P99 时间账。

**通过条件**：取消无法解释的经验缩放；资源、容量、带宽和时间守恒；选定 MC 路线达到至少 1050 TPS/usr；最坏层和最坏路由分布通过。

### G3：Compute Die 架构冻结

**交付**：AI Core、TMA/SRAM、NoC、Collective/Reduce 规格；单 Die block diagram；ICD；PPA v1。

**通过条件**：所有单元数量、接口和时钟域明确；NoC、SRAM、TMA 和 PHY 可布线；面积、功耗、频率有 10–15% 余量。

### G4：Package 架构冻结

**交付**：8 Die topology、route table、MC home/NUMA、package-local collective、package floorplan、thermal/PDN/clock v1。

**通过条件**：不再同时使用 ring、mesh 和 hierarchy 三套口径；packet 模型覆盖最坏 collective、MC miss 和故障绕行；卡级 PPA 和热约束收敛。

### G5：Scale-out 冻结

**交付**：选定 N* 与 PP×TP 的物理拓扑、PHY/port 方案、collective protocol（含每 MoE 层 4 或 5 次以及 MLA LSE 合并）、replay/timeout/RAS、P99 报告。

**通过条件**：跨卡带宽和归约延迟档位可实现；最坏 hop、拥塞、重放和降级通过；host 不需要逐 collective 介入；P99 达标。1M 若仍走路线 A，观测部署是 32 卡、PP1×TP32。

### G6：RTL 前架构签核

**交付**：Architecture Specification v1.0、Microarchitecture Specification set、Verification Plan、golden traces、PPA/thermal/package sign-off、RTL/IP work package、requirement traceability、risk acceptance。

**通过条件**：所有 `BLOCKER` 关闭；主要 KPI 至少有 10% 设计余量；每个规格都能分解为 RTL、IP、firmware 或软件任务；变更控制基线建立。

---

## 10. 当前必须优先关闭的问题

| 优先级 | 问题 | 影响 | 关闭证据 |
|---|---|---|---|
| B-001 | 正式 K3 逐层结构和 dtype 未冻结 | FLOP、byte、容量、tile 全部可能变化 | 模型 manifest |
| B-002 | MC 档位未选定：320 为基线，480 为默认上限，560/640 为激进（ADR-011） | P1 最佳点使用 640 GB/s，不能作为承诺；1M、16 卡路线 A 约 883 TPS | 选定颗数与每颗带宽的供应商规格 |
| B-003 | Final Tuning 仍含经验缩放因子 | 性能可能高估 | 精确 tile/transaction 模型 |
| B-004 | 卡内拓扑口径冲突 | 带宽、hop、封装无法签核 | 统一拓扑和 packet 模型 |
| B-005 | 选定 PP×TP 的跨卡拓扑未定义 | 归约延迟档位和互联 200/400 GB/s 的可实现性未知 | PHY、布线、功耗和 P99 方案 |
| B-006 | 频率、面积、功耗未回标 | PPA 可能不收敛 | synthesis/floorplan/IP macro |

在这些问题关闭前，Core 个数、SRAM 分档、MC 颗数、5×5 NoC 和卡内 reduce 拓扑都只作为规格网格或拓扑候选。已经固定的是每卡 8 颗计算 Die、UCIe 接 MC，以及第 4.1 节的四拍时间线。

---

## 11. 高层架构的最终成功标准

当以下条件全部满足时，项目可将高层架构转入详细架构和 RTL 前阶段：

1. K3 workload、层清单、dtype、KV/state 和分片已冻结；
2. 选定的 MC 路线有供应商或工程实现依据；
3. 统一 Tile IR 覆盖编译器、模拟器、固件和硬件；
4. 性能模型不再依赖未解释的全局经验缩放；
5. 选定的 MC、SRAM、算力和归约延迟档位，在第 4.1 节的时间账里达到 `>=1050 TPS/usr`；
6. P99、最坏层、最坏路由、重放和热降频均通过；
7. Core、SRAM、TMA、MC、NoC、8 Die fabric、RDMA、Scheduler 和 RAS 的单元数量与接口已明确；
8. 面积、功耗、热、封装、PHY 和岸线具有 10–15% 余量；
9. 所有 BLOCKER 均有关闭证据；
10. 规格可直接分解为 RTL、IP、firmware、compiler 和验证工作包。
