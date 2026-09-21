# Stage A 方向级架构运行报告

运行时间：2026-09-21 10:52:39  
Run ID：`stage-a-20260921105239`  
状态：`DIRECTIONAL_ESTIMATE / D-GATE BLOCKED`

## 1. 本次实际运行的流程

```text
D1 workload profile
  -> D2 memory/bandwidth envelope
  -> D3 compute/core envelope
  -> D4 communication envelope
  -> D5 7-reticle/package envelope
  -> D6 software assumptions
  -> D7 directional TPS sweep
  -> D-Gate evaluation
```

本次运行已经读取并使用：

- `data/workload/model_profiles.json`
- `docs/design/spec/k3_7r_package_baseline.json`
- `docs/design/spec/k3_mc_baseline.json`
- P0/P1 粗粒度 Compute Die profile
- MC320/MC640 方向级带宽 profile
- TP8/TP16/TP32 候选
- K3、GLM-5.2、DeepSeek-V4-Pro 三模型覆盖

## 2. 生成的机器可读结果

```text
data/direction/directional_resource_envelope.json
data/direction/directional_tps_scorecard.json
```

执行脚本：

```text
models/direction/run_directional_envelope.js
models/direction/run_directional_tps.js
```

## 3. 方向级资源结论

### 7-reticle package

| 项目 | 结果 |
|---|---:|
| Reticle 数量 | 7 |
| Placement window | 5248 mm² |
| Compute Die | 8 |
| Compute Die 面积 | 400 mm²/Die |
| Memory Cube | 16 |
| MC320 package payload | 5.12 TB/s raw planning payload |
| MC640 package payload | 10.24 TB/s raw stretch payload |
| Compute power budget | 2000 W |
| Cooling envelope | 3200 W |
| 面积守恒 | PASS |

面积守恒使用：

```text
8 × 400 + 16 × 100 + 448 = 5248 mm²
```

### 模型配置状态

| 模型 | 状态 | 方向级证据等级 |
|---|---|---|
| K3 | MODEL | E1 |
| GLM-5.2 | MODEL_PENDING_CONFIG_CONFIRMATION | E0 |
| DeepSeek-V4-Pro | MODEL_PENDING_LICENSE_AND_CONFIG_CONFIRMATION | E0 |

因此，本次结果只能作为架构方向估计，不能作为最终性能承诺。

## 4. 方向级候选结果

本次运行生成：

```text
36 个候选组合
```

组合维度：

```text
2 个 Compute Profile
× 2 个 MC Profile
× 3 个 TP Profile
× 3 个模型
```

Compute Profile：

```text
P1-compact
P0-7R-balanced
```

MC Profile：

```text
MC320
MC640
```

TP Profile：

```text
TP8
TP16
TP32
```

## 5. 当前排名靠前的候选

当前粗略模型排序结果中，排名前 3 的候选为：

```text
P1-compact-MC320-TP8
P1-compact-MC640-TP8
P0-7R-balanced-MC320-TP8
```

但是这三个结果目前**不能直接作为架构推荐**，原因是当前方向级估算使用了占位 workload 常数，并且尚未完成 sensitivity sweep。

特别需要注意：

- TP8 排名前靠前是当前粗略通信模型和 workload 常数共同造成的结果；
- 这不代表 TP8 一定优于 TP16/TP32；
- 当前模型没有完整表达三模型不同的 MoE routing、indexer、KV/state 和 collective payload；
- 必须经过 Q1 manifest 和 Q2 arithmetic ledger 后重新排名。

## 6. D-Gate 结果

| Gate 项目 | 状态 |
|---|---|
| 7-reticle area conservation | PASS |
| 三模型粗 TPS 覆盖 | PASS |
| Bottleneck classification | PASS（方向级） |
| Sensitivity sweep | BLOCKED |
| 候选数量不超过 3 | PASS |
| D-Gate 总体 | BLOCKED |

当前 D-Gate 状态：

```text
BLOCKED_PENDING_SENSITIVITY_SWEEP_AND_FORMAL_MANIFEST
```

## 7. 当前 blocker

### Blocker 1：方向级 workload 仍为占位常数

脚本当前使用的是方向级 workload class/placeholder：

```text
K3: 42 TFLOP/token, 5.36 TB/token
GLM-5.2: 48 TFLOP/token, 5.90 TB/token
DeepSeek-V4-Pro: 55 TFLOP/token, 6.40 TB/token
```

这些值不是逐算子事件级结果，不能用于最终 TPS 签核。

下一步必须由：

```text
Q1 -> Q2
```

生成正式 manifest 和 arithmetic ledger。

### Blocker 2：GLM-5.2 / DeepSeek-V4-Pro 配置未冻结

当前缺少正式的：

- 层数
- dtype
- expert count
- active experts/token
- KV/state layout
- MTP acceptance
- index cache 行为

因此只能生成 planning estimate。

### Blocker 3：Sensitivity sweep 尚未实现

必须至少扫描：

```text
bandwidth
frequency
core_count
collective_latency
software_gain
area
power
```

当前 D-Gate 不能通过。

### Blocker 4：通信仍属于方向级 envelope

当前仅使用方向级 collective latency envelope，尚未建模：

- packet/flit
- VC/credit
- queue contention
- all-to-all
- expert dispatch/combine
- package-local / cross-package hop

## 8. 本次运行的结论

### 当前能确认的内容

1. 7-reticle、8 Compute Die、16 MC 的面积守恒成立。
2. 三模型已进入同一个高层方向评估流程。
3. P0/P1 和 MC320/MC640 已在结果维度中分离。
4. 可以生成候选架构集合并做初步 bottleneck 分类。
5. 当前结果已经可以作为 Q1/Q2 详细设计的输入草案。

### 当前不能确认的内容

1. 不能确认 TP8 是最终最优配置。
2. 不能确认任何模型已经达到 1000 TPS/usr。
3. 不能把 MC640 作为默认可制造带宽。
4. 不能把 P1 结果外推为 P0 结果。
5. 不能进入最终架构签核。

## 9. 下一步 Agent 交互

建议下一批执行：

```text
D2/D3/D4/D5/D6
  -> sensitivity sweep
  -> D7 candidate re-ranking
  -> Q9 direction validation
  -> A0 D-Gate review
```

D-Gate 通过后再执行：

```text
Q1 manifest
  -> Q2 arithmetic intensity / Roofline / sizing
  -> Q3/Q4/Q5 event models
  -> Q6 scheduler
  -> Q7 PPA
  -> Q8 detailed TPS
  -> Q9 Q-Gate
```

## 10. 运行产物

```text
models/direction/run_directional_envelope.js
models/direction/run_directional_tps.js
data/direction/directional_resource_envelope.json
data/direction/directional_tps_scorecard.json
```
