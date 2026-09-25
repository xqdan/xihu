# K3 7-Reticle Agent 量化指标与验收矩阵

版本：2026-09-21（2026-09-26 按 ADR-0021 修订为单一硬件规格）
状态：`BASELINE / METRICS READY`

本文件把 `AGENT_WORKSTREAM_PLAN.md` 中的 A0–A13 进一步拆成可度量的模块指标、交付物和退出条件。所有性能数字必须同时标注证据等级、模型版本、输入 workload、单位和证据来源。

## 1. 统一口径

### 1.1 硬件规格

硬件规格只有一份 P1（ADR-0021），权威值在 `teams/hardware/inputs/k3_mc_baseline.json`（`computeDieCandidate`、`package`、`card`），
由 Final Tuning 搜索经 `npm run baseline:sync` 写入：8 L + 4 H/Die，1.0 GHz，40 MiB 数据 SRAM/Die，373.71 mm²/Die（SF4），
设计说明见 `docs/architecture/21_TPS_DESIGN_BASELINE.md`。详细 tile、transaction 和 PPA 模型完成前，性能结论必须标为
`MODEL / NOT SILICON-PROVEN`。

### 1.2 固定系统边界

| 项目 | 当前值 |
|---|---:|
| Reticle 数量 | 7 |
| Reticle placement window | 82 × 64 mm = 5,248 mm² |
| Compute Die | 8 × 373.71 mm² = 2,989.71 mm²（单 Die 上限 400 mm²） |
| Memory Cube | 16 × 100 mm²规划面积 = 1,600 mm² |
| 裸 Die 总面积 | 4,589.71 mm²（window 余 658.29 mm²，推导值） |
| Data SRAM | 40 MiB/Die，320 MiB/package |
| MC 容量 | 16 GB/MC primary，256 GB/package |
| MC payload | 320 GB/s/MC baseline，640 GB/s/MC stretch（发布点） |
| Package MC raw payload | 5.12 TB/s baseline，10.24 TB/s stretch |
| 功耗 | Die 286.2 W（上限 300 W），卡 2,768.5 W（上限 2,800 W）；液冷，ASSUMPTION（O-015） |
| Scale-out payload target | 800 GB/s/package |
| workload | K3 Decode，B=1，Context=1M，TP32，PP=1 |
| 性能目标 | 1,000 TPS/usr |
| 架构冻结门槛 | ≥1,050 TPS/usr |
| raw latency budget | ≤854.70 µs/token |

### 1.3 指标状态

- `FROZEN`：来自当前架构基线，修改必须有 ADR。
- `TARGET`：本阶段必须达到的验收目标。
- `STRETCH`：用于优化方向，不是当前签核门槛。
- `MODEL`：需要模拟、测量或供应商数据校准。
- `OPEN`：必须在 G4 前收敛，否则保留为 blocker。

## 2. A0：Architecture Integrator / Chief Architect

### 负责范围

公共架构状态、ADR、schema 版本、blocker、集成报告和最终签核。

### 量化交付

| 指标 | 目标 / 验收 |
|---|---|
| 公共契约覆盖率 | 100%；Tile IR、地址、layout、epoch、NoC packet、MC transaction、RDMA transaction、PMU 至少各有一个版本号 |
| 需求追踪覆盖率 | G4 前 ≥95% 需求有文档、模型、测试和证据；最终签核达到100% |
| 公共文件 ownership | 关键公共文件每个只能有1个active owner；并发修改冲突为0 |
| ADR完整性 | 每个改变拓扑、容量、带宽、位宽或状态机的PR必须关联ADR，覆盖率100% |
| blocker管理 | 每个BLOCKER包含owner、下一步、证据类型和预计关闭门；无无主blocker |
| 单一规格 | CI检查`singleHardwareSpec`通过率100%；资源只取自spec文件 |
| 集成回归 | 每次合并必须通过`npm test`；主线不得保留未解释失败 |

### 退出条件

- `WORKSTREAM_REGISTER.md`、需求编号规则、硬件规格 schema、公共单位规则已发布；
- A1–A13 每个workstream都有 owner、分支、依赖、交付物和验收标准；
- G4 签核报告包含假设、模型版本、seed、单位和证据链接。

## 3. A1：Workload & Model Manifest

### 负责范围

K3逐层模型清单、dtype/layout、KV/state、TP shard、operator DAG和KPI输入。

### 量化交付

| 指标 | 目标 / 验收 |
|---|---|
| 层级覆盖 | 93/93层可机器读取；每层都有operator、输入输出shape、dtype、layout、TP shard和依赖 |
| DAG完整性 | operator依赖无环；所有输入、输出和跨层buffer均有唯一ID；孤立节点为0 |
| 运行场景 | 至少覆盖B=1、Context=1M、Decode=1 token；Prefill作为兼容场景单独标记 |
| 算子覆盖 | Attention、Linear Attention、RMSNorm、RoPE、Router、MoE、GEMM、通信归约全部显式建模 |
| 数据统计 | 每层输出FLOP、读写byte、KV/state byte、激活峰值和可并行tile数 |
| TP映射 | TP32 shard、package rank、die、core placement字段完整率100% |
| 可复现性 | 同一manifest、同一版本和seed生成结果逐字节一致；报告hash稳定 |
| Golden输入 | 至少3个代表性trace：Attention、Linear Attention、MoE；每个包含shape、dtype和所有transaction |

### 退出条件

- manifest loader能生成93层operator DAG；
- A10可以不读手工经验系数直接读取workload；
- 任何residual scaling、全局利用率乘数或未解释的layer替代均为0。

## 4. A2：7R Package / Floorplan

### 负责范围

7-reticle placement、8 Compute Die、16 MC、RDL/PHY/keep-out和package接口清单。

### 量化交付

| 指标 | 目标 / 验收 |
|---|---|
| Reticle几何 | 7个reticle，每个26 × 33 mm、858 mm²；理论总面积6,006 mm²，placement window按5,248 mm²管理 |
| Compute Die | 8个唯一坐标，每个 373.71 mm²（上限 400 mm²）；重叠面积为0 |
| MC | 16个唯一坐标；每个按100 mm²规划面积；每个Compute Die绑定2个local MC |
| 面积守恒 | 8 × Die 面积 + 1,600 ≤ 5,248 mm²（当前 4,589.71 mm²）；`areaConservation` 检查 |
| Occupancy | bare die占placement window 4,589.71/5,248 = 87.46%；余量 658.29 mm² 不能被重复计算 |
| 坐标模型 | die、MC、边界、scale-out、host、clock、management和keep-out均有机器可读坐标 |
| 接口清单 | 所有die-to-die、MC、scale-out、clock/reset、debug、power接口有owner、方向、位宽、速率和时钟域 |
| 布线保留 | window 余量必须分解到RDL、edge keep-out、PHY beachfront、VRM/thermal和管理区域 |
| 可制造性 | vendor stitch map、最大外形、edge keep-out和RDL约束在G4前达到`FROZEN`或明确风险接受 |

### 退出条件

- floorplan图、coordinate JSON和面积表三者一致；
- A6/A7/A8/A11可直接读取坐标和接口，不再复制手工数字；
- 任意单点die或MC故障都有可计算的替代路径或降级状态。

## 5. A3：Compute Die / AI Core

### 负责范围

L/H Core、Tensor/Vector能力、command queue、执行资源和kernel cycle模型。

### 量化交付

| 指标 | 目标 / 验收 |
|---|---|
| Core数量 | 8 L + 4 H/Die；96 L/H Core/package |
| 频率 | 1.0 GHz 固定（ADR-0005）；必须同时报告占空比、stall和有效issue rate |
| 面积预算 | 按 `k3_physical_basis.js` 面积项分解，总和 = `estimatedAreaMm2`（373.71 mm²），上限 400 mm² |
| 能力矩阵 | BF16/FP16/FP8/INT8支持状态、累加精度、tile shape和对齐约束100%有表格 |
| 队列 | 每种command queue的深度、credit、backpressure和completion事件必须为整数且可模拟 |
| Kernel模型 | Attention、Linear Attention、MoE、GEMM、Vector post-op至少各有一个cycle模型 |
| 模型校准 | 有参考RTL/门级/微基准后，关键kernel预测误差目标≤10%；无参考时标为MODEL |
| Core利用率 | P50/P95/P99利用率和stall原因必须可从trace重建，不允许只给平均利用率 |

### 退出条件

- 规格从 spec 文件加载、仿真和报告；
- 每个kernel cycle可映射到Core、SRAM、TMA、NoC或MC事件；
- 不能通过增加未声明的全局Core利用率因子达到1050 TPS/usr。

## 6. A4：SRAM / TMA / Memory Hierarchy

### 负责范围

本地SRAM、共享SRAM、bank/slice/port/ECC、TMA descriptor和buffer lifecycle。

### 量化交付

| 指标 | 目标 / 验收 |
|---|---|
| SRAM容量 | 8 MiB L-local + 16 MiB H-local + 16 MiB shared = 40 MiB/Die；package总量320 MiB |
| Slice数量 | 按16个shared SRAM slice建模；每个slice的容量、bank数、端口数和服务率必须明确 |
| TMA实例 | 高层基线按16个TMA group/Die；descriptor格式、最大tile、stride和scatter限制必须明确 |
| Buffer生命周期 | allocate、fill、ready、consume、release、poison至少6种状态；非法状态转换为0 |
| Bank冲突 | 每次回放输出bank conflict、queue wait、ECC/scrub和有效payload；关键trace的P95 bank stall目标≤10% |
| 带宽 | 对每个tile报告required bytes、issued bytes、effective bytes/s和backpressure；有效带宽达到模型需求的≥90%为TARGET |
| ECC/RAS | bit error、scrub、repair、poison传播和重试均有状态与测试；数据静默损坏路径为0 |

### 退出条件

- SRAM容量守恒、双缓冲生命周期和TMA事务在golden trace中闭合；
- A10能看到SRAM bank和TMA事件；
- 所有容量和带宽数字来自机器可读profile。

## 7. A5：Memory Cube / MC Controller

### 负责范围

16 MC、容量、payload、地址映射、NUMA、队列、ECC/retry和带宽瓶颈闭合。

### 量化交付

| 指标 | 目标 / 验收 |
|---|---|
| MC实例 | 16 MC/package，2 MC/Compute Die；home mapping覆盖率100% |
| 容量 | primary 16 GB/MC、256 GB/package；prototype 8 GB/MC、128 GB/package必须可区分 |
| 单MC payload | baseline 320 GB/s；stretch 640 GB/s；必须报告raw、sustained和有效payload三种数值 |
| Package payload | 5.12 TB/s baseline、10.24 TB/s stretch；不得把raw带宽直接当可用带宽 |
| Sustained效率 | 在A1 workload下输出读写比例、queue occupancy、P50/P95/P99 latency；有效payload目标≥raw的90% |
| 地址映射 | layer/tensor/tile到MC、bank、channel的映射可逆；热点MC占比P99≤1.25×平均值为TARGET |
| 队列 | queue depth、最大inflight transaction、retry、timeout和credit必须进入transaction模型 |
| 320路径 | 320 GB/s baseline若无法达到≥1,050 TPS/usr，必须输出byte-reduction、复用、压缩或替代MC路线的定量证据并保留BLOCKER |
| 640路径 | 640 GB/s只作为stretch对照，不得替代可制造baseline的签核证据 |

### 退出条件

- 320/640 GB/s回放结果可复现；
- MC demand、sustained payload和端到端TPS在同一模型中闭合；
- MC供应商/IP数据、功耗和热约束有明确证据等级。

## 8. A6：Die-local NoC

### 负责范围

Core、SRAM slice、MC gateway之间的数据、控制和collective网络。

### 量化交付

| 指标 | 目标 / 验收 |
|---|---|
| Endpoint | 12 Core endpoint + 16 SRAM slice endpoint + MC gateway；每个endpoint有唯一ID |
| 拓扑候选 | 抽象 mesh（`abstractNocMesh`）为当前候选；替代拓扑必须给出面积、跳数、带宽和功耗对比 |
| 网络平面 | Data、Control、Collective三平面；packet/flit格式、VC、credit和优先级完整 |
| 容量 | 每条link的width、frequency、buffer depth和aggregate bandwidth可计算；禁止只写“高带宽” |
| 拥塞 | 关键golden trace的P95/P99 link utilization、queue wait和最大hop必须输出；P99 utilization≤80%为TARGET |
| 正确性 | packet loss、duplicate、deadlock和credit underflow均为0 |
| QoS | Decode deadline高于Prefill后台流量；优先级反转和starvation测试通过 |
| 故障 | 单link/单endpoint故障有检测、重路由或降级路径；故障注入恢复结果可复现 |

### 退出条件

- A3/A4/A5的traffic contract可以直接生成NoC流量；
- NoC事件能进入A10性能回放和A12 golden trace；
- 每个关键链路不存在未解释的带宽超配。

## 9. A7：Package Fabric / Die-to-Die

### 负责范围

8 Die的4×2 mesh、两组4-Die reduce domain、MC home、NUMA和封装内路由。

### 量化交付

| 指标 | 目标 / 验收 |
|---|---|
| 拓扑 | 8 Die，4 × 2 mesh；两个4-Die hierarchical reduce domain |
| 路由 | route table覆盖所有die-to-die、MC home和collective路径；静态路由可审计 |
| Link参数 | width、lane数、速率、clock domain、编码开销、buffer和retry均必须明确 |
| 带宽闭合 | A10最坏trace下每条关键link的demand/capacity ratio≤1.0；P95≤0.8为TARGET |
| NUMA | local MC、remote MC、remote SRAM访问的平均和P99 latency分别报告；不得用单一平均值替代 |
| Collective | die内归约、4-Die域归约和8-Die package归约分别报告bytes和时间 |
| 故障 | 单Die、单link、单MC故障均有route/degraded mode；可用路径覆盖率100% |
| 时钟/复位 | 所有跨Die事务有CDC/reset release语义；重复释放或丢失事务为0 |

### 退出条件

- 4×2 mesh、MC home、路由表和floorplan坐标一致；
- package内collective不依赖未声明的host介入；
- A8能够复用package fabric的endpoint和故障语义。

## 10. A8：Scale-out / RDMA / Collective

### 负责范围

Package到TP32边界、remote SRAM mailbox、epoch、AllReduce/RS/AG、LSE和故障恢复。

### 量化交付

| 指标 | 目标 / 验收 |
|---|---|
| TP规模 | 32 package/rank组成TP32；每个package唯一rank ID |
| Scale-out payload | 800 GB/s/package为TARGET；必须同时报告raw、sustained、有效collective payload |
| 协议状态 | write、mailbox、epoch、commit、ready、ACK、release至少7类事件有顺序定义 |
| 一致性 | duplicate commit、lost ACK、stale epoch、double release、越界write均为0 |
| Collective | AllReduce、Reduce-Scatter、All-Gather、LSE m/l/O均有bytes、step数和时间模型 |
| 效率 | 关键trace的有效collective payload/链路payload目标≥80%；低于80%必须说明瓶颈 |
| 尾延迟 | P50/P95/P99 collective latency独立报告；不能只报告平均吞吐 |
| 可靠性 | timeout、replay、poison、link/package failure至少各1个fault trace；恢复结果确定性100% |
| Host独立性 | 一个decode step中的kernel、TMA、collective和ACK不依赖host逐tile介入；介入次数目标为0 |

### 退出条件

- RDMA状态机、Tile IR事件和A12 golden trace一致；
- TP32在无故障和单故障模式下都能完成一轮decode；
- 800 GB/s目标和实际有效payload之间的差值有可解释分解。

## 11. A9：Tile IR / Compiler / Scheduler

### 负责范围

operator到tile、placement、资源预留、静态/动态调度、persistent decode和PMU。

### 量化交付

| 指标 | 目标 / 验收 |
|---|---|
| IR覆盖 | 93层DAG可完整序列化、反序列化和校验；round-trip差异为0 |
| Tile字段 | operator/layer、shape、dtype、layout、placement、resource、buffer、transaction、dependency、epoch、QoS、fault字段齐全 |
| Placement | 每个tile映射到package/die/core/SRAM/MC；无重复占用、越界和悬空引用 |
| 资源预留 | Core、TMA、SRAM bank、NoC VC、MC queue、RDMA credit均可预留、释放和冲突检测 |
| 调度模式 | static schedule + dynamic credit/ready两种模式；同一trace可比较其stall来源 |
| Decode | persistent decode step不依赖host逐kernel launch；host介入次数目标为0 |
| PMU | 每个关键资源至少有busy、stall、queue、bytes、error、latency事件；事件命名冲突为0 |
| 失败处理 | timeout、poison、retry、cancel和replay在IR中可表达；非法状态无法生成 |

### 退出条件

- A10能直接使用Tile IR生成operator/transaction trace；
- A12能验证IR schema、状态机和资源守恒；
- 编译器报告所有未映射tile，未映射数量为0。

## 12. A10：Performance Model Integration

### 负责范围

manifest→DAG→Tile IR→resource/transaction simulator，输出三模型 × TP × 320/640 MC 和尾延迟结果。

### 量化交付

| 指标 | 目标 / 验收 |
|---|---|
| 规格来源 | 资源只取自 spec 文件（`singleHardwareSpec`）；检查100%通过 |
| 当前对照 | 必须复现 `teams/hardware/inputs/k3_mc_baseline.json#modelResults` 的 MC320 / MC640 两点（`tests/regression/test_design_baseline.js`）；数值变化需有差异说明 |
| 签核 | 可制造路线达到≥1,050 TPS/usr；仅达到1,000–1,049.99只能标记未过架构门槛 |
| 端到端延迟 | raw latency≤854.70 µs/token；同时报告P50/P95/P99 |
| 模型输入 | 所有FLOP、byte、queue、NoC、MC、RDMA时间由事件产生；经验缩放因子为0 |
| 统计稳定性 | 至少5个seed或确定性重放；P50/P95/P99定义和样本数固定 |
| 资源守恒 | time、byte、capacity、credit和transaction count全部通过守恒检查 |
| 敏感性 | 至少输出MC320/640、SRAM容量、NoC拥塞、RDMA payload四项敏感性结果 |
| 校准误差 | 与模块级golden trace对比，关键阶段时间误差目标≤10%；未校准项必须标MODEL |

### 退出条件

- 输出一份三模型 × TP × MC 性能报告；
- 明确达到或未达到1050 TPS/usr；
- 未达到时自动列出byte、memory、NoC、collective、Core和thermal的贡献分解。

## 13. A11：PPA / Power / Thermal / RAS

### 负责范围

Die/package面积、功耗、热、供电、DVFS、故障预算和降级模式。

### 量化交付

| 指标 | 目标 / 验收 |
|---|---|
| Die面积 | 373.71 mm²/Die，上限 400 mm²；面积项按 `k3_physical_basis.js` 分解并与 `estimatedAreaMm2` 守恒 |
| Package面积 | Compute 2,989.71 + MC 1,600 = 4,589.71 ≤ 5,248 mm² |
| 功耗 | Die 286.2 W（上限 300 W）、卡 2,768.5 W（上限 2,800 W）；MC、PHY、RDL、VRM和管理功耗单列 |
| 散热 | 液冷冷板（ASSUMPTION，O-015）；不得把 Die 功耗之和当成卡总功耗 |
| 功耗剖面 | Core、SRAM/TMA、NoC、MC、Die-to-Die、RDMA、clock、management逐项报告平均、P95和峰值 |
| 热点 | 每个Die/MC/PHY hotspot有位置和温度模型；热点不得用package平均温度替代 |
| 电源 | IR drop、瞬态电流、VRM/PDN余量和时钟功耗有数值；缺供应商数据必须标OPEN |
| 降级 | 单Die、MC、link、thermal throttle、power cap至少5种降级模式有性能结果 |
| RAS | 检测、隔离、重试、重映射、scrub、poison、replay和恢复时间均有预算 |

### 退出条件

- 面积、功耗、热和可靠性预算与A2/A4/A5/A7/A8/A10一致；
- 有面积和功耗余量报告；
- 任何超预算项目都自动进入BLOCKER，而不是在报告中静默缩放。

## 14. A12：Verification / Regression / Traceability

### 负责范围

需求追踪、contract test、golden trace、守恒检查、fault/replay、CI和规格来源检查。

### 量化交付

| 指标 | 目标 / 验收 |
|---|---|
| 需求追踪 | 每个REQ至少链接1份设计文档、1个机器数据或模型、1个测试和1项证据；G4覆盖率100% |
| Contract test | 每个A1–A11公共接口至少1个contract test；关键状态机至少1个正向和3个异常场景 |
| Golden trace | 至少3个算子trace + 1个端到端decode step；trace包含版本、seed、profile和单位 |
| 守恒 | area、capacity、bytes、time、credit、transaction、epoch和package count全部有自动检查 |
| 规格来源 | 第二份规格、资源不取自spec文件、字段缺失、单位错误和结果误标记均有负测试 |
| 故障覆盖 | MC、NoC link、Die、RDMA timeout、thermal throttle至少5类fault；恢复/降级结果可复现 |
| 统计覆盖 | 正常、峰值、P95/P99、最坏路由和多seed至少各一组回归 |
| CI门禁 | `npm test`通过；链接、JSON schema、单位、证据等级标签和生成报告检查通过 |
| 回归时间 | 单元contract tests在本地≤5分钟；完整回归目标≤30分钟，超时必须拆分并行job |

### 退出条件

- 主线测试全绿；
- 所有BLOCKER有失败测试或明确证据；
- 能从最终TPS数字反查到manifest、Tile IR、transaction trace和测试。

## 15. A13：Documentation / Report Publisher

### 负责范围

文档模板、报告生成、证据等级标签、指标索引和审阅交付。

### 量化交付

| 指标 | 目标 / 验收 |
|---|---|
| 报告生成 | 面积、SRAM、MC、NoC、RDMA、PPA、性能至少7类报告自动生成 |
| 可追溯字段 | 每个关键数字包含profile、版本、输入、seed、单位、状态和证据链接；覆盖率100% |
| 证据等级标识 | 标题、图例和表格均带证据等级（MODEL、PLANNING_ESTIMATE 等）；误标测试为0 |
| 生成确定性 | 同一输入重复生成的JSON/CSV数值一致；报告hash差异只能来自时间戳元数据 |
| 手工修改 | generated data/reports不接受无生成命令的手工改动；CI能检测 |
| 视觉审阅 | 关键报告至少包含面积、带宽、延迟、功耗、TPS和blocker五类摘要 |
| 版本索引 | 每份报告反向链接到commit、schema版本和源数据；断链为0 |

### 退出条件

- reviewer仅凭报告即可区分FROZEN、TARGET、MODEL、OPEN；
- 所有关键数字可以回溯到JSON、模型或测试，而不是复制粘贴。

## 16. 跨 Agent 依赖和合并门槛

### 16.1 依赖图

```text
A1 ─────┬── A3 ──┐
        ├── A4 ──┤
A2 ─────┼── A5 ──┤
        ├── A6 ──┼── A10 ──┐
        ├── A7 ──┤         ├── G4 Architecture Sign-off
        ├── A8 ──┤ A11 ────┤
        └── A9 ──┘ A12 ────┘
                         A13贯穿并消费版本化输出
```

### 16.2 Gate指标

| Gate | 必须满足的量化条件 |
|---|---|
| G0 | A0发布公共schema；ownership冲突为0；所有Agent有任务卡 |
| W1 exit | A1 93/93层manifest；A2面积守恒差值0；coordinate JSON可读 |
| W2 exit | A3–A9各至少1份contract test；公共接口版本化；spec加载成功 |
| W3 exit | A10输出三模型 × TP × 320/640对比；A11完成面积/功耗/热表；A12全绿 |
| G4 | 可制造路线≥1,050 TPS/usr；raw latency≤854.70 µs；P99、面积、功耗、热、RAS全部通过 |

### 16.3 资源有限时的量化优先级

1. **最小3 Agent**：A0/A12、A1/A9/A10、A2–A8/A11。先保证93层manifest、7R守恒和性能闭合。
2. **推荐6 Agent**：A0、A1、A2、A3/A4、A5/A6/A7、A8/A9、A10/A11/A12/A13。每个合并单元至少保留一个独立contract test。
3. **10+ Agent**：完整A1–A13拆分，但保持A0唯一公共状态owner；不得因为Agent数量增加而允许多个Agent改同一公共文件。

## 17. 不允许用以下方式“达标”

- 用 MC640 Stretch 的模型结果替代可制造路线签核；
- 把MC raw bandwidth直接写成sustained bandwidth；
- 用一个全局utilization、scaling或efficiency乘数隐藏未建模的transaction；
- 把 Die 功耗之和写成卡总功耗；
- 把平均延迟替代P95/P99；
- 用软件host介入次数掩盖硬件scheduler/RDMA缺口；
- 修改generated data/reports而不更新生成脚本、输入和测试；
- 在没有ADR和回归测试的情况下静默改变Tile IR、SRAM、MC、NoC或package topology。
## 18. 多模型统一验收矩阵

| Agent | K3必须保持 | GLM-5.2新增 | DeepSeek-V4-Pro新增 | 统一验收 |
|---|---|---|---|---|
| A1 | 93层DAG、KV/state、LSE m/l/O | indexer、index cache、MTP字段 | sparse attention/indexer、expert dispatch字段 | 三个`model_id`均能生成合法manifest和Tile IR |
| A3 | L/H Core、Tensor/Vector | sparse index、MTP draft/verify | expert GEMM、FP8/FP4 dequant | 每类新增执行类型有cycle/resource模型 |
| A4 | 40 MiB/Die、TMA、ECC | index cache、MTP branch buffer | expert staging、sparse state | buffer class、容量、eviction、epoch可追踪 |
| A5 | 16 MC、320/640 GB/s | index miss和长上下文state | expert weight、dispatch/combine | bytes按state/index/expert/dispatch分类，raw不等于sustained |
| A6–A8 | NoC、4×2 package fabric、TP32 RDMA | indexer/MTP QoS和rollback | all-to-all、expert home、combine | 无deadlock、lost ACK、duplicate merge和stale epoch |
| A9 | Tile IR、persistent decode | candidate token、accept mask | expert id/capacity、overflow | 不依赖host逐token/逐expert启动 |
| A10 | MC320/640发布点回归 | index hit、MTP acceptance | expert load balance、overflow | `3 × 3 × 2`结果矩阵，P50/P95/P99齐全 |
| A11 | 373.71 mm²、Die 300 W、卡 2,800 W 上限 | index miss峰值、MTP重叠 | expert热点、dequant峰值 | 三模型最坏值不得静默超预算 |
| A12–A13 | K3 golden trace和报告 | model-specific fault/report | model-specific fault/report | 每个关键数字带model/profile/schema/seed/evidence |

### 多模型G4门槛

1. 三个模型各自拥有正式或明确标记为待确认的配置版本；
2. 三个模型都能跑通至少一个端到端 decode step；
3. 任一模型未达到其目标时，G4报告必须按 memory、compute、NoC、RDMA、scheduler、thermal 分解原因；
4. 在GLM-5.2和DeepSeek-V4-Pro正式配置确认前，平台结论只能称为“架构兼容性基线”，不能称为最终产品性能签核。
## 19. TPS作为一级架构观测指标

TPS指标定义、18个观测位置、`MODEL_OBSERVED`/`SILICON_OBSERVED`/`PENDING_MODEL_RUN`/`BLOCKED_CONFIG`状态和A0–A13责任见[`14_TPS_OBSERVATION_METRICS.md`](../../../docs/architecture/14_TPS_OBSERVATION_METRICS.md)及[`out/workload/tps_observation_matrix.json`](../../../out/workload/tps_observation_matrix.json)。

每个Agent涉及性能的改动必须至少报告：

- `model_id`、TP、MC profile、physical profile、seed；
- TPS/usr、raw/e2e latency、P50/P95/P99；
- bytes、compute、memory、NoC、collective、power和thermal分解；
- 结果状态和可追溯source。
