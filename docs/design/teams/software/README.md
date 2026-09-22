# Software Team

## Mission
负责模型部署、编译器/运行时映射和优化策略，把模型算子和硬件规格转成可执行 schedule，并量化软件收益及其代价。

## Agents

| Agent | 职责 | 输入 | 输出 | 关键约束 |
|---|---|---|---|---|
| SW-01 Deployment/Runtime | serving、batch=1 decode、KV/state、host/device control | model manifest、HW ABI | deployment spec、runtime state machine | 不改变硬件规格；记录 launch/firmware overhead |
| SW-02 Compiler/Graph | graph lowering、layout、sharding、TP/CP/EP mapping | operator DAG、HW ISA/Tile IR | compiler lowering、schedule IR | 每次变换可追踪、可回放 |
| SW-03 Kernel Optimization | GEMM/attention/MoE/indexer/vector kernel mapping | shapes、dtype、AI Core spec | kernel catalog、cycle assumptions | dequant、padding、sparsity 单独记账 |
| SW-04 Fusion | 常见融合算子：QKV、RoPE+attention、RMSNorm+linear、MoE gate+dispatch、dequant+GEMM、MLP chain | operator DAG、memory ledger | fusion candidates、合法性和收益 | 记录 alias、精度、workspace、fallback |
| SW-05 Collective/Comm-Compute | all-reduce、reduce-scatter、all-gather、all-to-all 与 GEMM/attention overlap | NoC/MC topology、collective bytes、kernel timing | overlap schedule、packet/kernel dependency | overlap 不能重复计算；通信资源独立 |
| SW-06 Scheduler/Serving | persistent decode、prefetch、double buffer、MTP、queue/QoS | kernel/collective/memory events | critical path、runtime policy | MTP acceptance/rollback；P50/P95/P99 |
| SW-07 Software KPI/Profiler | profiling schema、software gain budget、regression | traces、baseline、model scenarios | measured/estimated gain、profiling report | estimate 与 measured 分开；不可把收益写成 peak |

## Review and handoff
SW-01/02 定义部署路径，SW-03/04/05 形成优化候选，SW-06 合并成 schedule，SW-07 做收益和回归。结果交给 `ARCH-02/03` 和 `VV-*`。
