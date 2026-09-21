# K3 1000 TPS/usr 芯片设计文档集

- `AGENT_WORKSTREAM_PLAN.md`：并行 agent workstream、依赖图、合并顺序和签核闸门。

版本：2026-09-20。

本目录把现有搜索、模拟器和历史方案整理成一套可逐步冻结的芯片设计文档。
目标交付深度为**单元级**：明确 Tensor Core、Vector Core、TMA、SRAM、
NoC、MC 接口、Die 间互联、Scale-out/RDMA、调度和封装等单元的数量、
接口、拓扑、位宽、性能预算和验证条件；单元内部流水线与 RTL 暂不展开。

## 1. 当前结论

1. 工作负载暂定为 K3 工程 preset：93 层、B=1、Context=1M、
   TP=32、PP=1，目标为 1000 TPS/usr。
2. 当前 Final Tuning 搜索结果是 **998.81 TPS/usr**，并未严格达到目标。
3. 998.81 TPS/usr 使用的是每颗 MC **640 GB/s** 的搜索假设。
   本地 Memory Cube 参考规格给出的 KGD 最大单向带宽是
   **320 GB/s/颗**。在相同 Compute Die 和优化参数下，320 GB/s 点只有
   **546.63 TPS/usr**。
4. 因此目前不能把“998.81 TPS”视为已经证明可实现的芯片指标。首先需要
   冻结可制造的 MC 带宽与连接方式，再冻结 Compute Die。
5. 当前路线以**外置 Memory Cube**为主：MC 提供容量和带宽，矩阵计算仍在
   Compute Die。带 GEMM base die 的近存计算 MC 是备选路线，不混入本轮基线。

## 2. 状态标记

| 标记 | 含义 |
| --- | --- |
| `FROZEN` | 项目目标或已明确约束，修改需走设计变更 |
| `BASELINE` | 当前推荐基线，可进入细化设计，但尚未物理签核 |
| `MODEL` | 仅由性能/PPA 模型假设得到，必须校准 |
| `OPEN` | 尚未决定或现有资料相互冲突 |
| `BLOCKER` | 不关闭就不能宣称达到目标或冻结架构 |

## 3. 文档索引

### 高层架构总纲

- [HIGH_LEVEL_ARCHITECTURE.md](HIGH_LEVEL_ARCHITECTURE.md)：K3 1000 TPS/usr 高层架构、模块边界、详细设计文档树、接口契约、里程碑和签核门槛。

| 文档 | 负责范围 |
| --- | --- |
| [00_CURRENT_STATE.md](00_CURRENT_STATE.md) | 已确定事项、冲突、证据等级和当前性能 |
| [01_SYSTEM_ARCHITECTURE.md](01_SYSTEM_ARCHITECTURE.md) | 系统边界、卡/Die/MC 分层和端到端数据流 |
| [02_AI_CORE.md](02_AI_CORE.md) | L/H AI Core、Tensor、Vector 和执行接口 |
| [03_TMA_AND_SRAM.md](03_TMA_AND_SRAM.md) | TMA、本地 SRAM、共享 SRAM、bank 与生命周期 |
| [04_MEMORY_SUBSYSTEM_MC.md](04_MEMORY_SUBSYSTEM_MC.md) | Memory Cube、容量、带宽、地址映射和 MC 控制器 |
| [05_ON_DIE_NOC.md](05_ON_DIE_NOC.md) | 单 Die NoC 拓扑、位宽、VC、QoS 和流控 |
| [06_MULTIDIE_AND_SCALEOUT.md](06_MULTIDIE_AND_SCALEOUT.md) | 8 Die 卡内扩展、TP32 和板间物理拓扑 |
| [07_COLLECTIVE_RDMA.md](07_COLLECTIVE_RDMA.md) | 远端 SRAM 语义、归约引擎、epoch 和可靠性 |
| [08_SCHEDULER_AND_SOFTWARE.md](08_SCHEDULER_AND_SOFTWARE.md) | 编译器、tile 描述符、调度器、固件和 PMU |
| [09_PACKAGE_POWER_RAS.md](09_PACKAGE_POWER_RAS.md) | 封装、I/O 岸线、功耗、时钟、散热和 RAS |
| [10_TILE_SIMULATION.md](10_TILE_SIMULATION.md) | 算子/tile 模型、资源竞争、校准和签核标准 |
| [11_PLAN_AND_DELIVERABLES.md](11_PLAN_AND_DELIVERABLES.md) | 分阶段设计计划、里程碑、交付物和退出条件 |
| [DECISIONS.md](DECISIONS.md) | 架构决策记录 |
| [OPEN_ISSUES.md](OPEN_ISSUES.md) | 阻塞项、责任子系统和关闭证据 |
| [spec/k3_mc_baseline.json](spec/k3_mc_baseline.json) | 当前机器可读基线与回归数值 |

- `12_7_RETICLE_SINGLE_CHIP_ARCHITECTURE.md`：7-reticle 单芯片、Compute Die 面积和集成存储规划。

## 4. 设计文档完成定义

每个子系统文档进入 `FROZEN` 前至少要包含：

- 功能和非功能需求；
- 单元级框图与实例数量；
- 所有上下游接口、数据宽度、时钟域和流控；
- 容量、带宽、延迟、吞吐、面积和功耗预算；
- 正常流程、背压流程、错误流程和复位流程；
- 算子/tile 映射及最坏资源并发；
- 可执行模型或回归测试；
- 未决项为零，或者有明确的风险接受记录。

## 5. 基线复算

```sh
npm test
node tests/test_design_baseline.js
```

机器可读基线中的数字由当前 Final Tuning 模型回归。它们是工程模型结果，
不是硅上保证。



- `spec/k3_7r_package_baseline.json`：7-reticle package 的面积、SRAM、MC 容量、带宽和 PPA 规划基线。
