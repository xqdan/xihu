# Arithmetic Intensity / Roofline / Compute Sizing Agent

## 1. 目的

本 agent 负责把三模型的 workload 假设转换为可审计的：

```text
operator FLOP/token
operator bytes/token
arithmetic intensity = FLOP / byte
TP/CP/EP 切分后的 I_MC 与 I_network
Roofline classification
required effective FLOPS
required peak FLOPS
L/H/Vector/Indexer/Reduce sizing
```

它是 `A3 Compute Die / AI Core` 与 `A10 Performance Integration` 的共享输入，不负责替代事件级 simulator，也不把未确认的模型配置当作最终规格。

## 2. 参考设计来源

本 agent 以 repo 外层已有文档为方法参考：

```text
references/frontier_moe_arithmetic_intensity.html
```

该文档的关键规则已转化为机器可读 contract：

1. **线性 GEMM**：TP 切权重时 FLOP 与权重 bytes 同比例切分，基础 `I` 近似不随 TP 变化；Prefill 通过本地 token 数 `S/CP` 放大 I。
2. **MLA/MQA/DSA/CSA 注意力**：不能把 KV 按 attention head 简单切分；TP 主要切 Q/head，注意力 FLOP 与流量必须分别建模。
3. **Decode**：dense 权重、KV/state、routed expert、通信 payload 分开记账；routed expert 的权重读取按 unique expert 数量和 batch/route 统计。
4. **Prefill**：使用 `S`、`TP`、`CP`，显式区分本地权重、KV 读写、TP collective、CP KV exchange。
5. **Vector**：RMSNorm、residual、SiLU、RoPE、Softmax/LSE、KDA/state update 不应被误塞进 Tensor roofline。
6. **Roofline**：对 L/H/Vector/Indexer/Reduce 分别给出带宽墙、算力墙和 ridge point；不能只输出一个全芯片 FLOP 数。
7. **Sizing**：`required_effective_flops = workload_flops / target_time`；`required_peak = required_effective / utilization / duty_cycle`，并保留 headroom、PD bandwidth share 和 thermal cap。

## 3. 输入与输出

### 输入

- `teams/model/inputs/model_profiles.json`
- `teams/model/inputs/multi_model_tp_matrix.json`
- `teams/council/inputs/arithmetic_intensity_contract.json`
- 模型逐层 manifest（若缺失，输出 `BLOCKED_CONFIG`）
- 芯片资源（唯一硬件规格 P1、MC320/MC640、L/H/Vector peak，均取自 `k3_mc_baseline.json`）
- 参考文档中的模型专用 attention 参数（必须标记 source class）

### 输出

主结果：

```text
teams/council/inputs/arithmetic_intensity_results.json
```

每条结果必须包含：

```text
run_id
model_id
phase: decode | prefill
context_tokens / prefill_tokens
batch
tp / cp / ep
physical_profile
mc_profile
operator_id / operator_class
core_class: L | H | V | INDEXER | REDUCE
flops
bytes: weight / kv_state / index / expert / collective / metadata / total
arithmetic_intensity
network_intensity
roofline_bound: bandwidth | compute | communication | blocked
required_effective_flops
required_peak_flops
ridge_point
assumptions
source_refs
confidence: E0 | E1 | E2 | E3
status
```

聚合结果还必须输出：

- 每模型×TP8/16/32 的 decode breakdown；
- 每模型×TP/CP 的 prefill breakdown；
- 每个 core class 的最大需求；
- `required_peak / available_peak`；
- bottleneck 与阻塞字段；
- 供 A10 使用的 `sizingSummary`。

## 4. 明确的公式

### 4.1 基础算术强度

```text
I_MC = FLOP / memory_bytes
I_network = FLOP / (memory_bytes + collective_bytes)
```

字节必须是实际传输字节，不是参数数量；必须注明 raw、sustained 或 effective。

### 4.2 Roofline

对于资源域 `r`：

```text
ridge_r = effective_peak_flops_r / sustained_bandwidth_r
roofline_perf_r = min(effective_peak_flops_r, I_r * sustained_bandwidth_r)
```

PD 并行时，带宽份额为 `share_r`：

```text
sustained_bandwidth_r = package_bandwidth * share_r * efficiency
ridge_r = peak_r / sustained_bandwidth_r
```

### 4.3 Required compute sizing

目标 TPS 为 `T=1000 tokens/s/user` 时：

```text
target_time_us_per_token = 1e6 / T = 1000 us
required_effective_flops = flops_per_token * T
required_peak_flops = required_effective_flops / utilization / duty_cycle
```

对于 operator 或阶段存在并发份额 `q`：

```text
required_peak_flops = required_effective_flops / (utilization * duty_cycle * q)
```

注意：如果 bytes 约束给出的时间大于目标时间，则应标记 `bandwidth_blocked`，不能通过增加 peak FLOPS 掩盖。

### 4.4 TP/CP/EP

- 线性权重 GEMM：`FLOP_rank = FLOP / TP / CP`，`weight_bytes_rank = weight_bytes / TP`。
- Prefill 本地 token：`S_local = S / CP`。
- MLA/MQA：KV 不按 Q head 简单除 TP；attention FLOP/traffic 由 attention family 单独计算。
- Routed MoE：权重 bytes 由 resident/unique expert 与 route token 统计决定；必须同时输出 `active_experts`, `unique_experts`, `capacity_overflow`。
- Network bytes：all-reduce、all-gather、all-to-all、dispatch/combine 分开列出，禁止用单一 `log2(TP)` 倍数替代事件模型。

## 5. Agent 工作流

```text
load profile
  -> validate manifest/config
  -> expand operator inventory
  -> apply TP/CP/EP sharding rules
  -> calculate FLOP and byte ledger
  -> calculate I_MC / I_network
  -> classify Roofline per resource class
  -> calculate required effective/peak FLOPS
  -> aggregate model/TP/phase sizing
  -> emit JSON + markdown/CSV report
  -> run consistency tests
```

### 并行子 agent

| 子 agent | 交付 | 量化验收 |
|---|---|---|
| AI-INT-A1 Manifest Adapter | 三模型输入适配、配置状态 | 每个 model 缺字段自动 BLOCKED，不静默补值 |
| AI-INT-A2 Operator Ledger | 各算子 FLOP/bytes | 每个 operator 有 unit、dtype、source、FLOP/bytes |
| AI-INT-A3 TP/CP/EP Sharder | 切分和通信 | TP8/16/32、CP1/8/16/32 可生成 rank ledger |
| AI-INT-A4 Roofline Engine | L/H/V/Indexer/Reduce roofline | 输出 ridge、bound、effective peak、带宽墙 |
| AI-INT-A5 Compute Sizer | 算力规模建议 | 输出 required/available/ratio/headroom |
| AI-INT-A6 Verification | 守恒和负例 | 单位、TP、FLOP、bytes、版本、状态检查 |
| AI-INT-A7 Report Publisher | 报告 | JSON、CSV、Markdown 与 run_id 对齐 |

## 6. 当前配置的阻塞策略

GLM-5.2 和 DeepSeek-V4-Pro 当前仍为 planning / pending config。agent 可以产生 **planning estimate**，但必须：

- `status = BLOCKED_CONFIG` 或 `PLANNING_ESTIMATE`；
- `confidence <= E1`；
- 所有公开/推导参数写入 `assumptions`；
- 不允许进入 G4 sign-off；
- 不允许覆盖 K3 的 E2 事件级结果。

K3 若没有冻结 dtype、正式层级和 KV/state layout，也只能是 `MODEL` baseline，不能伪装成 `FROZEN`。

## 7. Definition of Done

- 三模型均可加载，配置缺口可审计；
- 9 个 model×TP case 均能生成 ledger 或明确 blocked；
- decode 输出 TP8/16/32 的 FLOP、bytes、I_MC、I_network、Roofline 和 sizing；
- prefill 至少覆盖 CP1/8/16/32、TP1/8/16/32 的矩阵；
- L/H/Vector/Indexer/Reduce 独立输出；
- arithmetic intensity 守恒：聚合 FLOP/bytes 等于 operator ledger；
- 资源只取自唯一规格文件，MC320/MC640 不混淆；
- `npm test`、专用 arithmetic intensity test 和 `git diff --check` 全部通过；
- 结果包含 manifest version、contract version、source commit、seed/run_id。

## 8. 禁止事项

- 不使用单一 `2 * parameter_count` 代替所有 attention/MoE/communication 细节；
- 不把 raw bandwidth 当 sustained bandwidth；
- 不把 MC640 的模型内 sizing 当成可制造路线结论；
- 不把未确认 GLM/DeepSeek 配置标记为 final；
- 不用 `log2(TP)` 单独代替 collective traffic；
- 不把 Vector/Indexer/Reduce 的需求隐藏到 Tensor peak；
- 不用经验 utilization 缩放因子而不记录来源。
