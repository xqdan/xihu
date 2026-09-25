# 算子与 Tile 级模拟计划

## 1. 目标

建立能回答以下问题的可执行模型：

- 每个算子如何切成 tile；
- tile 在 L/H/Vector/TMA/Collective 上何时运行；
- 每个 tile 读写哪些 SRAM bank、NoC link 和 MC channel；
- 哪些传输可与计算重叠；
- partial-ready 在什么数据到达后真正可启动；
- P50/P95/P99 token latency；
- 物理 320 GB/s MC 下距离 1000 TPS 还差多少；
- 规格变化对面积、功耗和 TPS 的真实影响。

## 2. 当前模型已有能力

[`integration/detailed/k3_operator_sram_sim.js`](../../integration/detailed/k3_operator_sram_sim.js)
已经提供：

- 93 层 operator graph；
- weight、KV、state、prediction 和 writeback job；
- weight tile、KV tile、head tile；
- SRAM 容量和对象生命周期；
- DMA/compute/collective 离散事件；
- TMA、Local SRAM、Shared SRAM、NoC、MC 和链路带宽上限；
- online-softmax m/l/O；
- 预测命中/误读/淘汰；
- layer/operator 时间账。

这是良好起点，但还不是签核级模型。

## 3. 当前需要移除的经验项

Final Tuning 中以下优化主要以乘法缩放实现：

- matrix utilization 0.88；
- attention fusion；
- MoE token packing；
- Wup/router fusion；
- tile partial-ready；
- phase fusion；
- hierarchical/direct reduce；
- local port read/write scale；
- launch batching。

下一版必须把它们替换为：

- 明确的 fused operator graph；
- 明确的 tile 数和 shape；
- 明确的端口占用周期；
- 明确的 packet/request；
- 明确的依赖和可重叠窗口；
- 明确的资源冲突。

## 4. 签核级模型层次

### L0：解析模型

- FLOP/byte/capacity；
- 设计空间早期筛选；
- 允许使用利用率，但不得用于最终通过。

### L1：Operator/Tile 离散事件

- 当前主模型升级版；
- 精确 tile DAG；
- resource reservation；
- bank/slice/link/VC；
- 可作为架构 KPI 主模型。

### L2：NoC/MC/RDMA transaction model

- packet、credit、queue、replay；
- 与 L1 co-simulation；
- 校准通信和 DMA。

### L3：Kernel cycle model

- Tensor/Vector/TMA pipeline；
- 关键 kernel：QK/PV、softmax、expert、state update；
- 校准 L1 的 service time。

### L4：RTL/emulation trace

- 单元 RTL 和 FPGA/仿真器；
- 回放相同 tile trace；
- 架构冻结后持续回归。

## 5. 精确算子图

必须从模型清单生成，不再使用“每四层一个 Softmax”近似。每层记录：

- Attention 类型和完整投影矩阵；
- q/k/v/o shape；
- Linear Attention state；
- MoE/dense 类型；
- expert 路由、shared expert；
- dtype 和 accumulation；
- collective 边界；
- residual/norm/fusion 合法性。

Attention 投影不能继续只用 active-parameter residual 拟合。

## 6. Tile 维度扫描

至少扫描：

- weight tile：1/2/4/8 MiB；
- KV tile：1K/2K/4K/8K/16K token；
- head tile：8/16/32/48/96；
- expert token tile：1/2/4/8；
- partial stripe：4/16/64 KiB；
- prefetch/overlap depth：0–4；
- Local/Shared buffer 数：2–4。

每个候选必须报告：

- Tensor fill；
- Vector fill；
- Local bank conflict；
- Shared slice conflict；
- TMA/NoC/MC service；
- collective tail；
- live SRAM；
- energy/token。

## 7. 真实运行场景

### 必测主场景

- B=1，Context=1M，TP32，Decode；
- 24 个 Softmax MLA 层；
- 69 个 Linear Attention 层；
- 92 个 MoE 层；
- Final LM Head。

### 敏感性

- Context：32K/128K/1M/2M；
- Batch：1/2/4/8；
- MC：320/更高带宽；
- dense dtype：BF16/FP8；
- 路由分布：均匀/热点/最坏；
- MC/Die/链路故障；
- Prefill 并发；
- 热降频；
- P99 重放。

## 8. 校准顺序

1. 通过 reference kernel 或 GPU trace 校准 FLOP/byte；
2. 通过 Tensor/Vector cycle model 校准 Core；
3. 通过 SRAM bank model 校准 TMA；
4. 通过 packet model 校准 NoC；
5. 通过 MC vendor model/样片校准内存；
6. 通过 RDMA transaction model 校准 collective；
7. 用整 token trace 关闭时间守恒；
8. 比较解析、tile、transaction、RTL 四层误差。

## 9. 性能通过标准

架构冻结前：

- 使用可实现 MC 规格；
- 不使用未解释的全局缩放因子；
- B=1/1M/TP32 达到至少 1050 TPS/usr；
- P99 不低于 1000 TPS/usr；
- 所有资源利用率和队列深度可实现；
- SRAM 至少 15% 可用工程余量；
- 卡功耗至少 10% 架构余量；
- 多 seed/多路由 trace 均通过；
- 结果由独立回归测试复算。
