# 流片后与 Bring-up 计划

- 所有者：Hardware（bring-up）；共签：V&V（实测证据）、Software（固件）
- 状态：**框架**——无硅、无测试板。本文定义"拿到硅之后怎么把模型变成测量"
- 权威来源：[`VV_PLAN.md`](VV_PLAN.md) §1（`SILICON_OBSERVED`）、
  `HARDWARE_12_CLOCK_RESET_POWER.md` §3（复位顺序）、`HARDWARE_13_DFT.md` §3（可枚举）

## 0. 本文的目的

`VV_PLAN.md` §1 的证据阶梯顶端是 `SILICON_OBSERVED`。本文定义从硅到该等级的路径，
**以及每一步失败时的判定分类**——因为 bring-up 的价值不在于"点亮"，
而在于**尽快把"硅与模型不一致"定位到具体单元**。

发布点 1101.77 是 `MODEL` 等级，联合悲观点 906.51。硅上结果落到哪个区间，
决定的是"哪一类假设错了"，而不是"项目成功/失败"。

## 1. 阶段划分

| 阶段 | 目标 | 通过判据 | 依赖 |
| --- | --- | --- | --- |
| S0 上电 | 管理域 + JTAG 枚举 | 全部 8 Die + 16 MC 可枚举（`HARDWARE_13_DFT.md` §3-4） | 测试板、DFT |
| S1 主域 | PLL 锁定、主域复位释放 | 按 `HARDWARE_12_CLOCK_RESET_POWER.md` §3 顺序完成 | 固件 |
| S2 PHY | MC 训练、UCIe link、环拓扑发现 | 环上 8 Die 可互访；本地 MC 可读写 | PHY IP |
| S3 单 Die 功能 | 单 Die 跑通一个 tile | `TILE_IR.md` 的执行语义成立 | 编译器/toolchain |
| S4 单卡 | 8 Die + 16 MC 跑一次 decode step | 输出与模型预期一致（数值可比） | S3 |
| S5 多卡 | 32 卡 TP32 | 393 次集合通信语义正确 | scale-out |
| S6 性能 | 逐 kernel 计时 | 见 §3 | PMU |

## 2. 实测必须回标的量

**这一节是本文的核心**：bring-up 不是"确认能跑"，而是产出
`DESIGN_EVIDENCE_MATRIX.md` §2 那 12 类的实测值。

| 优先级 | 回标量 | 测量方法 | 归口 |
| ---: | --- | --- | --- |
| 1 | `mcUtil` | PMU 长时间稳态带宽 | HW-04 |
| 2 | τ（每次集合通信） | PMU 时间戳，393 次分类统计 | Comm Core |
| 3 | MC 实际带宽 | 同上 | Memory MC |
| 4 | 软件机制 10 项 | 逐机制 on/off 对比 | SW-01/02/03 |
| 5 | `launchScale` | 空批/满批发射对比 | SW-01 |
| 6 | 专家预测命中率 | 路由统计（片上） | SW-06 |
| 7 | `layoutImbalance` / 利用率 | PMU 计数器 | HW-02/HW-03 |
| 8 | 功耗（Die/卡） | 板级测量 + 片上 counters | Package/Power |

**顺序不可颠倒**：1–3 决定发布点能否成立，4–6 决定 `ASSUMPTION` 能否关闭，
7–8 决定余量是否真实。

## 3. 性能实测与模型的比对

**比对的对象是逐 kernel 的时长，不是总 TPS。**

| 比对 | 做法 | 差异分类 |
| --- | --- | --- |
| K1–K8 逐 kernel | PMU 实测 vs `KERNEL_SPEC.md` 时长 | 单元级（哪一类 kernel 偏了） |
| 时间账分量 | 实测 vs 21 号文档 §3 的时间账（kernel 224.84 / tmaFill 134.77 / memoryTransport 192.37 / tauFloor 183.00 …） | 类别级（计算 / 访存 / 通信 / 发射） |
| 集合通信 | 393 次分类计数（五类协议） | 协议级 |
| 总 TPS | 由以上推出 | — |

**为什么必须逐 kernel**：总 TPS 相符可能由多种偏差相互抵消构成，
它无法告诉你是 `matrixUtil` 偏高还是 τ 偏低。逐 kernel 比对才是回标的数据源。

## 4. 失败分类（bring-up 的真正用途）

| 现象 | 可能原因 | 处置 |
| --- | --- | --- |
| S0/S1 失败 | DFT 模式或复位顺序问题 | 修固件/DFT，**不改设计判据** |
| S2 失败 | link 训练、拓扑发现（B-004） | 关闭拓扑冲突（O-003/O-004） |
| S3 数值不符 | 精度或 tile 语义 | 走 `VV_PRECISION_SIGNOFF.md` / Tile IR |
| S4/S5 集合通信错 | partial-ready 阈值（O-009）/ epoch（O-010） | 回到 `07_COLLECTIVE_RDMA.md` |
| 总 TPS 落在 1000–1101 | 某项 `ASSUMPTION` 偏乐观 | 定位到 §2 的某一项，回标 |
| 总 TPS < 1000 | 联合悲观点成真或更差 | 启动 O-020 的杠杆，或接受降级目标（ADR） |

## 5. 未闭合项

| 项 | 状态 |
| --- | --- |
| 测试板与 bring-up 环境 | 不存在 |
| 硅 | 不存在 |
| PMU 计数定义 | 见 `08_ON_DIE_SCHEDULER_AND_PMU.md` |
| 固件启动流程 | 见 `COMPILER_RUNTIME_AND_FIRMWARE.md` |
| 本文全部阶段 | 未开始 |
