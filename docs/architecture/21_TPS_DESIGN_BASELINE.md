# K3 TPS/usr 设计基线（P1）

版本：2026-09-25（频率固定 1.0 GHz；三星 SF4 面积、矩阵密度 3.2 TF/mm²、液冷）  
状态：`BASELINE`（由模型推导，不是 `FROZEN`，见 ADR-0003、[ADR-0005](../../teams/council/adr/ADR-0005-tps-design-baseline.md)）  
权威数值：[`teams/hardware/inputs/k3_mc_baseline.json#tpsDesign`](../../teams/hardware/inputs/k3_mc_baseline.json)，由 `npm run baseline:sync` 从
[`out/rdma/k3_rdma_final_tuning_results.json`](../../out/rdma/k3_rdma_final_tuning_results.json) 重算  
一致性检查：[`tests/regression/test_tps_design_baseline.js`](../../tests/regression/test_tps_design_baseline.js)

## 0. 本文的作用

本文把当前发布点 **1101.77 TPS/usr** 依赖的软件和硬件设计集中写在一处，并明确以下三点：

1. 每一项设计在时间账里贡献多少；
2. 单独回退任一项后 TPS 变成多少；
3. 每一项的证据等级，以及冻结前还缺哪些证据。

本文中的数字都是 `teams/hardware/inputs/k3_mc_baseline.json#tpsDesign` 的两位小数取值。测试会重算该块，并逐一核对本文数字；
模型一改，这里就必须同步，不能手改数字。硬件单元文档（`teams/hardware/docs/02`–`09`）自 2026-09-25 起按本发布点书写；
凡与本文冲突的地方，一律以本文和 spec 为准。硬件规格只有这一份（ADR-0021）。

模型链路：

```text
design_engine (K3 形状) -> sim.build (逐 token DAG) -> A.mappedPlan (逐算子时长)
  -> final_tuning.mapped (OPT、GAIN=1、τ 下限、端口计费) -> sim.simulate (事件循环：DMA/TMA/SRAM/COMM)
```

对应代码：

- [`teams/model/src/design_engine.js`](../../teams/model/src/design_engine.js)
- [`integration/detailed/k3_operator_sram_sim.js`](../../integration/detailed/k3_operator_sram_sim.js)
- [`integration/detailed/k3_architecture_search.js`](../../integration/detailed/k3_architecture_search.js)
- [`integration/detailed/k3_rdma_final_tuning_model.js`](../../integration/detailed/k3_rdma_final_tuning_model.js)
- [`integration/detailed/k3_tps_design_baseline.js`](../../integration/detailed/k3_tps_design_baseline.js)
- [`integration/detailed/k3_physical_basis.js`](../../integration/detailed/k3_physical_basis.js)（物理基准：工艺面积、矩阵密度、散热限值）

## 1. 目标、预算与发布点

| 项目 | 值 | 状态 |
| --- | ---: | --- |
| 目标 | 1000 TPS/usr，B=1 decode，Context 1M，TP32，PP1 | `FROZEN`（ADR-0009） |
| 工程裕量 | e2e = raw × 1.17 | `BASELINE` |
| raw 预算 | 854.70 µs/token | 由目标推导 |
| 频率 | 1.0 GHz，固定，不参与搜索 | `BASELINE`（2026-09-25 决定） |
| 工艺（面积） | 三星 SF4 级 4 nm：逻辑 ×1.277、SRAM ×1.248、PHY ×1（相对 N4 参考系数） | `ASSUMPTION`（B-006） |
| 矩阵密度 | 3.2 TF/mm²（1 GHz，N4 参考；SF4 逻辑系数另乘） | `ASSUMPTION`（B-006） |
| 散热 | 液冷（冷板）：Die 300 W、卡 2800 W | `ASSUMPTION`（O-015） |
| 发布点 TPS | 1101.77 TPS/usr | `MODEL` |
| 发布点 raw / e2e | 775.75 / 907.63 µs | `MODEL` |
| raw 余量 | 78.95 µs | `MODEL` |
| MC 带宽假设 | 640 GB/s/颗（ADR-0019 的 `STRETCH/AGGRESSIVE` 档） | `BLOCKER`（B-002） |
| 同一候选在 MC320 下 | 586.46 TPS/usr | 参考规格兼容点，不达标 |
| 验收状态 | `target-met-in-model-only`；架构闸门 1050 TPS/usr **未通过** | 见 `acceptance` |

结论：在 MC640 的假设下，1000 TPS/usr 目标**仅在模型中**达到。这个结果不能宣称为可制造的芯片指标（第 7 节）。
P1 数字虽已高于 1050，但架构闸门要求可制造的 MC 路线和详细 tile 模型，所以仍是未通过。

### 1.1 频率规则

算力只能通过 core 数、tensor engine 数和阵列形状调整，**不能靠降频换算力**。搜索空间中 `EXT.ghz = [1]`，
频率也不参与成对微调。

### 1.2 物理基准（2026-09-25 决定，ADR-0005 决定 6）

`A.physical()` 按 N4 参考系数和风冷限值计算；
`integration/detailed/k3_physical_basis.js` 的 `resize()` 在其结果上按 SF4 重算面积，并按液冷限值重做全部限值检查。
功耗、频率和带宽系数不变。

- 矩阵密度取 3.2 TF/mm²、限值取液冷的 300 W / 2800 W：功耗允许 UCIe 128 lane（MC 不再被 UCIe 端口截断），
  面积和功耗一起买到更多 H 算力。

当前发布点的硬件：8 个 L core；4 个 H core，每个 5 × 48×128 engine；每 core 512 向量 lane；
H local SRAM 4 MiB，KV tile 32768；UCIe 128 lane。Die 373.71 mm²（N4 参考下为 374.86 mm²）、286.22 W，卡 2768.47 W。

## 2. 时间账

恒等式（模拟器断言）：

```text
raw = compute − tmaHidden + comm + wait − overlap
    = 434.62 − 106.91 + 451.95 + 22.35 − 26.27 = 775.75 µs
TPS = 1e6 / (raw × 1.17)
```

| 服务项 | µs | 含义 |
| --- | ---: | --- |
| `kernel` | 224.84 | 矩阵/向量 kernel 本体（含 unpack、FP8 KV 反量化） |
| `tmaFill` | 134.77 | 由 DMA 取入 shared SRAM 的输入，经 TMA 通道装入 local SRAM（权重、expert、KV、state） |
| `localTma` | 42.87 | 仍留在算子内的装载：激活、写回 flush、local 口超额 |
| `reduce` | 14.23 | 算子内的片上归约（PV 合并等） |
| `launch` | 11.17 | kernel 发射，已乘 `launchScale` 0.45 |
| `dieLink` | 6.73 | 算子内的跨 Die 传输 |
| `memoryTransport` | 192.37 | 集合通信：协议模型给出的内存搬运 |
| `cardLocal` | 74.71 | 集合通信：卡内 8 Die 阶段 |
| `tpReduce` | 1.88 | 集合通信：TP32 归约计算 |
| `tauFloor` | 183.00 | 把每次集合通信补足到 τ = 1.15 µs 的时间 |
| `assumedGain` | 0.00 | GAIN 表的净折扣（GAIN 全为 1） |
| `commOverlap` | −26.27 | shared 专家在集合通信期间计算 |
| `tmaHidden` | −106.91 | 被集合通信或前一个 kernel 掩盖的 TMA 装载 |
| DMA wait | 22.35 | 主要是 routed expert 未命中部分的取数 |

其中：

- compute 434.62 = kernel + tmaFill + localTma + reduce + launch + dieLink；
- comm 451.95 = memoryTransport + cardLocal + tpReduce + tauFloor；
- TMA 装载中仍暴露在关键路径上的是 27.87 µs。

### 2.1 按算子类别的服务时间（µs）

| 类别 | µs | 主要算子 |
| --- | ---: | --- |
| MLA 注意力（24 层） | 208.62 | QK、online softmax、PV、MLA Q/KV 投影、RoPE、KV append |
| MoE（92 层） | 127.63 | Wdown、Router、shared 专家、routed 专家、Wup、Top-k |
| 线性注意力（69 层） | 55.01 | 线性投影、recurrent state 更新 |
| 注意力公共部分 | 40.64 | RMSNorm、输出投影、残差 |
| LM head 与采样 | 2.72 | Final RMSNorm、LM head、采样 |
| 集合通信 | 451.95 | 393 次 × 1.15 µs |

### 2.2 集合通信（reference-393 口径）

| 集合通信 | 次数 | 计入时间 µs | 协议模型均值 µs | workspace B |
| --- | ---: | ---: | ---: | ---: |
| LSE merge / output reduce-scatter | 24 | 27.60 | 0.98 | 1325568 |
| Attention output all-reduce | 93 | 106.95 | 0.77 | 276480 |
| Wdown + Router all-gather | 92 | 105.80 | 0.43 | 186880 |
| Routed latent merge | 92 | 105.80 | 0.69 | 204800 |
| Wup + Shared output all-reduce | 92 | 105.80 | 0.77 | 276480 |

UCIe 回到 128 lane 后，LSE merge 的协议时间降到 0.98 µs，五类都低于 τ，全部按 1.15 µs 计。
因此通信时间完全由 τ × 次数决定（ADR-0004、B-008）。

## 3. 硬件设计（每 Compute Die，除非注明）

搜索向量 `x` 全量记录在 `tpsDesign.hardware.x`。下表的系数全部是分析假设
（`A.TECH`），尚未由 memory compiler、标准单元、PHY 宏或综合结果回标（B-006）。

### 3.1 卡与封装

| 项目 | 规格 | 状态 |
| --- | --- | --- |
| 卡组织 | 8 Compute Die + 16 MC；每 Die 本地 2 MC；一张卡 = 一个 TP rank；32 张卡构成 TP32 | `BASELINE`（ADR-0011） |
| 封装 | 7-reticle placement window 5248 mm²；当前占用 4589.71 mm² | `BASELINE`（ADR-0018） |
| 工艺 | 三星 SF4 级 4 nm（面积按第 1.2 节折算） | `ASSUMPTION`（B-006） |
| 散热 | 液冷（冷板）；冷板、VRM、卡供电未建模 | `ASSUMPTION`（O-015） |
| 卡功耗 | 2768.47 W（上限 2800 W），其中 MC 398.72 W | `MODEL` |
| 时钟 | 1.0 GHz（固定，第 1.1 节） | `BASELINE`；实现性待 B-006 |

### 3.2 计算单元

| 单元 | 规格 | 峰值 | 承担的算子 |
| --- | --- | ---: | --- |
| L core | 8 个；每个 8 个 1×256 tensor engine | 32.77 TFLOPS BF16 | 低复用 GEMV：MLA/线性注意力投影、输出投影、Wdown/Router/Wup、shared 与 routed 专家、LM head；routed 专家权重为 MXFP4，在向量单元上 unpack |
| H core | 4 个；每个 5 个 48×128 tensor engine | 245.76 TFLOPS BF16 | 高复用矩阵：吸收式 MLA 的 QK/PV、线性注意力 recurrent state |
| 向量单元 | 每个 core 512 lane（12 core） | 12.29 TOPS | RMSNorm、softmax、SiLU、Top-k、残差、权重 unpack、FP8 KV 反量化 |
| Reduce 引擎 | 4096 lane | 2.66 TOPS | 集合通信的归约 |

矩阵利用率 0.65、向量利用率 0.35、layout imbalance 1.15，均为 `A.TECH` 的固定假设，
不是可调旋钮（`tests/regression/test_k3_rdma_final_tuning.js` 断言 OPT 中不存在这两个利用率键）。

### 3.3 存储层级

| 单元 | 规格 | 带宽 | 设计用途 |
| --- | --- | ---: | --- |
| L local SRAM | 1 MiB/core，64 bank × 64 B | 3.07 TB/s/core | 权重 tile 双缓冲；当前占用 0.36 MiB |
| H local SRAM | 4 MiB/core，64 bank × 64 B | 3.07 TB/s/core | KV tile 双缓冲与 m/l/O 累加器；当前占用 2.74 MiB（BF16 KV 时放不下，见第 5 节） |
| Shared SRAM | 16 MiB/Die，16 slice | 读 6.14 / 写 3.07 TB/s | DMA 落地区：权重、预测专家、KV、state、集合通信 workspace |
| 数据 SRAM 合计 | 40 MiB/Die（24 local + 16 shared） | — | — |
| Shared 窗口 | 8 × 16 × 0.85 = 108.80 MiB/卡 | — | 峰值预留 100.24 MiB/卡 |
| RDMA workspace | 1.26 MiB | — | 集合通信 staging |

Shared SRAM 端口放大（`localWriteRatio` 1.70、`tmaDedicatedPort` ×1.55、`sharedReadScale` 1.18、
`sharedReadPerWrite` 0.18）已计费：每 Die 16.15 mm²（SF4）、5.69 W，每卡 45.51 W。
在发布点全部关掉后 TPS 只降到 1101.71（第 5 节）。
每卡 45.51 W 只换来 0.06 TPS，是下一轮可以回收的预算；是否回收由 ADR-0005 的变更流程决定，本文不擅自修改。

### 3.4 数据搬运

| 单元 | 规格 | 带宽 | 状态 |
| --- | --- | ---: | --- |
| TMA | 每 core 4 engine × 512 B/cycle | 1.64 TB/s/core | `MODEL`（O-007） |
| 片上 NoC | 6×6 抽象 mesh，256 B/cycle × 4 lane | 7.99 TB/s | `OPEN`（O-003） |
| UCIe（Die 间） | 每端口 128 lane × 64 Gbps | 819.20 GB/s/端口；环切面 1638.40 GB/s | `BLOCKER`（B-004） |
| MC 接口 | 2 × 640 GB/s，利用率 0.7；UCIe 端口 819.20 GB/s 不再截断 | 896.00 GB/s/Die | `BLOCKER`（B-002） |
| RDMA（scale-out） | 16 lane × 112 Gbps | 168.00 GB/s/Die；800.00 GB/s/卡（上限） | `BLOCKER`（B-005） |

发布点的数据搬运：

- 每 token 每 rank 读取 4.97 GB；
- DMA busy 775.30 µs，几乎占满 raw 775.75 µs；
- 有效 DMA 6.41 TB/s/卡；
- 每 rank 后备容量 49.20 GB。

DMA 已接近满载。UCIe 回到 128 lane 后 MC 带宽不再被端口截断，MC 带宽直接决定 DMA 上限（第 6 节）。

### 3.5 面积与功耗（每 Die）

面积按 SF4 折算（第 1.2 节）；功耗系数未变。

| 模块 | 面积 mm² | 功耗 W |
| --- | ---: | ---: |
| 矩阵 | 111.18 | 133.69 |
| 向量 | 11.77 | 7.99 |
| SRAM 阵列 / bank | 39.61 / 32.70 | 28.48 |
| core 开销 | 12.26 | — |
| TMA | 21.46 | 3.84 |
| NoC | 35.92 | 11.98 |
| Reduce | 44.41 | 32.77 |
| UCIe | 22.34 | 31.46 |
| RDMA | 10.60 | 6.72 |
| 控制/杂项 | 15.33 | 23.60 |
| Shared 端口放大 | 16.15 | 5.69 |
| **合计** | **373.71**（上限 400） | **286.22**（上限 300，液冷） |

PHY shoreline 占用 24.21 mm，预算 52.95 mm。

## 4. 软件设计

### 4.1 执行模型

- 每个 token 是一张固定的算子 DAG。93 层中，第 0、4、…、92 层（共 24 层）是 softmax MLA，其余 69 层是线性注意力；
  第 1–92 层带 MoE。
- 算子按程序顺序发射到 L、H、V 和 COMM 四类单元。集合通信在独立通道上执行，但在 B=1 下每次都位于依赖主链上。
- 精度口径：routed 专家权重为 MXFP4，dense 权重为 BF16，KV cache 为 FP8（第 4.6 节），矩阵计算为 BF16。
- tile 规划：权重 tile 8 MiB，KV tile 32768 token，head tile 96，RDMA stripe 64 KiB。

### 4.2 集合通信

- 计数口径 `countBasis='reference-393'`（B-007 已接受）。这是**口径对齐，不是优化**：
  `Q / new-KV all-gather`（24 次）和采样广播（1 次）仍作为本地算子留在 DAG 中；shared 输出归约并入 `Wup + Shared output all-reduce`，
  并排在 shared 专家之后。
- 成本基准：每次至少 τ = `OPT.tauUs` = 1.15 µs（ADR-0004）；协议模型给出更长时间时取协议值。
- 协议参数：stripe 64 KiB，oneWay 0.05 µs，commit/notify/ack 分别为 2/2/4 cycle，每个 NIC 64 outstanding，2 个 epoch，
  commit/ack 按 16 批量，phase 融合系数 3。它们只影响超过 τ 的集合通信，发布点没有集合通信超过 τ。
- 以下 reduce/ACK 开关当前都只通过 GAIN 起作用，GAIN = 1，所以对时长没有贡献：
  `dieDirectReduce`、`groupAck`、`readyCounter`、`dieGroupReduce`、`hierarchicalReduce`、`remoteDirectReduce`。

### 4.3 计算与通信重叠（`commOverlap`）

与 routed 路径无数据依赖的 shared 专家（gate/up、SiLU×up、down）被排在 `Wdown + Router all-gather` 之后，与其并行执行。
重叠量的上限是 shared 专家的计算时间，发布点为 26.27 µs。其他算子一律不与集合通信重叠。

### 4.4 独立 TMA 通道（`tmaLane`）

由 DMA 取入 shared SRAM 的输入（权重、routed expert、KV tile、线性注意力 state）要装入 local SRAM。
这部分装载从算子中拆出，放到 L、H 两个域各一条的 TMA 通道上，按程序顺序提前发射。发射条件是：

- 输入已在 shared SRAM 就绪；
- 该域 local 双缓冲有空闲的一半。

TMA 通道与 DMA、算子和集合通信共享 shared 读口和 fabric，与同域 kernel 共享 local 写口。
发布点装载共 134.77 µs，其中被掩盖 106.91 µs，暴露 27.87 µs。

模拟器的兜底规则：已装满但属于后续算子的 tile 会钉住它的输入。
当 head 算子需要的 DMA 因此装不下时，取消最远的一次装载（`tmaCancels`），发布点为 0 次。

### 4.5 DMA：预取、KV 窗口、抢占与预测

- 预取深度 `x.depth` 进入搜索（1–4 层）。发布点取 4；取 2–4 时 TPS 相同，取 1 时 1018.96。
- `kvPrefetch='window'`：历史 KV 不依赖当前 token，因此后续 `x.depth` 层的 KV context tile 与权重一样可以提前取入，只受 shared 容量约束。
- `dmaPreempt`：DMA 按 stripe 切分。Top-k 之后的 routed expert 未命中取数，以及下一个算子需要的数据，
  可以暂停正在进行的预取。被暂停的预取保留 SRAM 预留，按消费顺序恢复。发布点抢占 92 次。
- 专家预测命中率 0.8（`ASSUMPTION`）：每 token 每 rank 预测取数 0.81 GB，其中错取 0.16 GB。
  剩余 DMA wait 22.35 µs 主要来自未命中的 20%。

### 4.6 注意力映射

- 吸收式 MLA：QK、PV 在 H core 上执行，按 head tile 96 × KV tile 32768 分块。
- `pvMerge='layer'`（FlashDecoding 式）：m/l/O 累加器跨 context tile 留在 H local SRAM，每个（层, head tile）只在最后一个 tile 合并一次；
  跨 Die 合并用按 head 的双向环 reduce-scatter。
- `softmaxFusion`：online softmax 在 H core 向量单元上按 score 块与 QK 流水，只暴露一个块或超出 QK 的部分。
- `kvCache='fp8'`（FlashMLA 布局）：每 token 每层 656 B，即 512 FP8 E4M3 + 4 个 FP32 scale（每 128 元素一个）+ 64 维 BF16 RoPE；
  BF16 布局为 1152 B。QK/PV 仍是 BF16，latent 在 kernel 内于向量单元反量化（与权重 unpack 同速率）；
  这部分时间从 softmax 可掩盖的预算中扣除。精度影响未评估（B-001、O-013）。

### 4.7 逐元素算子融合（`epilogueFusion`）

以下算子并入相邻 kernel 的 prologue/epilogue：RMSNorm、SiLU×up、专家加权和、dispatch pack、RoPE、KV append。
这些算子不再单独经过 shared→local 装载，也没有单独的写回和 launch；向量时间与字节照常计入。
以下两类不融合：

- 紧跟集合通信的残差加；
- 计数口径下的本地算子（Q/new-KV all-gather、采样）。

### 4.8 Launch（`launchBatching`）

每个非 COMM、未融合的算子计一次 launch：`A.TECH.launchUs` 0.015 µs × `OPT.launchScale` 0.45，只应用一次，共 11.17 µs。
0.45 是**未回标的假设**（B-003），证据等级与其他机制不同。

### 4.9 GAIN 表

`GAIN` 中 25 个经验因子全部为 1，时间账中 `assumedGain` 为 0（B-003）。
任何因子离开 1，都必须有来自事件/资源模型的证据，并走第 8 节的变更流程。

## 5. 逐项回退

在发布点只回退一项、其余不变时重放的结果：

| 机制 | 层级 | 回退为 | TPS/usr | raw µs | 证据 |
| --- | --- | --- | ---: | ---: | --- |
| `tmaLane` | 调度/TMA | `false` | 984.20 | 868.42 | `MODEL` |
| `kvPrefetch` | 调度/DMA | `'layer'` | 991.52 | 862.01 | `MODEL` |
| `softmaxFusion` | kernel 映射 | `false` | 1033.22 | 827.22 | `MODEL` |
| `dmaPreempt` | 调度/DMA | `false` | 1041.66 | 820.52 | `MODEL` |
| `commOverlap` | 调度/集合通信 | `false` | 1073.24 | 796.37 | `MODEL` |
| `epilogueFusion` | kernel 映射 | `false` | 1077.23 | 793.43 | `MODEL` |
| `pvMerge` | kernel 映射 | `'tile'` | 1082.21 | 789.77 | `MODEL` |
| `launchBatching` | runtime | `false` | 1088.47 | 785.23 | `ASSUMPTION` |
| `sharedPortScaling` | 硬件/SRAM 端口 | 四个端口参数全部回到 1 / `false` / 0 | 1101.71 | 775.79 | `MODEL`（O-007） |
| `kvCache` | 模型格式 | `'bf16'` | 不可行（H local tile） | — | `MODEL`（B-001） |

- 单独回退 `tmaLane` 或 `kvPrefetch`，TPS 会跌破 1000；其余单项回退仍在 1000 以上，但每一项都降低 TPS，余量 78.95 µs 是各项叠加的结果。
- `sharedPortScaling` 贡献仅 0.06 TPS，代价是每 Die 16.15 mm²、5.69 W（第 3.3 节）。
- 在发布点开着但**不影响 TPS**的开关：`tilePartialReady`，它只通过 GAIN 起作用。
- 计数口径切回 `repo-510` 得 941.74 TPS/usr。这是口径差，不能读作优化收益（ADR-0004）。

## 6. 敏感度

| 变量 | 值 | TPS/usr |
| --- | --- | ---: |
| τ | 1.15 µs（发布） | 1101.77 |
| τ 盈亏点 | 1.35 µs（每次集合通信余量 0.201 µs） | 1000.00 |
| MC 带宽 | 320 / 400 / 480 / 560 / 640 GB/s | 586.46 / 721.01 / 853.44 / 977.00 / 1101.77 |
| 预取深度 | 1 / 2–4 | 1018.96 / 1101.77 |
| KV tile 16384（发布值为 32768） | FP8 / BF16 | 1094.35 / 1027.08 |
| KV tile 32768（发布值） | FP8 / BF16 | 1101.77 / 不可行（H local tile） |

几点读法：

- 在同一候选上，MC 低于 640 GB/s 就不达标（560 GB/s 为 977.00）；ADR-0019 的默认上限 480 GB/s 只有 853.44。
- 通信占 raw 的 58%，完全由 τ 决定。τ 升到约 1.35 µs 才跌破 1000。
- 按次数算的解析天花板（393 次约 1134.46）见 `tauBasis.ceilingTpsByCount`。

## 7. 证据等级与未闭合项

| 设计要素 | 等级 | 冻结前需要的证据 |
| --- | --- | --- |
| 目标、B=1、TP32 | `FROZEN` | — |
| K3 结构、dtype、FP8 KV | `MODEL` | B-001：模型清单、权重 manifest、FP8 KV 精度评估 |
| MC 640 GB/s | `BLOCKER` | B-002：供应商规格（或放弃 MC640 另选架构） |
| launchScale、预测命中率 0.8 | `ASSUMPTION` | B-003：runtime trace、专家预测实测 |
| 卡内拓扑、scale-out、UCIe 128 lane | `BLOCKER` | B-004、B-005：统一拓扑与 PHY 方案 |
| 频率 1.0 GHz（固定）、面积、功耗系数 | `MODEL` | B-006：synthesis/floorplan/IP 回标 |
| SF4 面积折算（逻辑 ×1.277、SRAM ×1.248、PHY ×1） | `ASSUMPTION` | B-006：SF4 PDK/标准单元/memory compiler 数据；SF4/SF4X 节距未公开，按 SF4E 取 |
| 矩阵密度 3.2 TF/mm² | `ASSUMPTION` | B-006：MAC 阵列宏的面积数据 |
| 液冷 Die 300 W / 卡 2800 W | `ASSUMPTION` | O-015：冷板、VRM、卡供电方案 |
| τ = 1.15 µs | `MODEL` | B-008：由 B-004/B-005 给出物理推导 |
| TMA 独立端口、TMA 通道 | `MODEL` | O-007：TMA/SRAM 微架构可实现性 |
| 调度机制（第 4.3–4.7 节） | `MODEL` | kernel/调度器 trace 或 RTL 性能模型（B-003 的要求同样适用） |

按 ADR-0003，本文所有配置都不得标为 `FROZEN`。架构闸门（1050 TPS/usr，使用可制造 MC 路线、详细 tile 模型）目前未通过。

## 8. 变更控制

1. **单一来源**：
   - 硬件取值在 `out/rdma/k3_rdma_final_tuning_results.json#search.best.x`；
   - 物理基准（工艺面积、矩阵密度、散热限值）在 `integration/detailed/k3_physical_basis.js#BASIS`；
   - 软件开关在 `OPT`；
   - 经验因子在 `GAIN`；
   - 汇总在 `teams/hardware/inputs/k3_mc_baseline.json#tpsDesign`。

   本文和其他文档只引用这些来源，不另行定义数值。
2. **何时算变更**：出现以下任一情况，都要在同一次提交里完成：重新搜索、`npm run baseline:sync`、`npm run model:planning`、更新本文数字、在 `00_CURRENT_STATE.md` 记录。
   - 修改 `OPT` 的任一开关或参数；
   - 修改 `GAIN`、`A.TECH`、`A.LIMITS` 或物理基准 `BASIS`/`PROCESS`；
   - 修改模拟器的调度语义；
   - 修改搜索空间，包括放开固定的频率（第 1.1 节）。
3. **新增机制**：必须满足以下全部条件。
   - 在 `OPT` 中有开关；
   - 能从时间账追溯到服务项；
   - 在 `tpsDesign.software.mechanisms` 中登记回退值与证据等级；
   - 单独回退时 TPS 下降。

   不满足最后一条的，放入 `noEffectAtPublishedPoint`。
4. **禁止事项**：
   - 未经 B-003 的证据，让 GAIN 离开 1；
   - 用计数口径的变化宣称性能收益；
   - 把 MC640 的结果写成可制造指标；
   - 靠降频换取算力。
5. **重现**：`npm run search:final && npm run baseline:sync && npm run model:planning && npm test`
   （`model:planning` 刷新以 spec 哈希为输入的规划产物）。
