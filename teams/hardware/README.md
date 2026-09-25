# Hardware Team

## Mission
定义 7-reticle 单芯片的可实现硬件规格，并把模型需求转换为 compute、memory、network、package、PPA/RAS 约束。

## Agents

| Agent | 职责 | 输入 | 输出 | 关键约束 |
|---|---|---|---|---|
| HW-01 Package/Floorplan | 7-reticle 封装、die、MC、PHY、RDL、thermal keep-out | `k3_mc_baseline.json#package`、模型容量、PPA budget | package spec、area/thermal envelope | area conservation；只有一份硬件规格（ADR-0021） |
| HW-02 AI-Core | L/H/Vector/Indexer/Reduce、dtype、issue、频率、core pod | arithmetic intensity、software kernel needs | AI Core spec、peak/effective resource envelope | peak 不等于 sustained；资源按 core class 分开 |
| HW-03 SRAM/TMA/Memory | local/shared SRAM、bank、TMA、buffer lifecycle | tile shapes、bytes、reuse | memory hierarchy、tile-fit、service constraints | per-core/die/package 分离；bytes 守恒 |
| HW-04 MC/Memory Controller | MC320/MC640、带宽、容量、QoS | memory traffic、queue model | MC spec、sustained bandwidth、capacity | raw 不得当 effective；MC640 是 stretch |
| HW-05 NoC/Die-to-Die | NoC、collective fabric、packet/credit/hop、拓扑 | TP/CP/EP traffic、package floorplan | topology、latency/bandwidth envelope | local/cross-package 分离；防 deadlock |
| HW-06 PPA/RAS | power、thermal、IR drop、DVFS、故障降级 | activity/event traces、floorplan | PPA/RAS report | average/P95/peak 分离；不能冒充实测 |

## Directory

| Path | Content |
|---|---|
| `docs/` | 硬件单元设计：02 AI Core、03 TMA/SRAM、04 MC、05 NoC、06 多 Die/Scale-out、07 Collective/RDMA、08 片上调度器与 PMU、09 封装/功耗/RAS（编号沿用原 docs/architecture/ 序号） |
| `inputs/k3_mc_baseline.json` | 唯一硬件规格（P1，ADR-0021），含 `package` 面积约束。**混合文件**：规格字段手工维护；`computeDieCandidate`、`modelResults`、`collectiveCount`、`tauBasis`、`sramAccounting`、`acceptance.reason`、`tpsDesign` 由 `integration/pipelines/sync_baseline_spec.js` 从 Final Tuning 结果重写（`npm run baseline:sync`），不要手改这些字段 |
| `src/resource_profiles.js` | P1 × MC320/MC640 资源 profile，从上面的 spec 推导 |
| `src/k3_compute_node.js` | Compute Node 模型 |
| `contract.json` | 对外 resource contract 的静态部分；合成到 `out/contracts/hardware_resource_contract.json` |

## Review and handoff
HW-01/HW-02/HW-03/HW-04/HW-05 先形成规格；HW-06 做资源和热闭环；交给 `ARCH-02` 与 `SW-*`。硬件规格变更必须有 ADR。
