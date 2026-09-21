# K3 1000 TPS/usr 高层架构设计

版本：2026-09-21  
状态：`BASELINE / ARCHITECTURE PLANNING`

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

### 2.1 主要产品目标

| 类别 | 目标 |
|---|---|
| 主要 workload | K3 Decode inference |
| 主要场景 | B=1、Context=1M、TP32、PP=1 |
| 目标性能 | `1000 TPS/usr` |
| 架构冻结门槛 | `>=1050 TPS/usr` |
| 延迟目标 | 端到端平均 token latency `<=1000 us` |
| Raw 延迟预算 | `<=854.70 us/token`，按 1.17 工程裕量倒推 |
| 目标尾延迟 | P99 不低于 1000 TPS/usr 对应的服务水平 |
| 主要模式 | Decode 优先；保留 Prefill 兼容能力 |
| 并行方式 | 32 张卡组成一个 TP32 replica |
| 软件介入 | 一个 decode step 内不依赖 host 逐 kernel/逐 collective 介入 |

### 2.2 架构基线

```text
K3 TP32 Decode Replica
└── 32 × Accelerator Card
    └── 1 × Card / TP rank
        ├── 8 × Compute Die
        │   ├── 4 × L Core
        │   ├── 4 × H Core
        │   ├── Local SRAM
        │   ├── Shared SRAM
        │   ├── TMA / DMA
        │   ├── Die-local NoC
        │   ├── Collective / Reduce
        │   ├── MC controllers
        │   └── Die-to-die / Scale-out endpoints
        ├── 16 × external Memory Cube
        │   └── 2 × local MC / Compute Die
        ├── Card-local die fabric
        ├── Card-level collective gateway
        └── Scale-out / RDMA fabric endpoint
```

### 2.3 关键架构原则

1. **本地性优先**：权重、KV、Linear Attention state 和工作 tile 优先绑定到本地 Die/MC；远端访问只作为显式的重平衡、collective 或故障降级路径。
2. **显式数据移动**：Local SRAM、Shared SRAM、MC 和 remote SRAM 不采用 CPU 式隐式 cache coherence；使用 Tile Descriptor、TMA、epoch 和 mailbox 管理数据所有权与可见性。
3. **计算与搬运重叠**：Tensor、Vector、TMA、MC、NoC 和 Collective 通过双缓冲/多缓冲、依赖 token 和资源预约实现流水化。
4. **分层归约**：先在 Core/Die 内归约，再在 8 Die 卡内归约，最后进入 TP32 跨卡 collective，避免所有流量直接进入跨卡网络。
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

### 3.2 L1：System 与 TP32 层

这一层定义 32 卡如何共同完成一个 token step：TP shard、卡级权重/KV/state placement、卡内先归约、跨卡后归约、Decode/Prefill QoS、慢卡和故障处理，以及 e2e token latency 和 collective budget。

### 3.3 L2：Card 层

一卡是一个 TP rank，包含 8 个 Compute Die 和 16 个外置 MC。

主要职责：

- 8 Die 的任务分派和 NUMA 管理；
- 2 MC/Die 的本地数据绑定；
- 卡内 4×2 mesh 候选拓扑；
- card-local hierarchical reduce；
- 卡级 SRAM 工作窗口；
- 卡级功耗、热和 RAS；
- 跨卡 Scale-out/RDMA 端点。

卡内拓扑当前建议采用“4×2 mesh + 两个四 Die reduce domain”的统一候选，但在 packet 模型、封装 floorplan 和 PPA 通过前仍保持 `OPEN`。

### 3.4 L3：Compute Die 层

```text
Compute Die
├── 4 × L Core
├── 4 × H Core
├── 8 × Local SRAM cluster
├── 8 × Shared SRAM slice
├── 8 × TMA group
├── Data NoC
├── Control NoC
├── MC controller × 2
├── Die-to-die gateway
├── Collective / Reduce engine
├── RDMA / Scale-out gateway
├── Scheduler / PMU
├── Clock / Reset / DVFS
└── RAS / Security / Debug
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

### 4.1 通用算子路径

```text
Model compiler
  -> Tile IR / static schedule
  -> TP/card/die placement
  -> MC controller
  -> Shared SRAM
  -> TMA
  -> Local SRAM
  -> L/H Core + Vector
  -> local partial / writeback
  -> card-local reduce
  -> RDMA remote SRAM mailbox
  -> cross-card collective
  -> ready / consume / ACK
  -> next tile or next layer
```

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

### M1：System、TP32 与数据放置

**职责**：定义 32 卡 TP replica、TP shard、权重/KV/state placement、token step、慢卡和 group completion、Decode/Prefill QoS、容量和带宽预算。

**关键文档**

- `spec/system/SYSTEM_ARCHITECTURE_SPEC.md`
- `spec/system/TP32_TOPOLOGY_SPEC.md`
- `spec/system/DATA_PLACEMENT_AND_NUMA_SPEC.md`
- `spec/system/END_TO_END_LATENCY_BUDGET.md`

**主要接口**：Workload manifest、Tile IR、Card Scheduler、Collective/RDMA、PMU/telemetry。

### M2：AI Core 与计算阵列

**职责**：定义 L/H Core 数量和职责、Tensor/Vector 能力、dtype、累加精度和 shape、Core command queue、Core/TMA/SRAM 并发和 kernel cycle budget。

**关键文档**

- `spec/ai_core/AI_CORE_ARCH_SPEC.md`
- `spec/ai_core/L_CORE_SPEC.md`
- `spec/ai_core/H_CORE_SPEC.md`
- `spec/ai_core/TENSOR_ENGINE_SPEC.md`
- `spec/ai_core/VECTOR_ENGINE_SPEC.md`
- `spec/ai_core/CORE_COMMAND_AND_EVENT_SPEC.md`

**基线候选**：每 Die 4 L Core + 4 H Core；1.2 GHz 作为模型候选；逻辑 Tensor peak 仅作为上限，不作为可持续性能承诺。

### M3：TMA、Local SRAM 与 Shared SRAM

**职责**：定义容量、bank、slice、端口和仲裁；TMA descriptor、队列和 DMA 事务；buffer 生命周期；ECC、scrub、repair；tile fit 和 bank-cycle 模型。

**关键文档**

- `spec/tma_sram/TMA_ARCH_SPEC.md`
- `spec/tma_sram/LOCAL_SRAM_SPEC.md`
- `spec/tma_sram/SHARED_SRAM_SPEC.md`
- `spec/tma_sram/SRAM_ADDRESS_AND_BANK_MAP.md`
- `spec/tma_sram/BUFFER_LIFECYCLE_SPEC.md`

**基线候选**：L Local SRAM 4×1 MiB/Die；H Local SRAM 4×4 MiB/Die；Shared SRAM 8×3 MiB/Die；总数据 SRAM 44 MiB/Die、352 MiB/card。122.2 MiB 是整卡 Shared SRAM 工作窗口峰值，不是每 Die 容量。

### M4：Memory Cube 与内存控制器

**职责**：定义 MC 数量、容量、带宽和持续 payload；MC controller、channel、queue 和地址映射；TMA/MC 事务；ECC、CRC、retry、lane repair；NUMA、prefetch 和 read/write 合并；MC 故障和降容。

**关键文档**

- `spec/memory_mc/MC_PRODUCT_SPEC.md`
- `spec/memory_mc/MC_CONTROLLER_SPEC.md`
- `spec/memory_mc/MC_ADDRESS_MAPPING_SPEC.md`
- `spec/memory_mc/MC_TRANSACTION_SPEC.md`
- `spec/memory_mc/MC_POWER_THERMAL_SPEC.md`

**当前决策**：主线暂定为外置 Memory Cube，MC 不承担 Tensor/GEMM；每卡 16 MC、每 Die 本地 2 MC 是当前组织基线；320 GB/s/MC 是参考规格兼容点；640 GB/s/MC 只能作为 Stretch。

**阻塞项**：必须在架构冻结前选择并证明可制造的 MC-X/640 GB/s、更多 MC/双数据面、320 GB/s 下的字节削减，或近存计算 MC 替代路线。

### M5：Die-local NoC

**职责**：Core、SRAM、MC、collective 和 PHY gateway 互联；Data NoC 与 Control NoC；VC、credit、QoS、路由和死锁避免；packet、flit、buffer、backpressure；packet-level P99 和物理可布线性。

**关键文档**

- `spec/noc/NOC_ARCH_SPEC.md`
- `spec/noc/DATA_NOC_SPEC.md`
- `spec/noc/CONTROL_NOC_SPEC.md`
- `spec/noc/ROUTING_QOS_AND_DEADLOCK_SPEC.md`
- `spec/noc/NOC_PACKET_FORMAT.md`

**基线候选**：5×5 mesh 作为单 Die 逻辑候选；Data NoC、Control NoC 和 Collective fast path 分层；4096-bit/方向只作为模型候选，必须通过物理布线和 PPA 验证。

### M6：8 Die Card Fabric

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

**职责**：生成和优化 Tile IR；TP group、Card、Die、Core 四级调度；TMA、MC、NoC 和 collective 资源预约；persistent decode-step execution；bring-up、DVFS、故障处理；PMU 和性能 trace。

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

**当前风险**：237.46 W/Die 和约 2.4 kW/card 是模型结果，不是物理签核结果。必须纳入高速 PHY、ECC、VRM、BMC、冷却、PVT 和老化余量。

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

### 8.1 初始 Raw 延迟预算

| 类别 | 目标上限 |
|---|---:|
| Tensor / Vector kernel | 390 us |
| Local TMA / SRAM | 250 us |
| Card-local + TP32 Collective/RDMA | 115 us |
| MC / DMA 暴露等待 | 55 us |
| Launch / control / tail | 20 us |
| 预算合计 | 830 us |
| Raw 工程余量 | 约 24.7 us |
| Raw 上限 | 854.70 us |

该预算是架构目标，不是当前模型已经满足的结果。MC 带宽路线改变时，必须重新分配并重新验证全部预算。

### 8.2 容量与带宽目标

初始基线：8 Compute Die/card；16 MC/card；2 MC/Die；16 GB/MC 优先，8 GB 为降本档；44 MiB data SRAM/Die；352 MiB data SRAM/card；Shared SRAM working window 约 122.4 MiB/card；TP32 scale-out payload 目标约 800 GB/s/card；具体 MC 持续 payload 必须由选定供应商或实现路线确认。

### 8.3 PPA 目标

架构冻结前必须同时满足：Die 面积有 10–15% 余量；卡级功耗有至少 10% 余量；SRAM、NoC、PHY、MC 和封装均有独立预算；频率在目标 PVT corner 下可实现；热降频不破坏 TP32 P99；所有高速端口都有可实现的岸线、bump 和布线。

---

## 9. 设计阶段与交付门槛

### G0：需求冻结

**交付**：Workload Specification、K3 layer manifest、dtype/layout/KV/state 规格、KPI 和验收规格、ADR 与风险清单。

**通过条件**：模型逐层清单冻结；1000 TPS 测量方法冻结；1050 TPS 架构门槛冻结；所有性能输入可追溯。

### G1：内存路线冻结

**交付**：MC product spec、MC controller spec、MC transaction model、320/640/替代路线对比、卡级容量/带宽/功耗报告。

**通过条件**：选定一条可制造路线；得到持续 payload、延迟、功耗和故障参数；该路线进入统一 tile 模型；若采用 320 GB/s，必须证明字节削减或架构变化足以达到目标。

### G2：精确性能模型冻结

**交付**：Tile IR、operator/tile DAG、bank-cycle、NoC packet、MC transaction、RDMA/collective 模型、P50/P95/P99 时间账。

**通过条件**：取消无法解释的经验缩放；资源、容量、带宽和时间守恒；选定 MC 路线达到至少 1050 TPS/usr；最坏层和最坏路由分布通过。

### G3：Compute Die 架构冻结

**交付**：AI Core、TMA/SRAM、NoC、Collective/Reduce 规格；单 Die block diagram；ICD；PPA v1。

**通过条件**：所有单元数量、接口和时钟域明确；NoC、SRAM、TMA 和 PHY 可布线；面积、功耗、频率有 10–15% 余量。

### G4：Card 架构冻结

**交付**：8 Die topology、route table、MC home/NUMA、card-local collective、package floorplan、thermal/PDN/clock v1。

**通过条件**：不再同时使用 ring、mesh 和 hierarchy 三套口径；packet 模型覆盖最坏 collective、MC miss 和故障绕行；卡级 PPA 和热约束收敛。

### G5：TP32 Scale-out 冻结

**交付**：32 卡拓扑、PHY/port/connector/optics 方案、RDMA protocol、collective protocol、replay/timeout/RAS、P99 报告。

**通过条件**：跨卡物理带宽和功耗可实现；32 卡最坏 hop、拥塞、重放和降级通过；host 不需要逐 collective 介入；P99 达标。

### G6：RTL 前架构签核

**交付**：Architecture Specification v1.0、Microarchitecture Specification set、Verification Plan、golden traces、PPA/thermal/package sign-off、RTL/IP work package、requirement traceability、risk acceptance。

**通过条件**：所有 `BLOCKER` 关闭；主要 KPI 至少有 10% 设计余量；每个规格都能分解为 RTL、IP、firmware 或软件任务；变更控制基线建立。

---

## 10. 当前必须优先关闭的问题

| 优先级 | 问题 | 影响 | 关闭证据 |
|---|---|---|---|
| B-001 | 正式 K3 逐层结构和 dtype 未冻结 | FLOP、byte、容量、tile 全部可能变化 | 模型 manifest |
| B-002 | 320 GB/s 参考点与 640 GB/s 目标点冲突 | 当前 998.81 TPS 不能作为承诺 | 供应商规格或替代架构 |
| B-003 | Final Tuning 仍含经验缩放因子 | 性能可能高估 | 精确 tile/transaction 模型 |
| B-004 | 卡内拓扑口径冲突 | 带宽、hop、封装无法签核 | 统一拓扑和 packet 模型 |
| B-005 | TP32 物理拓扑未定义 | 800 GB/s/card 可实现性未知 | PHY、布线、功耗和 P99 方案 |
| B-006 | 频率、面积、功耗未回标 | PPA 可能不收敛 | synthesis/floorplan/IP macro |

在这些问题关闭前，4 L + 4 H、44 MiB/Die、5×5 NoC 和 8 Die topology 都只能视为架构候选或基线，不能视为最终冻结规格。

---

## 11. 高层架构的最终成功标准

当以下条件全部满足时，项目可将高层架构转入详细架构和 RTL 前阶段：

1. K3 workload、层清单、dtype、KV/state 和分片已冻结；
2. 选定的 MC 路线有供应商或工程实现依据；
3. 统一 Tile IR 覆盖编译器、模拟器、固件和硬件；
4. 性能模型不再依赖未解释的全局经验缩放；
5. 320 GB/s 或最终选定路线在精确模型中达到 `>=1050 TPS/usr`；
6. P99、最坏层、最坏路由、重放和热降频均通过；
7. Core、SRAM、TMA、MC、NoC、8 Die fabric、RDMA、Scheduler 和 RAS 的单元数量与接口已明确；
8. 面积、功耗、热、封装、PHY 和岸线具有 10–15% 余量；
9. 所有 BLOCKER 均有关闭证据；
10. 规格可直接分解为 RTL、IP、firmware、compiler 和验证工作包。
