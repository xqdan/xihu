# Hardware Team

## Mission
定义 7-reticle 单芯片的可实现硬件规格，并把模型需求转换为 compute、memory、network、package、PPA/RAS 约束。

## Agents

| Agent | 职责 | 输入 | 输出 | 关键约束 |
|---|---|---|---|---|
| HW-01 Package/Floorplan | 7-reticle 封装、die、MC、PHY、RDL、thermal keep-out | `k3_mc_baseline.json#package`、模型容量、PPA budget | package spec、area/thermal envelope | area conservation；只有一份硬件规格（ADR-0021） |
| HW-02 AI-Core | L/H/Vector/Indexer/Reduce、dtype、issue、频率、core pod；按核类的 Matrix:Vector 配比 | arithmetic intensity、software kernel needs、设计空间 `inputs/matrix_vector_design_space.json`（lanes、低精度输入方式、exp 单元及其 ASSUMPTION） | AI Core spec、peak/effective resource envelope、搜索选出的 Matrix:Vector 设计 `out/detailed/matrix_vector_design.json`（`npm run aicore:search`，只含最终方案；各备选的落选原因见 [02](docs/02_AI_CORE.md) 第 2.5 节） | peak 不等于 sustained；资源按 core class 分开；vector 必须被同 kernel 矩阵时间掩盖，配比结论要写明原生 FP8/MXFP4 前提和支持的模型范围 |
| HW-03 SRAM/TMA/Memory | local/shared SRAM、bank、TMA、buffer lifecycle | tile shapes、bytes、reuse | memory hierarchy、tile-fit、service constraints | per-core/die/package 分离；bytes 守恒 |
| HW-04 MC/Memory Controller | MC320/MC640、带宽、容量、QoS | memory traffic、queue model | MC spec、sustained bandwidth、capacity | raw 不得当 effective；MC640 是 stretch |
| HW-05 NoC/Die-to-Die | NoC、collective fabric、packet/credit/hop、拓扑 | TP/CP/EP traffic、package floorplan | topology、latency/bandwidth envelope | local/cross-package 分离；防 deadlock |
| HW-06 PPA/RAS | power、thermal、IR drop、DVFS、故障降级 | activity/event traces、floorplan | PPA/RAS report | average/P95/peak 分离；不能冒充实测 |
| HW-07 Comm-Core | 集合通信触发、WQE 模板下发、接收 commit/notify 计数、ACK 合并、超时/poison；内存语义（PUT/PUT_SIGNAL/GET/远端原子、全局地址、内存序） | collective graph（SW-05）、mailbox 语义（[07](docs/07_COLLECTIVE_RDMA.md)）、设计空间 `inputs/comm_core_design_space.json`（全部备选方案与 cycle/面积假设） | Comm Core 规格（[10](docs/10_COMM_CORE.md)，第 7 节列出各备选方案的落选原因）、搜索选出的最终方案 `out/detailed/comm_core_design.json`（`npm run commcore:search`）、τ 自底向上推导的控制路径一项（O-018） | 固件不在每次集合通信的关键路径上；AI Core 不发 WQE；slot generation 与 mailbox epoch 一致；cycle 数在回标前都是 ASSUMPTION |

## Directory

| Path | Content |
|---|---|
| `docs/` | 硬件单元设计：02 AI Core、03 TMA/SRAM、04 MC、05 NoC、06 多 Die/Scale-out、07 Collective/RDMA、08 片上调度器与 PMU、09 封装/功耗/RAS（编号沿用原 docs/architecture/ 序号）、10 Comm Core；后端与物理层：11 布局/面积、12 时钟复位电源域、13 DFT、14 时序签核、15 RTL 验证、PROCESS_AND_LIBRARY 工艺与库、PACKAGE_SUBSTRATE 封装与基板、POWER_BUDGET 卡功耗逐项分配 |
| `inputs/k3_mc_baseline.json` | 唯一硬件规格（P1，ADR-0021），含 `package` 面积约束。**混合文件**：规格字段手工维护；`computeDieCandidate`、`modelResults`、`collectiveCount`、`tauBasis`、`sramAccounting`、`acceptance.reason`、`tpsDesign`、`designPoint` 由 `integration/pipelines/sync_baseline_spec.js` 从 Final Tuning 结果重写（`npm run baseline:sync`），不要手改这些字段。默认同步发布点（`--point published`）；`--point joint --adr <ADR 文件>` 改从联合点同步，把它的 OPT / 模型补丁写进这份基线并留下一块 `designPoint`，这需要 ADR——搬基线是决定，不是落盘文件的副作用 |
| `src/resource_profiles.js` | P1 × MC320/MC640 资源 profile，从上面的 spec 推导 |
| `src/k3_compute_node.js` | Compute Node 模型 |
| `contract.json` | 对外 resource contract 的静态部分；合成到 `out/contracts/hardware_resource_contract.json` |

## Review and handoff
HW-01/HW-02/HW-03/HW-04/HW-05/HW-07 先形成规格；HW-06 做资源和热闭环；交给 `ARCH-02` 与 `SW-*`。硬件规格变更必须有 ADR。
