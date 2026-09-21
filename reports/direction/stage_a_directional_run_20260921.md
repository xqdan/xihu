# Stage A 方向级架构运行报告

运行时间：2026-09-21T12:48:24.579Z
Run ID：`stage-a-20260921124431`
状态：`DIRECTIONAL_ESTIMATE / D-GATE BLOCKED`

## 1. 运行链路

```text
D1 workload profile -> D2 memory/bandwidth -> D3 compute/core
  -> D4 communication -> D5 7-reticle/package -> D6 software
  -> D7 directional TPS -> independent D-Gate validator
```

## 2. 单位和资源 scope

本次计算只使用基础 SI 单位：FLOP/token、byte/token、FLOP/s、byte/s。MC 的有效带宽为 raw payload × sustainedAssumption。Compute 与 memory 均以 `package_rank` 为 scope。

| Profile | Scope | Value |
|---|---|---:|
| P1-compact | package_rank | 1415.5776 TFLOP/s |
| P0-7R-balanced | package_rank | 2359.2960 TFLOP/s |
| MC320 | package_rank | 3.5840 TB/s effective |
| MC640 | package_rank | 7.1680 TB/s effective |

## 3. 候选与聚合

总候选行：36；架构候选：12；每个候选均有三模型行。只有 K3 可比较，因此不进行正式排名。授权探索 sweep：`P0-7R-balanced-MC320-TP8`, `P0-7R-balanced-MC320-TP16`, `P0-7R-balanced-MC320-TP32`。

## 4. K3 directional result

| Candidate | TP | MC | Bottleneck | TPS/usr | Memory us | Status |
|---|---:|---|---|---:|---:|---|
| P1-compact-MC320-TP8 | 8 | MC320 | memory | 144.09 | 5931.62 | DIRECTIONAL_ESTIMATE |
| P1-compact-MC320-TP16 | 16 | MC320 | memory | 288.18 | 2965.81 | DIRECTIONAL_ESTIMATE |
| P1-compact-MC320-TP32 | 32 | MC320 | memory | 576.37 | 1482.90 | DIRECTIONAL_ESTIMATE |
| P1-compact-MC640-TP8 | 8 | MC640 | memory | 288.18 | 2965.81 | DIRECTIONAL_ESTIMATE |
| P1-compact-MC640-TP16 | 16 | MC640 | memory | 576.37 | 1482.90 | DIRECTIONAL_ESTIMATE |
| P1-compact-MC640-TP32 | 32 | MC640 | memory | 1152.74 | 741.45 | DIRECTIONAL_ESTIMATE |
| P0-7R-balanced-MC320-TP8 | 8 | MC320 | memory | 144.09 | 5931.62 | DIRECTIONAL_ESTIMATE |
| P0-7R-balanced-MC320-TP16 | 16 | MC320 | memory | 288.18 | 2965.81 | DIRECTIONAL_ESTIMATE |
| P0-7R-balanced-MC320-TP32 | 32 | MC320 | memory | 576.37 | 1482.90 | DIRECTIONAL_ESTIMATE |
| P0-7R-balanced-MC640-TP8 | 8 | MC640 | memory | 288.18 | 2965.81 | DIRECTIONAL_ESTIMATE |
| P0-7R-balanced-MC640-TP16 | 16 | MC640 | memory | 576.37 | 1482.90 | DIRECTIONAL_ESTIMATE |
| P0-7R-balanced-MC640-TP32 | 32 | MC640 | memory | 1152.74 | 741.45 | DIRECTIONAL_ESTIMATE |

## 5. D-Gate

```json
{
  "areaConservation": true,
  "threeModelRowsAccounted": true,
  "threeModelComparable": false,
  "bottleneckClassification": true,
  "sensitivitySweep": false,
  "candidateCountLe3": true,
  "formalSelectionRecorded": false,
  "decision": "BLOCKED_PENDING_SENSITIVITY_SWEEP_AND_FORMAL_MANIFEST"
}
```

D-Gate blocked 时，Stage B 只能以 `EXPLORATORY_AFTER_BLOCKED_D_GATE` 运行，不得把探索结果写成正式候选或 silicon TPS 承诺。

## 6. 产物

```text
data/direction/directional_workload_baseline.json
data/direction/directional_tps_scorecard.json
data/governance/candidate_register.json
data/governance/gate_status.json
reports/direction/stage_a_directional_run_20260921.md
```
