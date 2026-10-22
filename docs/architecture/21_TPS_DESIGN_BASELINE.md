# K3 TPS/usr 设计基线（P1）

版本：2026-09-25（频率固定 1.0 GHz；三星 SF4 面积、矩阵密度 3.2 TF/mm²、液冷）  
状态：`BASELINE`（由模型推导，不是 `FROZEN`，见 ADR-0003、[ADR-0005](../../teams/council/adr/ADR-0005-tps-design-baseline.md)）  
权威数值：[`teams/hardware/inputs/k3_mc_baseline.json#tpsDesign`](../../teams/hardware/inputs/k3_mc_baseline.json)，由 `npm run baseline:sync` 从
[`out/rdma/k3_rdma_final_tuning_results.json`](../../out/rdma/k3_rdma_final_tuning_results.json) 重算  
一致性检查：[`tests/regression/test_tps_design_baseline.js`](../../tests/regression/test_tps_design_baseline.js)

## 0. 本文的作用

本文把当前发布点 **1124.70 TPS/usr** 依赖的软件和硬件设计集中写在一处，并明确以下三点：

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
| 散热 | 液冷（冷板）：Die 300 W、卡 3200 W（ADR-0026，原 2800 W） | `ASSUMPTION`（O-015） |
| 发布点 TPS | 1124.70 TPS/usr | `MODEL` |
| 发布点 raw / e2e | 759.94 / 889.13 µs | `MODEL` |
| raw 余量 | 94.76 µs | `MODEL` |
| MC 带宽假设 | 1152 GB/s/颗（HBM3E，引脚速率换算，非供应商数据；ADR-0019 的 `STRETCH/AGGRESSIVE` 档位槽位，原 640，ADR-0026） | `BLOCKER`（B-002） |
| 同一候选在 MC320 下 | 585.93 TPS/usr | 参考规格兼容点，不达标 |
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
H local SRAM 4 MiB，KV tile 32768；UCIe 128 lane。Die 364.03 mm²（N4 参考下、端口放大之前为 389.20 mm²）、290.48 W，卡 3031.92 W。

## 2. 时间账

恒等式（模拟器断言）：

```text
raw = compute − tmaHidden + comm + wait − overlap
    = 431.13 − 108.07 + 451.95 + 11.92 − 26.98 = 759.94 µs
TPS = 1e6 / (raw × 1.17)
```

| 服务项 | µs | 含义 |
| --- | ---: | --- |
| `kernel` | 205.95 | 矩阵/向量 kernel 本体（含 unpack、FP8 KV 反量化） |
| `tmaFill` | 135.45 | 由 DMA 取入 shared SRAM 的输入，经 TMA 通道装入 local SRAM（权重、expert、KV、state） |
| `localTma` | 42.87 | 仍留在算子内的装载：激活、写回 flush、local 口超额 |
| `reduce` | 28.47 | 算子内的片上归约（PV 合并等） |
| `launch` | 11.66 | kernel 发射，已乘 `launchScale` 0.45 |
| `dieLink` | 6.73 | 算子内的跨 Die 传输 |
| `memoryTransport` | 192.37 | 集合通信：协议模型给出的内存搬运 |
| `cardLocal` | 94.56 | 集合通信：卡内 8 Die 阶段（8 Die 双向环，每次 8 跳，B-004） |
| `tpReduce` | 2.01 | 集合通信：TP32 归约计算 |
| `tauFloor` | 163.01 | 把每次集合通信补足到 τ = 1.15 µs 的时间 |
| `assumedGain` | 0.00 | GAIN 表的净折扣（GAIN 全为 1） |
| `commOverlap` | −26.98 | shared 专家在集合通信期间计算 |
| `tmaHidden` | −108.07 | 被集合通信或前一个 kernel 掩盖的 TMA 装载 |
| DMA wait | 11.92 | 主要是 routed expert 未命中部分的取数 |

其中：

- compute 431.13 = kernel + tmaFill + localTma + reduce + launch + dieLink；
- comm 451.95 = memoryTransport + cardLocal + tpReduce + tauFloor；
- TMA 装载中仍暴露在关键路径上的是 27.37 µs。

### 2.1 按算子类别的服务时间（µs）

| 类别 | µs | 主要算子 |
| --- | ---: | --- |
| MLA 注意力（24 层） | 206.95 | QK、online softmax、PV、MLA Q/KV 投影、RoPE、KV append |
| MoE（92 层） | 127.63 | Wdown、Router、shared 专家、routed 专家、Wup、Top-k |
| 线性注意力（69 层） | 53.19 | 线性投影、recurrent state 更新 |
| 注意力公共部分 | 40.64 | RMSNorm、输出投影、残差 |
| LM head 与采样 | 2.72 | Final RMSNorm、LM head、采样 |
| 集合通信 | 451.95 | 393 次 × 1.15 µs |

### 2.2 集合通信（reference-393 口径）

| 集合通信 | 次数 | 计入时间 µs | 协议模型均值 µs | workspace B |
| --- | ---: | ---: | ---: | ---: |
| LSE merge / output reduce-scatter | 24 | 27.60 | 1.03 | 1325568 |
| Attention output all-reduce | 93 | 106.95 | 0.82 | 276480 |
| Wdown + Router all-gather | 92 | 105.80 | 0.48 | 186880 |
| Routed latent merge | 92 | 105.80 | 0.74 | 204800 |
| Wup + Shared output all-reduce | 92 | 105.80 | 0.82 | 276480 |

UCIe 回到 128 lane 后，LSE merge 的协议时间降到 0.98 µs；2026-10-10 卡内阶段按 8 Die 环计 8 跳（ADR-0016、B-004，原 6 跳），五类各多 0.05 µs，LSE merge 为 1.03 µs，仍都低于 τ，全部按 1.15 µs 计。
因此通信时间完全由 τ × 次数决定（ADR-0004、B-008）。

## 3. 硬件设计（每 Compute Die，除非注明）

搜索向量 `x` 全量记录在 `tpsDesign.hardware.x`。下表的系数全部是分析假设
（`A.TECH`），尚未由 memory compiler、标准单元、PHY 宏或综合结果回标（B-006）。

### 3.1 卡与封装

| 项目 | 规格 | 状态 |
| --- | --- | --- |
| 卡组织 | 8 Compute Die + 16 MC；每 Die 本地 2 MC；一张卡 = 一个 TP rank；32 张卡构成 TP32 | `BASELINE`（ADR-0011） |
| 封装 | 7-reticle placement window 5248 mm²；当前占用 4512.26 mm² | `BASELINE`（ADR-0018） |
| 工艺 | 三星 SF4 级 4 nm（面积按第 1.2 节折算） | `ASSUMPTION`（B-006） |
| 散热 | 液冷（冷板）；冷板、VRM、卡供电未建模 | `ASSUMPTION`（O-015） |
| 卡功耗 | 3031.92 W（上限 2800 W），其中 MC 628.10 W | `MODEL` |
| 时钟 | 1.0 GHz（固定，第 1.1 节） | `BASELINE`；实现性待 B-006 |

### 3.2 计算单元

| 单元 | 规格 | 峰值 | 承担的算子 |
| --- | --- | ---: | --- |
| L core | 8 个；每个 8 个 1×256 tensor engine | 32.77 TFLOPS BF16 | 低复用 GEMV：MLA/线性注意力投影、输出投影、Wdown/Router/Wup、shared 与 routed 专家、LM head；routed 专家权重为 MXFP4，在向量单元上 unpack |
| H core | 4 个；每个 5 个 48×128 tensor engine | 294.91 TFLOPS BF16 | 高复用矩阵：吸收式 MLA 的 QK/PV、线性注意力 recurrent state |
| 向量单元 | 每个 core 512 lane（12 core） | 12.29 TOPS | RMSNorm、softmax、SiLU、Top-k、残差、权重 unpack、FP8 KV 反量化 |
| Reduce 引擎 | 4096 lane | 1.33 TOPS | 集合通信的归约 |

矩阵利用率 0.65、向量利用率 0.35、layout imbalance 1.15，均为 `A.TECH` 的固定假设，
不是可调旋钮（`tests/regression/test_k3_rdma_final_tuning.js` 断言 OPT 中不存在这两个利用率键）。

### 3.3 存储层级

| 单元 | 规格 | 带宽 | 设计用途 |
| --- | --- | ---: | --- |
| L local SRAM | 1 MiB/core，64 bank × 64 B | 3.07 TB/s/core | 权重 tile 双缓冲；当前占用 0.36 MiB |
| H local SRAM | 4 MiB/core，64 bank × 64 B | 3.07 TB/s/core | KV tile 双缓冲与 m/l/O 累加器；当前占用 1.58 MiB（BF16 KV 在 KV tile 16384 下放得下但只有 976.33 TPS/usr，32768 下放不下，见第 5、6 节） |
| Shared SRAM | 16 MiB/Die，16 slice | 读 6.14 / 写 3.07 TB/s | DMA 落地区：权重、预测专家、KV、state、集合通信 workspace |
| 数据 SRAM 合计 | 40 MiB/Die（24 local + 16 shared） | — | — |
| Shared 窗口 | 8 × 16 × 0.85 = 108.80 MiB/卡 | — | 峰值预留 108.65 MiB/卡 |
| RDMA workspace | 1.26 MiB | — | 集合通信 staging |

Shared SRAM 端口放大（`localWriteRatio` 1、`tmaDedicatedPort` ×1.55、`sharedReadScale` 1.18、
`sharedReadPerWrite` 0.18）已计费：每 Die 7.78 mm²（SF4）、2.74 W，每卡 21.92 W。
在发布点全部关掉后 TPS 只降到 1124.69（第 5 节）。
`localWriteRatio` 原为 1.70，由 ADR-0023 降到 1：这一项单独占 8.37 mm²/Die、2.95 W/Die，
回放里 TPS 不变（1124.70）。剩下的三项仍合计 0.06 TPS，是否继续回收走 ADR-0005 的变更流程。

### 3.4 数据搬运

| 单元 | 规格 | 带宽 | 状态 |
| --- | --- | ---: | --- |
| TMA | 每 core 4 engine × 512 B/cycle | 1.64 TB/s/core | `MODEL`（O-007） |
| 片上 NoC | 6×6 抽象 mesh，256 B/cycle × 4 lane | 7.99 TB/s | `OPEN`（O-003） |
| UCIe（Die 间） | 每端口 128 lane × 64 Gbps，8 Die 双向环（ADR-0016 口径） | 819.20 GB/s/端口；环切面 1638.40 GB/s | `ASSUMPTION`（B-004，待硬件评审） |
| MC 接口 | 2 × 640 GB/s，利用率 0.7；UCIe 端口 819.20 GB/s 不再截断 | 1612.80 GB/s/Die | `BLOCKER`（B-002） |
| RDMA（scale-out） | 16 lane × 112 Gbps | 168.00 GB/s/Die；800.00 GB/s/卡（上限） | `BLOCKER`（B-005） |

发布点的数据搬运：

- 每 token 每 rank 读取 4.97 GB；
- DMA busy 474.57 µs，几乎占满 raw 759.94 µs；
- 有效 DMA 10.62 TB/s/卡；
- 每 rank 后备容量 49.20 GB。

DMA 已接近满载。UCIe 回到 128 lane 后 MC 带宽不再被端口截断，MC 带宽直接决定 DMA 上限（第 6 节）。

### 3.5 面积与功耗（每 Die）

面积按 SF4 折算（第 1.2 节）；功耗系数未变。

| 模块 | 面积 mm² | 功耗 W |
| --- | ---: | ---: |
| 矩阵 | 130.80 | 157.29 |
| 向量 | 11.77 | 7.99 |
| SRAM 阵列 / bank | 39.61 / 32.70 | 28.48 |
| core 开销 | 12.26 | — |
| TMA | 21.46 | 3.84 |
| NoC | 35.92 | 11.98 |
| Reduce | 23.48 | 16.38 |
| UCIe | 22.34 | 31.46 |
| RDMA | 10.60 | 6.72 |
| 控制/杂项 | 15.33 | 23.60 |
| Shared 端口放大 | 7.78 | 2.74 |
| **合计** | **364.03**（上限 400） | **290.48**（上限 300，液冷） |

PHY shoreline 占用 24.21 mm，预算 52.85 mm。

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
重叠量的上限是 shared 专家的计算时间，发布点为 26.98 µs。其他算子一律不与集合通信重叠。
重叠期间两方都按映射时长计时，不互相让带宽。按需求比例分配 shared SRAM 读写口和 fabric 复算后（ARCH-CH-01，
`out/detailed/contention_delta.json`，MODEL），发布点的前台总需求峰值是上限的 0.31（fabric），差值为 0；
8 个可行联合点峰值 0.88，差值同样为 0。

### 4.4 独立 TMA 通道（`tmaLane`）

由 DMA 取入 shared SRAM 的输入（权重、routed expert、KV tile、线性注意力 state）要装入 local SRAM。
这部分装载从算子中拆出，放到 L、H 两个域各一条的 TMA 通道上，按程序顺序提前发射。发射条件是：

- 输入已在 shared SRAM 就绪；
- 该域 local 双缓冲有空闲的一半。

TMA 通道与 DMA、算子和集合通信共享 shared 读口和 fabric，与同域 kernel 共享 local 写口。
发布点装载共 135.45 µs，其中被掩盖 108.07 µs，暴露 27.37 µs。

模拟器的兜底规则：已装满但属于后续算子的 tile 会钉住它的输入。
当 head 算子需要的 DMA 因此装不下时，取消最远的一次装载（`tmaCancels`），发布点为 0 次。

### 4.5 DMA：预取、KV 窗口、抢占与预测

- 预取深度 `x.depth` 进入搜索（1–4 层）。发布点取 4；**1–4 的 TPS 全部相同**（ADR-0026 之前取 1 时 1018.96，现在没有差别：发布点被集合通信约束，共享窗口有富余）。深度只在窗口紧的点才起作用（如 `sharedMiB` 8），见 `tests/regression/test_k3_rdma_final_tuning.js`。
- `kvPrefetch='window'`：历史 KV 不依赖当前 token，因此后续 `x.depth` 层的 KV context tile 与权重一样可以提前取入，只受 shared 容量约束。
- `dmaPreempt`：DMA 按 stripe 切分。Top-k 之后的 routed expert 未命中取数，以及下一个算子需要的数据，
  可以暂停正在进行的预取。被暂停的预取保留 SRAM 预留，按消费顺序恢复。发布点抢占 92 次。
- 专家预测命中率 0.8（`ASSUMPTION`）：每 token 每 rank 预测取数 0.81 GB，其中错取 0.16 GB。
  剩余 DMA wait 11.92 µs 主要来自未命中的 20%。

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

每个非 COMM、未融合的算子计一次 launch：`A.TECH.launchUs` 0.015 µs × `OPT.launchScale` 0.45，只应用一次，共 11.66 µs。
0.45 是**未回标的假设**（B-003），证据等级与其他机制不同。

### 4.9 GAIN 表

`GAIN` 中 25 个经验因子全部为 1，时间账中 `assumedGain` 为 0（B-003）。
任何因子离开 1，都必须有来自事件/资源模型的证据，并走第 8 节的变更流程。

## 5. 逐项回退

在发布点只回退一项、其余不变时重放的结果：

| 机制 | 层级 | 回退为 | TPS/usr | raw µs | 证据 |
| --- | --- | --- | ---: | ---: | --- |
| `tmaLane` | 调度/TMA | `false` | 974.25 | 877.29 | `MODEL` |
| `kvPrefetch` | 调度/DMA | `'layer'` | 1027.05 | 832.19 | `MODEL` |
| `softmaxFusion` | kernel 映射 | `false` | 1061.26 | 805.36 | `MODEL` |
| `dmaPreempt` | 调度/DMA | `false` | 1087.13 | 786.20 | `MODEL` |
| `commOverlap` | 调度/集合通信 | `false` | 1092.76 | 782.15 | `MODEL` |
| `epilogueFusion` | kernel 映射 | `false` | 1097.41 | 778.83 | `MODEL` |
| `pvMerge` | kernel 映射 | `'tile'` | 1025.55 | 833.41 | `MODEL` |
| `launchBatching` | runtime | `false` | 1108.48 | 771.06 | `ASSUMPTION` |
| `sharedPortScaling` | 硬件/SRAM 端口 | 四个端口参数全部回到 1 / `false` / 0 | 1124.69 | 759.94 | `MODEL`（O-007） |
| `kvCache` | 模型格式 | `'bf16'` | 976.33 | 875.42 | `MODEL`（B-001） |

- 单独回退 `tmaLane` 或 `kvCache`（FP8 KV 改回 BF16），TPS 会跌破 1000（974.25、976.33）；`kvPrefetch` 及其余单项回退仍在 1000 以上，但每一项都降低 TPS，余量 94.76 µs 是各项叠加的结果。ADR-0026 之前 `kvCache` 回退是“不可行（H local tile）”、`kvPrefetch` 回退是 991.52；现在前者可行、后者 1027.05。
- **联合回退**（`tpsDesign.software.jointAblation`）：单项回退看起来余量充足，是因为每次只拿掉一项。把一组机制一起回退：

  | 一起回退的机制 | TPS/usr | raw µs |
  | --- | ---: | ---: |
  | 调度类：`tmaLane`、`kvPrefetch`、`dmaPreempt`、`commOverlap` | 897.63 | 952.18 |
  | kernel 映射类：`softmaxFusion`、`epilogueFusion`、`pvMerge`、`launchBatching` | 936.90 | 912.26 |
  | 两类全部 | 766.82 | 1114.60 |

  所以 1000 TPS/usr 要求这些机制同时成立，而它们都是 `MODEL`（`launchBatching` 是 `ASSUMPTION`），没有 trace 或 RTL 证据。
  测试要求每个联合回退都比组内任何一项单独回退更低。
- `sharedPortScaling` 贡献仅 0.002 TPS（1124.70 对 1124.69），代价是每 Die 7.78 mm²、2.74 W（第 3.3 节；`localWriteRatio` 已按 ADR-0023 由 1.70 降到 1）。
- 在发布点开着但**不影响 TPS**的开关：`tilePartialReady`，它只通过 GAIN 起作用。
- 计数口径切回 `repo-510` 得 956.61 TPS/usr。这是口径差，不能读作优化收益（ADR-0004）。

## 6. 敏感度

| 变量 | 值 | TPS/usr |
| --- | --- | ---: |
| τ | 1.15 µs（发布） | 1124.70 |
| τ 盈亏点 | 1.39 µs（每次集合通信余量 0.201 µs） | 1000.00 |
| MC 带宽 | 320 / 400 / 480 / 560 / 1152 GB/s（最后一档是 MC640 槽位，HBM3E） | 585.93 / 722.17 / 852.32 / 978.18 / 1124.70 |
| 预取深度 | 1 / 2–4 | 1124.70 / 1124.70（发布点被集合通信约束，深度不起作用） |
| KV tile 16384（发布值；字段名 `kvTile16384` 是历史遗留） | FP8 / BF16 | 1124.70 / 976.33 |
| KV tile 32768（ADR-0026 之前的发布值） | FP8 / BF16 | 1039.86 / 不可行（H local tile） |

### 6.1 没有被任何东西测量的参数

下面几项是模型输入，仓库里没有实测或综合数据。表中是只改这一项、其余不变的详细模型重放（`tpsDesign.sensitivity.assumptions`），
"盈亏点"是 raw 预算 854.70 µs 仍成立的最低取值（二分求得）。

| 参数 | 发布值 | 重放 | 盈亏点 |
| --- | ---: | --- | --- |
| MC 持续效率 `A.TECH.mcUtil` | 0.70 | 0.6 → 1122.15；0.65 → 1123.52；0.75 → 1124.94 | 降到 0.4 仍成立（0.3 为 874.6） |
| 矩阵利用率 `A.TECH.matrixUtil` | 0.65 | 0.55 → 1090.18；0.6 → 1108.61；0.7 → 1138.86 | 0.40 |
| 向量利用率 `A.TECH.vectorUtil` | 0.35 | 0.25 → 1097.22；0.3 → 1117.90；0.45 → 1130.09 | 0.13 |
| 专家预测命中率（模拟器输入） | 0.8 | 0.6 → 1109.89；0.7 → 1117.25；0.9 → 1132.25 | 降到 0.3 仍成立 |
| 权重 unpack 速率 `A.TECH.unpackParamsPerLaneCycle`（参数/lane/cycle） | 2 | 1.5 → 1100.64；1 → 1044.56；0.8 → 1005.18；0.5 → 876.88 | 0.78 |
| bank 不均衡 `A.TECH.layoutImbalance` | 1.15 | 1.3 → 1087.62；1.4 → 1064.23；1.8 → 979.93 | 上界 1.70 |
| `launchScale` | 0.45 | 0.7 → 1117.27；1 → 1108.48 | — |

- **最薄的余量换了位置（ADR-0026）。** HBM3E 之前最薄的是 MC 持续效率：从 0.70 降到 0.63 就跌破 1000。现在发布点被集合通信约束、带宽有富余，
  MC 持续效率降到 0.4 都不跌破（0.4 → 1112.8，0.3 → 874.6，断崖在 0.3 到 0.4 之间）——**这不是 MC 变可靠了，是瓶颈换了**：
  内存侧的不确定性被集合通信的 τ 取代，而 τ 本身尚无物理推导（B-008）。按“发布值到盈亏点的相对距离”排序，现在最薄的是矩阵利用率（0.65 → 0.40，相对 38%）、
  其次 MC 持续效率（0.70 → 0.4 的下限，至少 43%）、bank 不均衡（1.15 → 1.70，48%）。这一排序只对**单项**成立；联合悲观点（6.1.1）仍低于 1000。
  MC 持续效率这个数在两处各有一份：详细模型读 `A.TECH.mcUtil`，规划模型读 `bandwidthTiers.sustainedEfficiency`。
  `tests/regression/test_tps_design_baseline.js` 要求两者相等。
- unpack 速率和 bank 不均衡原先不在这张表里。两者各自的余量不算薄（unpack 要降到 0.78 以下、不均衡要升到 1.70 以上才跌破 1000），
  但 unpack 速率没有任何 RTL 或微基准依据，而 L core 的 kernel 正是被它而不是被 MAC 限住；`layoutImbalance` 同时是 H local tile 的容量系数。
  ADR-0026 之前 `layoutImbalance` 1.8 在发布点（本地 SRAM 4 MiB）是“不可行（H local tile）”；现在发布点同样是 H 核 local 4 MiB，1.8 可行但已跌破 1000（979.93）。
- 预测命中率在模型里影响较小（降到 0.6 才掉 3.1%），但该参数只作用于模拟器的采纳逻辑，不改变预取任务的大小，所以这个小影响不应读作预测器本身不重要。

#### 6.1.1 联合悲观点

上表是只改一项。余量要看这些项**同时**偏悲观时是否还成立（`tpsDesign.sensitivity.jointPessimistic`，取各自扫描的悲观端，不是预测）：

| 组合 | 取值 | TPS/usr |
| --- | --- | ---: |
| `compute`（Die 侧） | matrixUtil 0.5、vectorUtil 0.25、unpack 1、layoutImbalance 1.3、KV tile 16384 | 947.09 |
| `allUnmeasured` | 上面加 mcUtil 0.65、预测命中率 0.7、launchScale 0.7 | 935.44 |

两个联合点都低于 1000，而其中任何一项单独都在 1000 以上。发布点的 1124.70 只在这些参数同时取乐观值时成立；
**设计指标应是联合悲观点仍不低于 1000，而不是发布点**。这一点把第 6.1 节每项单独看起来足够的余量，变成了总共不够。

### 6.2 规划口径与详细口径的差

Stage A/B 的 18 个槽位用规划 token time，它的 5 个因子在**一个**详细重放点（K3，P1，MC640，TP32）上拟合，没有自由度。
唯一能拿它与详细模拟器比较的是 K3 TP32 在不同 MC 带宽下的重放（`calibration.validation.holdout`）：

| MC GB/s/颗 | 详细模型 | 规划模型 | 规划相对详细 | 角色 |
| ---: | ---: | ---: | ---: | --- |
| 320 | 585.93 | 500.28 | −14.6% | 留出 |
| 400 | 722.17 | 625.35 | −13.4% | 留出 |
| 480 | 852.32 | 750.42 | −12.0% | 留出 |
| 560 | 978.18 | 875.49 | −10.5% | 留出 |
| 1152（MC640 槽位） | 1124.70 | 1142.61 | +1.6% | 拟合点 |

- 规划模型在带宽越低时越悲观，说明 `kMemory` 不是常数。四个留出点的残差全部超过 10% 的门（`test_tps_observation_matrix.js` 把它记为已知退化，ADR-0026「未解决」）：拟合点被集合通信约束，访存侧系数几乎不受约束，外推到访存绑定的档位时偏低。
- 观察矩阵里每个槽位带 `corroboration`：K3 TP32 MC640 是 `FITTED_POINT`（残差不是证据），K3 TP32 MC320 是 `DETAILED_HOLDOUT`，
  其余 16 个槽位（GLM-5.2、DeepSeek-V4-Pro 的全部，以及 K3 的 TP8/TP16）是 `UNCORROBORATED`——没有对应的详细模型，数字是 K3 因子的外推。
- Stage A 与 Stage B 调用同一个公式、同一组标定，两者的 TPS 差在构造上为 0。因此 `design.integrate` 的粗估-细估 delta 为 0
  只说明两者同源；它对 `UNCORROBORATED` 槽位不是对账结果，workflow 会把这些槽位单独列出。

几点读法：

- 在同一候选上，MC 低于 MC640 槽位（1152 GB/s）的各档都不达标（网格里最高的非槽位档 560 GB/s 为 978.18）；ADR-0019 的默认上限 480 GB/s 只有 852.32。注意 560 与 1152 之间没有网格点，所以这里不能读成“需要 1152”：S-BW 拆分反推的最低需求约 640 GB/s（`04_MEMORY_SUBSYSTEM_MC.md` §5.1.2）。
- 通信占 raw 的 59%，完全由 τ 决定。τ 升到约 1.39 µs 才跌破 1000。
- 按次数算的解析天花板（393 次约 1142.61）见 `tauBasis.ceilingTpsByCount`。

### 6.3 GLM-5.2 与 DeepSeek-V4-Pro：未测量假设的敏感度

这两个模型没有详细模拟器，TPS/usr 是 K3 因子的外推（§6.2）。`out/detailed/stage_b_planning_run_20261002.md` 的 “Assumption sensitivity” 表对每个槽位每次只改一个输入
（`TT.assumptionSensitivity`，`tests/regression/test_planning_assumption_sensitivity.js` 独立重放并固定结论）。TP32，P1：

| 模型 | MC | 名义 | 每层 +1 次集合通信 | 每层 −1 次 | 10% 注意力权重复制 | 全部复制 | 命中率 0.5 | `kMemory` 1.3 |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| GLM-5.2 | MC320 | 1627 | 1597 | 1627 | 890 | 175 | 1429 | 1542 |
| GLM-5.2 | MC640 | 1919 | 1597 | 2403 | 1889 | 631 | 1919 | 1919 |
| DeepSeek-V4-Pro | MC320 | 1684 | 1667 | 1684 | 933 | 186 | 1535 | 1595 |
| DeepSeek-V4-Pro | MC640 | 1932 | 1667 | 2296 | 1903 | 670 | 1932 | 1932 |

- 名义值已含 ADR-0024 的 q all-gather（GLM 333 次、DeepSeek 305 次）；“−1 次”列即 ADR-0024 之前的集合通信次数下的值（2403 / 2296）。
- MC640 由“集合通信次数 × τ”决定（GLM 333 × 1.15 µs = 383 µs）；单次消息约 24 KB，远低于 τ 对应的数据量，字节不进入结果。内存侧因子（命中率、`kMemory`）在 MC640 不起作用。
- MC320 由内存路径决定：再少一次集合通信不改变结果，再多一次则集合通信路径接管（1597 / 1667）；`kMemory` 和命中率在这里起作用，这两个因子只在 K3 上拟合或取值。
- **注意力权重的切分（ADR-0024）**：行里把注意力权重按 1/TP 计，manifest 声明 context 分片。context 分片的稀疏注意力要求每个 rank 拿到全部 head 的 q，
  ADR-0024 选择“权重保持 1/TP 分片，每层多一次 q all-gather”，因此名义值已含这一次。另一条路（复制权重）在表里只作对照：复制 10% 就让 GLM（890）和 DeepSeek（933）在 MC320 都掉到 1000 以下，全部复制则两个模型都不达标。
  **口径差异**：K3 的 reference-393 把 `Q / new-KV all-gather` 留作本地算子、不计入 393 次（ADR-0004）；GLM/DeepSeek 在这里计入。K3 按同样口径（repo-510）只有 956.61 TPS/usr，低于 1000。
  所以 K3 的 1143 与 GLM/DeepSeek 的 1919 / 1932 不是同一计数基础上的比较，GLM/DeepSeek 这一侧更保守（见 ADR-0024）。
- 没有建模、因此没有数字的项：专家切片在 L 核上的填充（TP-only 下每 rank 专家宽度 GLM 64、DeepSeek 约 120）；专家未命中取数在关键路径上的暴露（K3 详细模型里这部分是 11.92 µs 的 DMA wait，规划模型取 `max()` 时丢掉了）。
  两者都需要对应的 tile / 时序模型才能给出结论。

### 6.4 探索场景：Batch=1 + MTP 验证（EXPLORATORY，不是基线）

基线按 Batch=1、每步 1 个 token 计（`SCENARIO_MATRIX.md`：MTP 接受率场景当前未纳入）。本节只回答一个问题：**如果一步可以验证同一序列的 k 个 token，1000 TPS/usr 对内存带宽的要求会放松多少。**
它不改变任何 Gate、发布值 1124.70 或 Batch=1 的定义；产物 `out/detailed/mtp_exploration.json`（`npm run mtp:explore`，约 1.5 分钟，由 `tests/regression/test_mtp_exploration.js` 复算）。

模型（`integration/detailed/mtp_exploration.js` 头注释是权威描述）：

- 细化模拟器按 `batch = k` 个 token、`seqs = 1` 条序列跑一步：激活、路由、集合通信和路由专家并集随 k 增长，KV 与线性注意力状态只按 1 条序列读（k 个 token 共用一次 KV 读，这是一起验证的全部收益）；
- 路由专家并集：`worst` = k×K 个互不重叠，`expected` = 独立路由 N(1−(1−K/N)^k)；相邻 token 的真实路由有相关性，真值在 `expected` 以下，两者都**没有测量**；
- 硬件钉在发布点，软件旋钮按（稠密精度、MC 档位、k、并集）重调；
- 接受率与草稿代价是**假设**，扫描而非测量：每步期望 token 数 (1−a^k)/(1−a)；每个草稿 token 付 d 个 k=1 的平均层时间（d=1 是一层 MoE，d=2 另含 LM head 与采样）；
- 回滚、被拒 token 的 KV 失效、草稿头的 SRAM 占用、数据相关步长的调度开销**没有建模**。

步时间（BF16 稠密，MC640 槽位即 1152 GB/s，µs，未乘 1.17 余量）：k=1 为 755.0，k=2 为 966.1，k=3 为 1228.7，k=4 为 1473.8。
k=1 的 755.0 比发布点的 759.94 低 0.7%：重调网格里 `depth` 1 + `kvTile` 32768 比发布旋钮（`depth` 4、`kvTile` 16384）快 4.97 µs（1132.09 对 1124.70 TPS/usr），且满足 `search:final` 的三条约束；`search:final` 没找到它，因为 `depth` 单独不起作用、`kvTile` 32768 单独更慢（1039.86），只有两者一起才赢，而这一对不在它的成对移动里。差距被记录并在测试里限制在 1% 内，不是隐藏。
一步验证 2 个 token 要多付 28%，因为路由专家并集翻倍；所以 MTP 只在接受率足够高时才赚钱。

**达到 1000 TPS/usr 所需的最小每 token 接受率**（`worst` / `expected` 并集；d=1；0 表示 k=1 已经够）：

| 稠密精度 | MC320 | MC400 | MC480 | MC560 | MC640（1152） |
| --- | --- | --- | --- | --- | --- |
| BF16 | 0.8 / 0.8 | 0.65 / 0.65 | 0.4 / 0.4 | 0.25 / 0.25 | 0 / 0 |
| FP8 稠密 | 0.45 / 0.45 | 0 / 0 | 0 / 0 | 0 / 0 | 0 / 0 |

读法：

1. 在已发布的 MC640 槽位上，MTP 不是达标的条件，而是裕量：接受率 0.4 / 0.6 / 0.8 时 BF16 为 1228 / 1404 / 1684 TPS/usr（`model_profiles.json` 的 `reportedMtpAcceptanceGainMax` 是 0.2，在这个值上最优仍是 k=1，为 1132）；
2. 在 MC480 上要 0.4 的接受率才够，MC400 要 0.65，MC320 要 0.8——这些接受率都没有测量，所以 MTP **不能替代**带宽，只能给带宽落空留一点余地；
3. 与 FP8 稠密（第 6.1.1 节与 `04_MEMORY_SUBSYSTEM_MC.md` 的条件路线）叠加后，MC400 已不需要 MTP；MC320 需要 0.45 的接受率。
4. 草稿代价 d=2 时最小接受率最多抬高 0.05（BF16 的 `worst` 并集：MC400 由 0.65 变 0.7，MC480 由 0.4 变 0.45）。

结论级别：`PLANNING_ESTIMATE`，且依赖两个未测量输入（接受率、专家路由相关性）。要把它升级成基线场景，需要 MODEL-03/04 提供实测接受率与路由相关性，并由软件团队给出数据相关步长的调度合同。

### 6.5 探索：计算 Die 的面积与功耗再分配（EXPLORATORY，不是基线）

问题：发布点的 Die 把预算花在"名义模型里买 TPS"的单元上，而联合悲观点（6.1.1）压的恰好是另一批没测量的计算参数（矩阵/向量利用率、unpack、布局不均衡、KV tile）。
能否把名义上几乎不换 TPS 的预算（Reduce 通道、TMA 引擎、RDMA 通道）挪给悲观点下真正受限的单元，同时不丢名义结果？
产物 `out/detailed/die_area_reallocation.json`（`npm run area:explore`，约 2 分钟，由 `tests/regression/test_die_area_reallocation.js` 复算）；方法见 `integration/detailed/die_area_reallocation.js` 头注释。

**包络**：发布点 Die 面积 364.0 / 400 mm²、Die 功耗 290.5 / 300 W、卡功耗 3031.9 / 3200 W、封装 4512.3 / 5248 mm²。
这里的“封装”是模型自己的口径（不扣 keep-out）；扣掉观测 keep-out 0.1254 之后窗口只剩 4589.9 mm²，发布点余量 77.6 mm²，**面积也是一个边界**（ADR-0026 第二条约束），不再是“面积有富余”。
功耗仍是最紧的：Die 功耗余量只有 9.5 W（3.2%），卡功耗余量 168.1 W（5.3%）；任何单项升级（`nL` 8→12、`nH` 4→5、`hRows` 48→64、`ucieLanes` 128→256 等）都先死在 Die/卡功耗上。
所以"多出来的 36 mm² 面积"不能直接买计算——它得先用别处的功耗换出来，而且其中约 77.6 mm² 的 keep-out 余量里只有一部分可以花。

**单步边际**（只动一个字段；ΔTPS 为名义 / 联合悲观计算点）：

| 字段 | 变化 | ΔTPS 名义 | ΔTPS 悲观 | Δ面积 mm² | Δ功耗 W（Die） |
| --- | --- | ---: | ---: | ---: | ---: |
| `reduceLanes` | 2048 → 3072 | +14.2 | +10.1 | +10.5 | +8.2 |
| `reduceLanes` | 2048 → 1024 | −40.6 | −29.0 | −10.5 | −8.2 |
| `tmaEngines` | 4 → 3 | −1.4 | −1.0 | −5.4 | −1.0 |
| `rdmaLanes` | 16 → 12 | −0.6 | −0.5 | −1.4 | −1.7 |
| `vectorLanes` | 512 → 640 | +19.9 | +39.0 | +2.9 | +2.0 |
| `vectorLanes` | 512 → 384 | −51.2 | −101.9 | −2.9 | −2.0 |
| `hEngines` | 6 → 5 | −37.8 | −57.7 | −19.6 | −23.6 |
| `hRows` | 48 → 40 | −35.3 | −28.7 | −19.6 | −23.6 |
| `sharedSlices` | 16 → 12 | −10.8 | −36.9 | −5.2 | −1.8 |
| `lCols` | 256 → 128 | −38.4 | 0.0 | −6.5 | −7.9 |
| `lBanks` | 64 → 32 | −11.9 | −0.2 | −6.5 | −6.8 |
| `hBanks` | 64 → 32 | −0.6 | −33.3 | −3.3 | −3.4 |

读法：**HBM3E 之前**（ADR-0026）`vectorLanes` 在名义下是闲置的（512→640 为 −0.02），悲观点下最值钱（+28.4）；**现在**名义下也值钱（+19.9），悲观点下是 +39.0。原因是发布点不再被内存链路约束，向量单元不再闲置。
名义上几乎不换 TPS 的只剩 `rdmaLanes`（−0.6）和 `tmaEngines`（−1.4）；`reduceLanes` 2048→1024 现在名义上就要 −40.6，不再是“免费的功耗来源”。
`lCols` 256→128 在悲观点下 0.0 而名义 −38.4，说明它在名义下由 L 核 unpack 以外的路径限速（不要从悲观点单独推出可以砍）；`hBanks` 64→32 反过来，名义 −0.6 而悲观 −33.3。

**爬山结果**（从发布点出发，在"名义 TPS ≥ 下限"的约束下，按联合悲观计算点的 TPS 做成对一步移动的爬山；两个下限——名义不低于发布值 99%、名义不低于 1000 目标——得到同一个点，约束没有起作用）：

| 变化 | 发布点 | 再分配点 |
| --- | --- | --- |
| `vectorLanes` | 512 | 1024 |
| `reduceLanes` | 2048 | 3072 |
| `lBanks` | 64 | 32 |
| 名义 TPS/usr | 1124.70 | 1148.40 |
| 联合悲观点（计算） | 947.09 | 1036.20 |
| 联合悲观点（全部未测量，留出点） | 935.44 | 1022.27 |
| Die 面积 / 功耗 | 364.0 mm² / 290.5 W | 379.7 mm² / 299.9 W |
| 卡功耗（余量） | 3031.9 W（168.1 W） | 3107.3 W（92.7 W） |
| 观测 keep-out（0.1254）下的封装余量 | +77.6 mm² | **−47.9 mm²（装不下）** |

结论：

1. 名义同时涨（+23.7 TPS），悲观点由 947.1 抬到 1036.2（+89.1），留出点由 935.4 抬到 1022.3（+86.8）。留出点同向，说明增益不只是对调参点的过拟合；
2. **这个提案放不进封装。** 它的 Die 是 379.7 mm²，在观测 keep-out 0.1254 下封装缺口 −47.9 mm²，正是 ADR-0026 第二条约束排除的那一类点。研究本身的可行性判定不扣 keep-out（`die_area_reallocation.js` 沿用 `A.LIMITS`），所以它报“可行”；这个口径差**没有被修**，本节的“越过 1000”不能当作结论，只能读作“不计 keep-out 时的上界”。要得到可用的答案，需要让研究也按 `robust_model.js` 的口径判可行；
3. 增益来自 `vectorLanes` 512→1024，由 `reduceLanes` 2048→3072 和 `lBanks` 64→32 配合；与改前不同，这次的提案**增加** reduce 通道而不是减少 `rdmaLanes`；
4. 代价：卡功耗余量从 168.1 W 缩到 92.7 W，Die 功耗余量 9.5 W → 0.1 W（299.9 / 300）。换来的是对“向量利用率没达到 0.35”这类风险的保险，花掉的是散热和功耗裕量，两者不是免费的；
5. 即使按这个上界，也是联合悲观点才刚过 1000（1036.2），而 AC-1 要的是在不扣 keep-out 的前提之外仍成立；所以这是**可能缩小缺口**的线索，不是已消除缺口；
6. 爬山是贪心的、一步最多动两个字段，不保证全局最优。

适用范围：这是给 HW-01 / HW-02 单元负责人的提案。`vectorLanes=1024` 要求向量单元负责人给出面积/时序/布局签核，并要求功耗模型对 1024 通道的计费被测量覆盖；联合悲观点本身是**假设的压力场景**，不是测量。
不改变基线、Gate 或任何已发布数字。

## 7. 证据等级与未闭合项

| 设计要素 | 等级 | 冻结前需要的证据 |
| --- | --- | --- |
| 目标、B=1、TP32 | `FROZEN` | — |
| K3 结构、dtype、FP8 KV | `MODEL` | B-001：模型清单、权重 manifest、FP8 KV 精度评估 |
| MC 640 GB/s | `BLOCKER` | B-002：供应商规格（或放弃 MC640 另选架构） |
| MC 持续效率 0.7、矩阵/向量利用率、预测命中率 | `ASSUMPTION` | B-003、B-006：第 6.1 节；单项盈亏点最薄的是矩阵利用率（0.40），MC 持续效率降到 0.4 仍成立（ADR-0026 之前盈亏点是 0.63） |
| GLM-5.2、DeepSeek-V4-Pro、K3 TP8/TP16 的规划 TPS | `ASSUMPTION` | 第 6.2 节：没有详细模型，是 K3 因子的外推；第 6.3 节：注意力权重切分与每层集合通信次数未定 |
| launchScale、预测命中率 0.8 | `ASSUMPTION` | B-003：runtime trace、专家预测实测 |
| 卡内拓扑（按 8 Die 双向环计）、scale-out、UCIe 128 lane | `BLOCKER` | B-004：环口径待硬件评审与 packet 模型；B-005：scale-out 拓扑与 PHY 方案 |
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
