# 未决问题与阻塞项

## P0 阻塞项

| ID | 问题 | 影响 | 关闭证据 |
| --- | --- | --- | --- |
| B-001 | 正式 K3 逐层结构和 dtype 未冻结；2026-09-25 发布点采用 FP8 KV cache（FlashMLA 布局，计算仍为 BF16，`OPT.kvCache`），精度影响未评估 | FLOP/byte、算子图和容量可能变化 | 模型清单与权重 manifest |
| B-002 | MC 档位未选定：320 参考、480 默认上限、560/640 激进（ADR-011）；P1 目标点使用 640 GB/s | 320 与 640 两点 TPS 见 `00_CURRENT_STATE.md` 第 3 节 | 选定颗数与每颗带宽的供应商规格或替代架构 |
| B-003 | Final Tuning 的经验缩放因子：2026-09-25 决定全部置 1（`GAIN` 表保留名称）；共享 SRAM 端口放大已计入面积/功耗；`OPT.launchScale` 仍是未回标参数 | 置 1 后发布点从 990.13 降到 681.06 TPS（同时含 τ 变更；之后加入 shared 专家计算通信重叠并补种子搜索后为 729.14，再加入独立 TMA 通道后为 774.77，再加入 KV 跨层预取和 DMA 抢占后为 860.03，再加入 PV 按层合并、softmax/逐元素融合并搜索预取深度与 H core 规格后为 1007.27，再改 FP8 KV cache 后为 1031.52）；已实现的优化收益目前未计入 | 逐项用精确 tile/transaction 模型给出收益后，才允许对应因子离开 1 |
| B-004 | 卡内 topology 口径冲突 | 带宽、hop、封装无法签核 | 统一拓扑与 packet 模型 |
| B-005 | TP32 scale-out 物理拓扑未定义 | 800 GB/s 和低时延不可实现性未知 | PHY/拓扑/布线/功耗方案 |
| B-006 | P1 的 1.0 GHz、面积、功耗（见 `00_CURRENT_STATE.md` 第 2 节）和 P0 的 1.0 GHz 候选均未回标 | PPA 可能不收敛 | synthesis/floorplan/IP macro |
| B-007 | reference-393 口径：2026-09-25 决定接受。合并后的 `Wup + Shared output all-reduce` 已移到 shared 专家计算之后（此前排在之前，shared 部分和未被归约）；`Q / new-KV all-gather` 按参考页作本地算子 | 已接受；若供应商结构说明否定 shared 与 Wup 输出同宽相加，须回退 `repo-510` | 供应商 shared 专家结构说明或权重 manifest 的输出张量宽度（确认性，不阻塞） |
| B-008 | τ 口径：2026-09-25 决定发布点每次集合通信下限取 spec 的 1.15 μs（`OPT.tauUs`）；1.15 μs 本身尚无物理推导 | 通信 451.95 μs（393 × 1.15），占 raw 预算的 53%；393 次的天花板约 1059.42 TPS（含 shared 专家重叠和 TMA 掩盖，假设 DMA 等待为 0）；发布点 1031.52 离预算余 26.1 μs，τ 若高于 1.15 μs 约 0.066 μs 即跌破 1000 | 由 B-004/B-005 给出 τ 的物理推导并回标（ADR-0004） |

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
| O-015 | 2400 W 是否包含 optics/VRM/host I/O | Package/Power |

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
