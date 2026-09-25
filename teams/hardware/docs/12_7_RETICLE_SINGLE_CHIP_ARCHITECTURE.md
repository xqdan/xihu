# K3 7-Reticle 单芯片与集成存储架构

版本：2026-09-21  
状态：`BASELINE PROPOSAL / OPEN FOR PACKAGE REVIEW`

## 1. 设计前提

本方案把“单芯片”定义为一个 **7-reticle 先进封装 SiP / 2.5D package**，而不是单颗单 Die。单个 7-reticle package 对软件表现为一个 TP rank；32 个 package 组成 K3 TP32 Decode replica。

```text
K3 TP32 replica
└── 32 × K3 7-Reticle Package
    ├── 8 × Compute Die
    ├── 16 × 3D-DRAM / Memory Cube chiplet
    ├── Active silicon interposer / RDL
    ├── Package-local die fabric
    ├── Package-local collective / reduce
    └── Scale-out / RDMA endpoint
```

本文件只冻结高层物理边界和面积/存储预算，不冻结工艺、PHY IP、bump map、
SRAM compiler 或最终 MC 供应商规格。所有数字属于架构级规划值。

## 2. Reticle 面积口径

### 2.1 面积定义

| 项目 | 规划值 | 说明 |
|---|---:|---|
| 单 Reticle | 26 mm × 33 mm = 858 mm² | 7R 面积口径 |
| 7 Reticle 理论面积 | 6,006 mm² | `7 × 858 mm²`，不是可直接填满的有源面积 |
| 工程封装放置窗口 | 82 mm × 64 mm = 5,248 mm² | 用于初始 floorplan |
| 理论面积余量 | 758 mm² | 相对 7R 理论面积的面积级余量 |
| 封装内布线/间隙预算 | 448 mm² | 约占 5,248 mm² 的 8.5% |

`6,006 mm²` 是 7-reticle 的面积类别上限；真正用于 placement、keep-out、
RDL、TSV、PDN、时钟和热设计的第一版窗口按 `5,248 mm²` 管理。不能把
7R 理论面积直接当作可放置裸片面积。

### 2.2 封装平面候选

```text
Package placement window: approximately 82 mm × 64 mm

North:  8 × MC, each approximately 10 mm × 10 mm
Middle: 8 × Compute Die, 4 columns × 2 rows, each 20 mm × 20 mm
South:  8 × MC, each approximately 10 mm × 10 mm

Nominal occupied rectangle: 80 mm × 60 mm
Reserved edge / keep-out / routing: remaining package window
```

计算 Die 采用 4×2 规则阵列，MC 位于上下两侧，形成短距离、本地优先的
Compute-to-MC 连接。具体 MC 是否全部位于北/南两排，仍需由封装厂根据
bump、冷板和信号完整性约束确认。

## 3. 单芯片的高层组成

### 3.1 Compute Die 数量

| 项目 | 单 Die | 单 7R package |
|---|---:|---:|
| Compute Die | 1 | 8 |
| L Core | 8 | 64 |
| H Core | 8 | 64 |
| Shared SRAM | 16 MiB | 128 MiB |
| Local SRAM | 80 MiB | 640 MiB |
| 数据 SRAM 合计 | 96 MiB | 768 MiB |
| 本地 MC | 2 | 16 |
| 标称频率候选 | 1.0 GHz | 1.0 GHz |

这里的 `8 L + 8 H` 是 7-reticle package 的高层候选，来自现有 400 mm²
Compute Die 参考设计；当前代码中的 `4 L + 4 H、44 MiB/Die` 仍保留为
较小面积/较低 SRAM 的对照候选，不应与本方案混写。

### 3.2 单 Compute Die 面积预算

单 Die 采用 `20 mm × 20 mm = 400 mm²` 的物理上限/规划面积：

| 模块 | 面积预算 | 占比 | 规划内容 |
|---|---:|---:|---|
| Tensor / Vector / RF | 200 mm² | 50.0% | 8 L Core + 8 H Core、Tensor、Vector、RF |
| 片上 SRAM | 76 mm² | 19.0% | 96 MiB 数据 SRAM、ECC、bank peripheral |
| NoC / MC controller | 50 mm² | 12.5% | 双数据面 NoC、2 个 MC controller、reduce gateway |
| UCIe / Die fabric PHY | 48 mm² | 12.0% | MC、Die-to-Die 和 package I/O PHY/adapter |
| 管理 / 安全 / PMU | 12 mm² | 3.0% | RISC-V management、PMU、RAS、debug |
| Clock / DFT / spare / margin | 14 mm² | 3.5% | 时钟、DFT、备用和布线余量 |
| **合计** | **400 mm²** | **100%** | 规划上限 |

`400 mm²` 不是要求所有逻辑必须填满，而是用于 package floorplan、I/O
岸线和热预算的单 Die 约束。正式面积必须由 memory compiler、PHY macro、
综合和 post-route 结果回标。

### 3.3 Compute Die 内部存储单元

| 存储层级 | 配置 | 容量/Die | 作用 |
|---|---|---:|---|
| L-Core Local SRAM | 8 个 L Core × 8 MiB | 64 MiB | GEMV、Skinny GEMM、低复用 FFN、Expert tile |
| H-Core Local SRAM | 8 个 H Core × 2 MiB | 16 MiB | QK/PV、KV tile、Linear Attention state |
| Shared L2 / SRAM | 16 slices × 1 MiB | 16 MiB | MC refill、跨 Core tile、partial、collective staging |
| **数据 SRAM 合计** | — | **96 MiB** | 不含 RF、指令 cache、metadata 和 PHY buffer |

片上 SRAM 的设计原则：

- L/H Local SRAM 物理上就近绑定 Core，不走全局超宽总线；
- Shared SRAM 采用 slice、bank color 和多平面 NoC；
- Weight、Activation、KV/State、Collective mailbox 分离 bank class；
- 所有数据阵列支持 ECC、scrub、spare row/column 和故障隔离；
- mailbox、epoch metadata 和 remote-ready 状态优先放在 Shared SRAM；
- 96 MiB 是物理数据容量目标，ECC、tag、repair 和控制开销单独计入面积。

### 3.4 Package 集成存储单元

| 存储单元 | 数量/package | 单元容量候选 | Package 容量 | 带宽基线 |
|---|---:|---:|---:|---:|
| 3D-DRAM / Memory Cube | 16 | 8 GB | 128 GB | 320 GB/s/MC |
| 3D-DRAM / Memory Cube | 16 | 16 GB | 256 GB | 320 GB/s/MC |
| MC-X / 双数据面 Stretch | 16 | 8/16 GB | 128/256 GB | 640 GB/s/MC |

主容量档建议采用 **16 × 16 GB = 256 GB/package**；8 GB 档用于成本和
早期原型。性能基线暂按 320 GB/s/MC，640 GB/s/MC 只能作为必须单独验证的
Stretch 路线。

因此单 package 的外部内存聚合带宽为：

```text
16 × 320 GB/s = 5.12 TB/s raw payload
16 × 640 GB/s = 10.24 TB/s raw payload  (Stretch)
```

注意：7R 面积和 16 个 MC 的集成并不自动证明 1000 TPS/usr。当前 P1 模型已经
显示 320 GB/s/MC 点明显不达标（数值见 [`docs/architecture/00_CURRENT_STATE.md`](../../../docs/architecture/00_CURRENT_STATE.md) 第 3 节），接近目标的结果依赖 640 GB/s/MC
或等效的字节削减、复用和算法/调度变化。

## 4. 单芯片数据流和互联

### 4.1 本地数据路径

```text
MC0/MC1
  -> MC controller
  -> Shared SRAM slice
  -> TMA
  -> L/H Local SRAM
  -> Tensor / Vector
  -> local partial
  -> package-local reduce
  -> Shared SRAM mailbox
```

### 4.2 7R package 内部拓扑

```text
                8 × MC north row
        MC   MC   MC   MC   MC   MC   MC   MC
          |    |    |    |    |    |    |    |
        D0---D1---D2---D3       package I/O
        |    |    |    |             |
        D4---D5---D6---D7       scale-out / RDMA
          |    |    |    |             |
        MC   MC   MC   MC   MC   MC   MC   MC
                8 × MC south row
```

- Compute Die 之间采用 4×2 mesh 候选；
- collective 使用两个四 Die reduce domain；
- 每个 Compute Die 绑定两个本地 MC；
- MC 不直接参加 Tensor/GEMM；
- package edge 集中放置 scale-out、host、管理和时钟接口；
- Die-to-Die、Die-to-MC 和 Scale-out PHY 不共享同一套带宽假设。

### 4.3 互联预算

| 互联 | 目标 | 说明 |
|---|---:|---|
| MC-to-Die | 320 GB/s/MC payload baseline | 每 Die 2 个本地 MC |
| Die-to-Die | 320 GB/s/方向/链路候选 | 4×2 mesh，需 SI/PI/热验证 |
| Package collective | 分层 reduce / multicast | 避免所有流量穿过跨 package 网络 |
| Scale-out | 800 GB/s/package payload target | TP32 之间的外部接口 |
| Control plane | 低速独立 VC | descriptor、barrier、fault、PMU |

## 5. 单芯片面积总账

### 5.1 裸片面积

| 类别 | 数量 | 单元面积 | 总面积 |
|---|---:|---:|---:|
| Compute Die | 8 | 400 mm² | 3,200 mm² |
| MC chiplet | 16 | 100 mm² | 1,600 mm² |
| **裸片面积合计** | — | — | **4,800 mm²** |
| 工程放置窗口 | — | — | 5,248 mm² |
| 放置/布线余量 | — | — | 448 mm² |
| 7R 理论面积上限 | — | — | 6,006 mm² |

占工程放置窗口的比例：

```text
Compute Die: 3,200 / 5,248 = 61.0%
MC:          1,600 / 5,248 = 30.5%
Routing:       448 / 5,248 =  8.5%
```

该比例与现有 7-reticle 参考架构保持一致。若单 Die 面积降到约 260 mm²，
可以增加封装余量或增加 MC/PHY，但不能在没有重做 bandwidth model 的情况下
直接把节省面积换算为性能。

### 5.2 面积冻结建议

第一版建议冻结三个面积 profile，而不是马上只保留一个数字：

| Profile | Compute Die | MC | 片上 SRAM | 用途 |
|---|---:|---:|---:|---|
| P0 7R balanced | 8×400 mm² | 16×100 mm² | 96 MiB/Die | 主架构候选 |
| P1 compact | 8×260 mm² | 16×100 mm² | 44 MiB/Die | 现有搜索模型对照 |
| P2 bandwidth-first | 8×260–300 mm² | 16 MC dual-plane 或更多 MC | 64–96 MiB/Die | 320 GB/s 瓶颈替代路线 |

P0 用于封装和集成存储的主设计；P1 用于验证当前软件/模型是否受算力或
SRAM 影响；P2 用于关闭 1000 TPS/usr 的 MC 带宽阻塞。

## 6. 关键设计目标

### 6.1 性能

- 单 7R package 作为一个 TP rank；
- 32 package 构成 TP32；
- B=1、Context=1M、Decode；
- 端到端目标 1000 TPS/usr；
- 架构冻结门槛 1050 TPS/usr；
- raw latency `<=854.70 us/token`；
- 320 GB/s 和 640 GB/s MC 结果必须分别报告；
- 任何性能优化必须能追溯到 tile、transaction、bandwidth 或 queue。

### 6.2 存储

- 片上数据 SRAM：96 MiB/Die、768 MiB/package；
- 外部 3D-DRAM：256 GB/package 优先；
- 片上 Shared SRAM working window 和物理容量分开报告；
- MC 只承担容量和数据搬运，近存计算作为独立备选路线；
- KV/state、权重和 collective mailbox 具有明确 home 和生命周期。

### 6.3 PPA 与封装

- 单 Die 规划面积：400 mm² 上限；
- 单 Die 功耗：先按 230–260 W 区间建模，250 W 为预算点；
- 7R package 采用液冷假设；
- 8 Die + 16 MC 的裸片总面积约 4,800 mm²；
- 工程 placement window 至少保留 8.5% routing/keep-out 预算；
- 任何增加 MC、PHY 或 SRAM 的方案都必须同时更新 PDN、热和岸线预算。

## 7. 必须新增的详细设计文档

```text
teams/hardware/docs/
├── 12_7_RETICLE_SINGLE_CHIP_ARCHITECTURE.md  # 本文
├── 13_COMPUTE_DIE_AREA_AND_FLOORPLAN.md
├── 14_INTEGRATED_MEMORY_HIERARCHY.md
├── 15_PACKAGE_BUMP_PHY_AND_RDL.md
├── 16_PACKAGE_POWER_THERMAL_BUDGET.md
└── 17_SINGLE_CHIP_TO_TP32_MAPPING.md
```

### 13：Compute Die Area and Floorplan

必须交付：

- 20×20 mm floorplan；
- 8 L + 8 H Core 的物理位置；
- 96 MiB SRAM bank/slice 位置；
- 2 个 MC gateway 的北/南岸线；
- NoC、reduce、clock、DFT、RAS 区域；
- 400 mm² 面积表和 10% 余量；
- congestion、IR drop、thermal hotspot 初版。

### 14：Integrated Memory Hierarchy

必须交付：

- L-SRAM/H-SRAM/Shared SRAM 分层；
- 16 MC 的容量、带宽和地址映射；
- weight/KV/state/mailbox 的 home；
- 320/640 GB/s 对比模型；
- MC transaction、TMA descriptor 和 SRAM lifecycle；
- ECC、scrub、repair 和降容策略。

### 15：Package Bump、PHY 和 RDL

必须交付：

- 82×64 mm placement floorplan；
- 8 Compute Die + 16 MC bump map；
- MC-to-Die、Die-to-Die、Scale-out PHY 分区；
- UCIe lane、bump、RDL、keep-out 和 escape；
- SI/PI、repeater、clock、reset 和 sideband 方案。

### 16：Package Power、Thermal Budget

必须交付：

- 8 Die × 250 W 计算功耗预算；
- 16 MC 功耗和堆叠热阻；
- PHY、VRM、BMC、冷板和液冷流量；
- 48 V 输入和多电源域；
- 单 Die 降频对 TP32 最慢 package 的影响；
- 2.8–3.2 kW package cooling envelope。

### 17：Single Chip to TP32 Mapping

必须交付：

- 一个 7R package 如何映射为一个 TP rank；
- 32 package 的 topology、hop 和 collective；
- package-local reduce 与 cross-package RDMA 的边界；
- package failure、Die failure、MC failure 和降级；
- 800 GB/s/package scale-out port budget。

## 8. 当前决策和未决问题

### 建议先作为 BASELINE 的决策

1. 单芯片边界采用 7-Reticle package，而不是单颗 Compute Die；
2. 一个 package 包含 8 Compute Die + 16 MC；
3. Compute Die 规划上限为 400 mm²，约 20×20 mm；
4. 每 Die 规划 96 MiB 数据 SRAM；
5. 每 package 规划 768 MiB 片上数据 SRAM；
6. 每 package 规划 16 个 MC，16 GB/MC 为容量优先档；
7. 一个 package 是一个软件 TP rank，32 package 构成 TP32。

### 必须保持 OPEN 的问题

- 7R 的 6,006 mm² 是否是封装厂认可的面积上限，还是仅概念面积；
- 82×64 mm placement window、边缘 keep-out 和 RDL stitch；
- 400 mm² Compute Die 的良率、频率和功耗；
- 96 MiB SRAM 的实际 compiler 密度和端口面积；
- 16 MC 是否可以提供持续 320 GB/s/MC payload；
- 640 GB/s/MC 是否需要双数据面或新 MC-X；
- 7R package 的液冷、PDN 和 scale-out 岸线；
- 8 Die mesh 是否能在 320 GB/s/链路下完成 P99 collective。

## 9. 架构冻结门槛

该 7-reticle 单芯片方案只有在以下条件同时满足时才能从 `BASELINE PROPOSAL`
进入 `FROZEN`：

1. 7R/82×64 mm 封装规则由封装厂确认；
2. 8×400 mm² Compute Die 和 16×100 mm² MC floorplan 通过；
3. 96 MiB/Die SRAM macro、bank、ECC 和端口模型通过；
4. 320 GB/s MC baseline 和 640 GB/s Stretch 使用同一 Tile/MC 模型复算；
5. 选定的可制造路线达到 `>=1050 TPS/usr`，而不是只达到当前 P1 MC640 Stretch 点；
6. package power、thermal、PDN、PHY 和 RDL 具有至少 10% 余量；
7. 单 package 到 TP32 的 collective、RDMA、故障和降级模型通过；
8. 7R 物理边界、存储层次和接口规格写入机器可读 baseline。
