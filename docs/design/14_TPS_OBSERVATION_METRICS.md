# TPS 架构观测指标与签核规则

版本：2026-09-21
状态：`BASELINE / OBSERVATION METRIC`

## 1. 目的

TPS不再只是最终报告中的一个结果，而是三模型架构设计的一级观测指标。每一次Compute、SRAM、MC、NoC、RDMA、Scheduler或封装调整，都必须能够回答：

1. 对K3、GLM-5.2、DeepSeek-V4-Pro分别带来多少TPS变化；
2. 在TP8、TP16、TP32下变化是否一致；
3. MC320与MC640下变化是否来自真实带宽、字节数或排队变化；
4. 该TPS是模型仿真、硅上观测，还是尚未运行；
5. 是否达到1000 TPS/usr目标和1050 TPS/usr架构冻结门槛。

机器可读主表：

```text
data/workload/tps_observation_matrix.json
```

## 2. 一级指标定义

| 字段 | 定义 |
|---|---|
| `metric` | `decode_tps_per_user` |
| 单位 | `tokens/s/user` |
| 测量场景 | Batch=1、Context=1M、Decode=1 token、PP=1 |
| 公式 | `TPS/usr = 1,000,000 / e2e_latency_us_per_token` |
| 目标 | 1,000 TPS/usr |
| 架构冻结门槛 | ≥1,050 TPS/usr |
| 辅助预算 | raw latency ≤854.70 µs/token |
| 维度 | model、TP、MC profile、physical profile、workload case、seed |
| 方向 | 越高越好 |

TPS必须和以下辅助指标同时记录，不能只留一个标量：

```text
raw latency
end-to-end latency
P50/P95/P99 latency
MC raw/sustained/effective payload
SRAM peak and buffer occupancy
NoC queue wait and utilization
RDMA/collective latency
expert dispatch balance
index cache hit rate
MTP acceptance and rollback
power and thermal peak
```

## 3. 观测状态

| 状态 | 含义 | 是否可用于架构签核 |
|---|---|---|
| `MODEL_OBSERVED` | 可执行模型已经运行，有输入、版本、seed和来源 | 可用于模型阶段比较；不能宣称硅上实现 |
| `SILICON_OBSERVED` | FPGA、原型或硅上实测，含测量环境和误差 | 可用于产品签核，需完成校准和重复测量 |
| `PENDING_MODEL_RUN` | 测试用例已定义，但事件级模型尚未运行 | 不可用于达标结论 |
| `BLOCKED_CONFIG` | 模型正式配置、dtype、权重或授权输入未确认 | 不可用于达标结论 |

当前主表中，只有K3 TP32的MC320和MC640有既有可执行模型结果；GLM-5.2与DeepSeek-V4-Pro所有TP均等待正式事件级回放。

## 4. 观测矩阵

目标覆盖：

```text
3 models × 3 TP modes × 2 MC profiles = 18 observations
```

模型与TP组合：

| 模型 | TP8 | TP16 | TP32 |
|---|---|---|---|
| K3 | 待运行 | 待运行 | 已有MC320/MC640模型观测 |
| GLM-5.2 | 待运行 | 待运行 | 待运行 |
| DeepSeek-V4-Pro | 待运行 | 待运行 | 待运行 |

MC Profile：

```text
MC320：参考Memory Cube基线
MC640：Stretch / alternative route
```

MC640结果必须标为`STRETCH`或`MODEL`，除非供应商或物理实现完成确认，不得作为可制造默认值。

## 5. 当前已知基线

| Model | TP | Profile | MC | TPS/usr | Raw latency | E2E latency | 状态 |
|---|---:|---|---:|---:|---:|---:|---|
| K3 | 32 | P1 | 320 GB/s/MC | 见 `spec/k3_mc_baseline.json#modelResults.referenceMc320GBs` | 同左 | 同左 | MODEL_OBSERVED |
| K3 | 32 | P1 | 640 GB/s/MC | 见 `spec/k3_mc_baseline.json#modelResults.stretchMc640GBs` | 同左 | 同左 | MODEL_OBSERVED |
| K3 | 8/16/32 | P0 | 320/640 | 规划 token 时间（K3 标定） | 同左 | 同左 | PLANNING_ESTIMATE |
| GLM-5.2 | 8/16/32 | P0 | 320/640 | 规划 token 时间（K3 标定；形状取公开 config，部署布局含 ASSUMPTION） | 同左 | 同左 | PLANNING_ESTIMATE |
| DeepSeek-V4-Pro | 8/16/32 | P0 | 320/640 | 规划 token 时间（K3 标定，含 ASSUMPTION） | 同左 | 同左 | PLANNING_ESTIMATE |

K3 P1 结果来自：

```text
data/rdma/k3_rdma_final_tuning_results.json
docs/design/spec/k3_mc_baseline.json
```

数值由 `tests/test_design_baseline.js` 回归，本文不再重复抄写，避免多处漂移。K3 MC640 是否达到 1000 目标以 `spec/k3_mc_baseline.json#acceptance.currentStatus` 为准；即使达到，也是 P1 模型结果而非架构门槛（1050）闭合，不能写成“已经达标”。规划估算（`data/workload/tps_observation_matrix.json`）是 ADR-0006 的规划 token 时间：`max(访存 × kMemory, 计算 × kCompute + 集合通信 × τ) × 1.17`，系数在 K3 P1/MC640/TP32 详细点上标定（规划 1102.41 对 1101.77），MC320 样本外偏差约 −6%。它与 P1 tile 模拟不是同一个模型，只在标定点对齐；其余槽位不得当作 `MODEL_OBSERVED`。

## 6. 不同Agent对TPS的责任

### A0：Architecture Integrator

- 维护TPS指标定义、门槛和观测状态；
- 保证所有报告包含model、TP、MC和physical profile；
- 维护跨版本TPS变化表；
- 任何TPS上升必须能反查到ADR、代码、输入和测试。

验收：

- 18个矩阵位置均有状态；
- 0个无model_id的TPS数字；
- 0个把P1结果标为P0签核的报告。

### A1：Workload Manifest

输出每个模型、TP的：

- active parameter / expert workload；
- FLOP；
- weight bytes；
- KV/state bytes；
- index bytes；
- expert dispatch/combine bytes；
- 每token tile数。

验收：

- 三模型×三TP共9个case均能生成DAG；
- 每个case的bytes和FLOP可追溯；
- TP改变只改变明确的shard和collective，不允许隐藏缩放。

### A3/A4：Compute、SRAM与TMA

负责解释TPS变化来自：

- Core issue/utilization；
- Tensor/Vector cycle；
- TMA wait；
- SRAM bank conflict；
- KV/index/expert buffer occupancy；
- MTP accept/rollback。

验收：

- 每个TPS结果至少有compute、SRAM、TMA时间分解；
- 关键kernel模型误差目标≤10%；
- 不允许使用无来源的全局utilization乘数。

### A5：Memory Cube / MC

负责解释：

- MC320与MC640差异；
- weight/state/index/expert/dispatch bytes；
- MC queue wait；
- sustained payload；
- 热点MC和负载均衡。

验收：

- 18个观测位置均输出raw/sustained/effective payload；
- raw bandwidth不等于sustained bandwidth；
- 320路径不能达标时，必须形成明确BLOCKER。

### A6/A7/A8：NoC、Package Fabric与RDMA

负责解释TPS变化来自：

- die-local NoC queue；
- package内reduce；
- TP8/TP16/TP32 collective；
- expert dispatch/combine；
- indexer与MTP控制消息；
- retry、replay和timeout。

验收：

- 每个观测点都有P50/P95/P99通信延迟；
- TP变化产生的通信开销可量化；
- packet loss、duplicate、deadlock、stale epoch为0。

### A9：Tile IR / Scheduler

负责：

- 统一生成9个TP测试case；
- 记录每个tile的model_id、TP、资源预约和deadline；
- 让TPS回放不依赖host逐token启动；
- 输出stall原因和资源利用率。

验收：

- 9个case全部生成合法trace；
- 每个TPS结果可回放；
- scheduler overhead和host介入次数显式记录。

### A10：Performance Integration

A10是TPS主指标Owner，必须生成：

```text
3 models × 3 TP modes × 2 MC profiles × 5 seeds
```

每个观测结果必须包含：

```text
observation_id
model_id
case_id
tp
mc_profile
physical_profile
seed
status
tps_per_user
raw_latency_us_per_token
e2e_latency_us_per_token
P50/P95/P99
bytes_breakdown
compute_time
memory_time
communication_time
power
thermal
source_commit
```

验收：

- 18个组合全部有结果或明确状态；
- 每个结果有至少5个seed或确定性重放；
- P0/P1独立报告；
- 未达到1050时自动输出瓶颈分解。

### A11：PPA / Thermal / RAS

TPS不能脱离物理约束单独提升。A11必须输出TPS与以下指标的联合观测：

- TPS/W；
- TPS/mm²；
- TPS/package；
- peak power；
- thermal throttle；
- degraded-mode TPS。

验收：

- 任一模型TPS达标但功耗/热超预算，整体仍为未通过；
- 统计正常、P95和峰值功耗；
- 单Die、单MC、单Link故障后的TPS均有结果。

### A12：Verification

负责检查：

- TPS公式和单位；
- 观测状态；
- model/TP/MC维度完整性；
- 基线链接；
- P0/P1隔离；
- 结果是否由真实输入生成。

验收：

- 18个观测位置无重复或缺失；
- 任何空TPS必须有PENDING或BLOCKED状态；
- 任何MODEL_OBSERVED必须有source和sourceSelector；
- 任何SILICON_OBSERVED必须有环境、重复次数和测量误差。

### A13：Report Publisher

生成：

```text
reports/multi_model/tps_observation_matrix.html
reports/multi_model/tps_by_model.csv
reports/multi_model/tps_by_tp.csv
reports/multi_model/tps_bottleneck_breakdown.json
```

报告至少包含：

- 三模型TPS对比；
- TP8/TP16/TP32趋势；
- MC320/MC640对比；
- 1000目标线；
- 1050架构门槛线；
- 空值与blocker状态；
- TPS、延迟、带宽、功耗联合视图。

## 7. TPS变化的判读规则

### 7.1 结果提升必须有原因

每次TPS提升至少绑定一类可观测变化：

```text
compute cycle ↓
memory bytes ↓
sustained bandwidth ↑
SRAM hit rate ↑
NoC queue wait ↓
collective latency ↓
expert load balance ↑
index cache hit rate ↑
MTP acceptance ↑
```

否则只能标为`UNEXPLAINED`，不能进入架构baseline。

### 7.2 结果下降必须保留

TPS下降不是测试失败，应保留并标记原因，例如：

- TP从32降低到16/8导致权重或state复制；
- collective比例增加；
- MC热点增大；
- index cache容量不足；
- Expert Dispatch跨Die/跨Package增加；
- MTP rollback增加；
- thermal throttle触发。

### 7.3 目标判定

| TPS结果 | 判定 |
|---:|---|
| `<1000` | 未达到产品目标 |
| `1000–1049.99` | 达到目标但未达到架构冻结门槛 |
| `≥1050` | 达到架构冻结门槛，仍需检查PPA、P99和RAS |
| 空值 | 未完成模型回放或配置被阻塞 |

## 8. G4签核条件

G4不能只看单个最高TPS，而需要同时满足：

1. K3、GLM-5.2、DeepSeek-V4-Pro均有独立TPS结果；
2. TP8、TP16、TP32的结果均可解释；
3. MC profile、physical profile和seed明确；
4. 三个模型的目标和门槛判定分别完成；
5. 关键结果有P50/P95/P99和瓶颈分解；
6. TPS提升没有隐藏缩放因子；
7. 功耗、热、面积、P99和RAS全部通过；
8. 没有用K3结果替代另外两个模型的结论。

在当前状态下，TPS是架构观测指标，但GLM-5.2和DeepSeek-V4-Pro尚未完成可执行模型回放，因此不能宣称三模型已经达标。