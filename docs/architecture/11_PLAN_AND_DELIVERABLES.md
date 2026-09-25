# 芯片设计计划与最终交付

版本：2026-09-20。

## 1. 总体策略

先冻结**工作负载与 MC 路线**，再冻结 Compute Die 和互联。不能从当前
P1 Final Tuning 最佳搜索点直接进入微架构，因为该点依赖 640 GB/s/MC，而参考器件
只有 320 GB/s/MC（档位定义见 ADR-0019）。

规划采用 8 个阶段。时间以架构项目周为相对单位，供应商和实体实现周期另算。

## 2. 阶段计划

### P0：需求和口径冻结（第 0–2 周）

任务：

- 获取正式模型结构、逐层清单、权重精度和 KV/state 定义；
- 冻结 B=1、Context、TPS、P99、功耗和容量目标；
- 明确 1000 是最低值还是发布值，并设置 1050 架构门槛；
- 确认 MC 路线是纯存储 MC；
- 清理现有文档冲突和单位错误。

交付：

- Workload Specification；
- KPI/Acceptance Specification；
- Model Layer Manifest；
- 决策记录和风险清单。

退出条件：

- 不再用 residual 参数拟合代替正式 Q/K/V 矩阵；
- 所有性能结果使用同一组 dtype 和层顺序。

### P1：MC 可行性与带宽闭合（第 1–5 周）

任务：

- 与 MC 供应商确认 8/16 GB、320 GB/s 的 payload、功耗和并发；
- 建立 MC command/channel 模型；
- 评估 MC-X 640、双数据面、32 MC、压缩字节和近存计算备选；
- 确认 2 MC/Die 的 PHY、bump 和控制器。

交付：

- MC 子系统规格；
- vendor-compatible transaction model；
- MC 路线对比报告；
- 卡级容量/带宽/功耗表。

退出条件：

- 选定一种可制造路径，tile 模型中的 MC 参数有供应商依据；
- 若仍用 320 GB/s，必须给出达到 1050 TPS 的字节削减或架构变化。

### P2：精确 tile 模型（第 2–8 周）

任务：

- 从逐层清单生成完整 operator DAG；
- 定义 Tile IR；
- 建模 Local bank、Shared slice、TMA、NoC、MC、RDMA；
- 移除 Final Tuning 的经验缩放因子；
- 扫描 tile、buffer、dtype 和融合。

交付：

- L1 tile simulator；
- 标准 trace；
- 逐 operator/tile 时间账；
- P50/P95/P99 和敏感性报告。

退出条件：

- 使用选定 MC 规格达到 ≥1050 TPS/usr；
- 容量、端口、带宽和时间守恒全部通过。

### P3：单 Die 微架构冻结（第 6–12 周）

任务：

- 冻结 L/H Core 数量与逻辑阵列；
- 冻结 Vector、TMA、Local/Shared SRAM；
- 冻结 NoC topology/width/VC；
- 冻结 collective/reduce 单元；
- 初版 floorplan、时钟和 PPA。

交付：

- AI Core、TMA/SRAM、NoC、Collective 详细设计；
- 单 Die block diagram；
- Interface Control Documents；
- PPA v1；
- kernel cycle model。

退出条件：

- 单 Die 所有接口和实例数明确到单元级；
- 频率、面积、功耗、SRAM 和岸线至少保留 10–15% 余量。

### P4：8 Die 卡内扩展冻结（第 9–15 周）

任务：

- 冻结 4×2 mesh/4+4 hierarchy；
- packet-level 模拟 card-local collective；
- 冻结 MC home、NUMA 和故障绕行；
- 新版封装 floorplan、PDN、clock 和 thermal。

交付：

- Multi-die Architecture Specification；
- card-local topology 和 route table；
- interposer/bump/PHY plan；
- card-level PPA/thermal v1。

退出条件：

- 卡内拓扑不再使用 ring/mesh/hierarchy 三套口径；
- 最坏 collective 和 MC miss 进入 tile 回归。

### P5：TP32 Scale-out 冻结（第 12–20 周）

任务：

- 选择跨卡拓扑和电/光 PHY；
- 定义远端 SRAM write、路由、credit、replay 和 timeout；
- P99 collective 模型；
- Decode/Prefill QoS；
- 故障和降级。

交付：

- Scale-out Fabric Specification；
- RDMA/Collective Protocol Specification；
- topology、hop、端口和布线表；
- transaction-level model。

退出条件：

- 32 卡 P99 时延满足目标；
- 800 GB/s/card 的物理端口、功耗和拓扑可实现；
- 无 host 逐 collective 介入。

### P6：架构签核与 RTL 前准备（第 18–24 周）

任务：

- 整合 tile、NoC、MC、collective 和 PPA；
- corner/故障/降频/重放；
- 需求到单元规格 traceability；
- RTL 计划、验证计划和 IP 采购。

交付：

- Architecture Specification v1.0；
- Microarchitecture Specification set；
- Verification Plan；
- PPA/thermal/package sign-off report；
- risk acceptance 和 change-control baseline。

退出条件：

- 所有 `BLOCKER` 关闭；
- 主要 KPI 至少 10% 设计余量；
- 规格可直接分解为 RTL/IP work package。

### P7：RTL、原型与回标（第 24 周以后）

任务：

- 单元 RTL；
- UVM/形式验证；
- FPGA/emulation；
- 1 Compute Die + 2 MC 原型；
- 8 Die 卡和 TP32 扩展；
- 实测回标所有模型。

## 3. 子系统交付矩阵

| 子系统 | 架构文档 | 可执行模型 | RTL 前签核 |
| --- | --- | --- | --- |
| AI Core | Core/ISA/接口/实例 | kernel cycle | PPA、覆盖率 |
| TMA/SRAM | bank、端口、生命周期 | bank-cycle | macro、ECC、时序 |
| MC | 地址、控制器、PHY | transaction | vendor/IP 确认 |
| NoC | topology/width/VC | packet | 死锁、拥塞、PPA |
| Multi-die | 8 Die route | packet | bump/interposer |
| Scale-out | 32 卡 topology | transaction | PHY/光/板级 |
| Collective | mailbox/reduce | RTL/TLM | replay/epoch/形式 |
| Scheduler | Tile IR/队列 | trace replay | 固件/PMU |
| Package/Power | floorplan/PDN/thermal | system | 厂商联合签核 |
| System performance | workload/KPI | tile simulator | ≥1050/P99≥1000 |

## 4. 最终设计交付目录

最终交付应包括：

```text
spec/
  workload/
  system/
  ai_core/
  tma_sram/
  memory_mc/
  noc/
  multidie/
  scaleout/
  collective/
  scheduler_firmware/
  package_power_thermal_ras/

models/
  tile/
  kernel_cycle/
  noc_packet/
  mc_transaction/
  rdma_transaction/
  ppa/

teams/vv/
  testplan/
  golden_traces/
  regressions/
  coverage/

implementation/
  interface_control/
  floorplan/
  clocks_resets/
  power_domains/
  ip_manifest/
```

## 5. 最终“详细到单元级”的定义

最终 Architecture Specification 至少明确：

- 每 Die Core 数量；
- 每 Core Tensor engine 数和逻辑阵列 shape；
- Vector lane 数和功能集合；
- TMA engine 数、宽度和 descriptor；
- Local/Shared SRAM 容量、bank、slice、端口和 ECC；
- NoC 拓扑、每链路位宽、频率、VC、buffer 和 route；
- MC 数、容量、带宽、PHY、地址映射和控制器；
- 8 Die 拓扑和每条链路；
- TP32 物理拓扑、端口和协议；
- collective/reduce/mailbox 单元；
- 调度、PMU、RAS、时钟、电源域；
- 单元面积、功耗、吞吐和时延预算。

Tensor engine、Vector lane、TMA 内部流水线和 SRAM bitcell 级实现可以留到
Microarchitecture/RTL 阶段。
