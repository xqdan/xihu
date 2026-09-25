# 当前设计状态与已知结论

版本：2026-09-25。

## 0. 7-reticle 单芯片前提

自 2026-09-21 起，单芯片的物理边界改为一个 7-reticle advanced package：8×400 mm² Compute Die + 16×100 mm² MC，工程 placement window 约 82×64 mm、5,248 mm²；一个 package 对软件表现为一个 TP rank，32 个 package 构成 TP32。

当前需要并行维护两个 profile：

| Profile | 用途 | 规格 |
|---|---|---|
| P0 7R physical primary | 封装、面积、集成存储和 PPA 主规划 | 8 L + 8 H/Die，1.0 GHz 候选，96 MiB data SRAM/Die，400 mm²/Die |
| P1 compact executable | 当前搜索/回归模型 | 由 Final Tuning 搜索决定，权威值在 `spec/k3_mc_baseline.json#computeDieCandidate`；2026-09-25 按 GAIN=1、τ=1.15 μs、reference-393 口径重新搜索并加入注意力/小算子映射、FP8 KV cache，频率固定 1.0 GHz、面积按三星 SF4 估算、改用液冷（Die 300 W / 卡 2800 W）后为 8 L + 4 H/Die（H core 5×(48×128) engine）、1.0 GHz、40 MiB data SRAM/Die、KV tile 32K、UCIe 128 lane、reduce 4096 lane（同日在风冷上限下发布过 4 L + 5 H、30 MiB、UCIe 64 lane 的 1015.08 点；还短暂发布过 8 L + 4 H、0.8 GHz、40 MiB 的降频点，已撤回；更早是 8 L + 4 H、1.0 GHz、80 MiB，再早是 8 L + 8 H；2026-09-23 是 24 L + 8 H、88 MiB；2026-09-20 是 4 L + 4 H、1.2 GHz、44 MiB） |

P1 的性能回归结果不能直接宣称为 P0 7R 物理主候选的最终性能；需要先完成
P0 的 tile、kernel、MC、NoC、floorplan 和 PPA 模型。本文第 2、3 节的数字全部是 **P1** 结果。

## 1. 已确定的工作负载口径

| 项目 | 当前值 | 状态 |
| --- | ---: | --- |
| 目标 | 1000 TPS/usr，单用户 Decode | `FROZEN` |
| Batch | 1 | `FROZEN` |
| Context | 1,048,576 token | `BASELINE` |
| 模型 | K3 工程 preset，93 层、92 个 MoE 层 | `MODEL` |
| Hidden / latent | 7168 / 3584 | `MODEL` |
| Experts | 896，总 Top-16，2 个 shared expert | `MODEL` |
| Attention | 24 层 Softmax MLA + 69 层线性 Attention | `MODEL` |
| 并行 | TP=32 张卡，PP=1 | `BASELINE` |
| 工程裕量 | 1.17 | `BASELINE` |
| raw 时延预算 | 854.70 μs/token | 由目标推导 |

K3 preset 来自
[`src/core/design_engine.js`](../../src/core/design_engine.js)，属于本地工程口径，
不是已经由模型提供方签核的正式规格。模型结构、精度和层顺序在架构冻结前必须
由独立的模型清单确认。

## 2. 当前最佳 Compute Die 候选（P1）

> 支撑当前 TPS/usr 发布点的软硬件设计（逐单元规格、时间账、软件机制、逐项回退、敏感度、证据等级与变更控制）
> 已汇总为 [`21_TPS_DESIGN_BASELINE.md`](21_TPS_DESIGN_BASELINE.md)（ADR-0005，`spec/k3_mc_baseline.json#tpsDesign`）。

当前 Final Tuning 搜索候选的**权威数值**在
[`spec/k3_mc_baseline.json`](spec/k3_mc_baseline.json) 的 `computeDieCandidate` 中，
由 `npm run baseline:sync` 从
[`data/rdma/k3_rdma_final_tuning_results.json`](../../data/rdma/k3_rdma_final_tuning_results.json)
生成，`tests/test_design_baseline.js` 强制两者一致。本文不再手抄数字，避免多处漂移。

| 项目 | 值 | 状态 |
| --- | ---: | --- |
| 工艺/频率 | 面积按三星 SF4 级 4 nm 估算（`computeDieCandidate.physicalBasis`：逻辑 ×1.277、SRAM ×1.248、PHY ×1，矩阵密度 3.2 TF/mm² @N4 口径）；`frequencyGHz` 固定 1.0 GHz，不参与搜索 | `ASSUMPTION`（B-006） |
| 散热/功耗上限 | 液冷（冷板）：Die 300 W、卡 2800 W（`physicalBasis.limits`；原风冷 260 W / 2400 W） | `ASSUMPTION`（O-015） |
| L Core | `computeDieCandidate.lCores`（当前 8，每 Core 8×(1×256) engine） | `MODEL` |
| H Core | `computeDieCandidate.hCores`（当前 4，每 Core 5×(48×128) engine） | `MODEL` |
| BF16 Dense peak | `computeDieCandidate.bf16DenseTflops` | 推导值 |
| Vector peak | `computeDieCandidate.vectorTops` | 推导值 |
| Local SRAM | `lCore/hCore.localSramMiB`（当前 L 1 MiB/Core、H 4 MiB/Core，24 MiB/Die） | `MODEL` |
| Shared SRAM | `sharedSramMiB` / `sharedSramSlices`（当前 16 MiB，16 slices） | `MODEL` |
| 总数据 SRAM | `physicalDataSramMiB`（当前 40 MiB/Die） | 推导值 |
| NoC | 抽象 mesh，`dataNocBytesPerCyclePerDirection` | `MODEL` |
| TMA | `tmaEngines` × `tmaBytesPerCyclePerEngine` | `MODEL` |
| Reduce | `reduceLanes` | `MODEL` |
| 面积 | `computeDieCandidate.estimatedAreaMm2`（含共享 SRAM 端口放大成本） | `MODEL` |
| 功耗 | `computeDieCandidate.estimatedPowerW`（同上） | `MODEL` |
| 卡功耗 | `computeDieCandidate.estimatedCardPowerW` | `MODEL` |

2026-09-23 修正 Final Tuning 模型（端口放大计费、launch 只应用一次）后重新搜索，
最佳候选从 4 L + 4 H、1.2 GHz、44 MiB/Die 移动到 24 L + 8 H、1.0 GHz、88 MiB/Die；
2026-09-25 先切换计数口径（ADR-0004）移动到 8 L + 8 H；随后按 GAIN=1、τ=1.15 μs 的决定重新搜索，
移动到 8 L + 4 H、1.0 GHz、80 MiB/Die（32 MiB local + 48 MiB shared）；加入独立 TMA 通道后，
local SRAM 可提前装载下一块权重，搜索移动到 8 L + 4 H、1.0 GHz、72 MiB/Die（48 MiB local + 24 MiB shared，
weight tile 4 MiB）；再允许 KV 跨层预取和 DMA 抢占后，shared SRAM 的压力变小，搜索移动到
8 L + 4 H、1.0 GHz、48 MiB/Die（32 MiB local + 16 MiB shared，L core 64 bank，weight tile 8 MiB）；
加入注意力/小算子映射、搜索预取深度并细化 H core 网格后，卡功耗预算从 reduce lane 和频率挪给 H core 矩阵单元，
搜索移动到 8 L + 4 H（H core 5×(48×128) engine）、0.8 GHz、reduce 2048 lane、40 MiB/Die
（24 MiB local + 16 MiB shared），H 矩阵算力 196.6 TF/Die（原 131.1），卡功耗 2136 W；
KV cache 改为 FP8 后，H core local SRAM 可放下 32K token 的 KV tile，搜索把 KV tile 提到 32768、
reduce lane 回到 4096（卡功耗 2241 W，die 面积 396.7 mm²），其余不变。
同日决定**算力调整不得改变频率**，频率固定为 1.0 GHz（`EXT.ghz=[1]`，与此前各候选和 P0 一致）。
上面的 0.8 GHz 点放回 1.0 GHz 会超出 die/卡功耗上限，已撤回。重新搜索后移动到 4 L + 5 H
（H core 5×(32×128) engine，H 矩阵 204.8 TF/Die，L 矩阵 16.4 TF/Die）、1.0 GHz、30 MiB/Die
（14 MiB local + 16 MiB shared，H local 2 MiB/core，KV tile 16384）、UCIe 64 lane，
卡功耗 2392 W，die 面积 330.7 mm²（N4 参考系数、风冷上限）。
同日决定 compute die 面积按**三星 SF4 级 4 nm** 估算、矩阵密度取 3.2 TF/mm²（N4 口径 @1 GHz，原 1.6）、
改用**液冷**（Die 300 W、卡 2800 W，原 260 W / 2400 W），见
[`src/search/k3_physical_basis.js`](../../src/search/k3_physical_basis.js)。重新搜索后移动到 8 L + 4 H
（H core 5×(48×128) engine，H 矩阵 245.8 TF/Die，L 矩阵 32.8 TF/Die）、1.0 GHz、40 MiB/Die
（24 MiB local + 16 MiB shared，H local 4 MiB/core，KV tile 32768）、UCIe 128 lane、vector 512 lane，
Die 373.7 mm²（SF4）、286.2 W，卡功耗 2768 W。
02、03、05 号文档的单元级描述仍基于 2026-09-20 的候选，在 P1 候选稳定前只作对照，
不作为当前规格。

其中利用率、面积和功耗系数尚未由 memory compiler、标准单元、PHY 宏和
综合/布线结果回标。自 2026-09-23 起，Final Tuning 对共享 SRAM 读写端口的
放大（`localWriteRatio`、`tmaPortWriteScale`、`sharedReadScale`）按 bank 面积
和端口功耗计入 die/card 限制，不再是无成本的带宽放大。

## 3. 当前性能结论（P1）

| MC 带宽假设 | 权威数值 | 结论 |
| --- | --- | --- |
| 320 GB/s/MC | `modelResults.referenceMc320GBs` | 参考规格兼容点，明显不达标 |
| 640 GB/s/MC | `modelResults.stretchMc640GBs` | Stretch 点（ADR-011 归为 `STRETCH/AGGRESSIVE`）；是否达到 1000 以 `acceptance.currentStatus` 为准，且即使达到也只是模型结果 |

两点的 TPS、raw/e2e 时延、compute/comm/DMA 等待时间、每 token 每卡外部读取
字节和有效 DMA 带宽都记录在上述 JSON 字段中；`README.md`、各子系统文档和
看板引用同一来源。

320 GB/s 点的计算与通信时间与 640 GB/s 点完全相同，差别来自 DMA 等待，以及
等待拖慢 shared 专家和 TMA 预取后可掩盖的时间变少（`tests/test_design_baseline.js` 断言）。自 2026-09-25 起，640 GB/s 点的 raw 中
compute − TMA 掩盖 + τ 下限后的通信 − 重叠已达 818.30 μs，只给 DMA 等待留下约 36 μs；
只提 MC 带宽不能达到目标。

2026-09-25 的两项决定：
- `GAIN` 表中的全部经验缩放因子置为 1（B-003）。表仍逐项保留在
  [`src/rdma/k3_rdma_final_tuning_model.js`](../../src/rdma/k3_rdma_final_tuning_model.js)；
  任何因子离开 1 都必须有比 ASSUMPTION 更好的证据。
- 每次集合通信成本下限取 spec 的 τ = 1.15 μs（`OPT.tauUs`，ADR-0004、B-008）。
  时间账中的 `tauFloor` 是补足到 τ 的时间。
仍生效的非物理推导参数是 `OPT.launchScale` 和共享 SRAM 端口放大（后者已计费）。

计算与通信重叠（`OPT.commOverlap`，2026-09-25）：集合通信在独立的通道上执行，
算子仍按程序顺序发射。B=1 decode 下每次集合通信都在依赖主链上，只有与 routed
路径无数据依赖的 shared 专家（只读 MoE RMSNorm 输出）被排到 Wdown + Router
all-gather 之后、与之并行。于是 raw = compute + comm + wait − overlap，
overlap 上限是 shared 专家的计算时间。

独立 TMA 通道（`OPT.tmaLane`，2026-09-25）：此前每个算子的 shared→local 装载
（`localTma`）串行地算在 compute 内，且不能早于算子本身开始。现在由 DMA 取入
shared SRAM 的输入（权重、routed expert、KV tile、线性注意力 state）对应的装载
单独记为 `tmaFill`，在 L/H 两个域各一条 TMA 通道上按程序顺序提前发射：输入在
shared SRAM 就绪、且该域 local SRAM 双缓冲有空闲一半时即可开始，可与集合通信或
前一个 kernel 并行。通道与 DMA/算子/集合通信共享 shared SRAM 读口和 fabric，与同域
kernel 共享 local 写口；激活装载、写回 flush 和 local 口超额部分仍留在算子内。
于是 raw = compute − tmaHidden + comm + wait − overlap。被掩盖的部分在 routed
expert 和 KV tile 处部分转化为 DMA 等待，由下面两项处理。

KV 跨层预取与 DMA 抢占（2026-09-25，review 第 8 项）：
- `OPT.kvPrefetch='window'`：历史 KV 不依赖当前 token，KV context tile 与权重一样
  可提前到后续 `x.depth` 层取入 shared SRAM，只受容量约束（此前只允许层内）。
- `OPT.dmaPreempt=true`：DMA 按 stripe 切分，Top-k 之后释放的 routed expert
  未命中部分（或下一个算子需要的数据）可暂停正在进行的预取，被暂停的任务保留
  SRAM 预留并按消费顺序恢复。
- 预测预取本身无需提前：预测权重已在 Top-k 之前约 20 μs 取完，瓶颈是未命中的
  20% 被排在数 MB 的 KV 预取之后。预测命中率仍为 0.8（工程假设），未改动。
- 两项需要一起用：只开跨层 KV 预取时，大 KV 块会挡住 expert 未命中取数。
  在发布候选上，两项都关 707.00，只关抢占 767.85，只关跨层 KV 802.94，
  都开 860.03 TPS。

注意力与小算子映射（2026-09-25，review 优化空间）：
- `OPT.pvMerge='layer'`：PV 的 m/l/O 累加器跨 context tile 留在 local SRAM，每个
  (层, head tile) 只在最后一个 context tile 合并一次；跨 Die 由汇聚到单 Die 改为
  按 head 的双向环 reduce-scatter。
- `OPT.softmaxFusion`：online softmax 在 H core 向量单元上按 score 块与 QK 矩阵流水，
  只暴露首块或超出 QK 的部分。
- `OPT.epilogueFusion`：RMSNorm、SiLU×up、加权和、dispatch pack、RoPE、KV append
  并入相邻 kernel：去掉独立的 shared→local 阶段、launch 和 TMA 装载，向量时间与字节照记；
  紧跟集合通信的算子（残差加）不融合，下一个是集合通信时 flush 保留。
- 预取深度 `x.depth`（1–4 层）进入搜索，不再固定为 4；H core 网格加入 nH 5/6、
  hEngines 5/6、hRows 48，局部搜索增加成对相邻步（用于在卡功耗上限处挪预算）。
- 发布点 1007.27 TPS/usr（raw 848.53 µs = compute 550.64 − tmaHidden 142.57 +
  comm 451.95 + wait 21.29 − overlap 32.78），离 854.70 µs 预算只余 6.2 µs。
  在该候选上逐项关闭：pvMerge=tile 919.97，softmax 融合关 975.19，逐元素融合关
  979.98，三项都关 870.60；depth 1 为 955.20，depth 2–4 相同。MC320 为 543.54。
- 这些都是模型内的映射改动，仍需 kernel/RTL 证据（B-003 的精神同样适用）。

FP8 KV cache（2026-09-25，`OPT.kvCache='fp8'`，计算仍为 BF16）：
- 按 FlashMLA（DeepSeek-V3.2）的 FP8 布局存储：512 维 latent 为 FP8 E4M3，每 128
  元素一个 FP32 scale，64 维 RoPE 保持 BF16，每 token 每层 656 B（原 1152 B）。
  KV 的 DMA、shared SRAM 占用、local 装载和后备存储随之缩小；new-KV append 按 FP8 写回。
- QK/PV 仍是 BF16 矩阵乘，latent 在 kernel 内于 H core 向量单元反量化（与权重 unpack
  同速率），与矩阵计算重叠；这部分向量时间从 online softmax 可藏在 QK 下的预算中扣除。
- 发布点 1031.52 TPS/usr（raw 828.59 µs = compute 519.81 − tmaHidden 132.39 +
  comm 451.95 + wait 21.82 − overlap 32.61），离 854.70 µs 预算余 26.1 µs
  （τ 可再高约 0.066 µs 仍达标）。KV 读取 5.36 → 4.97 GB/token，DMA busy 837 → 780 µs。
- 归因：上一候选（KV tile 16K、reduce 2048）只换 FP8 为 1009.41（+2.1）；FP8 把 H local
  的 KV 双缓冲减半，使 32K KV tile 可行（BF16 下该点因 H local tile 不可行），再把卡功耗
  挪回 reduce 4096 得 1031.52。在新候选上：pvMerge=tile 1012.80，softmax 融合关 995.28，
  逐元素融合关 1003.75，depth 1 为 961.77。MC320 为 584.75。
- FP8 KV 是精度口径变更（B-001），需模型侧给出精度评估后才算冻结。
- 上述 1031.52 点使用 0.8 GHz，已按下一节的频率规则撤回。
- 模拟器修正：TMA 通道为后续算子提前装满的 tile 会钉住其输入，当 head 算子需要的 DMA
  装不下时会死锁（大 KV tile + 半窗口时出现）。现在作为最后手段取消最远的已完成装载，
  该算子稍后重新装载（`tmaCancels` 计数；发布点为 0）。

频率固定 1.0 GHz（2026-09-25 决定，算力只按 core/engine 数与形状调整）：
- 发布点 1015.08 TPS/usr（raw 842.01 µs = compute 502.36 − tmaHidden 110.34 +
  comm 453.44 + wait 23.70 − overlap 27.16），离 854.70 µs 预算余 12.7 µs
  （τ 可再高约 0.032 µs 仍达标）。比 0.8 GHz 点少 16.44 TPS。
- 卡功耗仍是约束（2392/2400 W）：搜索用 L core 8→4、UCIe 128→64 lane 换来 5 个
  H core。H 矩阵算力 204.8 TF/Die，高于 0.8 GHz 点的 196.6，但 L 侧 GEMV、TMA 掩盖、
  跨 Die 与卡内通信阶段变慢。LSE merge 的协议时间 1.21 µs 首次超过 τ。
  H local 2 MiB 只放得下 16K 的 KV tile。
- DMA busy 841.6 µs，几乎等于 raw；每颗 MC 的有效带宽被 UCIe 端口（409.6 GB/s）截断。
- 在新候选上逐项回退：pvMerge=tile 909.67，tmaLane 关 915.25，DMA 抢占关 961.00，
  KV 跨层预取关 968.56，commOverlap 关 992.84，逐元素融合关 996.63，softmax 融合关 997.69，
  launchBatching 关 1005.57，端口放大全关 1014.78；depth 1 为 975.78。MC320 为 585.95。
  完整表见 [`21_TPS_DESIGN_BASELINE.md`](21_TPS_DESIGN_BASELINE.md) 第 5 节。
- 上述 1015.08 点按 N4 参考面积与风冷上限计算，已被下一节的物理口径取代。

三星 SF4 面积、矩阵密度 3.2 TF/mm²、液冷（2026-09-25 决定，`src/search/k3_physical_basis.js`）：
- 只换面积口径（SF4、密度仍 1.6）时，1015.08 点的 Die 为 414.5 mm²，超出 400 mm²；
  搜索改为 4 L + 4 H（H 6×(32×128)），1015.06 TPS/usr，Die 399.7 mm²，面积成为绑定约束。
- 再把矩阵密度取 3.2 TF/mm²、上限改为液冷后：发布点 1101.77 TPS/usr（raw 775.75 µs =
  compute 434.62 − tmaHidden 106.91 + comm 451.95 + wait 22.35 − overlap 26.27），
  离 854.70 µs 预算余 78.95 µs（τ 可到约 1.35 µs 仍达标）。
- 收益来自 UCIe 64→128 lane 与 H 算力**同时**增加：UCIe 128 lane 使每颗 MC 不再被端口截断
  （MC 带宽 819→896 GB/s/Die，DMA busy 842→775 µs），此后算力才重新在关键路径上。
  只加算力约 +3 TPS，只加 UCIe 约 +9 TPS。Die 功耗 300 W 以上的放宽几乎没有额外收益。
- 五类集合通信的协议时间都低于 τ，通信 = 393 × 1.15 = 451.95 µs。
- 逐项回退：tmaLane 关 984.20，KV 跨层预取关 991.52，softmax 融合关 1033.22，DMA 抢占关 1041.66，
  commOverlap 关 1073.24，逐元素融合关 1077.23，pvMerge=tile 1082.21，launchBatching 关 1088.47，
  端口放大全关 1101.71；BF16 KV 在 32K tile 下不可行。depth 1 为 1018.96，MC320 为 586.46。
- P1 数值超过 1050 的架构闸门，但闸门要求可制造 MC 路线与详细 tile 模型，仍为未通过。

### 3.1 集合通信计数口径

通信次数按**参考页目标设计的口径**统计（`OPT.countBasis='reference-393'`，
2026-09-25 接受，B-007），总数见 `collectiveCount.total`，逐项见
`collectiveCount.byPhase`。这是**口径对齐，不是性能优化**（ADR-0004）：`Q / new-KV all-gather`（24）与
`Distributed sampling candidates`（1）仍作为本地算子保留在 DAG 中，
`Shared output all-reduce`（92）并入 `Wup + Shared output all-reduce`；合并后的归约排在
shared 专家计算之后，每 rank 先把 Wup 与 Shared down 的部分和本地相加再归约一次。
仓库早先口径为 510 次，可用 `countBasis='repo-510'` 复现。

**次数轴不是当前杠杆**：发布点自 2026-09-25 起使用 spec 的每次集合通信成本
基准（1.15 µs），393 次的解析天花板约 1134.46 TPS（已扣除 shared 专家重叠和 TMA 掩盖，DMA 等待取 0）。
降到 209 次时解析值为 1577.52 TPS，但这是乐观上界：它假设 DMA 等待为 0，并把 TMA
掩盖量按当前观测值固定，而通信越少，可藏在通信下的装载越少。对照表见
`spec/k3_mc_baseline.json#tauBasis.ceilingTpsByCount`。

## 4. 必须纠正的口径

### 4.1 SRAM 峰值不是每 Die

模拟器中的 283.45 MiB 峰值和 326.40 MiB window 是**整卡 8 个 Die 的
Shared SRAM 聚合工作窗口**：

- Shared SRAM 物理容量：8×16=128 MiB/卡；
- usable 0.85，再乘 window fraction（当前候选为 1.0）：108.8 MiB/卡；
- 模拟峰值：72.24 MiB/卡；
- Local SRAM 14 MiB/Die 由 tile-fit 约束单独检查。

因此旧报告中的“122.2 MiB/Die”（2026-09-23 候选的整卡峰值）是标签错误，不应据此把单 Die SRAM 扩到
122 MiB；当前的 72.24 MiB 同样是整卡值。

### 4.2 “MC”存在两条不同路线

1. **本轮主线：外置 Memory Cube。** MC 只负责存储和传输，计算在
   Compute Die；对应当前 Final Tuning 模型。
2. **备选：近存计算 MC。** MC base die 内有 GEMM/vector；对应
   近存计算 MC 备选路线（另行维护，不纳入本仓库基线）。

两条路线的 MC 数量、带宽定义、功耗和数据流不同，后续文档不得混用。

## 5. 当前资料中的主要冲突

| 冲突 | 当前处理 |
| --- | --- |
| P0 为 8 L + 8 H Core、1.0 GHz；P1 由搜索决定（当前 4 L + 5 H、1.0 GHz 固定） | 不是冲突，是两个 profile（ADR-004）；P0 是物理主规划，P1 是当前可执行回归模型；报告必须注明 profile |
| P0 Compute Die 为 400 mm² 上限；P1 估算见第 2 节 | 400 mm² 是 P0 规划上限，P1 数字只用于回归对照 |
| 卡内互联有“4×2 mesh”“双向 ring”“4+4 hierarchy”三种描述 | `BLOCKER`，统一拓扑后才可冻结 |
| 参考 MC 320 GB/s；默认搜索上限 480 GB/s；P1 最佳搜索使用 640 GB/s | `BLOCKER`，档位定义见 ADR-011，必须选定可制造档 |
| NoC 的 512 B/cycle 是分析参数，尚无可布线证明 | `OPEN`，需物理和拥塞模型 |
| Final Tuning 中大量优化使用经验缩放因子 | 2026-09-25 起 `GAIN` 全部为 1，不再计入经验收益；共享 SRAM 端口放大已计入面积/功耗；任何收益须由事件和资源模型给出（B-003） |
| Attention 投影参数由 residual 拟合，不是精确 Q/K/V 图 | `BLOCKER`，需模型清单和编译 trace |
| 正式 manifest 曾与 `design_engine` preset 描述不同的 K3 | 已修正：K3 唯一来源是 `src/core/design_engine.js#MODEL_PRESETS.kimiK3`，`tests/test_k3_manifest_consistency.js` 强制一致 |

## 6. 当前可以保留的设计方向

- 异构 L/H Core，分别覆盖低复用 GEMV/Skinny GEMM 和高复用
  Attention/GEMM；
- Local SRAM + Shared SRAM 分层，TMA 与计算流水重叠；
- 8 Die/卡，2 MC/Die，NUMA 本地优先；
- 远端 SRAM 可寻址、commit/ready/ACK/epoch 生命周期；
- LSE 使用 m/l/O 语义归约，不作为普通 FP32 sum；
- 以 tile 为抢占、同步和性能核算单位；
- Decode 小消息与 Prefill 大流量采用独立 QoS/VC。

这些是可继续深化的架构方向，但还不是已签核实现。
