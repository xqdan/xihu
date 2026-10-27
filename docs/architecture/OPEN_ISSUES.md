# 未决问题与阻塞项

## P0 阻塞项

| ID | 问题 | 影响 | 关闭证据 |
| --- | --- | --- | --- |
| B-001 | 正式 K3 逐层结构和 dtype 未冻结；2026-09-25 发布点采用 FP8 KV cache（FlashMLA 布局，计算仍为 BF16，`OPT.kvCache`），精度影响未评估 | FLOP/byte、算子图和容量可能变化 | 模型清单与权重 manifest |
| B-002 | MC 档位未选定：320 参考、480 默认上限、560/640 激进（ADR-0019）；发布点使用 1152 GB/s（MC640 槽位，HBM3E，引脚速率换算，非供应商数据；原 640，ADR-0026） | 320 与 MC640 槽位两点 TPS 见 `00_CURRENT_STATE.md` 第 3 节 | 选定颗数与每颗带宽的供应商规格或替代架构 |
| B-003 | Final Tuning 的经验缩放因子：2026-09-25 决定全部置 1（`GAIN` 表保留名称）；共享 SRAM 端口放大已计入面积/功耗；`OPT.launchScale` 仍是未回标参数 | 发布点 1043.96 TPS/usr 不含任何经验收益；各机制的收益来自事件/资源模型本身，逐项回退见 `21_TPS_DESIGN_BASELINE.md` 第 5 节 | 逐项用精确 tile/transaction 模型给出收益后，才允许对应因子离开 1 |
| B-004 | 卡内 topology 未定（双向环 / 4×2 mesh / 4+4 hierarchy）；2026-10-10 起模型统一按 8 Die 双向环计算（`A.dieRing`，ADR-0016，`ASSUMPTION`）：切面 2 条链路，集合通信卡内阶段 8 跳，逐 tile gather 4 跳，DMA 启动平均 2 跳 | 封装、packet 级时延无法签核；发布点不变（当时为 1101.77；ADR-0026 之后是 1124.70，ADR-0028 之后是 1043.96），卡内阶段从 6 跳改为 8 跳后 cardLocal 74.71 → 94.36 µs、tauFloor 183.00 → 163.35 µs（均为 2026-10-10 当时的值；ADR-0026 之后 cardLocal 94.56、tauFloor 163.01），τ 推导与 Comm Core 的余量变小（见 B-005、O-018）；mesh 切面加倍，相对环是乐观方向 | 硬件评审选定拓扑并给出 packet 模型；改 `dieRing` 一处后重新生成 |
| B-005 | TP32 scale-out 物理拓扑未定义 | 800 GB/s 和低时延不可实现性未知；2026-10-10 链路级 τ 推导（HW-CH-01，自选 5 个候选，延迟全为 `ASSUMPTION`）：名义参数下只有直连全互联（31 × 4 lane）按现 ACK 口径达标（1067.40 TPS/usr，卡内按 8 Die 环计），单层 rail 交换须把 ACK 推迟到 epoch 槽回收且交换 ≤ 0.251 µs（1018.39；τ 取规格下限时 982.59，低于 1000），leaf-spine、4×8 torus、环均不达标（`out/detailed/tau_derivation.json`） | PHY/拓扑/布线/功耗方案；硬件团队评审或替换 `teams/hardware/inputs/scaleout_topology_candidates.json` 的候选与延迟 |
| B-006 | 1.0 GHz（固定）、面积、功耗（见 `00_CURRENT_STATE.md` 第 2 节）均未回标；面积按三星 SF4 级 4 nm 由公开节点数据缩放（逻辑 ×1.277 按 CPP×MMP，SRAM ×1.248 按 HD bitcell，PHY ×1；SF4/SF4X 节距未公开，取 SF4E），矩阵密度取 3.2 TF/mm²（N4 口径 @1 GHz，原 1.6），均为 `ASSUMPTION`（`integration/detailed/k3_physical_basis.js`） | PPA 可能不收敛；发布点 Die 372.53 mm²（ADR-0028 之后），逻辑系数若按 CPP×MMP 偏乐观、矩阵密度若只有 2.5 TF/mm² 以下，面积可能超 400 mm² | synthesis/floorplan/IP macro；三星 SF4 PDK 的 SRAM compiler 与 MAC 阵列宏 |
| B-008 | τ 口径：2026-09-25 决定发布点每次集合通信下限取 spec 的 1.15 μs（`OPT.tauUs`）；1.15 μs 本身尚无物理推导 | 通信 451.95 μs（393 × 1.15，五类协议时间均低于 τ），占 raw 818.71 的 55%；393 次的天花板约 1059.44 TPS（`tauBasis.ceilingTpsByCount`，含 shared 专家重叠和 TMA 掩盖，假设 DMA 等待为 0）；发布点 1043.96 离预算余 35.99 μs，τ 可到 1.24 μs（每次余 0.092 μs）仍达标；规划链路每个槽位给出 τ = 1.15 / 1.5 / 2.0 μs 三列（ADR-0008），TP32/MC640 的 K3 在 1.5 μs 下为 905、2.0 μs 下为 749，GLM-5.2 与 DeepSeek-V4-Pro 在 2.0 μs 下为 1180 / 1206；正式候选是 τ 条件候选（规划模型下 K3 须 τ ≤ 约 1.27 μs，详细模型为 1.24 μs），入选只看点估计 | 由 B-004/B-005 给出 τ 的物理推导并回标（ADR-0004）；控制路径一项由 Comm Core 周期模型给出（O-018）。2026-10-10 已有推导框架（HW-CH-01，`npm run tau:derivation`）：τ = 链路级 memoryTransport + tpReduce + cardLocal + portTail + 控制路径；模型的 `oneWayUs = 0.05 µs` 在任何候选上都达不到（直连最近一跳名义 0.115 µs），抽象线上的单程预算为 0.220 µs；拓扑与延迟仍是 `ASSUMPTION`，未改 `OPT.tauUs` |

## 已接受 / 已关闭（保留编号，不再是阻塞项）

| ID | 问题 | 影响 | 关闭证据 |
| --- | --- | --- | --- |
| B-007 | reference-393 口径：2026-09-25 决定接受。合并后的 `Wup + Shared output all-reduce` 已移到 shared 专家计算之后（此前排在之前，shared 部分和未被归约）；`Q / new-KV all-gather` 按参考页作本地算子 | 已接受；若供应商结构说明否定 shared 与 Wup 输出同宽相加，须回退 `repo-510` | 供应商 shared 专家结构说明或权重 manifest 的输出张量宽度（确认性，不阻塞） |
| B-009 | 2026-09-25 关闭：GLM-5.2 形状改取公开 HF `config.json`（ADR-0007），含 MTP 总参数 753.3B 对公布 753B；剩余部署布局（FP8 KV 656 B、索引键 132 B、每层集合通信 full 4 / shared 3）为 `ASSUMPTION`，无 EP 已由 ADR-0020 定为部署决定，并入 O-016 | 已关闭；6 个观测槽位有规划 TPS，D-Gate 的 `threeModelComparable` 成立 | 部署布局的确认性证据（不阻塞） |
| O-021 | 2026-10-24 关闭。方向打分卡的形态表里有按 4 / 6 颗 compute die 记账的行，与 ADR-0021 的"唯一硬件规格 = 8 Die + 16 MC"冲突，且这些行曾出现在 `satisfiesEveryEntry` 与 Pareto 前沿里。**诊断最初来自一次真实 `design.arch.direction` 运行（2026-10-23）的 invariant-checker，但它的描述有一处错**：它把 `packageAreaMm2` 3370.07 读成"16 × 100 + 6 × 295.01"，实际是 `6 × 361.68 + 12 × 100`（cube 数 = dies × 2，也随 die 数变），该行面积/功耗算术本身自洽。真正的缺陷是别的：6 die 是**第二份规格**，而拓扑只按 8 Die 环建模（B-004），它却能赢得"满足全部合同条目" | 形态表按 die 数的探索本身保留（"差多少"需要数字），但非 8-Die 行新增 `specConformance.singleHardwareSpec=false`，被排除出 `satisfiesEveryEntry` / `meetsTarget` / `meetsArchitectureGate` / Pareto，并在 `outsideSpec` 里具名列出；`candidateCount` 25、`conformingCount` 23 | `morphology.js#evaluate`、`stage_a.js`、`directional_tps_scorecard.json#morphology` |
| O-022 | 2026-10-24 关闭。`directional_resource_envelope.json` 没有 provenance 块，E0/E1 标签与全部 package/bandwidth 数值无法归属到 commit 或 seed | 已补 `provenance`（`sourceCommit` / `manifestHash` / `seed` / `runId` / `units`），与另外两份 Stage A 产物同块 | `out/direction/directional_resource_envelope.json#provenance` |
| O-023 | 2026-10-24 关闭。`bandwidthEnvelope.*.payloadTBs` 装的是 raw 值（18.432 = 16 × 1152）却与 `sustainedAssumption: 0.7` 并列，读者会把它当 sustained；`mcStretchGBsPerCube` 的 "Stretch" 在 ADR-0027 之后过时。真实运行的 invariant-checker 正是据此误判"memory lane 未乘 0.7"（实测乘了：12.9024 TB/s） | 改名并同时输出两侧：`rawPayloadTBs` / `sustainedTBs` / `effectiveBytesPerSecond`；`mcStretchGBsPerCube` → `mcBindingGBsPerCube`、`mcBaselineGBsPerCube` → `mcReferenceGBsPerCube` 等。**这是命名缺陷，不是计算错误**——但它足以让一个检查器报出"模型算错" | `directional_envelope.js#bandwidthOf`、`bandwidthEnvelope`、`packageEnvelope` |

## P1 关键问题

| ID | 问题 | 责任文档 |
| --- | --- | --- |
| O-001 | 320 GB/s 是峰值还是持续 payload | Memory MC |
| O-002 | 16 GB 8Hi 的功耗与热降额 | Memory MC / Package |
| O-003 | 4096-bit NoC link 是否可布线 | NoC |
| O-004 | Control NoC 位宽与拓扑 | NoC |
| O-005 | L/H Tensor 逻辑阵列如何拆成物理子阵列 | AI Core |
| O-006 | Vector SFU、reduction、RF 容量 | AI Core |
| O-007 | TMA 独立端口是否真实可实现 | TMA/SRAM |
| O-008 | Shared SRAM bank class 比例 | TMA/SRAM |
| O-009 | partial-ready 阈值的正确性 | Collective/Simulation |
| O-010 | mailbox epoch 位宽与 timeout | Collective |
| O-011 | Decode/Prefill 是否同卡共部署 | System/Scheduler |
| O-012 | Dense/Attention/Shared 权重能否用 FP8 | Workload/AI Core |
| O-013 | 1M KV/state 的正式布局和精度 | Workload/Memory |
| O-014 | LM Head 的精度和分片 | Workload/AI Core |
| O-016 | 规划 token 时间的标定系数（kMemory、expertReread、kFlop、fixedPerLayerUs、kTmaExposedUsPerGB，ADR-0008）只在 K3 一个详细点上标定：expertReread 0.20 取自详细模型的输入值（专家预测准确率 0.8），不是测量值，每个槽位另给准确率 0.7 / 0.9 两列；kFlop 未覆盖 INDEXER 核类，DeepSeek-V4-Pro 的 indexer 计算属外推；每层固定开销扣除了 K3 特有的 shared 专家通信重叠；K3 在 MC320 的样本外核对为 0.94，访存受限槽位的数值可能偏保守约 6%；DeepSeek-V4-Pro 的 MLA/indexer 维度、dense 层数、词表、FP4 专家字节数、每层 5 次集合通信（含 q all-gather，ADR-0024）均为 `ASSUMPTION`；expert hidden 按 49B 激活反解（3840.8，隐含总参数为公布 1.6T 的 1.16 倍）与按 1.6T 反解（3299.8）两解并列，TPS 以区间给出；GLM-5.2 的 KV/索引键字节与每层集合通信次数同为 `ASSUMPTION`（ADR-0006、ADR-0007）；FFN/MoE 的 TP-only 映射已是部署决定（ADR-0020），不再是假设 | Workload/Modeling |
| O-015 | 卡功耗上限是否包含 optics/VRM/host I/O；2026-09-25 起按液冷（冷板）取 Die 300 W、卡 3200 W（原风冷 2400 W；ADR-0005 取 2800 W，ADR-0026 为 16 栈 HBM3E 提到 3200 W，没有对应的散热证据），冷板、VRM 与供电方案尚未建模 | Package/Power |
| O-017 | GLM-5.2 / DeepSeek-V4-Pro 的 router 字节按 TP 切分计入，但每层集合通信次数里没有 router 输出的 gather：若 router 复制到每个 rank，每 token 字节 GLM 约 +0.24 GB（+17%）、DS 约 +0.32 GB（+23%）；若保持切分，每个 MoE 层多 1 次集合通信（K3 的 Wdown+Router AG 口径）。另：稀疏注意力 top-2048 在 TP32 上按 context 切分，平均每 rank 64 个 token、最坏 2048 个，负载不均未计入（`teams/software/docs/MULTI_MODEL_LOWERING.md` 第 5 节） | Workload/Software |
| O-018 | Comm Core 微架构与控制路径回标：设计空间（`teams/hardware/inputs/comm_core_design_space.json`）里的 cycle 数、面积和 Control NoC 跳数都是 ASSUMPTION，需由 RTL 或周期模型给出；当前搜索选出的方案控制路径 0.042 µs/次，raw 预算内上限 0.620 µs/次，最慢的 LSE merge 加控制路径 1.07 µs（卡内按 8 Die 环计，B-004），仍低于 spec τ；回标后改设计空间并重新搜索（`descriptorExpand`、`sharedSram` 只差 2–8 ns 余量，可能翻转），并入 τ 的物理推导（B-008；2026-10-10 已接入 HW-CH-01 的 `tau_derivation.json`，控制路径翻倍时直连全互联名义点 1067.40 → 1011.78 TPS/usr，不是决定项）；内存语义的全局地址位宽、NIC 是否支持"收齐后原子加"（否则最慢一类超 spec τ 0.024 µs）待定（ADR-0022，`out/detailed/comm_core_design.json`） | Comm Core |
| O-019 | GLM-5.2 / DeepSeek-V4-Pro 规划数字的未建模项与待签核假设：每层 5 次集合通信含 q all-gather（ADR-0024，`PROPOSED`），口径比 K3 的 reference-393 保守；L 核上 TP-only 专家切片的 tile 填充、专家未命中取数在关键路径上的暴露未建模（21 号文档 §6.3）；18 个槽位里 16 个没有详细模型旁证 | Model/Software/Workload |
| O-020 | 发布点（当前 1043.96 TPS/usr）对未测量的计算参数没有余量：矩阵/向量利用率、unpack 速率、布局不均衡同时取悲观值时降到 837.08（再加 mcUtil、预测准确率、launch 缩放为 825.28），低于 1000（21 号文档 §6.1.1）。**已于 2026-10-23 修正：`JOINT_PESSIMISTIC.kvTile` 由 16384 改为 32768。** 16384 当时就是发布值，不构成悲观项；只有更大的 tile 在两个轴上都更差。发布点随之由（当时）1124.70 移到 **1138.48**，联合悲观点由 947.09 / 935.44 变为 **941.51 / 926.52**，仍然是「对未测量的计算参数没有余量」。旧定义实测：`kvTile` 取 16384（即发布值）时 compute 点回放 1025.77，取 8192 或 4096 只会更松——它把「与发布点同值」当成了悲观端。**追记（2026-10-26，ADR-0028）：核定义改为 L 1×512×8 / H 128×256×1 后，发布点 1138.48 → 1043.96，联合悲观点 941.51 / 926.52 → 837.08 / 825.28，缺口由 58.5 扩大到 174.7 TPS/usr；下文的杠杆数字（958.41、946.64、152.1 W 等）是 ADR-0028 之前的值，现值见 21 号文档 §6.5（941.54 / 926.62，卡功耗余量 131.2 W → 98.9 W，提案缺口 −79.3 mm²）。**三项探索研究给出各自的杠杆，**都不是基线**：(1) Die 面积/功耗再分配（§6.5，`out/detailed/die_area_reallocation.json`）：`vectorLanes` 512→1024 配合 `reduceLanes` 2048→3072、`lBanks` 64→32，名义 1148.40、悲观点 958.41、留出点 946.64，代价是卡功耗余量 152.1 W → 92.7 W、Die 功耗余量 0.1 W；**该提案 Die 379.7 mm² 在观测 keep-out 0.1254 下装不下窗口（−47.9 mm²），研究沿用不扣 keep-out 的判定，所以 958.41 只是上界**，需向量单元与功耗模型负责人签核；(2) FP8 稠密条件路线（`04_MEMORY_SUBSYSTEM_MC.md` §5.1.4）：MC400 即可达 1080.89 TPS/usr，依赖 B-001 / O-012 的精度签核；(3) Batch=1 + MTP 验证（§6.4，`out/detailed/mtp_exploration.json`）：BF16 在 MC640 槽位（1152 GB/s）以外需要 0.25–0.8 的每 token 接受率才能达标，接受率与专家路由相关性均未测量。**追记（2026-10-27，`3475d83`，耦合网格）：** 在 ADR-0028 的 `hRows=128` 钉住后，计算侧联合赢家换成 `vectorLanes=384|inlineDequant|sfu`（Domain 单独回放 1015.34）。五个 domain 赢家**同时**成立时不达标：composed 点 982.89，Die 327.42 mm² / 274.45 W，卡 2903.72 W，唯一违例 `belowContractTarget`。可行点改由 `tauOverlapCompute` 耦合给出：`vectorLanes` 640 + `commOverlap`（相对赢家只动 `vectorLanes`），联合点 **1001.74**（raw 853.22 µs），Die **333.89 mm²**（裸 Die 328.39 + 矩阵/向量过度设计 3.92 / 1.47 + Comm Core 0.10）、Die 功耗 **278.45 W**、卡 **2935.66 W**、封装余量 **318.76 mm²**、shoreline 24.21 / 预算 50.74 mm；B-TAU 的最慢类 LSE merge 1.092 µs 仍低于 1.15。它只比 1000 高 1.74 TPS/usr，且赢家的 kernel 在 DeepSeek-V4-Pro 的 DSA indexer 上靠 `minLanesPerCore` 373.3 才藏住向量工作——**这不是余量，是贴着合同线的可行点**（`out/detailed/coupling_design.json`，`out/detailed/coupling_candidates.json`） | Hardware/Software/Model |
| O-024 | H 核 64T（`128×256×1`）的 prefill 侧用途没有被建模。用户 2026-10-26 决定保留该定义（ADR-0028 决策 7），依据是 H 核同时服务 prefill 与 decode；但模型只建 decode B=1，那里 `headTile ≤ 96` 使第 97–128 行填不满（填充率 0.75，约 16T 不可达，`hRows` 128→96 的 TPS 变化为 0.0 却省 26.2 mm² / 31.5 W）。缺：(1) prefill 在 H 核上的填充率与时间；(2) prefill 与 decode 并行时对 shared SRAM、NoC、Die 功耗的争用；(3) 这 26.2 mm² / 31.5 W 在 prefill 侧换回多少。在此之前，保留 64T 的代价（封装余量 9.62 mm² 对 96 行的 218.90 mm²）是为一个未验证的用途付的。与 O-011 相关 | AI Core / System Scheduler |


## P2 风险项

| ID | 风险 | 缓解 |
| --- | --- | --- |
| R-001 | MC 供应商无法提供所需带宽 | 同时评估字节压缩和近存 MC |
| R-002 | NoC 宽度导致面积/功耗失控 | 多平面窄链路和专用 collective path |
| R-003 | P99 collective 被重放/拥塞放大 | 专用 VC、拓扑感知、硬件 epoch |
| R-004 | SRAM window 余量过小 | 减少 overlap、增加 shared、优化生命周期 |
| R-005 | TP32 最慢卡和热降频拖慢全组 | gang telemetry、温度均衡、设计余量 |
| R-006 | 模型结构变化翻转瓶颈 | 生成式 layer manifest 和自动回归 |

## 关闭纪律

- 每个问题必须有 owner、目标日期、证据链接和决策记录；
- 口头确认不能关闭 `BLOCKER`；
- 模型参数变化必须触发完整回归；
- 任何超过 2% TPS、5% 功耗或 5% 面积的变化进入变更评审。
