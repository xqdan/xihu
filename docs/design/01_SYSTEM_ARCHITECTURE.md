# 系统架构设计

## 1. 系统边界

本轮定义的“芯片”包含一个加速器卡上的 8 个 Compute Die、16 个外置
Memory Cube、封装内互联、卡级 Scale-out 端点以及配套控制逻辑。
32 张卡构成一个 TP32 Decode replica。

```text
TP32 replica
  32 × accelerator card
    1 card
      8 × Compute Die
      16 × Memory Cube (2 local MC / Compute Die)
      card-local die fabric
      800 GB/s aggregate scale-out payload budget
```

主机、交换机、光模块和电源/冷却属于系统接口，但其实现不包含在 Compute
Die RTL 内。

## 2. 基线层级

### 2.1 Compute Die

每 Die 暂定：

- 4 个 L Core；
- 4 个 H Core；
- 每 Core 独立 Tensor、Vector、TMA 和 Local SRAM；
- 24 MiB Shared SRAM，8 slices；
- 单独的 collective/reduce 单元；
- 2 个本地 MC 数据端口；
- 卡内 Die fabric 端口；
- Scale-out/RDMA 端点；
- 管理、PMU、时钟、复位和 RAS。

### 2.2 Card

- 8 个 Compute Die；
- 16 个 MC，每 Die 本地绑定 2 个；
- 逻辑上每张卡是 TP32 的一个 rank；
- 卡内先完成局部归约，再进入跨卡 collective；
- 权重和 KV 默认本地放置，远端 MC 只用于重平衡和故障降级。

### 2.3 TP32 replica

- 32 张卡按相同 shard map 加载；
- 每 token 由所有 rank gang-scheduled；
- collective epoch 在所有 rank 上一致推进；
- 以最慢 rank 作为 step 完成条件；
- B=1 低时延 Decode 不依赖 PP。

## 3. Decode 端到端数据流

```text
MC weight/state tile
  -> MC controller/UCIe
  -> Shared SRAM slice
  -> TMA
  -> Core Local SRAM
  -> Tensor/Vector execution
  -> local partial
  -> card-local reduce
  -> RDMA-to-remote-SRAM collective
  -> ready/commit
  -> next operator tile
```

Softmax MLA 另有：

```text
KV context tile -> QK -> online softmax m/l -> PV partial
  -> m/l/O semantic merge
  -> output rescale
```

MoE 另有：

```text
RMSNorm -> Wdown + Router -> Top-k
  -> expert tile fetch/prefetch
  -> gate/up -> SiLU -> down
  -> routed merge -> Wup
  -> shared experts -> residual
```

## 4. 地址与一致性原则

- MC、Shared SRAM、Local SRAM 和 remote SRAM slot 采用统一物理地址描述，
  但不是 CPU cache-coherent 地址空间。
- 数据所有权由 tile descriptor 和 epoch 管理。
- Local SRAM 不参与跨 Core 硬件一致性；显式 TMA/collective 传输。
- Shared SRAM 是 Die 内共享和远端落点，使用 slice home + bank interleave。
- remote write 可见不等于 tile ready；ready 由 commit counter/flag 定义。

## 5. 端到端预算

1000 TPS/usr 对应：

```text
E2E <= 1000.00 μs/token
raw <= 1000 / 1.17 = 854.70 μs/token
```

架构冻结门槛建议不是刚好 1000，而是 tile 模型达到至少
**1050 TPS/usr**，为模型误差、PVT、ECC、重放和软件抖动留出空间。

建议 raw 预算分配：

| 类别 | 目标上限 | 说明 |
| --- | ---: | --- |
| Tensor/Vector kernel | 390 μs | 需要真实 kernel trace 回标 |
| Local TMA/SRAM | 250 μs | 包含 bank conflict |
| Collective/RDMA | 115 μs | 包含 card-local 和 scale-out |
| MC/DMA 暴露等待 | 55 μs | 参考 MC 路线当前远超预算 |
| launch/control/尾部 | 20 μs | descriptor、barrier、sampling |
| 合计 | 830 μs | 留约 25 μs raw 工程余量 |

该表是设计目标，不是当前已实现数字。

## 6. 系统级退出条件

- 主模型清单、精度和层顺序被冻结；
- MC 物理规格与每卡连接方式可制造；
- TP32 物理拓扑明确，最坏 hop 和故障降级可计算；
- tile 模型在无经验缩放因子的情况下达到 1050 TPS/usr；
- 单 Die 面积、功耗、岸线和时钟收敛；
- 所有子系统接口文档完成并通过跨团队评审。
