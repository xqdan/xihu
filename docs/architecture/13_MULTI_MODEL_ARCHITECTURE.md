# K3 / GLM-5.2 / DeepSeek-V4-Pro 多模型架构调整

版本：2026-09-21  
状态：`BASELINE / MULTI-MODEL EXPANSION`

## 1. 调整结论

原设计不再是只针对K3的专用推理架构，而调整为：

```text
一个7-reticle package物理平台
  + 一个统一的Workload Manifest / Tile IR / Transaction IR
  + 三类模型执行Profile
    ├── K3 engineering preset
    ├── GLM-5.2
    └── DeepSeek-V4-Pro
```

K3仍然是当前主性能目标；GLM-5.2和DeepSeek-V4-Pro成为必须进入架构、存储、互联、调度、性能和验证流程的第二、第三工作负载。三者不能共享一个“平均模型参数”，必须保留逐模型的DAG、状态、路由、带宽和尾延迟结果。

**重要状态说明**：GLM-5.2和DeepSeek-V4-Pro的公开资料只能作为架构输入基线，不能替代授权权重、正式配置文件、部署dtype和供应商签核。相关数字在本项目中标为`MODEL_PENDING_CONFIG_CONFIRMATION`，直到A1完成正式manifest冻结。

**部署决定（2026-09-25）**：三个模型的FFN/MoE（dense FFN、shared expert、routed expert）全部按TP部署（TP-only）。每个expert都按TP rank切分，没有expert parallelism，也没有all-to-all dispatch/combine；每层FFN/MoE输出只做一次TP all-reduce。本文中涉及EP、token dispatch/combine、expert home和expert all-to-all的要求，均按此决定改写或标为不适用。

## 2. 统一性能政策

| 项目 | K3 | GLM-5.2 | DeepSeek-V4-Pro |
|---|---:|---:|---:|
| 初始目标TPS/usr | 1,000 | 1,000（规划目标） | 1,000（规划目标） |
| 架构冻结门槛 | ≥1,050 | ≥1,050（待产品确认） | ≥1,050（待产品确认） |
| Raw latency budget | ≤854.70 µs/token | ≤854.70 µs/token（待确认） | ≤854.70 µs/token（待确认） |
| Batch | 1 | 1 | 1 |
| Context | 1M token | 1M token | 1M token |
| TP / PP | TP32 / PP1 | TP32 / PP1 | TP32 / PP1 |
| 结果状态 | 当前baseline | 新增baseline | 新增baseline |

如果产品最终不要求GLM-5.2或DeepSeek-V4-Pro达到1,000 TPS/usr，必须在A0的KPI ADR中显式修改，而不能通过模型专属的隐藏缩放因子规避。

## 3. 新增工作负载差异

### 3.1 K3

K3继续使用当前仓库的93层工程preset和唯一硬件规格（P1，ADR-0021）。K3 的唯一形状来源是 `teams/model/src/design_engine.js#MODEL_PRESETS.kimiK3`，正式 manifest 由它约束（`tests/regression/test_k3_manifest_consistency.js`）；MC640 的 Final Tuning 发布点（见 `00_CURRENT_STATE.md` 第 3 节）是 `MODEL` 等级。

K3重点验证：

- 异构L/H Core；
- Linear Attention和LSE `m/l/O`；
- MoE/Router；
- package-local reduce和TP32 collective；
- 1M context下的KV/state和Decode流水线。

### 3.2 GLM-5.2

公开模型卡给出的架构输入包括约753B参数、1M context、IndexShare长上下文机制和MTP相关信号。项目不把公开报告中的FLOP下降或接受率直接当作硬件收益，而要求分别建模：

1. indexer计算；
2. index cache容量；
3. index cache hit/miss；
4. token-to-index复用；
5. MTP分支计算；
6. 接受/拒绝后的rollback和commit；
7. index cache与KV/state的带宽竞争。

GLM新增硬件需求：

- 支持可配置index cache，而不是只支持标准KV cache；
- 支持多候选token的分支调度和提交/回滚；
- 支持稀疏访问的TMA descriptor和非连续layout；
- 支持indexer、attention、router在同一NoC上的QoS隔离；
- 支持index cache P95/P99命中率和容量敏感性报告。

### 3.3 DeepSeek-V4-Pro

公开发布资料和配置快照给出的架构输入包括约1.6T总参数、约49B active参数、1M context、61层、384 routed experts、每token激活6个routed experts、1个shared expert，以及稀疏attention/indexer路径。项目必须把这些信号转为可执行的TP切分expert算子和sparse attention transaction，而不是只乘一个MoE利用率系数。

DeepSeek新增硬件需求：

- FFN/MoE为TP-only：384个routed expert每个都按TP rank切分，不做expert parallelism，不引入all-to-all dispatch/combine；
- 每个rank每token读取6个routed expert + 1个shared expert的本rank切片，按rank的expert切片宽度（expert hidden / TP）评估matmul效率；
- 6 routed experts + 1 shared expert的路径必须显式出现在DAG；
- FFN/MoE输出每层一次TP all-reduce，与K3相同进入RDMA/collective；
- FP8/FP4 expert weight路径要显式计算dequant、accumulation和格式转换成本；
- sparse attention indexer的状态与KV/state分开计费。

## 4. 物理平台不变但必须扩展的能力

| 子系统 | K3已有能力 | 多模型新增要求 |
|---|---|---|
| Compute Die | L/H Core、Tensor、Vector | Indexer Core/Vector模式、MTP分支、FP8/FP4 dequant、窄expert切片matmul |
| SRAM/TMA | Local/Shared SRAM、TMA | KV cache、index cache、expert staging buffer三种buffer class隔离 |
| MC | 16 MC、320/640 GB/s profile | expert weight streaming、long-context state、index cache miss三类带宽预算 |
| NoC | Data/Control/Collective | Indexer、Router独立QoS/VC（TP-only，无MoE all-to-all流量） |
| Package Fabric | 8 Die 4×2 mesh候选 | expert切片在Die间的布局与locality-aware routing（无跨Die token dispatch） |
| RDMA/Collective | TP32 mailbox、reduce、LSE | indexer top-k merge、MTP commit/rollback（无all-to-all、dispatch/combine） |
| Scheduler | Tile IR、persistent decode | 多分支token DAG、MTP accept/reject、expert capacity reservation |
| Performance | K3 P1回归 | 三模型分开回放，输出bytes、FLOP、hit rate、load balance和P99 |
| PPA/RAS | 面积/功耗/热预算 | 最坏模型取值、expert hotspot、cache容量切换、动态功耗峰值 |

## 5. Agent调整矩阵

### A0：架构集成

新增交付：

- `teams/council/adr/README.md`新增多模型KPI ADR；
- 三个model profile版本和证据等级；
- 每个模型的blocker和产品确认项；
- 统一报告格式：`model_id × physical_profile × mc_profile`。

量化验收：

- 三个模型均有独立profile；
- 所有关键KPI能够反查到模型ID；
- 任何报告不允许出现未标注模型的TPS；
- GLM/DeepSeek的公开资料与正式配置差异全部进入OPEN issue。

### A1：Workload / Model Manifest

新增交付：

```text
teams/model/inputs/model_profiles.json
docs/architecture/workload/K3_MANIFEST.md
docs/architecture/workload/GLM_5_2_MANIFEST.md
docs/architecture/workload/DEEPSEEK_V4_PRO_MANIFEST.md
docs/architecture/workload/MULTI_MODEL_SCHEMA.md
```

量化验收：

- K3：93/93层可生成DAG；
- GLM-5.2：1M context、indexer/index cache、MTP字段完整；
- DeepSeek-V4-Pro：61层、384 routed experts、6 active routed experts、1 shared expert、indexer字段完整；
- 每个模型至少3个代表性trace：long-context attention、TP-only MoE（router + expert切片）、decode commit；
- 所有模型的FLOP、bytes、state bytes、expert bytes和tile count可逐层输出。

### A2：Package / Floorplan

新增交付：

- expert home和index cache home的坐标规划；
- 384 expert逻辑ID到die/MC/NUMA的映射接口；
- GLM index cache和DeepSeek indexer的带宽/PHY需求清单。

量化验收：

- K3、GLM、DeepSeek的最坏package traffic都能映射到8 Die/16 MC；
- expert/indexer热点不能导致任意单一MC长期负载超过平均值1.25倍；
- 5,248 mm²面积守恒保持不变。

### A3：AI Core

新增执行类型：

```text
DENSE_GEMM
MOE_ROUTER
EXPERT_GEMM
SPARSE_INDEXER
MTP_DRAFT
MTP_VERIFY
DEQUANT_FP8_FP4
ROLLBACK_COMMIT
```

量化验收：

- 每种执行类型都有cycle model和资源占用；
- FP8/FP4 dequant和accumulation不得使用零成本假设；
- MTP accept/reject的两条路径都能回放；
- router选中expert的均匀与热点两种场景都能回放（TP-only下热点只影响expert复用，不产生跨rank负载不均）。

### A4：SRAM / TMA

新增buffer class：

```text
KV_STATE
SPARSE_INDEX_CACHE
EXPERT_STAGING
MTP_BRANCH_STATE
```

量化验收：

- 96 MiB/Die物理容量不变，但四类buffer的容量、优先级、eviction、ECC和生命周期必须可配置；
- index cache hit rate目标≥90%，实际值必须按模型报告；
- expert staging buffer的P95等待、重用率和溢出次数必须输出；
- MTP rollback不产生stale buffer或epoch错误。

### A5：Memory Cube / MC

新增带宽分解：

```text
KV/state streaming
+ index cache miss
+ expert weight streaming
+ checkpoint/rollback metadata
```

量化验收：

- 每个模型输出MC320和MC640两套结果；
- 读写、权重、state、index四类bytes分开计账（TP-only，无dispatch bytes）；
- sustained payload不得直接等于raw payload；
- 320 GB/s无法达到模型门槛时，必须给出byte reduction或替代MC路线。

### A6：Die-local NoC

新增网络流量类别：

```text
INDEXER
ROUTER
MTP_CONTROL
```

EXPERT_DISPATCH / EXPERT_COMBINE 不适用：FFN/MoE为TP-only，没有all-to-all。

量化验收：

- 新增流量至少有独立VC/QoS类别；
- Decode critical path的P99 queue wait不被indexer/router流量拖过预算；
- Router在最坏热点下无deadlock、credit underflow和priority inversion。

### A7：Package Fabric

新增路由语义：

- expert切片在8 Die上的布局（TP-only，每个expert都切分，无expert home）；
- index cache home；
- reduce返回路径；
- 单Die/单MC故障后的expert切片remap。

量化验收：

- 384 expert的TP切片可映射到8 Die；
- 单故障状态下不产生丢token、重复reduce或stale epoch。

### A8：RDMA / Collective

新增协议：

```text
MTP_DRAFT
MTP_VERIFY
MTP_COMMIT
MTP_ROLLBACK
```

量化验收：

- indexer top-k merge、MTP commit/rollback均进入transaction trace（TP-only，无all-to-all、dispatch、combine）；
- duplicate、lost ACK、stale epoch和重复token merge为0；
- collective效率、tail latency和replay次数按模型分别统计。

### A9：Tile IR / Scheduler

新增IR字段：

```text
model_id
expert_id
expert_capacity
index_cache_key
candidate_token_group
accept_mask
rollback_epoch
precision_path
```

量化验收：

- 三个模型都能生成合法Tile IR；
- MTP accept/reject、expert overflow和sparse index miss均可表达；
- 一个decode step不依赖host逐token/逐expert启动；
- 所有未映射tile、expert和candidate token数量为0。

### A10：Performance Integration

新增结果矩阵：

```text
3 models × 2 physical profiles × 2 MC profiles × 5 seeds
```

至少输出：

- TPS/usr；
- raw/e2e/P50/P95/P99 latency；
- FLOP和effective FLOP；
- KV/state/index/expert bytes；
- SRAM peak和各buffer occupancy；
- MC sustained payload；
- expert load balance；
- index cache hit rate；
- MTP acceptance、rollback和收益；
- 功耗和热峰值。

量化验收：

- K3 P1继续复现 `teams/hardware/inputs/k3_mc_baseline.json#modelResults` 中的 MC320 与 MC640 两点；
- 三模型均给出≥1,050 TPS/usr是否达标的明确结论；
- 未达标时按memory、indexer、expert、NoC、RDMA、Core、thermal分解；
- 经验缩放因子为0。

### A11：PPA / Thermal / RAS

新增最坏场景：

- DeepSeek 384 expert热点；
- GLM index cache miss峰值；
- MTP verify与主Decode重叠；
- FP4/FP8 dequant高峰；
- 1M context state刷新。

量化验收：

- 仍满足400 mm²/Die、250 W/Die、3,200 W/package envelope；
- expert、indexer、dequant和MTP功耗单列；
- 至少输出三模型各自平均、P95和峰值功耗；
- 任何模型的热/功耗超预算必须阻断G4签核。

### A12：Verification

新增回归：

- 每模型至少3个golden trace；
- 每模型至少1个端到端decode step；
- DeepSeek router热点（TP-only，无dispatch overflow）；
- GLM index cache miss和MTP rollback fault；
- K3 LSE m/l/O和现有RDMA replay回归。

量化验收：

- 三模型结果都在唯一硬件规格上（`singleHardwareSpec`）；
- 每个公共接口至少有正向、背压、超时、重放和故障测试；
- 需求追踪覆盖率G4达到100%。

### A13：Report Publisher

新增报告：

```text
reports/multi_model/model_matrix.html
reports/multi_model/<model_id>_memory_breakdown.json
reports/multi_model/<model_id>_expert_ffn.json
reports/multi_model/<model_id>_latency_p99.json
```

量化验收：

- 所有表格带model_id、physical_profile、mc_profile、schema version和seed；
- GLM和DeepSeek的公开资料、配置快照和未确认字段在报告中分栏显示；
- 任何数字没有证据链接时自动标记OPEN。

## 6. 新增测试和目录

```text
teams/model/inputs/model_profiles.json

docs/architecture/13_MULTI_MODEL_ARCHITECTURE.md
docs/architecture/workload/

models/index_cache/
models/expert_ffn/
models/mtp_scheduler/

src/workload/
src/scheduler/

reports/multi_model/
tests/regression/test_multi_model_profiles.js
```

初始版本只新增schema和profile contract test，不伪造GLM或DeepSeek的完整性能结果。完整模型回放必须在取得正式配置、权重抽象或供应商部署规格后进行。

## 7. 调整后的并行波次

### W1：模型输入并行

- A1建立三个manifest；
- A2建立expert/index cache home映射；
- A12建立三模型profile和字段负测试；
- A13建立多模型报告模板。

### W2：执行能力并行

- A3增加SPARSE_INDEXER、EXPERT_GEMM、MTP和FP4/FP8路径；
- A4增加KV、index cache、expert staging、MTP branch buffer；
- A5增加expert weight、index miss byte模型；
- A6/A7/A8增加indexer和MTP控制流（FFN/MoE为TP-only，无all-to-all）；
- A9扩展Tile IR和多分支调度。

### W3：三模型回放并行

- A10执行3×2×2×5的结果矩阵；
- A11执行三个模型的最坏PPA/thermal；
- A12执行模型特有故障和跨模型回归；
- A0根据结果决定共享硬件、可选硬件和软件fallback边界。

## 8. 新增架构决策点

在G4前必须回答：

1. index cache是独立SRAM slice、共享SRAM分区，还是MC cache？
2. 384 expert的TP切片在8 Die上如何布局？（已决定TP-only，不做expert home）
3. MTP是每个H Core本地执行，还是独立共享engine？
4. FP4/FP8 dequant放在Tensor Core前、SRAM入口还是MC controller？
5. ~~expert all-to-all是package内优先，还是直接使用TP32 scale-out？~~ 已决定（2026-09-25）：FFN/MoE为TP-only，无all-to-all。
6. 三模型共用一套Tile IR，还是通过model-specific lowering扩展？
7. K3的1000 TPS/usr是否正式推广为GLM-5.2和DeepSeek-V4-Pro的同等目标？
8. 公开模型卡与正式配置不一致时，哪个版本进入签核？

任何未回答项必须进入`OPEN_ISSUES.md`，不能在性能报告中静默假设。

## 9. 当前结论

7-reticle、8 Compute Die、16 MC、硬件规格不需要因为增加模型而立即修改；但是计算单元、SRAM/TMA、NoC、Package Fabric、RDMA、Scheduler和验证体系必须从“K3专用”升级为“多模型可配置”。

最重要的结构性变化是：

```text
从：K3 的普通 Attention + MoE + KV/state
到：K3 + IndexShare/Indexer + DeepSeek Sparse Attention
   + 384-expert TP-only MoE + MTP + FP8/FP4 Precision Path
```

在A10完成三模型事件级回放前，不能声称当前硬件规格同时满足三个模型的1,000 TPS/usr目标。
## 10. TP8 / TP16 / TP32 测试矩阵

机器可读用例位于：

```text
teams/model/inputs/multi_model_tp_matrix.json
```

当前版本包含9个基础用例：

```text
3 models × 3 TP modes = 9 cases
```

| Model | TP8 | TP16 | TP32 | 特有检查 |
|---|---|---|---|---|
| K3 | `K3-TP8-DECODE-1M` | `K3-TP16-DECODE-1M` | `K3-TP32-DECODE-1M` | Linear Attention、LSE `m/l/O`、MoE、persistent decode |
| GLM-5.2 | `GLM-5.2-TP8-DECODE-1M` | `GLM-5.2-TP16-DECODE-1M` | `GLM-5.2-TP32-DECODE-1M` | index cache、sparse index、MTP、rollback |
| DeepSeek-V4-Pro | `DeepSeek-V4-Pro-TP8-DECODE-1M` | `DeepSeek-V4-Pro-TP16-DECODE-1M` | `DeepSeek-V4-Pro-TP32-DECODE-1M` | TP-only expert（384 expert、top-6）、indexer、FP8/FP4路径 |

### 10.1 统一测试输入

每个测试用例固定：

```text
batch = 1
context = 1,048,576 token
decode tokens = 1
PP = 1
physical profile = P1-compact-executable
MC profiles = MC320, MC640
seed = 11, 23, 47, 89, 131
```

测试目标不是直接伪造TPS结果，而是先确认三模型在不同TP规模下的：

- manifest和Tile IR可生成；
- package/die/MC拓扑计算正确；
- Tensor/KV/Expert/Index分片语义一致；
- Collective和MTP事件可表达；
- P50/P95/P99、带宽、SRAM、功耗等结果具有统一输出字段。

### 10.2 TP拓扑量化

本项目约定1个7-reticle package对应1个TP rank，因此：

| TP | Package | Compute Die | MC | Data SRAM | MC容量 | Scale-out aggregate target |
|---:|---:|---:|---:|---:|---:|---:|
| 8 | 8 | 64 | 128 | 6,144 MiB | 2,048 GB | 6.4 TB/s |
| 16 | 16 | 128 | 256 | 12,288 MiB | 4,096 GB | 12.8 TB/s |
| 32 | 32 | 256 | 512 | 24,576 MiB | 8,192 GB | 25.6 TB/s |

其中每个package保持：

```text
8 Compute Die
16 MC
768 MiB data SRAM
256 GB primary MC capacity
800 GB/s package scale-out target
```

### 10.3 测试退出条件

- 9个用例全部能被JSON loader读取；
- 每个模型恰好包含TP8、TP16、TP32三个用例；
- 拓扑守恒检查通过：`packages = TP`、`dies = TP × 8`、`MC = TP × 16`；
- K3用例必须启用LSE merge，禁用index cache和MTP branch；
- GLM-5.2用例必须启用index cache、MTP branch和rollback；
- 所有用例的expert权重为`tensor_parallel`、`expertDispatch = false`（TP-only，无EP）；DeepSeek-V4-Pro用例检查384 expert和每token 6 active expert字段；
- 后续A10性能模型必须对9个用例分别输出TPS、raw/e2e latency、P50/P95/P99、MC payload和SRAM peak；
- 任一用例未能生成事件级trace时，不得宣称该TP规模已通过架构验证。
